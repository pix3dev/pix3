# Sprite Editor — design for renaming, double-click open, and animation-editor merge

Status (2026-08-02): **Phase 1 shipped** (commit `53e6c07` — rename + double-click open,
`src/ui/sprite-editor/`, `OpenSpriteEditorCommand`). Phase 2 (shared slicing module +
"Create Animation from image") and Phase 3 (shell-merge with the flipbook editor) остаются.
**§8 (2026-08-02) revises the Phase-3 target UX** from mode-tabs to a Construct-3-style
single-canvas editor and adds Phases 4–6 (scene-node entry, file-layout convention,
navigator grouping, generation-fit UX, power tools). §§1–7 remain valid except where §8
explicitly overrides (§8.3 overrides §3.2's mode-tab layout; the shell/two-tab-types/two-document
decisions all survive).
Scope: rename "Asset Generator" → "Sprite Editor", make double-clicking an
image asset open it, and evaluate/design a Construct-3-style merge with the flipbook animation editor.

---

## 0. Corrected premise + recommendation up front

**Premise correction.** The Asset Generator is not a node and not a modal — it is already a full
**editor tab** (`EditorTabType 'asset-generator'`, component `<pix3-asset-generator-panel>`,
`src/ui/asset-generator/asset-generator-panel.ts`) hosted by Golden Layout next to scene/animation/code
tabs. It already does most of what a "Sprite Editor" needs: load a bound project image
(`loadBoundImage` :331), crop (:1354+), rotate/flip (:1305+), background removal (worker-based),
resize-on-save (:1034+), Save to project / Overwrite original / Save to library / Insert as Sprite2D
(:1615–1740), plus AI generation. So features 1–2 are a rename plus a one-function rerouting — low
risk, high value.

**Merge recommendation (feature 3).** Converge on one merged "Sprite Editor" surface — but only as a
**thin mode-shell that hosts the two existing panels as sub-views**, never as a single-component
rewrite (the panels are 1 992 and 2 419 lines; a 4 400-line god component would be unmaintainable and
their document models genuinely differ). Ship it phased:

- **Phase 1 (do now):** rename + double-click-to-open. Low risk.
- **Phase 2 (do now/next):** extract shared slicing into a pure module both panels use, and add
  "Create Animation from this image…" linkage from the Sprite Editor to the flipbook editor.
- **Phase 3 (worth it, but gated):** the shell merge — one tab with Image / Animation mode tabs,
  Construct-3 style. Do it after Phase 2 has been used in anger; Phase 2 already delivers ~80 % of the
  workflow value (single entry point + slicing + one-click handoff) at ~20 % of the risk.

Key architectural insight that makes the phasing safe: in Construct 3 the animation frames ARE rasters
owned by the object, so image-editing and animation-editing are one document. In Pix3 they are **two
documents** — a raster file (png/jpg) vs a `.pix3anim` `AnimationResource`
(`packages/pix3-runtime/src/core/AnimationResource.ts`: `{version, texturePath, clips[]}`,
`AnimationClip {name, frames, fps, loop, playbackMode}`, `AnimationFrame {texturePath, anchor,
boundingBox, collisionPolygon, events…}`) whose frames *reference* image files. The natural Pix3 merge
is therefore *navigation between two bound resources inside one shell*, not one fused document — which
is exactly what a shell composition gives us without rewriting either editor.

---

## 1. Phase 1a — Rename to "Sprite Editor"

### 1.1 Internal id: migrate cleanly (recommended) — the migration is nearly free

Normally renaming a tab-type id risks breaking persisted sessions/layouts. Here it does not:

- `'asset-generator'` tabs are **explicitly excluded from session persistence** in all three places
  (`src/services/EditorTabService.ts` :106, :117, :371), so no `pix3.projectTabs:{projectId}`
  localStorage blob ever contains one.
- `LayoutManager` does **not** persist Golden Layout state at all (no localStorage/save-layout code in
  `src/core/LayoutManager.ts`); the layout is rebuilt every session and editor tabs are re-created
  from the (already filtered) session.

So: **rename the id to `'sprite-editor'` end-to-end.** Everything else is compile-time-checked via the
`EditorTabType` union. Defensive back-compat: keep one legacy line in the
`restoreProjectSession` filter (`EditorTabService.ts` :371) — `if (t.type === 'asset-generator') return
false;` stays (it already drops them), so even a hand-edited stale session cannot crash restore.

### 1.2 Directory / file / tag renames — do them (mechanical, no runtime persistence of tag names)

Recommended: rename now while the surface is small; the churn is one `git mv` + ~8 import sites + a
sed pass over the CSS (all selectors are tag-name-prefixed).

| Current | New |
| --- | --- |
| `src/ui/asset-generator/` | `src/ui/sprite-editor/` |
| `asset-generator-panel.ts` / `.ts.css` | `sprite-editor-panel.ts` / `.ts.css` |
| class `AssetGeneratorPanel` | `SpriteEditorPanel` |
| tag `pix3-asset-generator-panel` (:103, :1990, all CSS selectors) | `pix3-sprite-editor-panel` |
| `EMPTY_RESOURCE_ID = 'asset-generator://new'` (:42) | `'sprite-editor://new'` (also `EditorTabService.ts` :270) — never persisted, safe |
| toolbar title `Asset Generator` (:376) | `Sprite Editor` |
| CSS class prefix `ag-` | keep `ag-` (pure churn to rename ~90 selectors; prefix is internal) — or rename to `se-` if we're touching every selector anyway; **recommend keep `ag-`** |
| `src/features/editor/OpenAssetGeneratorCommand.ts` | `OpenSpriteEditorCommand.ts`, class `OpenSpriteEditorCommand` |

**Keep unrenamed** (they describe AI generation, which remains one feature *inside* the Sprite
Editor): `AssetGenService`, `GenerationHistoryService`, `AiImageSettingsService`,
`BackgroundRemovalService`, `SaveGeneratedAssetDialogService`, `GeneratedAssetDropService`,
`src/services/image-gen/*`.

### 1.3 Registration / display-string touch points (exact)

- `src/core/LayoutManager.ts`
  - :27 `PANEL_COMPONENT_TYPES.assetGenerator: 'asset-generator'` → `spriteEditor: 'sprite-editor'`
  - :48 `PANEL_TAG_NAMES` → `'pix3-sprite-editor-panel'`
  - :67 `PANEL_DISPLAY_TITLES` → `'Sprite Editor'`
  - :382–383 tab-type → component-type mapping
  - :655 `isEditorTabComponentType`
  - :841–842 lazy `import('@/ui/sprite-editor/sprite-editor-panel')`
