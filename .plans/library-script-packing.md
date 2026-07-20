# Library: self-contained prefab bundles — pack `user:` scripts + code-referenced assets

Implementation spec. Design decisions below are already approved by Igor — implement as written,
don't re-litigate. Ask only if you hit a contradiction with the actual code.

## Problem

Publishing a prefab to the Asset Library now bundles scene-level `res://` dependencies (sprites,
AudioPlayer tracks) — but **`user:` script components and everything referenced from inside script
code are lost** when the item is inserted into another project.

Root cause: script components serialize as `type: user:<ClassName>` (see
`packages/pix3-runtime/src/core/SceneSaver.ts:162-170`) — a global class-name reference, **not** a
`res://` path. The dependency collector in `PublishToLibraryService` only follows `res://` tokens,
so script files are never bundled. Sounds "lost" with them are `res://` paths embedded in script
source (`this.scene.audio.play('res://…')`) — also invisible to the scene-text scan.

Key engine facts (verified):

- `user:X` is registered globally by **class name** for every `export class X extends Script`
  found under `scripts/` or `src/scripts/`
  (`src/services/ProjectScriptLoaderService.ts:52`, `:565-588`, `:373`).
- Scripts **must** physically live under one of those directories to register. No other placement
  works.
- `res://` paths inside `.ts` source **cannot be remapped** (unlike scene YAML) — assets referenced
  from code must be restored at their original project paths.
- `core:*` components are engine-level — nothing to pack.
- Keyframe animation clips live inside component `config` → serialize with the node → already
  packed. Not part of this task.

## Approved decisions

