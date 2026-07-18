# Session prompt — Feature #1: Localization (editor authoring + play-mode wiring + migration)

> Paste the section below as the first message of a fresh Claude Code session in the `pix3` repo.
> Everything above this line is a note; everything below is the prompt.

---

Continue the **unified localization (i18n/l10n) system for Pix3**. The engine-agnostic **runtime core is already built and shipped** (commit `8987ac7` on branch `feat/editor-improvements`); your job is the **editor authoring layer + play-mode auto-wiring + the SkyDefender migration**. This is an **engine+editor feature** — per `CLAUDE.md`, state the plan and get my confirmation before writing code.

## Authoritative plan — read first
- **`.plans/localization-design.md`** — the full design (Godot `tr()`-adapted). Source of truth: data model (per-locale JSON tables + `sprites` section + `pix3project.yaml` `localization:` block), the `LocalizationService` API, node integration, editor UX, commands/operations, script API, export, edge cases, and the phased plan (§8). Follow it.
- Also read `AGENTS.md`, `CLAUDE.md`, `docs/nodes-and-systems.md`. Load the `pix3-game-dev` skill before runtime work and the `pix3-ui-conventions` skill before building the panel/inspector widget.

## What's ALREADY DONE — do NOT rebuild (commit `8987ac7`)
Runtime core, live-verified + 8 unit tests:
- `packages/pix3-runtime/src/core/localization/`: `LocalizationService` (per-locale JSON tables via `ResourceManager`, `tr`/`trSprite`/`has` with current→fallback→key chain, `{param}` interpolation, `onChange`, `setLocale`/`setTable`), `active-localization.ts` (globalThis sink: `setActiveLocalization`/`getActiveLocalization`/`resolveLocalizedText(key, fallbackLiteral, params?)`), `apply-locale-to-tree.ts` (re-renders keyed labels), `localization-types.ts`, spec. All exported from `packages/pix3-runtime/src/index.ts`.
- `UIControl2D`: `labelKey` field + schema prop (`editor: 'localization-key'`), `getDisplayText()` (= `tr(labelKey)` else literal), `updateLabel()` paints it, public `refreshLocalizedLabel()`. `property-schema.ts` has the `'localization-key'` editor hint.
- `Label2D`: `updateLabel()` uses `getDisplayText()`, `setTextKey(key, params?)`, `setText()` clears the key, `labelKeyParams` (runtime-only).
- Persistence: `SceneSaver.serializeCommonUIControlProps` writes `labelKey`; `SceneLoader` reads it into every UIControl2D subclass. Prefab-override diffs work (schema prop).
- `SceneService.get localization()` returns `delegate?.getLocalizationService?.() ?? getActiveLocalization() ?? inert` — so `this.scene.localization.tr(...)` works for scripts. The `SceneServiceDelegate` interface has the optional `getLocalizationService?()` method.

