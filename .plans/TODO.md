# TODO

Операционный список задач. Стратегия и обоснование приоритетов — в [ROADMAP.md](ROADMAP.md);
крупные фичи имеют собственные спеки в этой же папке (см. [README.md](README.md)).

**Статусы перепроверены по исходникам:** commit `1afac13`, 2026-08-01.

## all

- [ ] move to constructor injection in classes

## Редактор (Editor)

- [x] add transform animation timeline editor for nodes and tween animation support (Сложность: L)
- [x] add animation editor for animated sprites (Сложность: L) — _flipbook-редактор `src/ui/animation-editor/` + auto-slice; см. [done/sprite_animation_update.md](done/sprite_animation_update.md). **Заменён** единым Sprite Editor, строкой ниже_
- [x] unified Sprite Editor (Сложность: L) — _[done/sprite-editor-design.md](done/sprite-editor-design.md). Все фазы закрыты: 1–3 (единый шелл `pix3-sprite-editor-panel` на картинку и `.pix3anim`, старая флипбук-панель удалена, генерация вынесена в док-панель `Generate`), рантайм R1/R2 (в npm с 1.3.0), §9.9/§9.10, фаза 5 (§9.11 place mode + вставка из истории) и фаза 6 power tools целиком (§9.12: trim frames, auto collision polygon, chroma key, bulk frame ops, video import). §9.13 — журнал живых проверок трёх путей, которые раньше не исполнялись_
- [x] add image/asset library/store (Сложность: M) — _[asset-library.md](asset-library.md) Phase 1 + [asset-store-admin.md](asset-store-admin.md) фазы A–D; остались team-scope и Phase E_
- [ ] add image compression option (Сложность: M) — _partial: compress/resize есть в AssetGenService для генерации, к экспорту не подключён (P1 «компрессия ассетов при экспорте»)_
- [ ] add glb inspector, that will show how different parts of model affect size (Сложность: M)
- [ ] создание проекта после промпта «Unsaved Changes» не активируется и оставляет сироту в OPFS (Сложность: S) — _наблюдалось 2026-08-11 один раз, воспроизвести не удалось: проект пишется в OPFS целиком, но в recents не попадает, диалог откатывается в «Create». Трейл и гипотеза (гонка порядка при переключении корня проекта) — [done/browser-storage-projects.md](done/browser-storage-projects.md) §5.1_
- [ ] `Move Project to Folder…` — ручная проверка переноса (Сложность: XS) — _единственный незакрытый пункт §5 browser-storage: гейтинг пункта меню проверен, сам перенос требует нативного directory picker'а, который CDP не закрывает. Проверить руками: файлы на диске, backend стал local, OPFS-копия удалена, recents обновлён_
- [ ] открытие проекта с welcome не восстанавливает вкладку сцены (Сложность: S) — _сохранённая сессия в `pix3.projectTabs:<id>` содержит путь сцены, но дерево пустое; одинаково на local и browser бэкендах, то есть общее поведение роутера/восстановления вкладок_
- [x] Model Lab — генератор 3D-ассетов и сцен по референсу (Сложность: L) — _[done/model-lab-3d-generator.md](done/model-lab-3d-generator.md): фазы 1–6, панель `src/ui/model-lab/`, обе ланы (модель → GLB, сцена → `.pix3scene`)_
- [ ] нейронный image→3D провайдер в Model Lab (Сложность: M) — _процедурная реконструкция проигрывает специализированным 3D-генераторам; меняется только шаг генерации, ключ — в прокси `pix3-agent-bridge`. Обоснование и открытые вопросы: [ROADMAP.md](ROADMAP.md) P3 + §Backlog B0 архивного плана_
- [ ] log game events to editor's console (Сложность: M) — _partial: ошибки скриптов и uncaught-исключения мостятся в Logs через `RuntimeErrorBridgeService`; обычные `console.log`/сигналы игры — нет_
- [ ] generate asset manifest on project build (Сложность: M) — _partial: asset-manifest.json перечисляет пути, метаданных (размеры, длительность, поликаунт) нет_
- [ ] publish runtime package to the cloud, to optimize pipeline (Сложность: M) — _partial: `@pix3/runtime` публикуется в npm (OIDC trusted publishing); CDN-хостинг рантайма для экспортированных игр — нет_
- [x] fix icons for global light nodes (Сложность: S)
- [x] add icon to audio nodes (Сложность: S)
- [x] remove bounding boxes from global objects without transform (Сложность: S)
- [x] version check and update functionality (Сложность: S)

## Рантайм (Runtime)

