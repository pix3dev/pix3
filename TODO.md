# TODO

## all
- [ ] move to constuctor injection in classes

## Редактор (Editor)
- [ ] add transform animation timeline editor for nodes and tween animation support (Сложность: L)
- [ ] add animation editor for animated sprites (Сложность: L)
- [ ] add image compression option (Сложность: M)
- [ ] add glb inspector, that will show how different parts of model affect size (Сложность: M)
- [ ] add image/asset library/store (Сложность: M)
- [ ] log game events to editor's console (Сложность: M) — *partial: logs panel exists, no game→console bridge*
- [ ] generate asset manifest on project build (Сложность: M) — *partial: asset-manifest.json lists paths only, no metadata*
- [ ] publish runtime package to the cloud, to optimize pipeline (Сложность: M)
- [x] fix icons for global light nodes (Сложность: S)
- [x] add icon to audio nodes (Сложность: S)
- [x] remove bounding boxes from global objects without transform (Сложность: S)
- [x] version check and update functionality (Сложность: S)

## Рантайм (Runtime)
- [ ] add remote preview to check the game on device (Сложность: L)
- [ ] implement cinematic camera module, that will allow control camera more flexibly (Сложность: L)
- [x] fix layout system to process correctly margins in anchor mode (Сложность: M)
- [ ] update nodes properties and hot reload them in the game mode (Сложность: M)
- [x] unify scene objects addressing from custom scripts (Сложность: M)
- [x] add opacity to 3d sprite with fade in/out APIs (Сложность: M)
- [x] particle rotation toggle and saving fix (Сложность: S)
- [x] sprite color fix on editor mode (Сложность: S)

## UX / UI
- [ ] drag and drop assets into editor viewport and scene tree (Сложность: L)
- [ ] improve UX of controls on Object inspector (dragging numbers, compact) (Сложность: M) — *partial: sliders exist, no drag-to-scrub / compact mode*
- [x] add color picker for color values in Object inspector (Сложность: M)
- [x] make a node picker for properties with node type (Сложность: M)
- [x] allow to preview glb models from asset browser (Сложность: M)
- [ ] allow to preview sounds in editor (Сложность: M)
- [ ] allow to preview sounds in assets preview panel (Сложность: M)
- [ ] allow to preview animations in assets preview panel (Сложность: M)
- [x] add alignment methods for 2d objects (Сложность: M)
- [x] add show all and reset zoom in 2d navigation mode (Сложность: S)
- [x] show anchor point of sprite in the editor (Сложность: S)
- [x] allow to see file size in the asset preview/browser (Сложность: S)
- [x] add drag and drop support for audio files properties (Сложность: S)
- [ ] better control of camera and light directions (Сложность: S) — *partial: target gizmos render, not draggable*
- [x] update icons and layout of viewport toolbar (Сложность: S)
- [x] not to hide camera/light icons on select, make semitransparent (Сложность: S)
- [x] snap 2d objects to grid (Сложность: S)
- [x] move 2d nodes with arrow keys (Сложность: S)
- [ ] remove game tab and keep only popup window mode (Сложность: S) — *partial: both tab + popout hosts exist*

## Инфраструктура и Веб (Web & Infra)
- [ ] add tools.gritsenko.biz integration (publish & share) (Сложность: L) **Low priority**
- [x] create landing page for editor (Сложность: M)
- [x] publish online PWA version (Сложность: M)
- [x] add bundle size calculation (Сложность: S)