- `src/state/AppState.ts` :21 — `EditorTabType` union member `'asset-generator'` → `'sprite-editor'`.
- `src/services/EditorTabService.ts` :106/:117/:371 (persistence filters, keep legacy string in :371),
  :257–275 `focusOrOpenAssetGenerator` → `focusOrOpenSpriteEditor(imageResourcePath?)`; empty-tab
  fallback title `'Sprite Editor'`.
- `src/features/editor/OpenSpriteEditorCommand.ts` — `id: 'editor.open-sprite-editor'`, `title:
  'Sprite Editor'`, `menuPath: 'tools'`, `addToMenu: true` (menu regenerates from metadata via
  CommandRegistry — no menu code to touch), description "Open the sprite editor to edit or generate
  images". **Keywords must keep** `'asset generator'`, `'generate'`, `'ai'` so palette muscle-memory
  survives. Command-id rename is safe: `editor.open-asset-generator` is referenced nowhere else
  (grep-verified); menus/palette are registry-generated.
- `src/ui/pix3-editor-shell.ts` :72/:369/:418 — import + instantiation of the renamed command.
- `src/ui/assets-preview/assets-preview-panel.ts` :182–183/:207–209 — context-menu label "Open in
  Asset Generator" → "Open in Sprite Editor"; method `openInAssetGenerator` → `openInSpriteEditor`.
- `src/services/agent/AgentToolRegistry.ts` :1890 — user-facing error string mentions "Asset Generator
  panel" → "Sprite Editor panel".
- Cosmetic comments: `asset-tree.ts` :1041/:1105/:1171/:1227, `pix3-agent-chat-panel.ts` :358,
  `animation-timeline-panel.ts` :11, `pix3-save-asset-dialog.ts` :7, `image-ops.ts` :2,
  `pix3-editor-settings-dialog.ts` :55/:1034 ("used by the Asset Generator" → "Sprite Editor").
- Tests: `assets-preview-panel.spec.ts` (context-menu strings), any spec importing
  `AssetGeneratorPanel`.

### 1.4 Docs & skills (policy: no new .md files)

- `docs/pix3-specification.md` — rename the Asset Generator section to Sprite Editor, describe the new
  double-click behavior.
- `README.md` / `AGENTS.md` — only if they mention Asset Generator (grep at impl time).
- `.claude/skills/generate-sprites-in-editor` — the driving playbook references "Asset Generator" UI
  strings and the Tools-menu label; update selectors/labels or it will break agent-driven sprite
  generation.
- Memory note `asset-generator-feature.md` is auto-memory, not repo docs — leave.

### 1.5 Naming collision cleanup (recommended rider)

`PANEL_DISPLAY_TITLES` currently has **two panels titled "Animation"** (`animation` = flipbook editor
tab, `animationTimeline` = keyframe dock panel, LayoutManager.ts :60–61). While renaming strings,
retitle the flipbook tab to **"Sprite Animation"** (`animation` → 'Sprite Animation'), leaving the
keyframe timeline as "Animation". This pre-stages Phase 3 (where the flipbook becomes a Sprite Editor
mode) and kills a real confusion today.

---

## 2. Phase 1b — Double-click an image opens the Sprite Editor

### 2.1 The single choke point

Both double-click sources converge on `AssetFileActivationService.handleActivation`
(`src/services/AssetFileActivationService.ts` :39):

- asset tree: `asset-tree.ts` :762/:775 `activateAsset` → `'asset-activate'` CustomEvent →
  `asset-browser-panel.ts` :70 `handleActivation(detail)`;
- preview grid: `assets-preview-panel.ts` :220–222 `onItemDoubleClick` → :434 `handleActivation`.

One edit fixes both. Replace the body of `handleImageAsset` (:75–100):

```ts
private async handleImageAsset(payload: AssetActivation): Promise<void> {
  await this.editorTabService.focusOrOpenSpriteEditor(payload.resourcePath ?? undefined);
}
```

Delete the now-unused `findUiLayer`/`deriveSpriteName`/`UI_LAYER_NAME`, the `SceneManager` +
`CreateSprite2DCommand` imports (keep `CommandDispatcher` for the .glb branch). Update
`AssetFileActivationService.spec.ts` (image cases currently assert CreateSprite2DCommand dispatch —
they must assert `focusOrOpenSpriteEditor(resourcePath)` instead).

No change needed in the panel: `focusOrOpenSpriteEditor(path)` → `openResourceTab('sprite-editor',
path, …)` → panel's `syncFromTabState` (:276) + `loadBoundImage` (:331) already binds and displays the
image, and `openResourceTab` dedupes by `deriveTabId(type, resourceId)` so re-double-clicking focuses
the existing tab.

### 2.2 The single clear rule