- [x] **выпустить `@pix3/runtime` 1.3.0 в npm** (Сложность: S) — _сделано 2026-08-04: тег `runtime-v1.3.0` (первый `runtime-v*` в репозитории) → `publish-packages.yml` через OIDC → npm `latest = 1.3.0`. Открыло потребителям пер-кадровый anchor/`sizeMode`/`sourceSize` (R1) и `getFramePoint`/`core:PointAttachment` (R2). DeepCore подтянул обычным `npm update` (спека `^1.2.0` разрешилась в 1.3.0, package.json править не пришлось), собирается чисто_
- [x] add remote preview to check the game on device (Сложность: L) — _relay + player.html + `PreviewHostService`; см. [done/rapid-prototyping-design.md](done/rapid-prototyping-design.md)_
- [x] implement cinematic camera module, that will allow control camera more flexibly (Сложность: L) — _P0.1 vcams (3D) + Cutscene Director; Camera2D осознанно отложена_
- [x] update nodes properties and hot reload them in the game mode (Сложность: M) — _P0.5_
- [x] **zIndex/sortOrder на Node2D** (Сложность: S) — _`zIndex` + `zAsRelative` (Godot-семантика) в группе «Ordering»; бакеты по эффективному z поверх DFS в `render-order-2d.ts`, зеркала в `Viewport2DProxyRegistry` и `ViewportPicking`_
- [x] fix layout system to process correctly margins in anchor mode (Сложность: M)
- [x] unify scene objects addressing from custom scripts (Сложность: M)
- [x] add opacity to 3d sprite with fade in/out APIs (Сложность: M)
- [x] particle rotation toggle and saving fix (Сложность: S)
- [x] sprite color fix on editor mode (Сложность: S)

## UX / UI

- [x] drag and drop assets into editor viewport and scene tree (Сложность: L) — _`src/ui/shared/asset-drag-drop.ts` + drop-хендлеры во viewport, scene-tree, инспекторе и библиотеке_
- [x] improve UX of controls on Object inspector (dragging numbers, compact) (Сложность: M) — _`pix3-number-field` (drag-to-scrub, Shift = точнее ×0.1, Ctrl = грубее ×10, клик = ввод текстом) теперь стоит на **всех** числовых полях инспектора: transform/vector/size/rotation, скалярные свойства нод и числовые поля компонентов-скриптов; сырых `<input type="number">` в панели не осталось. Компактный summary-layout сделан раньше_
- [ ] drag-to-scrub в FPS-поле Sprite Editor (Сложность: XS) — _перепроверено 2026-08-10: восьми сырых инпутов из `inspector-section-renderers.ts` больше нет — пер-кадровое редактирование переехало в таймлайн Sprite Editor. Осталось одно сырое поле: `sprite-timeline.ts:123` (FPS клипа, `@change` → `controller.updateClipFps`) → заменить на `pix3-number-field`. `sprite-editor-panel.ts:2377` (custom max px при сохранении) — разовый ввод, скраб не нужен_
- [x] allow to preview animations in assets panel (Сложность: M) — _`.pix3anim` получил `previewType: 'animation'`: карточка/строка показывают первый кадр и `клип · fps · кадры`, play/stop (и Space на выделенном) проигрывает клип с учётом loop/ping-pong и per-frame duration. Первый кадр грузится при скане папки, остальные — лениво по нажатию play (`requestAnimationFrames`); sheet-клипы кроп по UV-подпрямоугольнику_
- [ ] better control of camera and light directions (Сложность: S) — _partial: target-гизмо рендерятся, но не таскаются_
- [ ] remove game tab and keep only popup window mode (Сложность: S) — _partial: живут оба хоста_
- [x] add color picker for color values in Object inspector (Сложность: M)
- [x] make a node picker for properties with node type (Сложность: M)
- [x] allow to preview glb models from asset browser (Сложность: M)
- [x] allow to preview sounds in editor (Сложность: M) — _инспекторный `audio-resource`-редактор: waveform + плеер + duration/channels/rate_
- [x] allow to preview sounds in assets preview panel (Сложность: M) — _waveform-миниатюра и play/stop в grid и списке, полоса плейхеда, часы `0:03 / 0:12`, Space на выделенном ассете_
- [x] add alignment methods for 2d objects (Сложность: M)
- [x] add show all and reset zoom in 2d navigation mode (Сложность: S)
- [x] show anchor point of sprite in the editor (Сложность: S)
- [x] allow to see file size in the asset preview/browser (Сложность: S)
- [x] add drag and drop support for audio files properties (Сложность: S)
- [x] update icons and layout of viewport toolbar (Сложность: S)
- [x] not to hide camera/light icons on select, make semitransparent (Сложность: S)
- [x] snap 2d objects to grid (Сложность: S)
- [x] move 2d nodes with arrow keys (Сложность: S)

## Инфраструктура и Веб (Web & Infra)

- [ ] add tools.gritsenko.biz integration (publish & share) (Сложность: L) **Low priority**
- [x] create landing page for editor (Сложность: M)
- [x] publish online PWA version (Сложность: M)
- [x] add bundle size calculation (Сложность: S)
