# Layout2D Node Implementation Plan

## New Phase Plan (2026-03-03): Project Base Viewport + 2D Placement Refactor

This section defines a new implementation phase for editor/runtime behavior updates.

### Goals

1. Add project-level base viewport size in Project Settings.
2. Persist base viewport size in `pix3project.yaml`.
3. Always render a base viewport frame in editor viewport (both navigation modes), but only when 2D layer rendering is enabled.
4. Remove auto-creation of `Layout2D`/root 2D container when creating 2D nodes.
5. Improve 2D object frame readability (crisper, higher-contrast outlines).

### Final UX Requirements

- Base viewport size is edited in Project Settings (`General` tab).
- Base viewport size is loaded/saved from project manifest (`pix3project.yaml`).
- In editor viewport:
  - Base viewport frame is shown in both `2d` and `3d` navigation modes.
  - Base viewport frame is hidden only when `appState.ui.showLayer2D === false`.
- Creating 2D nodes:
  - If currently selected node is a compatible 2D container -> create inside it.
  - Otherwise -> create at scene root.
  - Scene root may contain any number of mixed node types (2D/3D) without auto-generated container.
- 2D object outlines are visibly sharper and easier to read.

---

## Phase 1 - Project Manifest Data Model

**Status:** ✅ Completed (2026-03-04)

### Scope

Introduce project-level viewport base size in manifest schema and defaults.

### Files

- `src/core/ProjectManifest.ts`
- `src/services/ProjectService.ts`

### Changes

1. Extend `ProjectManifest` with:

```ts
viewportBaseSize: {
  width: number;
  height: number;
}
```

2. Add safe defaults in `createDefaultProjectManifest()`:
   - `width: 1920`
   - `height: 1080`

3. Update `normalizeProjectManifest(input)`:
   - Parse and validate both values.
   - Coerce invalid/missing values to defaults.
   - Clamp to sane minimum (recommended: `>= 64`) to avoid camera/projection edge cases.

4. Ensure `ProjectService.saveProjectManifest()` includes `viewportBaseSize` in YAML payload.

### Acceptance Criteria

- Opening old projects without `viewportBaseSize` still works and auto-populates defaults in memory.
- Saving any project writes `viewportBaseSize` to `pix3project.yaml`.

---

## Phase 2 - Project Settings UI + Operation Persistence

**Status:** ✅ Completed (2026-03-04)

### Scope

Expose base viewport size in settings dialog and persist through operation flow (with undo/redo).

### Files

- `src/ui/shared/pix3-project-settings-dialog.ts`
- `src/ui/shared/pix3-project-settings-dialog.ts.css`
- `src/features/project/UpdateProjectSettingsOperation.ts`

### Changes

1. In dialog state, add fields:
   - `baseViewportWidth`
   - `baseViewportHeight`

2. Initialize fields from `appState.project.manifest?.viewportBaseSize`.

3. Add numeric inputs in `General` tab:
   - `Base Viewport Width`
   - `Base Viewport Height`

4. Update `UpdateProjectSettingsOperation` params to include base viewport size.

5. In operation `perform()`:
   - Keep existing project metadata updates (`projectName`, `localAbsolutePath`).
   - Clone current manifest.
   - Apply viewport size changes.
   - Persist via `ProjectService.saveProjectManifest(nextManifest)`.
   - Update `state.project.manifest`.

6. In `undo`/`redo`:
   - Save previous/next manifest through `ProjectService` (not only in-memory mutation).
   - Keep behavior symmetric and deterministic.

### Acceptance Criteria

- Changing base viewport size in dialog updates manifest and file.
- Undo/redo restores both in-memory manifest and YAML contents.

---

## Phase 3 - Base Viewport Frame Rendering in Editor

**Status:** ✅ Completed (2026-03-04)

### Scope

Render a global base viewport frame independent of `Layout2D` node existence.

### Files

- `src/services/ViewportRenderService.ts`

### Changes

1. Add dedicated visual object/map member for base frame (single frame object is enough).

2. Create `createBaseViewportFrame()` helper:
   - Rect outline centered at origin.
   - Dimensions from manifest base size.
   - Add to 2D layer (`LAYER_2D`).
   - Configure material for high readability:
     - strong color contrast
     - `transparent: true`
     - high opacity
     - `depthTest = false`
     - `depthWrite = false`

3. Add `syncBaseViewportFrame()`:
   - Rebuild/update on project manifest change.
   - Re-apply visibility based on `showLayer2D`.
   - Keep visible regardless of navigation mode (`2d`/`3d`).

4. Ensure render path respects rule:
   - if `showLayer2D` is disabled, frame is not rendered.
   - if `showLayer2D` is enabled, frame is rendered in both modes.

5. Keep existing `Layout2D.showViewportOutline` behavior for Layout2D node borders as a separate visual concern.

### Acceptance Criteria

- Base viewport frame is visible in both navigation modes.
- Toggling 2D layer visibility hides/shows frame immediately.
- Frame updates immediately after changing Project Settings base size.