**Double-click = open in editor, for every asset type. Node creation is drag or explicit command,
never double-click.** No context-dependent exceptions (e.g. "if image already used as sprite, create
node") — context-dependent double-click is unpredictable and untestable. This matches
scene/anim/code behavior already.

Node creation from an image remains available via (all verified to NOT route through
`handleActivation`):

- drag to viewport → `editor-tab.ts` :453 `CreateSprite2DCommand`;
- drag to scene tree → `scene-tree-panel.ts` :783;
- Sprite Editor's own "Insert as Sprite2D" (`sprite-editor-panel.ts` ex-:1699–1718);
- create-node menu / NodeRegistry (:106) / agent `create-node-registry.ts` :49;
- Library insert (`LibraryInsertService.ts` :137).

**Mitigation for habit breakage:** add "Add to Scene as Sprite2D" to the assets-preview context menu
(`renderContextMenu`, assets-preview-panel.ts :171–187) alongside "Open in Sprite Editor", reusing the
exact logic being deleted from `handleImageAsset` (UI-layer targeting included — move it into a small
helper or keep it inline in the panel; simplest: expose
`AssetFileActivationService.createSpriteFromImage(payload)` as a public method and call it from the
menu item). The asset tree has no context menu today (grep-verified) — nothing to add there; note as a
possible follow-up.

### 2.3 Fix the extension set while here

`SUPPORTED_IMAGE_EXTENSIONS = {png, jpg, jpeg, webm, aif}` (:23) is buggy — `webm` is video, `aif` is
audio; almost certainly `webp`/`avif` were intended. Replace with the animation panel's proven set
(`animation-panel.ts` :44–55): `png jpg jpeg gif webp bmp svg tif tiff avif`, minus `svg` if
`loadBoundImage`'s canvas pipeline can't rasterize it reliably (verify at impl; recommend include —
`readImageSize`/`<img>` handles svg). Keep the constant in `AssetFileActivationService` (or move to a
shared `image-extensions.ts` under `src/ui/shared/` and import from both — recommended, one more
duplicate dies).

### 2.4 `.glb` inconsistency (flag, don't fix)

`.glb/.gltf` double-click still *creates a node* (`AddModelCommand`, :58–62) — now the only
type violating the rule. Out of scope here (there is no 3D-model editor tab to open), but record in
the spec that when a model viewer tab exists, `.glb` activation should follow the same rule.

---

## 3. Feature 3 — merge evaluation: Sprite Editor × flipbook Animation editor

### 3.0 Disambiguation (important)

The merge target is **`AnimationPanel`** (`<pix3-animation-panel>`,
`src/ui/animation-editor/animation-panel.ts`, editor-tab type `'animation'`) — the **flipbook/frame**
editor for `.pix3anim` files: multi-clip management, frame strip with drag reorder, fps/loop/ping-pong
preview playback, per-frame anchor/bbox/collision-polygon editing on a zoom stage, and spritesheet
slicing (`sliceSpritesheetIntoFrameFiles` :1977, `AnimationAutoSliceDialogService`). It is **not**
`AnimationTimelinePanel` (keyframe property tracks for `core:AnimationPlayer`, a docked bottom panel)
— that one stays untouched. Both are currently titled "Animation" (see §1.5).

### 3.1 Comparison

**(a) Full merge** — one "Sprite Editor" tab with mode tabs (Image | Animation), Construct-3 style.

**(b) Keep separate, tightly linked** — double-click image → Sprite Editor; "Create Animation…"
button opens the flipbook editor prefilled; slicing shared.

| Axis | (a) Full merge | (b) Linked separate |
| --- | --- | --- |
| Document model | Two documents in one shell: raster blob pipeline (explicit Save/Overwrite, no undo integration, deliberately session-excluded) vs `.pix3anim` edited through `UpdateAnimationDocumentOperation` (undoable, dirty-tracked, session-persisted). Merging does NOT unify these — the shell must carry two dirty/undo/persistence regimes side by side. | Each tab keeps its native regime. Zero semantic risk. |
| Component size | 1 992 + 2 419 lines. Viable only as shell + 2 sub-views; a fused component is a rewrite. | No structural change. |
| Session/tab semantics | Needs per-resource persistence rules (persist `.pix3anim`-bound tabs, drop image-bound/empty ones) — filter by resourceId, not type. Solvable, see §3.3. | Current rules untouched. |
| External contracts | `AnimationPanel` implements `AnimationInspectorController` for the AnimatedSprite2D inspector flow (inspector-panel → `CreateAndBindAnimationAssetCommand` → focus animation editor). Shell must preserve the registration path. | Untouched. |
| Code reuse | Shared slicing/zoom/preview become internal to one surface. | Same reuse via extracted modules (§4) — reuse does not require merging. |
| UX | One mental model: "double-click any sprite-ish asset → Sprite Editor", frame → edit-raster round-trips without tab juggling. Matches Construct 3, the user's reference. | Two tabs, one extra click on handoff; slightly more tab clutter when iterating frame art. |
| Risk/cost | Medium: shell + registration rework + mode routing + cross-mode binding. No data-model migration needed (that's what keeps it medium, not high). | Low. |

**Recommendation: (b) now, (a) as the designed end-state.** The decisive facts: (1) all reuse wins are
achievable with extraction alone; (2) the only thing full merge adds over linked-separate is
single-tab mode switching — real UX value, but the smallest slice of the total; (3) full merge is
strictly easier *after* Phase 2 extractions, because the shell then composes clean pieces. So the
merge is "worth it" — as Phase 3, composed, and only if after living with Phase 2 the two-tab handoff
still feels heavy. Everything below designs Phase 3 concretely so it is a decision, not a research
project.

### 3.2 Phase 3 architecture — shell hosting two sub-views

```
src/ui/sprite-editor/
  sprite-editor-tab.ts          NEW  <pix3-sprite-editor-tab>  — the shell (~250 lines)
  sprite-editor-tab.ts.css      NEW
  sprite-image-view.ts          =    renamed sprite-editor-panel.ts (Phase 1 name), toolbar title row
                                     removed (shell owns the header); everything else unchanged
  sprite-image-view.ts.css      =    renamed css
src/ui/animation-editor/
  animation-panel.ts            =    unchanged component, now instantiated by the shell
```

- **Shell** = `ComponentBase`, Light DOM, sibling `.ts.css`, all icons via
  `IconService.getIcon('image'|'film', IconSize.SMALL)` for the mode tabs, accent via
  `--pix3-accent-color`. Props: `tab-id`, derived `resourceId` from `appState.tabs`
  (same `syncFromTabState` pattern the image panel uses today, :276).
- **Mode routing rule** (how one tab binds either resource):
  - `resourceId` ends `.pix3anim` → Animation mode active, Image mode enabled *when a frame is
    selected* (bound to that frame's resolved `getAnimationFrameTexturePath`);
  - `resourceId` is an image path → Image mode active; Animation mode tab shows "Create animation…"
    affordance (Phase 2 flow) or switches to a sibling `.pix3anim` if one exists
    (`<image-basename>.pix3anim` next to it — cheap existence check via `ProjectStorageService`);
  - `resourceId === 'sprite-editor://new'` → Image mode only.
- **Tab types stay TWO** — this is the trick that avoids all migration: keep `EditorTabType
  'animation'` for `.pix3anim` and `'sprite-editor'` for images/empty, and point **both** LayoutManager
  registrations at the same shell tag (`PANEL_TAG_NAMES[animation] = PANEL_TAG_NAMES[spriteEditor] =
  'pix3-sprite-editor-tab'`), with the shell reading initial mode from the resourceId. Session
  persistence then needs zero changes: animation tabs persist exactly as today, sprite-editor tabs stay
  excluded. `AssetFileActivationService` stays exactly as after Phase 1. Dedupe-by-tabId keeps working
  per resource.
- **Cross-mode navigation:**
  - Animation mode, frame selected → toolbar action "Edit frame image" (IconService `edit-2`):
    shell switches to Image mode with the frame's texture path bound (in-shell binding, tab resourceId
    unchanged — the `.pix3anim` remains the tab's document). Image mode's existing **Overwrite
    original** (:1720) writes the raster back; the animation preview refreshes via its existing
    texture reload path (verify `texturePreviewUrl` invalidation on file change at impl; if stale, bust
    with an objectURL reload after overwrite — the shell knows both sides, so it can call a
    `reloadTextures()` the animation panel already effectively has via resource re-read).
  - Image mode with saved image → "Create animation…" (§4.2) which rebinds Animation mode to the new
    `.pix3anim`.
- **Dirty semantics stay per-mode:** Animation mode keeps operation-based undo + `isDirty` via
  `UpdateAnimationDocumentOperation`; Image mode keeps explicit-save. New nicety (can ship in Phase 1):
  set `tab.isDirty = true` whenever `current.source !== 'file'` and the result is unsaved, so the
  existing `beforeunload` guard (`EditorTabService` :143–156) and `closeTabInternal` dirty prompt cover
  abandoned edits; clear on save/overwrite. Verify `closeTabInternal`'s prompt path handles non-scene
  tab types (it takes a `skipDirtyPrompt` flag, so the plumbing exists).
- **What does NOT merge:** the two documents' undo stacks, save flows, and persistence rules. The
  shell is navigation + shared chrome only. This is the load-bearing decision that keeps Phase 3
  medium-sized.

### 3.3 Explicitly rejected alternative

Fusing into one component / one document (raster edits recorded as operations inside `.pix3anim`,
Construct-3-literal) — rejected: it would force undoable file-writes (the operation model returns
undo closures over app/scene state, not binary project files), break `Save to library` / `Download` /
history semantics, and demand a rewrite of both 2 000-line panels. Nothing in the product goals needs
it.

---

## 4. Shared infrastructure to extract (Phase 2)

### 4.1 Spritesheet slicing

Today slicing lives only in `AnimationPanel.sliceSpritesheetIntoFrameFiles` (:1977–2035): load blob →
canvas-crop grid cells → PNG-encode → `writeBinaryFile` to `buildAnimationFrameResourcePath(assetPath,
n)`. Two concerns are tangled: **pure raster slicing** and **frame-file naming/writing policy** (which
is `.pix3anim`-specific). Split them:

- **Pure part** → `src/services/image-gen/image-ops.ts` (already the home for pure, shared raster
  transforms — `rotateImageBlob`, `flipImageBlob`, `resizeImageBlob`; used by both the panel and agent
  tools, so agent `generate_asset` post-processing gains slicing for free):

  ```ts
  export interface SliceGrid { columns: number; rows: number; }
  export async function sliceImageBlob(blob: Blob, grid: SliceGrid): Promise<Blob[]>; // row-major PNGs
  ```

  `AnimationPanel.sliceSpritesheetIntoFrameFiles` keeps its signature but delegates cell extraction to
  `sliceImageBlob`, retaining only read-source + naming + `writeBinaryFile` + generated-paths logic.
  (`loadImageElement`/`canvasToBlob` move into image-ops as private helpers; image-ops already has
  equivalents.)
- **Dialog reuse:** `AnimationAutoSliceDialogService` (`src/services/AnimationAutoSliceDialogService.ts`)
  is already generic (`{texturePath, clipName, defaultColumns, defaultRows}` → `{columns, rows}`).
  Generalize `clipName` → `contextLabel: string` (one rename, its dialog component updates the copy)
  and both surfaces share it. It's a plain DI service — the Sprite Editor injects it directly.
- **Sprite Editor "Slice…" action** (toolbar, IconService `grid` icon): requires a bound/saved image →
  dialog → `sliceImageBlob` → `SaveGeneratedAssetDialogService`-style destination prompt (reuse it, or
  default to `<image-dir>/<name>_frames/frame_XX.png`) → `writeBinaryFile` per cell. Pure file
  outputs; no Command/Operation needed (matches existing Save-to-project precedent — project-file
  writes are not undoable app-state mutations). Then offer "Create animation from slices?" → §4.2.

### 4.2 "Create Animation from this image" linkage

New button in Sprite Editor when an image is bound/saved (Image mode in Phase 3; the standalone panel
in Phase 2):

1. Dispatch existing `CreateAnimationAssetCommand` (`src/features/scene/CreateAnimationAssetCommand.ts`,
   id `assets.create-animation-asset`) with `assetPath = <image path>.pix3anim` (sibling). Extend
   `CreateAnimationAssetOperationParams` with optional `texturePath` so the new resource is born
   pointing at the spritesheet (verify current params at impl; today it takes `assetPath` and writes an
   empty resource).
2. `editorTabService.focusOrOpenAnimation(assetPath)` — the animation editor's existing behavior
   already prompts auto-slice when a texture is set and no frames exist (`onUpdateTexturePath`
   :2071–2089 → `AnimationAutoSliceDialogService`), so the prefilled flow (open → "slice 4×4?" →
   frames appear) needs zero new animation-panel code.

Mutation-gateway compliance: the `.pix3anim` creation goes through Command+Operation (undoable); tab
opening is non-mutating (`didMutate: false` pattern like `OpenSpriteEditorCommand`).

### 4.3 Zoom/pan stage + preview playback (defer to Phase 3, extract minimally)

- The two stages are less similar than they look: animation stage = zoom + anchor/bbox/polygon editing
  (`AnimationEditMode`, `StageDragState`); image stage = object-fit letterboxed crop overlay
  (`CropRect`/`CropContentRect`). Shared surface is only wheel-zoom/pan pointer math. Extract a
  `StageZoomPanController` (plain class, `src/ui/shared/stage-zoom-pan.ts`: pointer capture, wheel
  zoom-to-cursor, pan, `toStageCoords()`), adopt in both during Phase 3. Do **not** attempt a shared
  stage component — the overlays are the components.
- Flipbook preview playback (fps/loop/ping-pong ticker, animation-panel :799–867): extract
  `FlipbookPreviewController` (frames+fps+mode → current index, rAF-driven) into
  `src/ui/animation-editor/flipbook-preview.ts` only when the Sprite Editor needs "preview sliced
  frames before committing" (nice Phase 2/3 add-on after slicing, not required).
- Rider while touching the animation panel: `ANCHOR_PRESETS` (:84–94) uses Unicode glyph labels
  (↖ ↑ •…) as UI icons — against the IconService rule; replace with `IconService` custom icons or CSS
  dots during Phase 3 cleanup.

---

## 5. Edge cases

| Case | Behavior |
| --- | --- |
| Double-click non-image | Unchanged: `.pix3scene`→scene tab, `.pix3anim`→animation editor, code→Monaco, `.glb`→AddModelCommand (flagged §2.4), unknown→console.info. |
| Double-click `.pix3anim` | Phase 1–2: animation editor as today. Phase 3: same tab type, now rendered by the shell in Animation mode — no behavior change visible beyond the mode header. |
| Image already open in another Sprite Editor tab | `openResourceTab` dedupes on `deriveTabId('sprite-editor', path)` → focuses existing tab (works today, keep). Empty tab remains a singleton via `sprite-editor://new`. |
| Unsaved raster edits on close/reload | Today: silently lost. Phase 1 nicety: set `tab.isDirty` when `current.source !== 'file'`, clear on save/overwrite → existing beforeunload guard + close prompt engage. |
| Session restore | `sprite-editor` tabs stay excluded (:106/:117/:371 — same three filters, new string; keep legacy `'asset-generator'` string in the restore filter defensively). Phase 3: unchanged, because `.pix3anim` keeps type `'animation'` (§3.2) which already persists. |
| Save to project / Overwrite / Insert as Sprite2D / Save to library / Download | Untouched by all phases (they live in the image view). Insert as Sprite2D keeps working post-rename (it dispatches `CreateSprite2DCommand` directly, :1707). |
| Old command id `editor.open-asset-generator` | Renamed; nothing references it (grep-verified). Palette discoverability preserved via keywords. |
| Right-click "Open in Asset Generator" | Renamed to "Open in Sprite Editor"; now redundant with dblclick but kept as discoverability + the menu gains "Add to Scene as Sprite2D" (§2.2). |
| Image formats | Fixed set per §2.3; formats outside the set fall through to code/no-handler as today. |
| Overwriting a frame texture from Image mode (Phase 3) | Must invalidate animation-panel texture object-URLs; shell coordinates a resource re-read after `onOverwriteOriginal`. |

---

## 6. Phased plan (files per phase)

### Phase 1 — rename + double-click (small PR, ship first)

1. `git mv src/ui/asset-generator src/ui/sprite-editor`; rename files/class/tag/css selectors; title
   string; `EMPTY_RESOURCE_ID`.
2. `src/state/AppState.ts` — union member rename.
3. `src/core/LayoutManager.ts` — :27/:48/:67/:382/:655/:841 + retitle flipbook tab "Sprite Animation" (§1.5).
4. `src/services/EditorTabService.ts` — :106/:117/:257–275/:371 (+ legacy filter string).
5. `git mv src/features/editor/OpenAssetGeneratorCommand.ts …/OpenSpriteEditorCommand.ts`; metadata; keywords keep old terms.
6. `src/ui/pix3-editor-shell.ts` — import/registration.
7. `src/services/AssetFileActivationService.ts` — image branch → `focusOrOpenSpriteEditor`; extension-set fix; expose `createSpriteFromImage` helper; prune dead imports. Update `AssetFileActivationService.spec.ts`.
8. `src/ui/assets-preview/assets-preview-panel.ts` — menu rename + "Add to Scene as Sprite2D"; spec.
9. `src/services/agent/AgentToolRegistry.ts` :1890 string; comment sweep (§1.3 last bullet).
10. Optional nicety: `isDirty` wiring for unsaved raster edits.
11. Docs: `docs/pix3-specification.md`; `.claude/skills/generate-sprites-in-editor` label/selector updates.

### Phase 2 — shared slicing + animation linkage

1. `src/services/image-gen/image-ops.ts` — add `sliceImageBlob` (+ move canvas helpers); animation panel delegates (`animation-panel.ts` :1977–2057 shrinks to naming+writing).
2. `src/services/AnimationAutoSliceDialogService.ts` — `clipName` → `contextLabel` (+ its dialog component copy).
3. `src/ui/sprite-editor/sprite-editor-panel.ts` — "Slice…" toolbar action + destination handling.
4. `src/features/scene/CreateAnimationAssetOperation.ts` — optional `texturePath` param.
5. `src/ui/sprite-editor/sprite-editor-panel.ts` — "Create Animation…" button → command + `focusOrOpenAnimation` (auto-slice prompt fires from existing animation-panel logic).
6. Specs for `sliceImageBlob`; `docs/pix3-specification.md` + `docs/nodes-and-systems.md` if slicing is agent-visible.

### Phase 3 (optional, gated on Phase-2 experience) — Construct-3 shell merge

1. NEW `src/ui/sprite-editor/sprite-editor-tab.ts` + `.ts.css` — shell, mode tabs (IconService `image`/`film`), mode routing per §3.2.
2. Rename `sprite-editor-panel.ts` → `sprite-image-view.ts`; strip its toolbar title row.
3. `src/core/LayoutManager.ts` — point BOTH `animation` and `spriteEditor` tags at `pix3-sprite-editor-tab`; lazy-import path.
4. Cross-mode: "Edit frame image" in Animation mode; texture invalidation after overwrite; "Create animation…" rebinds in place.
5. `src/ui/shared/stage-zoom-pan.ts` extraction + adoption; optional `flipbook-preview.ts`.
6. Preserve `AnimationInspectorController` registration (`AnimationEditorService`) — the shell must forward it or keep `animation-panel` as the registering component (recommended: the latter; the panel keeps its lifecycle, only its host changes).
7. ANCHOR_PRESETS glyph → IconService cleanup.
8. Docs: spec update; `docs/architecture.md` only if the editor-tab diagram names panels.

---

## 7. Top open decisions (recommendation first)

1. **Internal tab-type id** — *migrate to `'sprite-editor'`*; zero persisted-data exposure
   (asset-generator tabs never persist; GL layout isn't persisted). Alternative (keep id, rename
   strings only) is acceptable but leaves a permanent naming lie for no gain.
2. **Merge strategy** — *linked-separate now (Phase 2), shell merge as designed Phase 3*; never a
   single-component fusion. Trigger for Phase 3: frame-art iteration in real projects still feels
   two-tab-clunky after Phase 2.
3. **Phase 3 tab types** — *keep two types (`animation` + `sprite-editor`) rendering one shell tag*;
   avoids all session/persistence migration. Alternative (single type) forces persistence-filtering by
   resourceId and a session migration for saved `animation` tabs — cost without benefit.
4. **Directory/tag rename now vs later** — *now* (Phase 1); mechanical, tag names are not persisted
   anywhere, and postponing means renaming twice (Phase 3 re-shuffles the directory anyway).
5. **Double-click rule** — *always open editor, never create nodes*; old behavior preserved behind an
   explicit context-menu item. No "smart" per-context exceptions.
6. **Slicing home** — *pure function in `image-gen/image-ops.ts`* (agent tools get it for free), file
   naming/writing stays per-caller. Alternative (new `SpriteSheetSlicerService`) adds a DI service for
   what is a pure function — rejected per existing image-ops precedent.
7. **`SUPPORTED_IMAGE_EXTENSIONS` bug** — fix in Phase 1 (`webm`/`aif` → real image extensions,
   aligned with animation panel's set, shared constant in `src/ui/shared/`).

---

## 8. Revision 2026-08-02 — Construct-3-grade unified UX (full product target)

Product goal restated: editing sprites (static AND animated) must feel like Construct 3's sprite
editor — double-click the object, edit in one place, never think about texture files — while keeping
Pix3's extra layer (AI generation) and its file-based reality (textures are ordinary project files,
`.pix3anim` is a separate meta document).

### 8.0 Resolving the core contradiction: convention + presentation, not ownership

Construct 3 hides files because the object *owns* its rasters. Pix3 must not adopt ownership (files
are the interop story: git, external editors, agent tools, atlas, export pruning). Instead the
"files disappear" feeling is produced by three cooperating layers:

1. **A managed folder convention** (§8.2): every animated sprite lives in one folder; the editor
   creates/names files there so the user never picks paths in the happy flow.
2. **Navigator grouping** (§8.5): a managed folder renders as ONE item in the Asset Browser, like a
   single sprite object. Files are still reachable (expand), never load-bearing for the UX.
3. **The unified editor** (§8.3): one tab, one canvas, clips + timeline visible only when the bound
   resource is animated. All raster edits and generation happen against "the current frame", and the
   editor does the file writes.

Files stay the source of truth; unmanaged/hand-placed layouts keep working (a `.pix3anim` may
reference any path — such resources simply don't collapse in the navigator and skip
convention-dependent bulk tools). This is the same hybrid Godot/Unity strike zone the engine already
uses elsewhere.

### 8.1 Entry points — double-click the node opens the Sprite Editor

Target: dblclick a `Sprite2D`/`AnimatedSprite2D` anywhere → the unified editor opens bound to that
node's texture (Sprite2D) or `animationResourcePath` (AnimatedSprite2D).

- **Viewport.** Double-click currently drills selection scope (Figma model,
  `SelectionScopeResolver.resolveDoubleClick`, `src/features/selection/SelectionScopeResolver.ts`
  :142, dispatched from `src/ui/viewport/editor-tab.ts` :1256/:1321). Rule that keeps both:
  *double-click drills while there is somewhere to drill; double-clicking a node that is already the
  direct selection and has no drillable children opens its editor* — exactly Figma's
  "double-click again to enter vector-edit mode". Implementation: when `resolveDoubleClick` returns
  a no-op resolution (hit node already directly selected), dispatch
  `OpenSpriteEditorForNodeCommand`. Applies only to Sprite2D/AnimatedSprite2D (later: TileMap etc.).
- **Scene tree.** Precedent exists: dblclick on a prefab node opens the prefab tab
  (`scene-tree-node.ts` :540–549 `node-open-prefab`). Add the same for sprite nodes →
  `node-open-sprite-editor` event → shell dispatches the command. Prefab check keeps precedence.
- **Inspector.** Already there (animation asset property dblclick → editor,
  `property-editors.ts` :1638). Add the same affordance on Sprite2D's texture property → Sprite
  Editor (today it opens nothing).
- **Asset Browser.** Already there (Phase 1): image dblclick → Sprite Editor; `.pix3anim` dblclick →
  animation editor (post-§8.3: the same unified editor in animation mode).
- New command `editor.open-sprite-editor-for-node` (`src/features/editor/`): resolves the node's
  bound resource; `AnimatedSprite2D` without a resource → run the existing
  `CreateAndBindAnimationAssetCommand` flow (inspector already does this); `Sprite2D` with no
  texture → open empty editor with the node remembered for "Insert/Apply".

### 8.2 File-layout convention (managed sprite folder)

Decision needed by the user; **recommended: folder-per-sprite, clip-prefixed frames** —

```
sprites/character/character.pix3anim     ← one resource, ALL clips of this sprite
sprites/character/idle_0001.png
sprites/character/idle_0002.png
sprites/character/run_0001.png
```

Rationale against the alternatives:

- `sprites/character/idle/0001.png` (folder-per-clip) does not match the data model — ONE
  `.pix3anim` holds many clips, so per-clip folders orphan the meta file and break the "one folder =
  one sprite item" grouping rule.
- `sprites/character_idle_0001.png` (flat + name mangling) makes navigator grouping heuristic
  (prefix parsing) instead of structural (folder), and scales badly past ~3 sprites per folder.
- Current `frame_0001.png` naming (`buildAnimationFrameResourcePath`,
  `src/features/scene/animation-asset-utils.ts` :46) **collides across clips** — two clips sliced in
  the same folder overwrite each other. Fix regardless of the rest: signature gains a `clipName`
  → `<clip>_<nnnn>.png` (existing files keep working — paths are stored in the `.pix3anim`, the
  builder only names NEW files).

"Managed" predicate (used by grouping + bulk tools): a folder containing exactly one `.pix3anim`
whose frame texturePaths all resolve inside that folder. Pure function next to
`animation-asset-utils.ts`; no registry, no meta flags.

Import flows that must land files by convention:

- OS-file drop into the editor canvas/timeline (§8.4) → copy into the sprite's folder as next
  `<clip>_<nnnn>.png` (reuse write pipeline of `pix3-asset-import-dialog.ts` :246/:418).
- Generation "Apply to frame" (§8.6) → same naming, overwrite-in-place when replacing an existing
  frame's file (only if that file is inside the managed folder AND referenced by exactly one frame —
  else write a new file; shared-frame aliasing must never silently mutate siblings).
- Project-asset drops from outside the managed folder do NOT copy — the frame references the
  original path (cheap, non-destructive; the folder simply becomes unmanaged if the user cares).
  Offer "Copy into sprite folder" as a context action on such frames later.

### 8.3 Unified editor layout (overrides §3.2's mode-tab design; keeps its architecture decisions)

```
┌ toolbar: select | crop | rotate/flip | anchor | polygon | generate | bg-remove | save ─┐
│ clips rail   │                                                                         │
│ (anim only)  │                     canvas / stage                                      │
│ + add/del/   │       (image + overlay layers; zoom/pan)                                │
│   rename     │                                                                         │
├─ timeline (anim only): frame thumbs, drag-reorder, fps/loop/ping-pong, play preview ───┤
```

- Static image bound → canvas only; a "Create animation" affordance sits where the clips rail would
  be (runs the §4.2 flow, rebinding the same tab).
- `.pix3anim` bound → clips rail + timeline appear; **selecting a frame binds the canvas to that
  frame's texture**; raster tools then edit that file (write-back = existing Overwrite pipeline +
  texture-URL invalidation, §5 last row).
- What §3.2 got right and survives: shell component; TWO tab types (`animation` +
  `sprite-editor`) pointing at one shell tag (zero session migration); two documents with separate
  undo/dirty regimes; `AnimationInspectorController` registration stays on the animation logic.
- What changes vs §3.2: the flipbook editor's **stage dies**. Hosting two intact panels can't
  produce one-canvas UX. Honest decomposition of `animation-panel.ts` (~2 400 lines):
  1. **Document controller** (clip/frame CRUD via `UpdateAnimationDocumentOperation`, resource
     sync `syncFromDocumentState` :1413) → plain class `animation-document-controller.ts`.
  2. **Frame timeline** (strip markup :586+, reorder DnD :2287–2347, preview ticker :799–867) →
     `<pix3-sprite-timeline>` component.
  3. **Clips rail** (clip list + CRUD) → `<pix3-sprite-clips-rail>` component.
  4. **Stage overlays** (anchor/bbox/collision-polygon editing, `AnimationEditMode`) → ported onto
     the sprite-editor canvas as overlay layers next to the existing crop overlay. This is the
     riskiest chunk — the two stages use different coordinate models (letterboxed object-fit vs
     zoom-to-cursor); unify on the §4.3 `StageZoomPanController` FIRST, then port overlays.
  5. The old `<pix3-animation-panel>` remains temporarily as the render host wired to the same
     controller, and is deleted once the shell reaches parity (auto-slice prompt, spritesheet
     UV-window frames `offset`/`repeat`, per-frame events).
- Anchor tool scoping: per-frame anchor is a `.pix3anim` concept. For a static Sprite2D the anchor
  tool edits the NODE's anchor property (via `UpdateObjectPropertyOperation`) when the editor was
  opened from a node, and is hidden when opened from a bare file. Collision polygon: anim-frames
  only (static Sprite2D has no polygon property today — out of scope).

### 8.4 Drag & drop matrix (target behavior)

| Source ↓ / Target → | Canvas | Timeline (between frames / on a frame) |
| --- | --- | --- |
| Asset Browser / Library (project asset) | Replace current frame's texture ref (static: rebind image) | Insert frame at gap / replace frame's texture ref — **already works** (`animation-panel.ts` :1366–1399, frame targets :586–594); port to the new timeline component |
| OS file | Import by convention (§8.2) → replace current frame / rebind | Import by convention → insert/replace |
| Generation history entry | Enter place-mode (§8.6) on current frame | Insert as new frame at drop position (place-mode if size mismatch) |

OS-drop plumbing: `getAsFile()` handling exists in the sprite editor (:1092) and the import dialog —
the timeline component reuses the same normalize→copy→reference chain.

### 8.5 Navigator grouping (Asset Browser)

A managed sprite folder (§8.2 predicate) renders in `assets-content.ts` / `asset-tree.ts` as a
single item: film icon (IconService), sprite name, frame-count badge; dblclick → unified editor on
the `.pix3anim`; drag = drag of the `.pix3anim` (existing drop sites for `.pix3anim` keep working —
inspector binding, scene drop creating AnimatedSprite2D). Expand affordance (chevron / "Show
files" context item) reveals the raw files. Reuse the virtual-node machinery from the by-type
category grouping (`src/core/asset-categories.ts` precedent, `category:<id>` nodes) — this is a
second producer of virtual nodes, so hoist whatever is category-specific. Move/rename of the folder
item moves the folder (ProjectService already remaps references on move). Gate: compute the managed
predicate lazily per visible folder (it reads one `.pix3anim`), cache by folder mtime.

### 8.6 Generation-into-frame ("place mode") + history paste

Today generation replaces the whole canvas image. New per-frame flow when a generated/pasted image's
size ≠ current frame size — an iOS-photo-crop-style **place mode** on the canvas:

- incoming image rendered over the frame rect with drag/scale (wheel + corner handles) transform;
- quick actions: **Fit** (contain), **Fill** (cover), **Resize frame to image** (canvas grows; for
  anim frames this just means the new file is bigger — per-frame display sizing arrives with the
  runtime `native` size mode, §8.8);
- **Apply** = destructive bake: composite to a frame-sized PNG → write by convention (§8.2) →
  frame references it. Non-destructive UV placement via the existing `offset`/`repeat` frame fields
  is possible but rejected for v1: it complicates every downstream consumer (atlas, export, editor
  proxies) for a transform the user thinks of as "committed".
- Paste from history: the generation-history rail (GenerationHistoryService) gets "Apply to current
  frame" and drag-to-timeline (§8.4). Style-reference workflow (existing) is unaffected.

### 8.7 Power tools (backlog, post-Phase 5 — each is a toolbar action + dialog service)

- **Auto collision polygon**: alpha channel (or bg-removal ISNet mask for opaque images) → marching
  squares contour → Douglas-Peucker simplify → `collisionPolygon`. Synergy: BackgroundRemovalService
  already produces the mask.
- **Chroma key**: color-pick + tolerance → alpha; pure function in `image-ops.ts`, bulk-applicable.
- **Video import**: `<video>` + canvas frame extraction (fps picker, in-range trim) → frames by
  convention. Browser-only, no ffmpeg.
- **Bulk frame ops**: delete even/odd, apply raster op to all frames of a clip (map `image-ops`
  functions over frame files; managed-folder-only).

### 8.8 Per-frame anchor — close the runtime gap (confirmed direction 2026-08-02)

**Finding:** `AnimationFrame.anchor` exists in the schema
(`packages/pix3-runtime/src/core/AnimationResource.ts` :35, default 0.5/0.5) and is editable in the
animation panel, but **the runtime never applies it** — `AnimatedSprite2D.refreshTexturePresentation`
(`packages/pix3-runtime/src/nodes/2D/AnimatedSprite2D.ts` :408) only swaps texture/UV; the mesh is
always a centered `width×height` quad (:106–108), and the node has no anchor property at all
(`Sprite2D` does: mesh-position offset, `Sprite2D.ts` :219–223). Every frame is also stretched to
the node's width/height, so tightly-cropped frames of differing sizes cannot align today.

**Semantics (the explosion use case):** the frame anchor is the frame's own origin — the point in
the (possibly cropped) raster that must land on the node's position every frame. Cropping a frame
tighter then moving its anchor to the explosion's center keeps the animation visually identical
while the PNGs (and later the atlas) shrink. Node-level anchor stays a separate, global offset
(same meaning as `Sprite2D.anchor`); the two compose.

Runtime work (all mirrored by the editor viewport proxy — the editor draws SEPARATE proxy meshes,
so `Viewport2DProxyRegistry`/`ViewportRenderService` must apply identical math):

1. `AnimatedSprite2D` gains `anchor` (node-level, same prop/schema/mesh-offset pattern as
   `Sprite2D` :219–227) — orthogonal to the per-frame anchor, applied additively.
2. **`sizeMode: 'stretch' | 'native'`** node property, default `'stretch'` (= today, full
   back-compat for existing content):
   - `stretch`: frame fills `width×height`; per-frame anchor offsets the quad within the node —
     `mesh.position += ((0.5 − frameAnchor.x)·width, (0.5 − frameAnchor.y)·height)`.
   - `native`: each frame renders at `sourceSize × clipScale`, anchor-aligned;
     `clipScale = node.width ÷ sourceSize.width` of the clip's first frame (so resizing the node
     scales the whole animation uniformly and mixed-size frames keep their relative proportions).
3. **`sourceSize` per frame** (px, optional in the schema; `normalizeFrame` materializes from
   boundingBox-or-zero): stamped by the editor whenever a frame is added/replaced/cropped, so
   layout never waits on texture loads (a `0×0` sourceSize falls back to stretch for that frame —
   legacy files keep working).
4. Yalc-publish + DeepCore sanity check; `docs/node-types-reference.md` + spec update.

**Auto-crop synergy (add to §8.7 backlog):** "Trim frames" bulk tool — detect transparent margins
across a clip, crop each PNG, recompute each frame's anchor so the on-screen result is pixel-
identical, stamp new sourceSizes. This is what makes the atlas-packing win real with one click.

### 8.9 Named frame points ("image points", Construct-3 idea + rotation)

Per-frame named points that live in frame space and move (and rotate) across frames — muzzle-flash
spawn on a barrel, a hand socket that an item follows during a walk cycle.

- **Schema** (additive, no version bump):
  `AnimationFrame.points?: { name: string; x: number; y: number; angle?: number }[]` — coords
  normalized to the frame rect (same convention as `anchor`; the UI displays px), `angle` in
  degrees, default 0. Going past Construct 3: the angle makes a point a full 2D socket (muzzle
  *direction*, hand *orientation*), not just a position. `normalizeFrame` materializes `[]`,
  dedupes names within a frame.
- **Runtime API** (`AnimatedSprite2D`):
  - `getFramePoint(name, frameIndex?)` → `{ x, y, angle } | null` in **node-local space** —
    composed through the same presentation math as §8.8 (sizeMode, clipScale, frame anchor,
    node anchor), so the returned point is directly usable as a child-node position;
  - `getFramePointWorld(name)` → world-space position + accumulated angle;
  - frame events (§`AnimationFrameEvent`, already shipped) compose naturally: an `emit`-ing frame
    fires `muzzle-flash`, the handler reads `getFramePoint('muzzle')` — no new event plumbing.
- **`core:PointAttachment` script component** (the "item in hand" case): attaches the host node to
  a named point of its parent `AnimatedSprite2D` every tick — properties `point: string`,
  `applyRotation: boolean`, `offset: Vector2`. Ships after the runtime API; registered like other
  `core:` scripts.
- **Editor (unified-canvas tool, Phase 3 overlay family):** points list per clip (union of frame
  point names; adding a point inserts it into every frame of the clip at the same normalized spot);
  drag per frame; small direction-arrow handle for angle; ghost of the previous frame's points
  (mini onion-skin) for continuity while animating; "copy to next frame / all frames" context
  actions. Rendered as one more overlay layer next to anchor/bbox/polygon.

### 8.10 Revised phasing (supersedes §6 for Phases ≥ 3)

- **Phase 2 — unchanged from §6 plus two riders** *(small, do first)*: `sliceImageBlob` extraction,
  auto-slice dialog generalization, "Slice…" + "Create Animation…" in the sprite editor; **rider A**:
  `buildAnimationFrameResourcePath` gains `clipName` (kills the cross-clip collision now); **rider
  B**: OS-file drop on the (still separate) animation panel via the §8.2 import path — immediate UX
  win, survives Phase 3 intact.
- **Phase 3 — unified shell** *(the big one; internally staged)*:
  3a. `StageZoomPanController` extraction + adoption by the image canvas (prereq for overlay port).
  3b. Decompose animation panel per §8.3 (controller / timeline / clips rail), old panel still the host.
  3c. Shell tab: canvas + rails composition, frame→canvas binding, overwrite→invalidate loop, both
      tab types → shell tag. Old animation panel deleted at parity.
  3d. Entry points (§8.1): viewport drill-terminal dblclick, scene-tree dblclick, inspector texture
      dblclick, `OpenSpriteEditorForNodeCommand`.
- **Phase 4 — navigator grouping** (§8.5). Independent of Phase 3; can run in parallel after Phase 2.
- **Phase 5 — place mode + history-to-frame** (§8.6). Needs 3a–3c.
- **Phase 6 — power tools** (§8.7 + "Trim frames" from §8.8), pulled by real usage, order flexible.
- **Runtime track** (in `packages/pix3-runtime`, parallel to the editor phases; each step ends with
  `yalc:publish` + DeepCore check):
  - **R1 — frame presentation** (§8.8): node `anchor`, `sizeMode`, per-frame `sourceSize`, apply
    per-frame anchor in `refreshTexturePresentation`/mesh transform; editor proxy parity in
    `Viewport2DProxyRegistry`/`ViewportRenderService`. Do alongside Phase 3a–3b — the unified
    canvas's anchor tool must preview against the REAL semantics, not the ignored field.
  - **R2 — named points** (§8.9): schema + normalizer + `getFramePoint`/`getFramePointWorld` +
    `core:PointAttachment`. Before the points overlay tool lands (Phase 3d/5 window).

### 8.11 Decisions (user-confirmed status 2026-08-02)

1. ✅ **File convention** — folder-per-sprite + `<clip>_<nnnn>.png` (§8.2). Confirmed 2026-08-02;
   document as the project convention (spec + `pix3-game-dev` skill).
2. ✅ **Viewport dblclick overload** — drill-until-leaf-then-open (§8.1). Confirmed 2026-08-02.
3. ✅ **Frame anchor semantics** — per-frame anchor = frame's own origin (crop-friendly, §8.8);
   node anchor = global offset, composes on top; named points get position + angle (§8.9).
   Confirmed 2026-08-02 (user supplied the semantics).
4. **Place-mode bake** — destructive bake v1, UV placement rejected (§8.6).
5. **Static-sprite anchor tool** — edits the node property when node-bound, hidden otherwise (§8.3).
6. **Grouping default** — managed folders collapse by default with a global toggle in the Assets
   panel header (mirrors the existing folders/by-type toggle).
7. **`sizeMode` default** — `'stretch'` for back-compat; the editor sets `'native'` on newly
   created AnimatedSprite2D nodes (recommended — new content gets the good semantics, old scenes
   render unchanged).
8. **Point coordinate space** — stored normalized to the frame rect (consistent with `anchor`),
   displayed in px in the UI (Construct-3 habit). Crop/resize tools recompute both anchor and
   points, so either storage works; normalized keeps the schema uniform.
