Status: approved by user on 2026-04-29 for implementation handoff.


## Plan: Animation Editor UI Rework

Refactor the existing animation editor into a 4-zone workflow: clip list on the left, interactive frame stage in the center, inspector-style properties on the right, and timeline/playback controls at the bottom. Keep all changes inside Pix3 editor scope, but extend the `.pix3anim` schema so the editor can persist clip playback mode plus per-frame timing and geometry metadata. Reuse the existing panel/dialog/inspector interaction patterns, but do not force the animation asset UI through the node PropertySchema pipeline because that system is centered on scene nodes/scripts rather than standalone asset documents.

**Steps**
1. Phase 1, document model and persistence foundation. Extend the animation schema in `packages/pix3-runtime` with backward-compatible defaults for clip playback mode and per-frame metadata: duration multiplier, anchor, optional source texture override, bounding box, and collision polygon. Update normalization and default-resource creation so old `.pix3anim` files still load cleanly and new fields always serialize with predictable defaults. This blocks all UI work because the editor needs a stable shape to read/write.
2. Phase 1, persistence wiring. Keep mutations flowing through `UpdateAnimationDocumentOperation`, but adjust the editor-side update helpers to write the new clip/frame fields atomically. No new mutation architecture is needed; the existing resource-updater pattern is the correct seam.
3. Phase 2, panel layout refactor. Rework the current animation editor component into a structured shell using the existing panel styling conventions: left clip rail, center preview stage, right inspector pane, bottom timeline. Add local editor-only UI state for selected frame index, preview playback state, edit mode (`anchor`, `polygon`, `bbox`), zoom, and current preview frame cursor. This depends on Phase 1.
4. Phase 2, inspector-style properties pane. Replace the current inline clip settings block with an inspector-inspired side panel that shows clip properties and, when a frame is selected, frame properties. Clip section: FPS, loop, playback mode (`normal` or `ping-pong`). Frame section: duration multiplier, anchor X/Y, texture path override/reference, bounding box numbers, polygon summary/actions. Reuse inspector field styling and interaction discipline, but implement this as asset-document editing rather than PropertySchema-backed node editing.
5. Phase 2, clip list workflow. Expand the left rail into a fuller clip manager with add, rename, select, and delete. Deletion should use `DialogService.showConfirmation()` and preserve a valid fallback selection after removal. This can be implemented in parallel with the inspector pane once the new editor state exists.
6. Phase 3, interactive frame stage. Add a central preview surface that renders the currently selected frame using the animation texture coordinates, with overlays for anchor point, collision polygon, and bounding box. Add explicit edit-mode toggles so pointer interaction is unambiguous: drag anchor point in `anchor` mode, drag bbox handles in `bbox` mode, and add/move/remove polygon vertices in `polygon` mode. Add zoom in, zoom out, and reset zoom controls, with the overlay and pointer math operating in image-local coordinates.
7. Phase 3, timeline and playback. Replace the current static frame strip with a real timeline that supports current-frame selection, visible active state, scrubbing, and editor playback. Playback should remain editor-local and must honor clip loop + playback mode. Frame duration should use the agreed formula: `frameDuration = (1 / clip.fps) * frame.durationMultiplier`. This depends on the selected-frame state from Phase 2 and can share the same preview cursor used by the center stage.
8. Phase 4, save/reload and polish. Verify all new metadata survives save, close, and reopen flows. Tighten empty states, disabled states, and fallback behavior when there is no clip, no frame, or no texture. Preserve current undo/redo behavior by ensuring every property mutation still goes through the existing operation path.
9. Phase 4, targeted tests and manual QA. Add focused tests for schema normalization and document updates, then run editor-level verification for clip CRUD, frame selection, geometry editing, zoom, and playback.

**Relevant files**
- `c:\Projects\pix3-stuff\pix3\src\ui\animation-editor\animation-panel.ts` — main implementation surface; refactor layout, local editor state, playback, selection, and direct editing handlers.
- `c:\Projects\pix3-stuff\pix3\src\ui\animation-editor\animation-panel.ts.css` — convert current flat layout into left/center/right/bottom composition and add overlay/timeline styling.
- `c:\Projects\pix3-stuff\pix3\packages\pix3-runtime\src\core\AnimationResource.ts` — extend `AnimationClip` and `AnimationFrame` types plus normalization defaults for backward-compatible schema evolution.
- `c:\Projects\pix3-stuff\pix3\src\features\scene\animation-asset-utils.ts` — ensure default resource creation and serialization preserve the new fields.
- `c:\Projects\pix3-stuff\pix3\src\features\properties\UpdateAnimationDocumentOperation.ts` — reuse existing update path; verify no assumptions break with richer frame/clip payloads.
- `c:\Projects\pix3-stuff\pix3\src\ui\object-inspector\inspector-panel.ts` — reference for inspector interaction and styling patterns to reuse, not necessarily to modify.
- `c:\Projects\pix3-stuff\pix3\src\ui\shared\pix3-panel.ts` — reference shell for panel framing if the animation editor is wrapped in the standard panel container.
- `c:\Projects\pix3-stuff\pix3\src\services\DialogService.ts` — reuse `showConfirmation()` for clip deletion confirmation.
- `c:\Projects\pix3-stuff\pix3\src\ui\shared\pix3-confirm-dialog.ts` — existing dangerous-action dialog component used indirectly through `DialogService`.

**Verification**
1. Add/adjust focused tests for `normalizeAnimationResource()` to cover old documents without new fields, new documents with full metadata, and round-trip persistence of clip mode plus per-frame timing/geometry.
2. Add a focused document-update test covering mutation of clip mode, frame duration multiplier, anchor, bbox, and polygon through the animation document update path.
3. Run `npm run lint` in `c:\Projects\pix3-stuff\pix3`.
4. Run `npm run test` in `c:\Projects\pix3-stuff\pix3`.
5. Manual QA in the editor: open a `.pix3anim`, add/remove/rename clips, select frames in timeline, edit anchor, bbox, and polygon on the stage, switch edit modes, zoom in/out/reset, play normal and ping-pong clips, save, reopen, and confirm the data persists.

**Decisions**
- Included: Pix3 editor UI rework, `.pix3anim` schema expansion for editor-owned metadata, clip playback mode as part of asset format, and per-frame geometry/timing data.
- Excluded: runtime consumption of the new metadata, DeepCore changes, onion skinning, frame reordering, and event trigger authoring.
- Geometry granularity is per frame.
- Collision shape is an arbitrary polygon with editable vertices.
- Frame timing uses the mixed model `duration = (1 / clip fps) * durationMultiplier`.

**Further Considerations**
1. Recommended implementation detail: keep the preview stage DOM/SVG-based instead of routing through the full scene viewport service, because this editor is operating on UV-cropped image data rather than live scene nodes.
2. If the interaction code in `animation-panel.ts` becomes too large during implementation, split the center stage and timeline into local subcomponents, but keep mutation ownership in the panel container so undo/redo remains centralized.
3. If texture override is meant only as a read-only reference to the source sheet, keep it display-first in the first pass and avoid introducing multi-texture clip playback semantics unless a later requirement needs it.