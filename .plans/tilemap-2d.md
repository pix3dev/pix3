# Тайловые уровни: `TileMap2D` + `.pix3tileset` + рисование карты в редакторе

**Статус: спроектировано, не начато.** Записано: 2026-09-13. Сложность: **L целиком, M — играбельный
вертикальный срез** (фазы 1–2, без кисти). Оси ROADMAP: 🤖 agent pipeline (главная), 🧃 juice (вторая —
дешёвый левел-дизайн для платформеров/раннеров), 💰 косвенно (раннеры и платформеры — живой жанр playable-ad).
Смежное: [prompt-to-playable-flow.md](prompt-to-playable-flow.md) §3.7 трек B и фаза 3 (рецепт
`platformer-2d` — обещан, не существует: строка 783), [done/2d-batching-atlas-design.md](done/2d-batching-atlas-design.md),
[physics-engine.md](physics-engine.md), [done/spine-runtime-node.md](done/spine-runtime-node.md) (образец «добавляем 2D-ноду»).

## 0. Вердикт (читать первым)

**Активный план, приоритет P2 (🤖), исполнять фазами с воротами; кисть (фаза 3) — по критерию, не по инерции.**

Честная раскладка «за» и «против»:

- **Против.** Основной потребитель Pix3 — playable-ads и вайб-прототипы; ни один из измеренных прогонов
  ([done/vibe-vs-chat-gap.md](done/vibe-vs-chat-gap.md), [agent-eval-results.md](agent-eval-results.md)) не упёрся
  в отсутствие тайлов. В аудите [cross-engine-ideas.md](cross-engine-ideas.md) TileMap не значится ни гапом, ни
  skip'ом — слепое пятно, а не спрос. Аргумент «в Godot это есть» ничего не доказывает: в Godot есть и
  navigation-полигоны, и terrain-биты, и мы их сознательно не тащим (§10).
- **За — и этот аргумент перевешивает.** Тайловая карта — **единственная форма 2D-левел-дизайна, которую
  LLM-агент авторит и правит целиком как текст**. Сегодня уровень в Pix3 — это «данные на нодах»: платформа =
  `ColorRect2D`/`Sprite2D` + `core:Collider2D`, то есть ~12 строк YAML и два вызова тулов на объект. Уровень из
  60 платформ — 700 строк сцены и 120 ходов агента; тот же уровень в ASCII — 20 строк по 40 символов, правится
  одним `str_replace`, диффится в git построчно. Это ложится ровно в дифференциатор (agent pipeline) и в рычаг
  «покрытие» из замера vibe-vs-chat: рецепт `platformer-2d` без тайлов делать больно, а с ними — это 2 КБ
  шаблона. Плюс агентский тул `generate_scene_3d` (`AgentToolRegistry.ts:2130`) уже доказал спрос на «уровень как
  декларативный текст» — в 3D.
- **Что из этого следует для порядка.** Ценность — в рантайм-ноде и текстовом формате (фазы 1–2). Кисть в
  редакторе (фаза 3) — самая дорогая часть и одновременно та, которую агент **не** использует; она нужна
  человеку, который правит уровень руками после агента (трек B из Flow: «хочу сам подвигать → Open in Studio»).
  Поэтому фаза 3 гейтится критерием: *хотя бы один живой прогон, где человек правил `rows` в YAML/инспекторе и
  это оказалось ощутимо больнее, чем перетащить `ColorRect2D`*. Без этого критерия фаза 3 уезжает в `frozen/`
  отдельным файлом, а формат данных остаётся готовым её принять.

## 1. Что уже есть и что переиспользуем (не дублировать)