---

## Phase 4 - 2D Camera Scaling Refactor to Base Viewport

**Status:** ✅ Completed (2026-03-04)

### Scope

Use project base viewport size as camera space baseline for 2D editing.

### Files

- `src/services/ViewportRenderService.ts`

### Changes

1. Replace orthographic frustum sizing logic based on physical pixels with base-size-driven logic.

2. In `resize(width, height)`:
   - Keep renderer pixel sizing as is.
   - For orthographic camera bounds, derive from `viewportBaseSize` and host aspect ratio.
   - Preserve user zoom (`orthographicCamera.zoom`) across resize.

3. Keep pan/zoom tools behavior compatible with new unit space.

4. Ensure selection overlays and gizmos stay screen-stable after refactor.

### Acceptance Criteria

- Resizing editor panel/window does not redefine authored base-space dimensions.
- 2D composition remains stable against base frame.
- Existing 2D manipulation remains functional.

---

## Phase 5 - Remove Auto-Root2D/Layout2D Creation for 2D Nodes

**Status:** ✅ Completed (2026-03-04)

### Scope

Drop legacy placement behavior that creates a `Layout2D` container implicitly.

### Files

- `src/features/scene/node-placement.ts`
- All 2D create operations in `src/features/scene/Create*2DOperation.ts`
- `src/features/scene/CreateNodeBaseCommand.ts` (or per-command wrappers where needed)

### Changes

1. In `node-placement.ts`:
   - Remove `resolveDefault2DParent()` auto-creation behavior.
   - Remove `removeAutoCreatedLayoutIfUnused()` and `restoreAutoCreatedLayout()` helpers.
   - Add helper to resolve compatible selected parent:
     - selected node exists
     - selected node is container
     - selected node is 2D-compatible for 2D creation

2. Update all 2D create operations:
   - Remove `autoCreatedLayout` variables and related undo/redo handling.
   - Parent resolution order:
     1. explicit `parentNodeId` (if valid)
     2. selected compatible container
     3. root

3. Keep `SceneStateUpdater.selectNode(state, createdNodeId)` behavior unchanged for consistent created-node payload extraction.

4. Preserve insert index logic where already implemented (`CreateSprite2DOperation`) and normalize similar behavior across other 2D operations when feasible.

### Acceptance Criteria

- No create operation auto-adds `Layout2D`.
- 2D node creation works with/without selected container.
- Root-level creation works in mixed 2D/3D roots.
- Undo/redo remains clean and symmetric.

---

## Phase 6 - Improve 2D Outline Clarity

**Status:** ✅ Completed (2026-03-04)

### Scope

Make 2D node frames visually crisp and readable.

### Files

- `src/services/ViewportRenderService.ts`

### Changes

1. Material tuning for 2D frames (Layout2D/Group2D/UI/Sprite outlines where applicable):
   - stronger default opacity
   - consistent high-contrast palette
   - disable depth conflict (`depthTest=false`, `depthWrite=false`)

2. Pixel-snapping strategy for 2D visual roots:
   - in sync/update paths, align positions to pixel grid (or half-pixel where visually correct for line center).
   - avoid subpixel drift after transforms.

3. Ensure line visibility under zoom changes:
   - maintain minimum perceptual stroke visibility.
   - avoid disappearing/thinning artifacts at common zoom values.

4. Verify interaction overlays remain distinguishable from passive node outlines.

### Acceptance Criteria

- 2D outlines are clearly visible at default zoom.
- Outlines remain readable when zooming in/out.
- No severe shimmering in static scene.

---

## Phase 7 - Regression, Validation, and Test Coverage

**Status:** 🟡 In progress (build verification completed; focused tests pending)

### Scope

Protect new behavior with focused tests and manual validation checklist.

### Test Targets

1. Manifest normalization unit tests:
   - missing `viewportBaseSize`
   - invalid values
   - persisted values roundtrip

2. Operation tests:
   - `UpdateProjectSettingsOperation` updates manifest + undo/redo

3. 2D create operation tests:
   - selected compatible container -> child creation
   - no compatible selection -> root creation
   - no auto-layout node insertion

4. Manual validation matrix:
   - navigation mode `2d` + `3d`
   - `showLayer2D` on/off
   - viewport resize behavior
   - drag-drop image to tree and viewport
   - undo/redo for node creation and project settings

---

## Rollout Notes

- Backward compatibility: old manifests load with defaults.
- Existing scenes: no forced migration required for this phase.
- Docs update after implementation:
  - `docs/pix3-specification.md` (project manifest section and viewport behavior)
  - `docs/architecture.md` (brief note on base viewport frame + new 2D placement rule)

## Definition of Done

All phases are complete when:

1. Base viewport size is editable and persisted in `pix3project.yaml`.
2. Base frame is always visible in editor for both navigation modes, gated only by `showLayer2D`.
3. 2D node creation never auto-creates `Layout2D`.
4. 2D outlines are noticeably sharper/readable.
5. Undo/redo and tests confirm stable behavior.