> Note: the branch may have advanced (a parallel #4 batching effort added `core/atlas-frame-map`, `batch-2d`, `shared-quad-geometry` etc. to the runtime index). That's unrelated to localization; don't touch it.

## What REMAINS (your work)

**Phase 0 completion — SceneRunner play-mode wiring** (I deferred this): `SceneRunner` must, on `startScene`, create + `configure()` (from injected config) + `attachResources()` + `setActiveLocalization()` a play-mode `LocalizationService` (seeded with the editor's current preview locale in-editor, or `defaultLocale` in exports), stash the previous active pointer, subscribe its `onChange` → `applyLocaleToTree(rootNodes)`, and implement `SceneServiceDelegate.getLocalizationService()`; on `stop()` restore the stashed pointer + dispose (even on abnormal stop). Runtime `LocalizationService.spec` extend for lifecycle if useful.

**Phase 1 — Editor preview + inspector + manifest (the MVP the user wants authorable):**
- `src/core/ProjectManifest.ts` — `localization: { defaultLocale, fallbackLocale, locales }` block + `normalizeProjectManifest` default (absent ⇒ inert).
- `src/services/LocalizationEditorService.ts` (`@injectable`, `dispose()`): load `locales/*.json` + manifest block at project open; own the **editor-preview `LocalizationService`** instance + `setActiveLocalization()`; feed it via `setTable()` on edits; authoring API (`getTable`/`setEntry`/`removeKey`/`addLocale`/`getMissing`/`save`); mirror `appState.localization` slice `{ locales, defaultLocale, previewLocale, missingCounts, revision }`.
- `src/state/AppState.ts` — `localization` slice (IDs/counters only; tables stay in the service).
- `src/features/localization/`: `SetPreviewLocaleCommand`/`Operation` (non-dirtying; undo restores previous locale; runs `applyLocaleToTree` + refreshes label proxies + `requestRender()`), `UpdateLocaleEntryCommand`/`Operation` (undoable, write-through).
- `src/services/ViewportRenderService.ts` — label proxies must render `node.getDisplayText()` (not `node.label`) so keyed labels show translations in the editor; refresh affected label visuals on preview-locale change / table edit, then `requestRender()`.
- Inspector: `pix3-localization-key-editor` widget in `src/ui/object-inspector/property-editors.ts`, dispatched by the `editor: 'localization-key'` hint in `inspector-panel.ts` — text input + autocomplete over known keys, a status glyph (IconService `check`/`alert-triangle`) for "resolves in preview locale?", and an **Extract** button (literal `label` + empty `labelKey` → creates default-locale key from node path, sets `labelKey` via `UpdateObjectPropertyOperation`). Setting `labelKey` needs **no new op** — it's a schema prop through the existing `UpdateObjectPropertyCommand`.
- Viewport toolbar: a compact preview-locale dropdown (IconService `globe`).

**Phase 2 — Localization panel + localized sprites + extraction + export** (design §3.3, §4.3–4.5, §6): `pix3-localization-panel` (Golden Layout; keys×locales grid + Sprites tab + missing view), `Sprite2D.textureKey` / `Button2D.stateTextureKeys` resolved through the `sprites` table at the `SceneLoader` texture-load sites, `Add/Remove/RenameLocale` + `ExtractLocalizationKeys` commands, and `ProjectBuildService.collectAssetPaths` enumerating `locales/*.json` + their sprite paths (the one mandatory export change) + baking the `localization` config into the generated bootstrap.

**Phase 3 — SkyDefender migration (the proof) + docs + publish:** `samples/SkyDefender/locales/{en,ru}.json`; migrate `SdBalance.ts` `MISSION_NAMES`/`MISSION_META` literals to key helpers + `speakerKey`/`textKey`/`goalKey`; `GameFlow`/`MapController`/`HudController`/`ShopController` `setText(...)` → `setTextKey(...)` where persistent; `labelKey` on authored scene labels; menu-button EN/RU sprite keys. Then update `docs/nodes-and-systems.md` + `docs/pix3-specification.md` + `pix3-game-dev` skill; `cd packages/pix3-runtime && npm run yalc:publish` → `yalc update` in `../DeepCore`.

## ⚠️ Verification environment (learnings not in the design doc)
Editor-viewport label re-rendering on a locale switch **needs a real rendering context** — use the **chrome-devtools MCP**, not raw CDP:
- The editor renders **on-demand** (rAF); a background Chrome throttles rAF so **no WebGL canvas is created** and the viewport camera is null / `0×0`. The MCP's `take_screenshot` **forces a paint** — screenshot after every state change before checking that labels changed on screen.
- **Runtime-core mechanism is already proven** (this recipe worked live): via MCP `evaluate_script`, `const E = window.__PIX3_ENGINE__; const loc = new E.LocalizationService(); loc.configure({defaultLocale:'en',fallbackLocale:'en'}); loc.setTable({locale:'en',strings:{'menu.play':'Play'},sprites:{}}); loc.setTable({locale:'ru',strings:{'menu.play':'Играть'},sprites:{}}); E.setActiveLocalization(loc); const l = new E.Label2D({id:'t',labelKey:'menu.play'}); l.getDisplayText(); // 'Play'; await loc.setLocale('ru'); E.applyLocaleToTree([l]); l.getDisplayText(); // 'Играть'`. Your job is to verify the **editor path**: set `labelKey` in the inspector, switch preview locale, screenshot → the label in the viewport shows the translated text; and the **play-mode path**: start play (`window.__PIX3_DEBUG__.play.start()`), a script `setLocale('ru')`, screenshot → keyed labels re-render.
- Open a project/scene headlessly: OPFS "browser" project via `ProjectLifecycleService.createProject({ name, backend:"browser", viewportBaseWidth:1280, viewportBaseHeight:720, templateId:"empty-2d" })` then `EditorTabService.focusOrOpenScene(...)`; build nodes with `d.agentTools.execute("create_node", {...})`. The MCP profile also has a real project "S1 Clean Ring Racing". Test target **SkyDefender** (`samples/SkyDefender`) needs a one-time human directory-pick — ask me to open `c:\Projects\pix3-stuff\pix3\samples\SkyDefender` in the MCP's Chrome.
- Skills: `debug-running-game`, `pix3-remote-preview`.

## Conventions
- Mutation gateway (Command+Operation) for every editor state change; DI (`@injectable`/`@inject`, `dispose()`); Light-DOM Lit on `ComponentBase` + sibling `.ts.css` + **IconService** (never emoji) + theme tokens for the panel/widget/dropdown; no `any`.
- Runtime package stays editor-agnostic + publishable — the `LocalizationEditorService`/panel/commands live editor-side; the runtime only gets the SceneRunner wiring. `yalc:publish` after runtime changes.
- Keep `tsc --noEmit` at the repo baseline (~32 pre-existing errors); lint clean (ignore the repo-wide CRLF/prettier `Delete ␍` noise); no runtime-spec regressions.
- Backward-compatible: projects with no `localization` block / no `labelKey` behave exactly as today.
- Commit incrementally (SceneRunner wiring; Phase 1 editor MVP; Phase 2; Phase 3 migration); end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

Start with Phase 0 completion (SceneRunner wiring) + the Phase-1 plan (manifest + LocalizationEditorService + preview switch + inspector widget), propose it for my confirmation, then implement and verify the editor preview-locale switch changing scene labels in the viewport.