| Существующее | Где | Что берём |
| --- | --- | --- |
| `Node2D`: `zIndex`/`zAsRelative`, `opacity` через `registerOpacityMaterial`, `LAYER_2D` штампуется в `add` | [Node2D.ts](packages/pix3-runtime/src/nodes/Node2D.ts) | базовый класс; чанки — обычные дети-меши |
| Порядок отрисовки по DFS, `OVERLAY_2D_FLAG` | [render-order-2d.ts](packages/pix3-runtime/src/core/render-order-2d.ts) | ничего не добавляем: карта — узел дерева, слои = соседние ноды |
| Квад-батчер: батчит только `BATCHABLE_2D_KEY` + `MeshBasicMaterial`, остальное — passthrough своим draw-call'ом | [batch-2d.ts:308-334](packages/pix3-runtime/src/core/batch-2d.ts) | чанк-меш **не** помечаем batchable — он уже один draw call |
| `configure2DTexture` (sRGB, без мипмапов, `LinearFilter`) | [configure-2d-texture.ts](packages/pix3-runtime/src/core/configure-2d-texture.ts) | обязательно; поверх — `NearestFilter` для пиксель-арта |
| `AssetLoader.loadTexture(path, { atlas: false })` — обход пред-запускового атласа (прецедент: spine-страницы, `AssetLoader.ts:355`) | [AssetLoader.ts](packages/pix3-runtime/src/core/AssetLoader.ts) | тайлсет сам себе атлас |
| `AssetLoader.loadAnimationResource` — загрузка YAML-ресурса `.pix3anim` | `AssetLoader.ts:364` | образец для `loadTileSet` |
| `Collider2DSource` — структурный контракт коллайдера; коллайдер без тела = статическая геометрия мира (`Physics2DService.ts:1109`) | [Physics2DService.ts:58-84](packages/pix3-runtime/src/core/Physics2DService.ts) | тайлкарта регистрирует N слитых прямоугольников как N источников на **одном** статическом теле |
| `preview`/`commit` history-режимы у `UpdateObjectPropertyCommand` и `UpdateComponentPropertyCommand` | [UpdateObjectPropertyCommand.ts:15-58](src/features/properties/UpdateObjectPropertyCommand.ts) | мазок кистью = один undo |
| `Polygon2DEditController` — инструмент вьюпорта с «правом первого отказа» на pointer'ы, состояние в `appState.ui.polygonEditing` | [Polygon2DEditController.ts](src/services/viewport/Polygon2DEditController.ts), [editor-tab.ts:1059-1067](src/ui/viewport/editor-tab.ts) | образец `TileBrushController` |
| Общий view для ноды и прокси (`SpineSkeletonView`), общая геометрия (`buildTiledSpriteGeometry`) | [Viewport2DProxyRegistry.ts:22-24](src/services/viewport/Viewport2DProxyRegistry.ts) | один мешер чанков на рантайм и редактор |
| `ui.editor` кастомные редакторы инспектора (`collision-polygon`, `texture-resource`, `file-resource`) | [inspector-property-renderers.ts:561](src/ui/object-inspector/inspector-property-renderers.ts) | палитра и редактор строк — как `pix3-collision-polygon-editor` |
| Авто-нарезка листа по `columns`/`rows` | [AnimationAutoSliceDialogService.ts](src/services/animation/AnimationAutoSliceDialogService.ts) | те же параметры сетки у тайлсета |
| Экспорт: `mentionedNames` + таблица стабов; ссылконосные ресурсы сканируются транзитивно (`/\.(pix3scene\|prefab\|pix3anim)$/`) | [strippable-runtime-modules.ts](src/services/export/strippable-runtime-modules.ts), [ProjectBuildService.ts:671](src/services/export/ProjectBuildService.ts) | одна запись + одно расширение в regex |
| Агент правит активную `.pix3scene` через `str_replace`/`fs_write` — сцена перезагружается; файл < 16 000 символов отдаётся целиком | [AgentToolRegistry.ts:386,1190](src/services/agent/AgentToolRegistry.ts) | тула рисования в v1 **нет** — формат под это и спроектирован |

Не путать: `TiledSprite2D` — это nine-slice/повтор одной картинки ([tiled-sprite-geometry.ts](packages/pix3-runtime/src/core/tiled-sprite-geometry.ts)), к карте отношения не имеет.

## 2. Модель данных

### 2.1 `TileSet` — отдельный ресурс `tilesets/<name>.pix3tileset`

Развилка: (а) внутри сцены, (б) отдельный YAML-файл, (в) переиспользовать `.pix3anim` (кадры = тайлы).
**Выбор — (б).** (а) дублируется на каждый уровень (scene-per-level уже практикуется — SkyDefender), и легенду
пришлось бы держать синхронной в N сценах. (в) соблазнительно (авто-нарезка есть), но `.pix3anim` — модель
клипа: `durationMultiplier`, `anchor`, `collisionPolygon`, `events` ([AnimationResource.ts:53-92](packages/pix3-runtime/src/core/AnimationResource.ts));
тайлу нужны ровно `solid` и имя, а карте — легенда. Отдельный файл стоит дёшево: прецедент загрузки —
`loadAnimationResource`, прецедент экспорта — расширение в regex ссылконосных ресурсов, категория ассетов —
одна строка в [asset-categories.ts](src/core/asset-categories.ts) (новая папка `tilesets/` во flat-layout спеки §7.1).

```yaml
version: 1
texture: res://sprites/forest-tiles.png
tileWidth: 32
tileHeight: 32
margin: 0            # отступ листа
spacing: 0           # зазор между тайлами
columns: 8           # id тайла = row-major индекс в сетке листа; columns нужен ДО загрузки текстуры
filter: nearest      # nearest | linear; по умолчанию — настройка проекта (getProjectTextureFiltering)
tiles:               # только тайлы, о которых есть что сказать; остальные — просто картинка
  1: { name: ground, solid: true }
  2: { name: grass, solid: true }
  9: { name: spike, tags: [hazard] }
legend:              # символ строки карты → тайл. '.' зарезервирован под «пусто», пробел запрещён
  '#': 1
  '=': 2
  '^': 9
  '<': { tile: 9, flipX: true }   # варианты (flip/rotate) живут в легенде, НЕ в сетке
```

Почему варианты в легенде: сетка остаётся строго «один символ — одна клетка», а Godot-подобные
alternative-tiles появляются без второго формата. В v1 `flipX/flipY` читаются мешером; `rotate` — зарезервирован.

### 2.2 `TileMap2D` — нода; один слой = одна нода

Развилка: слои внутри ноды (Godot 3 `TileMap.layers`) или по ноде на слой (Godot 4 `TileMapLayer`).
**Выбор — по ноде на слой.** В Pix3 «порядок в дереве = порядок отрисовки» ([CLAUDE.md](CLAUDE.md) → 2D overlay
rendering), `zIndex` уже есть, Peek режет по ветвям — вложенная модель слоёв дала бы второй способ делать то же
самое и второй формат в YAML. Фон/земля/декор = три соседних `TileMap2D` с одним `tileSet`.