1. **Mixed placement on insert:**
   - Prefab scene + scene-referenced assets → `assets/library/<slug>/…` with reference remapping
     (today's behavior, keep it).
   - Script files (+ transitive relative imports) → **original project-relative paths**
     (`scripts/…`).
   - Assets referenced from script code → **original project-relative paths**.
2. **Content-aware conflicts, never overwrite:** target file exists and is byte-identical → skip
   silently; exists and differs → skip and **warn** ("kept existing `scripts/Enemy.ts`, differs
   from library copy"). Missing → write.
3. Full script packing now (no warn-only stopgap).
4. Phase 4 ("Add as scene" for scene-type items) is separable — do it last; OK to deliver as a
   follow-up if phases 1–3 land cleanly.

Out of scope: localization-table packing (`tr()` keys), republish/versioning UX, team scope,
rename-on-import for colliding class names.

## Files to read first

| File | Why |
|---|---|
| `src/services/PublishToLibraryService.ts` | Both publish paths + `collectDependencies` (extend here) |
| `src/services/library/library-dependencies.ts` | Pure `res://` scanners (add pure helpers here) |
| `src/services/library/library-path-remap.ts` | Insert-time remapping (`remapBundleReferences`) |
| `src/services/LibraryInsertService.ts` | Copy/insert flow, preview-skip logic (extend partition) |
| `src/services/library/library-types.ts` | `LibraryItemManifest` (new field) |
| `src/services/ProjectScriptLoaderService.ts` | Script discovery/registration, `syncAndBuild`/`ensureReady` |
| `src/services/agent/AgentChatService.ts:100-118` | `SCRIPT_CLASS_PATTERN` precedent for class→file scan |
| `src/services/library/*.spec.ts` | Existing test style |

## Design

### Bucket model

Every bundle file belongs to one of two buckets:

- **namespaced** (default): written to `assets/library/<slug>/<bundle-path>` on insert, `res://`
  refs to other namespaced files remapped. Scene entry, sprites, AudioPlayer tracks — as today.
- **original-path**: written verbatim to its bundle-relative path (which equals its original
  project-relative path), **no remapping applied to its content, and no refs pointing at it get
  remapped**. Scripts, their imports, and anything referenced from an original-bucket text file.

**Closure rule:** anything reachable (via `res://` ref or relative import) *from* an
original-bucket text file is itself original-bucket. Rationale: original-bucket files are written
verbatim, so their internal refs must stay valid at original paths. This makes the two buckets
internally consistent: namespaced text remaps only refs to namespaced files; refs to
original-bucket files are left untouched and resolve because those files are restored in place.

A file referenced from both scene YAML and script code → original bucket (scene ref simply isn't
remapped; still resolves).

### Manifest change (`library-types.ts`)

```ts
/**
 * Bundle-relative paths that must be restored to their ORIGINAL project-relative locations on
 * insert (scripts + assets referenced from script code), instead of being copied under
 * `assets/library/<slug>/`. References to these files are never remapped. Absent ⇒ empty
 * (pre-existing items keep today's behavior).
 */
originalPathFiles?: string[];
```

Backward compat: items without the field behave exactly as today.

## Phase 1 — pure helpers + tests (`library-dependencies.ts`)

Add (pure, no DI, mirror the existing text-based style):

```ts
/** Distinct user: component class names referenced in serialized scene text. */
export function collectUserComponentTypes(text: string): string[]
// regex: /\buser:([A-Za-z_$][A-Za-z0-9_$]*)/g, dedup, order-preserving

/** Relative import/export-from specifiers ('./x', '../x') in a script source. */
export function collectRelativeImports(text: string): string[]
// cover: import … from '…'; export … from '…'; bare `import '…'`; dynamic import('…') optional.
// Only specifiers starting with './' or '../'. Ignore '@pix3/runtime', 'three', '@/…', bare pkgs.

/** Ordered candidate project paths for a relative specifier from `fromFile`'s directory. */
export function resolveImportCandidates(fromFile: string, specifier: string): string[]
// normalize ../ and ./ segments; candidates: raw (if has extension), raw+'.ts', raw+'.js',
// raw+'/index.ts'. Caller probes storage in order.
```

Extend `src/services/library/library-dependencies.spec.ts` with cases: default-export class,
multiple user: on one line, `export * from './x'`, side-effect import, `../` traversal, specifier
with extension already (`./shader.glsl`).

## Phase 2 — publish side (`PublishToLibraryService.ts`)

1. **Class→file index.** New private `buildScriptClassIndex(): Promise<Map<string, string>>`:
   recursively list `scripts/` and `src/scripts/` via `this.storage.listDirectory` (mirror
   `ProjectScriptLoaderService.collectFilesRecursively` locally — do NOT refactor the loader),
   read each `.ts`/`.js` (skip `.spec.ts`, `.test.ts`, `.d.ts`), match
   `SCRIPT_CLASS_PATTERN = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+Script\b/g`,
   map className → project-relative path. Missing directories are fine (skip). Build lazily once
   per publish call.

2. **Extend `collectDependencies`** to carry a bucket context. Suggested shape — replace the
   loose params with a context object:
   ```ts
   interface CollectContext {
     files: Map<string, Blob>;
     originalPaths: Set<string>;   // bundle-relative == project-relative
     visited: Set<string>;
     scriptIndex: Map<string, string>; // lazy
   }
   private async collectDependencies(text, ctx, inOriginalBucket: boolean)
   ```
   Per text scanned:
   - `res://` refs (existing logic): add file; bucket = `inOriginalBucket` of the *referencing*
     text. Recurse into scene/script refs passing the same bucket flag.
   - **NEW** `collectUserComponentTypes(text)` (only meaningful for scene/prefab text, harmless
     elsewhere): resolve each class via the index; found → add the script file to `files` +
     `originalPaths`, then recurse its source with `inOriginalBucket = true` **and** follow
     `collectRelativeImports` (probe candidates via `storage.readBlob`/`readTextFile`, first hit
     wins; each import file → `files` + `originalPaths`, recurse as script).
   - Unresolvable class name → `console.warn('[PublishToLibraryService] user:X not found under
     scripts/ — bundle will not carry it')` and continue (still publish).
   - Guard cycles with `visited` as today. A file first seen namespaced then reached from an
     original context must be **promoted** to `originalPaths` (set add is enough; don't re-read).

3. Both `buildBundle` (node drag) and `publishAssetPath` (file drag) route through the extended
   collector — entry text scanned with `inOriginalBucket = false`.

4. Set `manifest.originalPathFiles = [...ctx.originalPaths].sort()` when non-empty (omit when
   empty to keep old-shape manifests).

5. Bundle layout unchanged: files keyed by project-relative path; scripts land at e.g.
   `scripts/Enemy.ts` inside the bundle.

## Phase 3 — insert side (`LibraryInsertService.ts`)

1. **Partition** `bundle.files` by `manifest.originalPathFiles` (normalize with
   `normalizeBundlePath` on both sides; default `[]`).
2. **Namespaced set:** written as today under `targetDir`, but `remapBundleReferences` must
   receive **only the namespaced file list** (today it gets all files — change this). Preview-skip
   (`preview.webp`, preview ≠ entry) stays; fold it into the partition cleanly.
3. **Original set:** for each file — probe target at its own path:
   - missing → write (text via `writeTextFile` verbatim — NO remap; binary via
     `writeBinaryFile`); ensure parent dirs.
   - exists → compare content (read existing; for text compare strings, for binary compare
     `byteLength` then bytes). Identical → skip silently. Different → skip + push warning
     `"Kept existing <path> — differs from the library copy"`.
4. `InsertedBundle` gains `readonly warnings: readonly string[]` (empty when none) and
   `resourcePaths` must include original-bucket files at their real (`res://<original>`) paths.
   Log each warning via `console.warn` (and `LoggingService` if it injects without ceremony —
   warnings surface in the Logs panel).
5. **Ordering constraint (critical):** if the bundle carries any original-path `.ts`/`.js`, then
   after the copy step and **before** `dispatchInsertCommand`, force a script rebuild so
   `user:` classes are registered before the scene text is parsed:
   ```ts
   await this.scriptLoader.syncAndBuild({ force: true });
   await this.scriptLoader.ensureReady();
   ```
   (`syncAndBuild` sets `scriptsStatus = 'loading'` synchronously, so `ensureReady` waits for the
   debounced build. Verify this holds; see `ProjectScriptLoaderService.ts:109-176`.) Inject
   `ProjectScriptLoaderService` — no DI cycle (loader doesn't reference insert service).
6. Dedup nuance: today `alreadyPresent` (entry exists) skips the whole write. Keep that for the
   namespaced set, but **always run the original-set sync** — it's idempotent (skip-if-identical)
   and covers "assets/library/<slug> copied earlier, scripts absent here".

## Phase 4 — "Add as scene" (separable; OK as follow-up)

Scene-type items (магазин, карта уровней, меню настроек, шаблон кат-сцены) shouldn't only
instance into the current scene. Add an explicit "Add to project & open" action:

- `LibraryInsertService.copyBundleIntoProject(itemId)` (already public) → then open
  `entryResourcePath` as a scene tab. Find the existing open-scene-file flow — start at
  `src/services/AssetFileActivationService.ts` (double-click activation in the Asset Browser) and
  reuse it; do not invent a new path.
- UI: a second button in `src/ui/asset-library/library-inspector.ts` shown for
  `manifest.type === 'scene'` (keep existing primary insert). Follow `pix3-ui-conventions`
  (IconService, tokens, Light DOM). **Note:** `library-panel.ts` has uncommitted user changes
  (`LibrarySyncService`) — rebase-friendly edits only, don't touch unrelated lines.

## Tests (required)

New `src/services/PublishToLibraryService.spec.ts` — mock `ProjectStorageService` with an
in-memory `Map<path, string|Blob>`; mock `SceneManager`/`AssetLibraryService`/
`SceneThumbnailGenerator` (make `generate` throw → exercises the graceful no-preview path;
happy-dom has no WebGL anyway). Cases:

1. Scene YAML with `type: user:Enemy` + sprite `res://assets/sprites/e.png`; `scripts/Enemy.ts`
   exists, contains `import { Helper } from './lib/helper'` and `res://assets/sfx/shoot.mp3` →
   bundle contains all 4 deps; `originalPathFiles = ['assets/sfx/shoot.mp3', 'scripts/Enemy.ts',
   'scripts/lib/helper.ts']`; sprite NOT in originalPathFiles.
2. Unknown `user:Ghost` → publishes anyway, no throw, warning logged.
3. File referenced from both scene and script → in `originalPathFiles` once.
4. Import cycle between two scripts → terminates, both bundled.

New `src/services/LibraryInsertService.spec.ts`:

1. Partition: namespaced files remapped/written under `assets/library/<slug>/`; original files at
   own paths verbatim (no remap of their content; scene refs to them not remapped).
2. Conflict: existing identical → not rewritten, no warning; existing different → kept, warning
   returned.
3. Ordering: with scripts present, `scriptLoader.syncAndBuild` + `ensureReady` called before
   `commands.execute` (spy order).
4. Legacy manifest (no `originalPathFiles`) → byte-for-byte today's behavior incl. preview skip.

Do NOT parse scenes through a real `SceneManager` in specs (avoids the AssetLoader
texture-cache unhandled-rejection gotcha — if you must, seed the texture cache first).

## Validation

```bash
npx vitest run src/services/library/ src/services/PublishToLibraryService.spec.ts src/services/LibraryInsertService.spec.ts
npx tsc --noEmit   # repo has ~32 PRE-EXISTING unrelated errors — only fix errors in touched files
npx eslint <touched files>  # ignore mass "Delete ␍" CRLF noise (autocrlf); real rules only
```

## Constraints (binding)

- AGENTS.md rules: DI via `@injectable`/`@inject`, no `any`, mutation gateway untouched (scene
  insertion already goes through `CommandDispatcher` — keep it that way).
- Match surrounding comment density/style (these services are heavily doc-commented).
- No new `docs/*.md`. `.plans/` is fine.
- `src/ui/asset-library/library-panel.ts` has fresh uncommitted user work (LibrarySyncService) —
  don't revert or reformat it; phases 1–3 shouldn't need to touch it at all.
- Keep `@pix3/runtime` editor-agnostic — nothing in this task belongs in `packages/pix3-runtime`.
