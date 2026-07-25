# Unified "Assets" Panel — Implementation Plan

Merge `pix3-asset-browser-panel` (tree) and `pix3-assets-preview-panel` (thumbnails) into one
Unity-style **Assets** panel: left folder-only navigator + right thumbnail/list content pane,
docked as a tab in the center-bottom stack next to Animation and Logs.

## Verified ground truth (differs from assumptions in the task brief)

- **Golden Layout state is NOT persisted.** `LayoutManagerService.initialize()` always calls
  `loadDefaultLayout()` with the hardcoded `DEFAULT_LAYOUT_CONFIG`; there is no
  `saveLayout`/`resolvedLayoutConfig`/localStorage code anywhere in `src/`. → **No layout
  migration is needed.** Removing the old component types is safe; only the default config,
  `PanelVisibilityState`, and registration maps change.
- Per-project asset-browser UI state IS persisted (localStorage) via
  `ProjectService.saveAssetBrowserState()/loadAssetBrowserState()`
  (`AssetBrowserPersistedState`: `expandedPaths`, `selectedPath`, `viewMode`,
  `groupedExpandedKeys`; loader gives legacy records defaults for new fields — safe to extend).
- External entry points that must keep working (all are `window` CustomEvents):
  - `assets-preview:reveal-path` — dispatched by `src/ui/object-inspector/inspector-panel.ts:375`
    (and today by the preview panel's own dir double-click).
  - `script-file-reveal-request` — dispatched by `src/ui/scene-tree/scene-tree-node.ts:535`.
  - `script-file-created` — dispatched by `src/services/ScriptCreatorService.ts:121` (and by the
    autoload-create flow itself).
- `AssetsPreviewService.syncFromAssetSelection(path, kind)` is the existing tree→grid seam;
  it already handles "file path → select parent folder + highlight file". Reuse unchanged.
- Content-pane CSS uses generic tokens (`--bg-2`, `--fg-0`, `--accent`, `--accent-soft`,
  `--accent-line`, `--radius-1/2`, `--danger`) — keep these; do NOT port the mockup's mint/oklch.
- Project display name: `appState.project.projectName: string | null` (AppState.ts:199).

## Architecture decision

New folder `src/ui/assets/` hosting one GL panel composed of two child components:

```
pix3-assets-panel  (src/ui/assets/assets-panel.ts + .ts.css)        ← GL component 'assets'
├─ .assets-split (CSS grid: [tree-pane] [splitter] [content-pane])
├─ Tree pane:
│  ├─ .tree-root-row  — selectable project-root row + "new folder" btn + group-by-type toggle
│  └─ <pix3-asset-tree>  (existing component, extended: folders-only, file-path fallback)
└─ Content pane:
   └─ <pix3-assets-content>  (src/ui/assets/assets-content.ts — extracted from
      assets-preview-panel.ts; grid/list body + new header: breadcrumbs, stats,
      view toggle, thumb-size slider, content toolbar)
```

Reuse vs rewrite:
- **Reuse `asset-tree.ts` in place** (`src/ui/assets-browser/`) with targeted edits — it carries
  the highest-risk logic (drag-drop, inline create/rename, external-change detection, grouped
  view, persistence). Moving the folder is deferred to the final cleanup phase (`git mv`
  `src/ui/assets-browser/*` → `src/ui/assets/`), purely mechanical.
- **Extract, don't rewrite, the preview grid**: `assets-content.ts` is `assets-preview-panel.ts`
  minus the `<pix3-panel>` wrapper, plus the new header and list view. All selection/audio/
  context-menu/drag logic moves verbatim.
- **Delete** `asset-browser-panel.ts` (+`.ts.css`) and `assets-preview-panel.ts` (+`.ts.css`)
  after their logic migrates into `assets-panel.ts` / `assets-content.ts`.

---

## File-by-file changes

### 1. NEW `src/ui/assets/assets-panel.ts` (+ `assets-panel.ts.css`) — `pix3-assets-panel`

Host component (extends `ComponentBase`, Light DOM, `IconService` icons, DI services).

- Renders `<pix3-panel actions-label="Assets actions" @asset-activate=...>` wrapping the split
  layout. No top `pix3-toolbar` (toolbar moves into the content header, Unity-style).
- **Split layout**: `.assets-split { display:grid; grid-template-columns: var(--assets-tree-width, 220px) 4px 1fr; }`
  with a pointer-driven splitter (`pointerdown` + `setPointerCapture` + `pointermove` updating
  the CSS var; min ~140px, max ~50%). No shared splitter component exists in the codebase —
  implement locally (~30 lines). Persist width (see §7).
- **Tree root row** (sticky above the tree scroller, VS Code Explorer style):
  - Label: `appState.project.projectName ?? 'Assets'`, folder icon via
    `iconService.getIcon('folder-solid', 16)`.
  - Click → "root selected": call `assetTreeRef.clearSelection()` (new API, §4) and
    `assetsPreviewService.syncFromAssetSelection('.', 'directory')`. Row shows `.selected`
    styling when `snapshot.selectedFolderPath === '.'` (subscribe to AssetsPreviewService).
  - Right-aligned inline actions: **new-folder button** (`icon="folder-plus"` — verify Feather
    name, else `plus` or register custom) calling `assetTreeRef.createFolder()`, and the
    **group-by-type toggle** (`icon="layers"`, `?toggled=`, same handler as today's
    `onToggleViewMode` → `assetTreeRef.setViewMode(...)`, synced from
    `appState.project.assetBrowserViewMode` subscription).
  - Root row is a **drop target** (move-to-root / external files / generated assets): forward
    `dragover/drop` to a new public `assetTreeRef.handleRootDrop(dataTransfer)` (§4) so the
    existing `onTreeDrop` logic is reused, not duplicated.
- **Migrated from `asset-browser-panel.ts`** (bodies copied nearly verbatim):
  `onCreateFolder`, `onCreateScene`, `onCreateAutoloadScript` (+ `promptForAutoloadSingleton`,
  `ensureScriptsDirectory`, `fileExists`, `generateAutoloadTemplate`), `onImportClick`,
  `onRenameClick`, `onDeleteClick`/`showDeleteConfirmation`/`performDelete`,
  `onOpenInIdeClick`, `onAssetActivate`, the `focusin → appState.editorContext.focusedArea='assets'`
  hook, and the three window-event listeners (`script-file-created`,
  `script-file-reveal-request`, `assets-preview:reveal-path`) — these now resolve **in-component**
  (tree + grid live together) but the window listeners stay because inspector-panel,
  scene-tree-node, and ScriptCreatorService still dispatch them.
- Listens for events from `<pix3-assets-content>` (§2): `folder-navigate` (breadcrumb click /
  dir double-click) → `void this.assetTreeRef.selectPath(path)` (for `'.'` → root-select flow);
  `content-rename-request` / `content-delete-request` → existing rename/delete flows.

### 2. NEW `src/ui/assets/assets-content.ts` (+ `.ts.css`) — `pix3-assets-content`

Extraction of `assets-preview-panel.ts` internals (subscription, `renderItem`, multi-select,
context menu via `DropdownPortal`, audio preview, `onItemDragStart`, generation drop overlay,
tooltip/format helpers) with these changes:

- Remove `<pix3-panel>` wrapper and `slot="subtitle"`; root is `.assets-content`.
- **Header row** (~28px, matches the design's breadcrumb mini-toolbar), containing left→right:
  1. **Breadcrumbs**: derived from `snapshot.selectedFolderPath` — root segment
     (`projectName ?? 'Assets'`) + one button per path segment, separated by
     `iconService.getIcon('chevron-right', IconSize.SMALL)`. Click →
     `this.dispatchEvent(new CustomEvent('folder-navigate', { detail: { path }, bubbles: true }))`
     (panel routes it to the tree so tree selection + expansion stays in sync).
  2. **Folder stats**: `"{count} items · {size}"` from new snapshot fields (§3). Dim text.
  3. **Content toolbar** (compact `pix3-toolbar dense variant="panel"` or plain icon buttons):
     Create dropdown (`pix3-dropdown-button`, same 3 items as today), Import, Rename, Delete,
     Open-in-IDE — the actions the old Asset Browser toolbar had. Rename/Delete operate on the
     grid selection when a grid item is selected, else the tree selection (panel decides;
     content emits `content-rename-request`/`content-delete-request` with the selected path).
  4. **Grid/list toggle**: two toggle buttons (`icon="grid"` — custom icon already registered;
     `icon="list"` Feather).
  5. **Thumbnail-size slider**: `<input type="range" min="56" max="160" step="8">`, hidden in
     list mode. Sets host CSS var: `this.style.setProperty('--assets-thumb-size', px)`.
- **Grid view** (existing, parameterized):
  `.assets-preview-grid { grid-template-columns: repeat(auto-fill, minmax(var(--assets-thumb-size, 104px), 1fr)); }`
  (`.thumb` keeps `aspect-ratio: 1/1`, drop the hardcoded `min-height: 88px/146px` so the
  slider actually scales items).
- **List view** (new): `.assets-list-row` — small thumb/icon (24px), name (flex-1), `W×H`
  (images), size, right-aligned; same click/dblclick/contextmenu/dragstart handlers as grid
  items (share a `renderItemInner`/handler set, two layout templates).
- Dir double-click: replace the `assets-preview:reveal-path` window dispatch with the same
  `folder-navigate` component event (bubbles to panel). The window event listener in the
  panel remains for the inspector.
- Extend the context menu: current image-only menu (Open in Sprite Editor / Add to Scene as
  Sprite2D) becomes a general menu — for all items add **Rename** and **Delete** entries
  (emit the request events above); keep the two sprite entries for images only.

### 3. `src/services/AssetsPreviewService.ts` — folder stats

- Extend `AssetsPreviewSnapshot` with `folderItemCount: number | null` and
  `folderSizeBytes: number | null` (recursive, "nested item count + size").
- After `loadFolder()` publishes items, kick an async `computeFolderStats(folderPath, requestVersion)`:
  recursive `projectService.listDirectory` walk (same exclusion rules: dot-entries,
  `node_modules`) summing `entry.size` and counting entries; guard with `requestVersion`,
  then `notify()`. This mirrors `AssetTree.getDirectoryContentSize` — put the shared walk in a
  small exported helper (e.g. `computeDirectoryStats(projectService, path)` in
  `src/services/asset-folder-stats.ts`) and have `AssetTree.getDirectoryContentSize` call it too.

### 4. `src/ui/assets-browser/asset-tree.ts` — folders-only + root support

- **Folders-only (folder mode)**: filter `entry.kind === 'file'` out at tree-build time — in
  `buildTreeFromExpandedPaths()` and `expandNode()` (skip file entries before
  `createNodeFromEntry`). Do NOT filter inside `listDirectory()` itself:
  `getDirectoryContentSize`, `walkProjectEntries` (grouped view + external-change signature),
  and `commitCreateFolder`'s existence check still need files.
- **Folders-only (by-type mode)**: add `includeFiles: boolean` to `BuildGroupedTreeOptions` in
  `grouped-asset-tree.ts`; when false, `trieToNodes()` returns only `dirNodes` (files stay in
  the trie so chain compaction, `sizeBytes`, and `fileCount` are unchanged). `loadGroupedRoot()`
  passes `includeFiles: false`.
- **`selectPath(targetPath)` file fallback** (critical for script reveal / import reveal /
  `script-file-created`): file nodes no longer exist in the tree. In `findAndSelectNode`, when
  the final segment can't be matched (or is known to be a file), select the **deepest matched
  directory** (expand chain as today), then call
  `assetsPreviewService.syncFromAssetSelection(targetPath, 'file')` — the service selects the
  parent folder in the grid and highlights the file. Return `true` when the parent directory
  chain resolved. Same fallback in `selectPathInGroupedTree`.
- **`revealAndOpen(targetPath)`**: after `selectPath`, the file has no tree node — build the
  `AssetActivation` directly from the path (`name` = last segment, `resourcePath` =
  `res://` + normalized, `extension` from name) and dispatch `asset-activate` as today.
- **New public APIs**: `clearSelection()` (sets `selectedPath = null`, saves state — used by
  the root row) and `handleRootDrop(dataTransfer)` (extracted body of `onTreeDrop`'s drop
  handling targeting `'.'`, so the panel's root row reuses move-to-root / external-file /
  generated-asset drops).
- **Accept grid-item drops** (files are dragged from the content pane now): in `onDrop`/
  `onTreeDrop`, prefer `ASSET_PATH_LIST_MIME` (JSON array set by the grid's `onItemDragStart`)
  over `text/plain`, and move **all** listed paths (single confirmation dialog:
  "Move N items…"). Import `ASSET_PATH_LIST_MIME` from `@/ui/shared/asset-drag-drop`.
  (Today `text/plain` holds `\n`-joined paths — moving only the first would silently drop the
  rest of a multi-selection.)
- `getSelectedPath()` semantics unchanged (now only ever a folder or null) — the panel's
  Rename/Delete route to the grid selection for files.
- `getTargetDirectory()` unchanged (selected folder, else root) — but Import/Create should
  prefer the **content pane's current folder** (`snapshot.selectedFolderPath`) when the grid
  has focus; simplest rule: panel passes `snapshot.selectedFolderPath ?? '.'` as
  `targetDirectory`, which equals the tree selection anyway since tree selection drives the
  grid. Keep tree method for create-flow node insertion.

### 5. DELETE after migration

- `src/ui/assets-browser/asset-browser-panel.ts` + `.ts.css`
- `src/ui/assets-preview/assets-preview-panel.ts` + `.ts.css` (folder removed; spec moves, §9)
- Final cleanup phase: `git mv src/ui/assets-browser/{asset-tree.ts,asset-tree.ts.css,asset-tree.spec.ts,grouped-asset-tree.ts,grouped-asset-tree.spec.ts} src/ui/assets/` and fix imports.

### 6. `src/core/LayoutManager.ts` — layout wiring

- `PANEL_COMPONENT_TYPES`: remove `assetBrowser: 'asset-browser'` and
  `assetsPreview: 'assets-preview'`; add `assets: 'assets'`.
- `PANEL_TAG_NAMES`: `[PANEL_COMPONENT_TYPES.assets]: 'pix3-assets-panel'`.
- `PANEL_DISPLAY_TITLES`: `assets: 'Assets'`.
- `DEFAULT_PANEL_VISIBILITY`: replace the two flags with `assets: true`.
- `DEFAULT_LAYOUT_CONFIG`:
  - Left column: remove the `assetBrowser` entry from the bottom stack (~line 130) — that stack
    now holds only `library` (keep the stack; height 50 unchanged).
  - Center-bottom stack (~line 164): insert `assets` as the FIRST component
    (`isClosable: false`), before `animationTimeline` and `logs` — the unified panel becomes
    the default-active tab of the LOGS/ANIMATION stack.
- `loadDefaultLayout()` visibility diff (~lines 846-856): replace the
  `assetBrowser`/`assetsPreview` comparisons with `assets`. (Consider replacing the hand-written
  field-by-field comparison with a keyed loop — optional.)
- `registerComponents()`: no per-type lazy import needed if registered eagerly (see §8);
  otherwise add `void import('@/ui/assets/assets-panel')` like `library` does.
- **No persisted-layout migration**: confirmed GL state is never saved; nothing else references
  the old component type ids.

### 7. State & persistence

- `src/state/AppState.ts`:
  - `PanelVisibilityState`: remove `assetBrowser` / `assetsPreview`, add `assets: boolean`;
    update the initial value at ~line 570 and `resetAppState` if it enumerates fields.
  - `ProjectState`: keep all existing `assetBrowser*` fields (tree still uses them). Add:
    `assetsThumbnailSize: number` (default 104), `assetsContentView: 'grid' | 'list'`
    (default `'grid'`). (These are ephemeral UI prefs — written directly like the existing
    `assetBrowser*` fields, not via commands, consistent with current tree code.)
- `src/services/ProjectService.ts`: extend `AssetBrowserPersistedState` with
  `thumbnailSize?: number`, `contentView?: 'grid' | 'list'`, `treePaneWidth?: number`;
  `saveAssetBrowserState` merge already handles partial patches; `loadAssetBrowserState`
  defaults legacy records (pattern already exists for `groupedExpandedKeys`).
- `assets-content.ts` persists slider/view changes via
  `projectService.saveAssetBrowserState({ thumbnailSize, contentView })`; `assets-panel.ts`
  persists `treePaneWidth` on splitter release; both restore in `connectedCallback`/on
  project-ready.

### 8. Registration / imports

- `src/main.ts:45`: replace `import './ui/assets-browser/asset-browser-panel';` with
  `import './ui/assets/assets-panel';` (which itself imports `./assets-content` and
  `../assets-browser/asset-tree` until the move).
- `src/ui/pix3-editor-shell.ts:134`: remove `import './assets-preview/assets-preview-panel';`.

### 9. Tests

- `src/ui/assets-browser/asset-tree.spec.ts`:
  - "renders file sizes and folder content sizes" — rewrite: files (`hero.png`) no longer
    render as rows; assert only `textures` renders AND its `.node-meta` still shows the
    recursive size (3.0 KB) proving files still count toward folder size.
  - Add: `selectPath('textures/ui/button.png')` selects `textures/ui` dir node and calls
    `assetsPreviewService.syncFromAssetSelection('textures/ui/button.png', 'file')` (stub).
  - Add: multi-path drop via `ASSET_PATH_LIST_MIME` moves all items.
- `src/ui/assets-browser/grouped-asset-tree.spec.ts`: existing cases pass `includeFiles: true`
  (or default true) to stay valid; add a case asserting `includeFiles: false` omits file leaf
  nodes but keeps `fileCount`, compaction labels, and dir `sizeBytes`.
- Move `assets-preview-panel.spec.ts` → `src/ui/assets/assets-content.spec.ts`, retarget tag
  `pix3-assets-content`; keep the size/meta cases; add: breadcrumb segments for
  `selectedFolderPath: 'assets/textures'` (+ `folder-navigate` detail on click), list-view row
  rendering, slider updates `--assets-thumb-size`, stats line renders from new snapshot fields.
- NEW `src/ui/assets/assets-panel.spec.ts` (jsdom, stubbed services): root-row click clears
  tree selection + syncs `'.'`; `assets-preview:reveal-path` window event routes to
  `assetTree.selectPath`; group-toggle calls `setViewMode`.
- `AssetsPreviewService` spec (if present — add otherwise): folder stats computed and
  version-guarded.

---

## Phased implementation order

1. **Phase 1 — extraction (no behavior change).** Create `src/ui/assets/assets-content.ts`
   by extracting the body of `assets-preview-panel.ts`; make `pix3-assets-preview-panel` a thin
   wrapper around it. Move `getDirectoryContentSize` walk into the shared stats helper. Run
   existing specs.
2. **Phase 2 — service + tree groundwork.** AssetsPreviewService folder stats; asset-tree
   folders-only filtering (both modes), `selectPath` file fallback, `revealAndOpen` direct
   activation, `clearSelection`, `handleRootDrop`, multi-path drop. Update tree/grouped specs.
   (Old Asset Browser panel now shows folders only — acceptable intermediate state.)
3. **Phase 3 — content header.** Breadcrumbs, stats display, grid/list toggle + list view,
   thumbnail slider + CSS var, content toolbar + extended context menu, persistence fields.
4. **Phase 4 — the unified panel + layout swap.** Build `pix3-assets-panel` (split, root row,
   migrated handlers/listeners); LayoutManager + AppState `PanelVisibilityState` edits;
   main.ts / pix3-editor-shell import changes; delete the two old panels; new panel spec.
5. **Phase 5 — cleanup.** `git mv` tree files into `src/ui/assets/`, fix imports, lint,
   `npm run test`, `npm run lint`.

## Resolved product decisions (confirmed by user 2026-07-20)

- **Default tab**: the unified **Assets** panel is the default-active tab of the center-bottom
  stack (demotes Logs). Implement as first component in that stack.
- **By-type grid**: selecting a category shows the **FULL folder contents** (existing
  `syncFromAssetSelection` semantics) for v1 — no category filtering plumbing.
- **Grid file ops**: **dialog-based rename** (extension preserved, via `DialogService`) +
  **multi-delete** on the grid selection with a single confirmation ("Delete N items?").
  Inline grid rename is deferred.

## Remaining risks & minor open questions

1. **Category row with `folderPath`=undefined** (multi-folder category) still leaves the
   content pane untouched on click — unchanged behavior, but now more visible. OK?
2. **Toolbar placement**: plan puts Create/Import/Rename/Delete/Open-in-IDE into the content
   header (Unity puts creation in a context menu + "+" button). If the header gets crowded at
   narrow widths, fall back to a "+" dropdown + overflow menu. Minor, decide during styling.
3. Left column bottom stack now holds only Library — visual balance of the default layout may
   need `height` retuning (currently 50).