Свойства (схема через `static getPropertySchema()` + `installReactiveSchemaProperties`, как у
[ColorRect2D.ts](packages/pix3-runtime/src/nodes/2D/ColorRect2D.ts)):

| Свойство | Тип | Заметка |
| --- | --- | --- |
| `tileSet` | `string` (`ui.editor: 'file-resource'`) | `res://tilesets/….pix3tileset` |
| `rows` | `object` (`string[]`, `ui.editor: 'tilemap-rows'`) | сама карта; сеттер перестраивает грязные чанки и коллайдеры |
| `collision` | `enum: physics \| none` | `physics` регистрирует слитые прямоугольники в `scene.physics2d` |
| `friction`, `restitution` | `number` | один материал на карту в v1 (per-tile — в тайлсете, потом) |
| `columns`, `rowCount` | read-only в инспекторе | выводятся из `rows`; изменение размера — через редактор строк / кисть |

Runtime API для скриптов (`docs/nodes-and-systems.md` → Scripts-facing runtime API):
`getCell(col,row): number`, `setCell(col,row,id)`, `setCells(patch)`, `worldToCell(x,y)`, `cellToWorld(col,row)`,
`isSolidAt(worldX, worldY)`, `getTileTags(id)`, `bounds` (px). Это же — основа для игр без физики (сокобан,
матч-сетка): им коллизии `physics` не нужны, нужен `isSolidAt`.

### 2.3 Кодировка клеток — варианты и выбор

| Вариант | Диффится в git | Не раздувает сцену | Агент правит одним `str_replace` | Ограничение |
| --- | --- | --- | --- | --- |
| плоский массив чисел `[0,0,3,3,…]` | нет (одна строка) | средне | нет — надо считать индексы | — |
| run-length строка | да, но нечитаемо | лучше всех | нет — надо декодировать | — |
| **ASCII-строки + легенда** | **да, строка = ряд** | да (1 байт/клетка) | **да — заменить один ряд** | ≤ ~90 типов тайлов на легенду |
| CSV-строки `"0,0,3,3"` | да | хуже ASCII в 2–3× | да, но хуже читается | нет лимита типов |

**Выбор — ASCII-строки + легенда**, с зарезервированным ключом `encoding: ascii` (по умолчанию) — дверь для
`csv` при тайлсетах > 90 типов, не меняя ни ноду, ни редактор (мешеру всё равно, откуда пришли id).
Карта 64×32 = 2,2 КБ; 128×64 = 8,5 КБ — всё ещё под порогом «файл целиком» у `fs_read` (16 000 симв.).
Рекомендация в скилле агента: ≤ 64×32 для ручных правок, ≤ 128×128 вообще (см. §10 «бесконечные карты»).

Толерантность загрузчика (принцип «Forgiving Vocabulary» спеки §7.1): ряды разной длины дополняются `.` до
максимума с диагностикой «row 7 is 38 wide, map is 40», неизвестный символ — пустая клетка + диагностика с
символом и рядом. Диагностики идут туда же, куда `inert-nodes`: линт `scene_tree`/`game_observe`/старт play —
агент видит опечатку сразу, а не по «дырке в полу».

### 2.4 Как ложится в `.pix3scene`

```yaml
- id: 'q9Xf3kLm_Zt1aRw8Pd-oB'
  type: 'TileMap2D'
  name: 'Ground'
  properties:
    transform: { position: { x: -640, y: 360 } }
    tileSet: res://tilesets/forest.pix3tileset
    collision: physics
    rows:
      - '........................................'
      - '..........==..............==............'
      - '........................................'
      - '=====......=====....====......==========' 
      - '#####......#####....####......##########'
```

Две ловушки сериализации, обе снимаются на этапе фазы 1:

1. **Складывание длинных строк.** `SceneSaver` пишет `stringify(document, { indent: 2 })`
   ([SceneSaver.ts:78](packages/pix3-runtime/src/core/SceneSaver.ts)); у `yaml@2` `lineWidth` по умолчанию 80 —
   ряд шире 80 клеток сложится в многострочный скаляр и перестанет быть «строка = ряд». Решение: `lineWidth: 0`
   в опциях сохранения (проверить на сэмплах, не переформатирует ли это существующие длинные строки —
   разовый дифф допустим, но его надо увидеть глазами).
2. **Живые поля vs `properties`-мешок.** У `ColorRect2D` пришлось добавлять ветку в `SceneSaver`
   (`SceneSaver.ts:379-387`), потому что сеттеры схемы мутируют поля и материал, а не `node.properties` — иначе
   вход в play-режим (serialize→re-parse) откатывал правки. `TileMap2D` держит `rows` **только** как живое
   поле, а `SceneSaver` читает его через ветку `instanceof TileMap2D`. Тест-пин: `TileMap2DPersistence.spec.ts`
   по образцу `ColorRect2DPersistence.spec.ts`.

### 2.5 Координаты

Pix3 2D — центр-ориджин, **y вверх** (`Node2D.ts:999-1001`: `top = height/2 - topMargin`; конверсия
«top-left/y-down → centre-origin/y-up» в UI Kit — `docs/nodes-and-systems.md:370`). Решение для карты:
**клетка (0,0) — верхний левый угол сетки в локальном (0,0) ноды; столбцы вправо (+X), ряды вниз (−Y)**;
`cellToWorld(col,row)` = центр клетки `((col+0.5)·w, −(row+0.5)·h)` в локальных координатах ноды.
Не центрировать сетку по ноде, как делают `ColorRect2D`/`Sprite2D`: при центрировании «добавь ряд снизу»
сдвигает **все** тайлы — ровно та правка, которую агент делает чаще всего. `Node2D.layout` (якоря) к
`TileMap2D` не применяется — это UI-механизм. Порядок рядов в файле = визуальный порядок сверху вниз.

## 3. Рендеринг

**Чанки.** Карта режется на чанки 16×16 клеток; каждый чанк — один `Mesh` с собственной `BufferGeometry`
(позиции `Float32`, UV `Float32`, индексы `Uint16` — 256 квадов = 1024 вершины, влезает) и **общим** на карту
`MeshBasicMaterial({ map, transparent: true, depthTest: false })`, зарегистрированным через
`registerOpacityMaterial` (так `opacity` ноды продолжает работать). Пустые чанки не создаются. Правка клетки
пачкает только её чанк; перестройка чанка — заполнение буферов, без аллокаций (буферы выделяются на 256 квадов
и усекаются `setDrawRange`).

**Один-два draw-call'а.** Чанк-меш **не** помечен `BATCHABLE_2D_KEY`, поэтому `Batch2DSystem.keyFor` отдаёт
`null` и меш проходит passthrough своим вызовом (`batch-2d.ts:319-321`) — это и есть цель: 40×20 карта = 6 чанков
= 6 вызовов при любом числе тайлов; при этом соседние `Sprite2D` по-прежнему батчатся между собой. Батчить
чанки между собой не нужно (`stats.passthrough` подрастёт на число чанков — учесть в ожиданиях Profiler'а).

**Порядок отрисовки.** Чанки — дети ноды, `assign2DRenderOrder` штампует их DFS-ом в ряд; они не
перекрываются, поэтому порядок между чанками не важен, а относительно соседей карта ведёт себя как любой
узел (тайлы поверх — нода позже в дереве или `zIndex`). `OVERLAY_2D_FLAG` не нужен.

**Культинг.** `mesh.frustumCulled = true` + `geometry.computeBoundingSphere()` после каждой перестройки — three
отсекает чанки вне ортокамеры сам, и в play-режиме (камера `Camera2D` → ортокамера рантайма), и в редакторе
(своя ортокамера вьюпорта). Никакого собственного культинга по камере не пишем.

**Текстура.** Тайлсет грузится `assetLoader.loadTexture(texture, { atlas: false })` (он сам себе атлас,
паковать его в общий лист бессмысленно и ломает UV) и обязательно проходит `configure2DTexture` (иначе — баг
«текстура чёрная/полупрозрачная на ANGLE/Adreno», [CLAUDE.md](CLAUDE.md) → 2D overlay rendering). Поверх:
`filter: nearest` → `NearestFilter`; при `linear` UV каждой клетки вжимаются на полтекселя, иначе на границах
клеток бликует соседний тайл. `TextureAtlasService` тайлсеты **не** сканирует (он ходит только по `res://…png`
в сценах/скриптах и по `.pix3anim`): если тот же PNG используется и `Sprite2D`, он запакуется для спрайта, а
карта получит сырую копию — две GPU-копии, приемлемо.

**Редакторский прокси.** Редактор не рисует рантайм-ноды (`Viewport2DProxyRegistry`) — карте нужен
`createTileMap2DVisual`. Чтобы не писать мешер дважды, он выносится в рантайм-модуль без зависимостей от ноды
(`core/tilemap/TileMapView.ts` — как `SpineSkeletonView`, который делят нода и прокси): нода и прокси держат по
экземпляру `TileMapView` над одними данными. Прокси перештамповывает `LAYER_2D` на детях после перестройки
(three.js layers не наследуются — урок Spine).

## 4. Коллизии и физика

Per-tile коллизия → разумное число тел:

1. `solid: true` берётся из тайлсета; карта строит битовую маску.
2. **Слияние**: в каждом ряду — прогоны подряд идущих solid-клеток; прогоны с одинаковыми `[x0,x1]` в
   соседних рядах склеиваются по вертикали → список прямоугольников. Платформер 40×20 даёт 20–60 прямоугольников
   (шахматка — вырожденный худший случай, N клеток; документируем как известное ограничение).
3. Каждый прямоугольник — объект, реализующий `Collider2DSource` (`shape: 'rect'`, `offset` = центр в локальных
   px ноды, `node` = сама карта, `getColliderRevision` = хеш `rows` + solid-набора). Регистрируется через
   `physics2d.registerCollider`; коллайдер без `core:PhysicsBody2D` над ним — статическая геометрия мира
   (`Physics2DService.ts:1109`, `staticBody`), тел не плодим вовсе. Броадфаза — равномерная сетка 128 px,
   пересобирается за шаг (`Physics2DService.ts:1414`): сотни статических прямоугольников ей безразличны.
4. Смена `rows` → снять/поставить только изменившиеся прямоугольники (диффом списков), не всё сразу — иначе
   спящие тела над полом просыпаются каждый мазок (`unregisterCollider` будит опору: `Physics2DService.ts:531`).

**Ловушка стрипания.** `TileMap2D` **не должен value-импортировать** `Physics2DService`: таблица стабов
проверяется спекой по реальному графу импортов, и нода, которую держит любой платформер, запинила бы физику
в каждом экспорте. Контракт `Collider2DSource` — `import type`, а сам сервис берётся из `scene.physics2d`
(как это делает `PhysicsWorld2DBehavior`; проверить при реализации, как нода добирается до `SceneService`
и создаётся ли `physics2d` лениво при первом `registerCollider`).

`core:Hitbox2D`/`Collision2DService` карта в v1 не поддерживает: игры без физики используют `isSolidAt`.
Односторонние платформы (`oneWay`) — ключ в тайлсете зарезервирован, солвер v1 его игнорирует.

## 5. Редактор

### 5.1 Присутствие ноды (фаза 2)

Списано с коммита `f4d142f7` (SpineSkeleton2D, 45 файлов) и с `ColorRect2D`; полный список файлов — §12.
Создание — `CreateTileMap2DCommand` (`menuPath: 'create/2d'`) + `CreateTileMap2DOperation` на
`CreateNodeOperationBase`; регистрация в [NodeRegistry.ts](src/services/scene/NodeRegistry.ts) (иконка Feather
`grid`, категория 2D) и в [create-node-registry.ts](src/services/agent/create-node-registry.ts) (для `create_node`);
пикинг — добавить в `isScreenRectSelectable2DNode` и `get2DVisual` ([ViewportPicking.ts:372-395, 470-487](src/services/viewport/ViewportPicking.ts)),
рамка выделения — `getNodeOnlyLocalCorners` по `bounds`. Инспектор: `tileSet` через `file-resource`, `rows`
через новый редактор `pix3-tilemap-rows-editor` (моноширинная textarea с подсветкой неизвестных символов и
счётчиком столбцов — это **fallback** и одновременно «агентский вид» карты для человека), палитра — §5.2.

### 5.2 Режим рисования (фаза 3)

`TileBrushController` по образцу `Polygon2DEditController`: включается кнопкой «Edit tiles» в инспекторе
выбранной карты → `appState.ui.tileEditing = { nodeId }`; `editor-tab.ts` даёт ему право первого отказа на
`pointerdown/move/up` **до** `polygonEditor` и обычного пикинга (`editor-tab.ts:1059-1067`); клик мимо карты и
`Esc` выходят из режима. Инструменты: кисть (drag — линия по Брезенхэму между событиями, иначе при быстром
движении рвётся), ластик (`.`), прямоугольник, заливка (flood fill по одинаковому id, кап 65 536 клеток),
пипетка (Alt-клик). Сетка и подсветка клетки под курсором рисуются как adornment над контентом
(`THREE.Group.renderOrder` как groupOrder — прецедент рамок выделения), толщина линий — `getFrameThicknessWorldPx(zoom)`.
Палитра — виджет в инспекторе (сетка тайлов из текстуры тайлсета, бейдж `solid`, выбранный тайл и текущий
инструмент). Расширение карты кистью за границу — увеличение `rows`/длины рядов с добавлением `.` (ориджин не
сдвигается — §2.5). После каждого мазка — `viewportRenderService.requestRender()` (вьюпорт рисует по запросу).

### 5.3 Undo — ключевая развилка

Варианты: (а) `UpdateObjectPropertyOperation('rows')` на **каждое** событие мыши → 400 записей на штрих;
(б) `coalesceKey` (`OperationService.ts:448-458`) — заменяет последнюю запись новой, но undo новой записи
восстанавливает `previousValue` **последнего** шага, а не начала штриха, — для property-операций это тихо
теряет начальное состояние; (в) **`preview`/`commit` режимы** `UpdateObjectPropertyCommand` — каждый
`pointermove` применяет через `operations.invoke` без записи, `pointerup` делает `commit` с `previousValue` =
`rows` на момент нажатия → **один штрих = один Ctrl+Z**. Ровно так работает полигон-инструмент.
**Выбор — (в).** Цена: копия `rows` на штрих (O(клеток), 128×128 = 16 КБ строк — незначительно); дельта-операция
(`PaintTileMapOperation` со списком `{col,row,prev,next}`) — оптимизация на потом, если карты вырастут.
Бонус (в): правка `rows` в play-режиме едет в живую ноду через `getRuntimeLivePropertySink` (P0.5 hot reload)
— рисуешь пол под бегущим персонажем.

### 5.4 Где живёт UI

Не док-панель. Палитра нужна ровно тогда, когда выбрана карта, — это семантика инспектора (как
`pix3-collision-polygon-editor` и Spine-превью), а док-панель тянет регистрацию в
[LayoutManager.ts:1055](src/core/LayoutManager.ts), персист раскладки, пункт меню Window. Отдельная панель
«Tile Set editor» (пометить `solid` кликом, задать легенду) — фаза 4; в v1 `solid`/`legend` пишутся в
`.pix3tileset` руками или агентом, а инспектор показывает их read-only.

## 6. Агентский путь

**Тула рисования в v1 нет — и это решение, а не пропуск.** Формат §2.3 сделан так, чтобы существующих тулов
хватало: `create_node {type:'tilemap2d'}` → `set_property tileSet` → `set_property rows` (JSON-массив строк)
или `str_replace` одного ряда в `.pix3scene` (активная сцена перезагружается — `AgentToolRegistry.ts:1190`).
`node_inspect` показывает `rows` как есть (40×20 = ~900 символов), `scene_tree` — сводку `TileMap2D 40×20,
6 chunks, 31 colliders` и диагностики загрузчика (§2.3). `fs_write` нового `.pix3tileset` — обычная запись файла.

Что добавляем: раздел «Tile levels» в [agent-skills/game-prototype.md](src/services/agent/agent-skills/game-prototype.md)
(конвенции легенды `#`/`=`/`^`/`.`, «считай столбцы, ряды равной длины», лимиты размера, «слой = нода»),
описание ноды в `docs/node-types-reference.md` (её читает `engine_search`), и **фиксацию в eval-suite**
([agent-eval-scenarios.md](agent-eval-scenarios.md)): сценарий «платформер: три платформы, яма, шипы» с
критерием «уровень собран ≤ 3 ходами тулов, персонаж не проваливается».

Ворота для тула `tilemap_paint {op: rect|fill|line, tile, from, to}`: eval показывает, что агент системно
ошибается длиной рядов или тратит > 5 ходов на правку одной области. До этого — не делать.

Рецепт Flow `recipe-platformer-2d` (фаза 3 Flow): `TileMap2D` + шаблонный `tilesets/basic.pix3tileset` с
крошечным сгенерированным PNG (4 плоских тайла в стиле placeholder-first), `core:PhysicsBody2D`/`Collider2D`
на герое, `moveAndSlide`, `core:CameraBrain`. Рецепт укладывается в кэп `MAX_RECIPE_MD_CHARS` (10 000) с
запасом — уровень в нём 30 строк.

## 7. Экспорт

- Запись в таблице стабов: `{ modulePath: 'nodes/2D/TileMap2D', keepWhenMentioned: ['TileMap2D'] }` (+
  `core/tilemap/*` как её importers). Спека таблицы пересчитает граф импортов — она же поймает value-импорт
  физики (§4). Проект без карты ⇒ **ноль** лишних байт; с картой — оценочно 6–8 KiB минифицированного кода.
- [ProjectBuildService.ts:671](src/services/export/ProjectBuildService.ts): `.pix3tileset` в regex
  ссылконосных ресурсов, чтобы текстура тайлсета попала в бандл транзитивно (иначе — «белые квадраты», уже
  наступали с `.pix3anim`). `pruneUnusedAssets`/отчёт о размере получают её как обычный ассет.
- `SceneLoader` — нейтрализованный импортёр (`NEUTRALISED_IMPORTERS`), `case 'TileMap2D'` там безопасен.
- `KNOWN_SCENE_NODE_TYPES` ([node-type-registry.ts:30](packages/pix3-runtime/src/core/node-type-registry.ts)) и
  белый список [scene-validate.ts:44](src/services/model-gen/scene/scene-validate.ts) — иначе линт назовёт ноду
  инертной, а `generate_scene_3d` отвергнет её в сценах.
- Single-file HTML: сцены едут JSON'ом, `rows` — обычный массив строк; текстура — base64 как все PNG
  (WebP-перекодировка опциональна и безопасна: ключ ассета остаётся `.png`).

## 8. Фазы

**Фаза 1 — рантайм и формат (M).** Вертикальный срез без редактора: сцена пишется руками.

- [ ] `core/tilemap/TileSetResource.ts` — тип, `parseTileSet`, нормализация (`legend`, `tiles`, дефолты), диагностики
- [ ] `AssetLoader.loadTileSet(path)` (кэш как у `.pix3anim`), `asset-categories`: `tilesets: ['pix3tileset']` → папка `tilesets/`
- [ ] `core/tilemap/TileMapView.ts` — чанковый мешер над `{rows, tileSet, texture}`; dirty-чанки; `frustumCulled` + bounding sphere; half-texel inset для `linear`
- [ ] `core/tilemap/tilemap-collision.ts` — маска solid → слитые прямоугольники (чистая функция, спека с шахматкой и L-формами)
- [ ] `nodes/2D/TileMap2D.ts` — свойства §2.2, `installReactiveSchemaProperties`, API §2.2, регистрация `Collider2DSource`-ов диффом
- [ ] `SceneLoader` case / `SceneSaver` ветка `instanceof` / `KNOWN_SCENE_NODE_TYPES` / `index.ts` barrel
- [ ] `SceneSaver`: `lineWidth: 0`; проверить дифф на `samples/**/*.pix3scene`
- [ ] Экспорт: запись в `strippable-runtime-modules.ts`, regex `.pix3tileset`, `scene-validate.ts`
- [ ] Спеки: persistence round-trip (+ строки > 80 символов), мешер (UV по id/flip, число чанков, пустые чанки), слияние коллизий, толерантность загрузчика, `color-convention.spec` не трогаем (цветов нет)
- [ ] Доки: `node-types-reference.md` §`### TileMap2D`, `nodes-and-systems.md` каталог + Scripts API, спека §7 (пример YAML + формат `.pix3tileset`), `.plans/README.md`

**Критерий готовности:** сэмпл `samples/HelloWorld/test-tilemap.pix3scene` с картой 40×20 играется:
`core:PhysicsBody2D`-ящик падает и **встаёт на тайлы**; Profiler показывает `passthrough` = числу чанков и
ни одного дополнительного вызова на тайл; `npx vitest run` зелёный, включая спеку таблицы стабов; экспорт
HTML пинбола без карты **байт в байт** не изменился; экспорт сэмпла с картой работает офлайн.

**Фаза 2 — присутствие в редакторе и агентский путь (M−).**

- [ ] `CreateTileMap2DCommand`/`Operation`, `NodeRegistry`, `create-node-registry`, иконка `grid` в дереве
- [ ] Прокси `createTileMap2DVisual` на `TileMapView`, sync в `syncAll2DVisuals`/`updateNodeTransform`/`updateNodeVisibility`, dispose
- [ ] Пикинг + рамка выделения по `bounds`; `TransformTool2d` двигает карту как целое (resize-ручки выключены — размер задаётся клетками)
- [ ] Инспектор: `file-resource` для `tileSet`, `pix3-tilemap-rows-editor` (textarea, счётчик столбцов, подсветка неизвестных символов), read-only сводка тайлсета
- [ ] `UpdateObjectPropertyOperation` понимает `rows` (тип `object`, глубокое сравнение массивов строк для `didMutate`)
- [ ] Агент: скилл game-prototype «Tile levels», сводка карты в `scene_tree`, диагностики §2.3 в линте, eval-сценарий
- [ ] Флаг `?pix3Tilemap=…` не нужен — но `__PIX3_DEBUG__`-снапшот ноды отдаёт `columns/rowCount/chunks/colliders` для `game_observe`

**Критерий готовности:** агент (Haiku-класс, как в третьем догфудинге Flow) с нуля собирает уровень
«три платформы, яма, шипы» за ≤ 3 хода тулов, персонаж бегает; правка одного ряда через `str_replace`
перезагружает сцену и видна во вьюпорте без перезапуска; Ctrl+Z после `set_property rows` возвращает карту.

**Фаза 3 — кисть (M). Ворота — §0.**

- [ ] `appState.ui.tileEditing`, `TileBrushController` (первый отказ в `editor-tab.ts`, захват pointer'а, Брезенхэм)
- [ ] Инструменты: кисть/ластик/прямоугольник/заливка/пипетка; горячие клавиши B/E/R/G/I, `[`/`]` — соседний тайл
- [ ] Undo `preview`/`commit` (§5.3); тест: 200 событий мыши → 1 запись истории
- [ ] Adornments: сетка (только в режиме), подсветка клетки, превью прямоугольника; `requestRender` после мазка
- [ ] Палитра в инспекторе (тайлы из текстуры, `solid`-бейдж, активный инструмент)
- [ ] Расширение карты за границу; play-режим — мазок доезжает до живой ноды (live sink), коллайдеры обновляются диффом

**Критерий готовности:** нарисовать 40×20 уровень мышью ≤ 2 минут; штрих — одна запись undo; во время
play пол дорисовывается под бегущим героем без перезапуска; `lint`/`type-check`/`test` зелёные.

**Фаза 4 — задел (не планируется, дверь открыта форматом):** редактор тайлсета (клик → `solid`, легенда),
`oneWay`, `encoding: csv`, per-tile `friction`, импорт Tiled `.tmj` (JSON, конвертер ~150 строк — самый
дешёвый способ получить готовые уровни из интернета), `Camera2D.limits` из `bounds` карты (S, полезно сразу).

## 9. Объём

Фаза 1 ≈ 900–1200 строк кода + ~400 тестов; фаза 2 ≈ 600–800; фаза 3 ≈ 800–1000. Для сравнения: Spine-нода —
12,6k строк, из них ~3k кода (`f4d142f7`). **Играбельный v1 = фазы 1+2**, без кисти: агент и человек правят
текст, вьюпорт показывает, физика работает. Что ещё можно не делать в v1, если поджимает: редактор строк в
инспекторе (агенту он не нужен, человек правит файл), диагностики в линте (оставить console.warn), `flipX`
в легенде.

## 10. Что сознательно НЕ делаем в v1

- **Autotiling / terrain-биты.** Самая дорогая и самая жалуемая часть Godot TileMap; агент делает «красивые
  края» текстом, человеку в playable их не нужно. Формат не мешает добавить потом (`tiles.<id>.terrain`).
- **Изометрия / гексы.** Ключ `orientation: orthogonal` зарезервирован в тайлсете, мешер v1 знает одну проекцию.
- **Бесконечные / стриминговые карты.** Кап 512×512 (262k клеток, 262 КБ строк — уже вне «агент читает файл»);
  рекомендуемый рабочий размер ≤ 128×128. Чанки уже есть — стриминг при спросе ляжет на них.
- **Навигация / поиск пути.** Оставляем `isSolidAt`/`getCell` — A* в 30 строк пишет игровой скрипт.
- **Per-cell метаданные, анимированные тайлы, несколько тайлсетов на карту** — слои = ноды, тайлсет на ноду.
- **`TileMap3D` / воксели.** DeepCore рисует свои блоки `InstancedMesh3D` (`WallsBehavior.ts`) — это другая
  задача и уже решена ECS-инстансингом.
- **Тул рисования для агента** — до ворот §6.
- **Док-панель палитры / отдельный редактор тайлсета** — до фазы 4.

## 11. Риски и ловушки этой кодовой базы

1. **Мипмапы 2D-текстур.** Без `configure2DTexture` NPOT-лист на ANGLE/Adreno грузится прозрачно-чёрным
   (`CLAUDE.md`). Плюс собственный нюанс тайлов: `LinearFilter` без half-texel inset даёт швы между клетками при
   нецелом зуме — дефолт `nearest` и inset для `linear`.
2. **Две копии three.** `instanceof TileMap2D` через шов editor↔runtime работает только благодаря
   `resolve.dedupe: ['three']`; если пикинг «не видит» карту — сначала `ls packages/*/node_modules/three`.
3. **Прокси ≠ рантайм-меши.** Всё, что рисует вьюпорт, — отдельная копия; общий `TileMapView` снимает дубль
   логики, но синхронизацию (transform/visibility/dispose/смена тайлсета/инвалидация текстуры через
   `invalidateTexture`) надо прописать во всех хуках `ViewportRenderService`, иначе карта в редакторе «отстаёт».
4. **Порядок отрисовки.** Чанки — дети; если когда-нибудь стамповать `BATCHABLE_2D_KEY` на них «ради
   батчинга», батчер попытается прочитать их как unit-квады и нарисует мусор — не делать, они уже один вызов.
5. **Реактивная схема.** `installReactiveSchemaProperties` перекрывает поля по схеме: сеттер `rows` обязан
   и перестроить чанки, и пересчитать коллайдеры, и обновить `bounds` — иначе воспроизводится класс §11.4 Flow
   («из инспектора работает, из скрипта нет»). И ветка `SceneSaver` — иначе play-режим откатывает правки.
6. **Граф импортов и стрипание.** Любой value-импорт `Physics2DService`/`Collision2DService` из ноды роняет
   `strippable-runtime-modules.spec.ts` и пинит физику во все экспорты — контракты только `import type`.
7. **YAML-складывание** длинных рядов (`lineWidth`) — §2.4.
8. **Коллаборация.** `SceneCRDTBinding` шлёт сцену целиком строкой-снапшотом (`sceneMap.set('snapshot', …)`);
   `preview`-мазки не пушатся в историю, но надо проверить, что биндинг не сериализует граф на каждый
   `invoke` — иначе штрих превращается в сотни снапшотов по сети. Если да — дебаунс на стороне биндинга, не
   особый случай для карты.
9. **Размер результата тулов агента.** `node_inspect` большой карты упирается в `MAX_TOOL_RESULT_CHARS`
   (24 000): сводка вместо полного `rows` при > 8 КБ, полный текст — через `fs_read` с диапазоном строк.
10. **Peek/ветви.** Карта верхнего уровня — отдельная ветвь Peek, всё работает само; карта внутри группы
    прячется вместе с группой — ожидаемо.
11. **Render-on-demand.** Любая правка карты вне Valtio/pointer-путей (например, из агентского `set_property`
    в фоне) обязана звать `requestRender()`, иначе «лаг до 500 мс».

## 12. Файлы (чек-лист, списан с `f4d142f7` и `ColorRect2D`)

Рантайм ([packages/pix3-runtime/src](packages/pix3-runtime/src)): `nodes/2D/TileMap2D.ts` (+ `.spec`),
`core/tilemap/{TileSetResource,TileMapView,tilemap-collision}.ts` (+ спеки), `core/AssetLoader.ts`
(`loadTileSet`), `core/SceneLoader.ts` (case), `core/SceneSaver.ts` (ветка + `lineWidth`),
`core/TileMap2DPersistence.spec.ts`, `core/node-type-registry.ts`, `index.ts`.
Редактор ([src](src)): `features/scene/CreateTileMap2DCommand.ts` + `Operation.ts`,
`services/scene/NodeRegistry.ts`, `services/agent/create-node-registry.ts`,
`services/viewport/Viewport2DProxyRegistry.ts` (visual), `ViewportRenderService.ts` (хуки),
`ViewportPicking.ts`, `services/viewport/TileBrushController.ts` (фаза 3), `state/AppState.ts`
(`ui.tileEditing`), `ui/viewport/editor-tab.ts` (маршрутизация pointer'ов), `ui/object-inspector/*`
(`pix3-tilemap-rows-editor`, палитра, рендерер по `ui.editor`), `ui/scene-tree/node-visuals.helper.ts`,
`core/asset-categories.ts`, `services/export/{strippable-runtime-modules,ProjectBuildService}.ts`,
`services/model-gen/scene/scene-validate.ts`, `services/agent/agent-skills/game-prototype.md`,
`templates/projects/recipe-platformer-2d/**` (Flow фаза 3).
Доки: `docs/node-types-reference.md`, `docs/nodes-and-systems.md`, `docs/pix3-specification.md` (§7 +
Change Log), `.plans/README.md`, `.plans/TODO.md`/`ROADMAP.md` (правит владелец репо).

## 13. Проверить при реализации (не проверено на этапе плана)

- Как нода получает `scene.physics2d` без импорта сервиса и создаётся ли он лениво (`PhysicsWorld2DBehavior`
  как прецедент); нужен ли `core:PhysicsWorld2D` в сцене для статической геометрии.
- Триггер сериализации в `SceneCRDTBinding` (на что подписан: история, `lastLoadedAt`, таймер).
- Дифф сэмплов после `lineWidth: 0` в `SceneSaver`.
- Реакция `TransformTool2d` на ноду без resize-ручек (есть ли флаг «только перемещение»).
- Как `UpdateObjectPropertyOperation` сравнивает `object`-значения для `didMutate` (массив строк по ссылке —
  всегда «изменилось»?).
