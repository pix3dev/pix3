# Spine runtime support — `SpineSkeleton2D`

Цель: новый **engine-level** 2D-нод `SpineSkeleton2D`, которому в инспекторе задают
skeleton (`.json`/`.skel`), atlas (`.atlas`) и текстуру(ы) страниц; анимации выбираются
из дропдауна (реальные имена из загруженного скелета) и управляются программно из
скриптов (`play/queue/stop/timeScale/skin/mix` + сигналы).

Решение по engine-vs-game (CLAUDE.md §Engine vs Game): Godot/Unity шиппят Spine как
встроенный нод/компонент (Godot — spine-godot, Unity — SkeletonAnimation) → **engine-level**:
runtime-нод + схема + Create*Command + YAML-сериализация + прокси во вьюпорте + инспектор,
затем `yalc:publish` и обновление DeepCore.

---

## 0. Решения, которые нужно подтвердить до кода

### 0.1 Какой Spine-рантайм

**Рекомендация:** `@esotericsoftware/spine-threejs` (тянет `@esotericsoftware/spine-core`),
запинить минорную версию под версию Spine-редактора проекта (например `4.2.x`).

- Даёт `SkeletonMesh extends THREE.Object3D` с динамической геометрией, батчерами
  (`MeshBatcher`), клиппингом (`SkeletonClipping`), blend-режимами и хуком
  `materialCustomizer` — это ровно то, что иначе пришлось бы писать самим (~1–1.5к LOC:
  обход слотов, Region/Mesh-attachment вершины, clipping, two-color tint).
- Их `AssetManager` **не используем** — он грузит через свой XHR и не умеет File System
  Access API. Собираем данные руками из строк/текстур, полученных нашим
  `ResourceManager`/`AssetLoader`:
  `new TextureAtlas(atlasText)` → каждой `page.setTexture(new ThreeJsTexture(threeTexture))`
  → `new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json)`
  (для `.skel` — `SkeletonBinary` + `Uint8Array`).
- Альтернатива (только `spine-core` + свой рендерер) — дороже на порядок и без выигрыша:
  лицензия та же, размер похожий. Брать только если `SkeletonMesh` не заведётся под наш
  2D-пасс (см. 0.4).

**Лицензия — вопрос к тебе.** Официальные Spine Runtimes идут под Spine Runtimes License:
использование требует валидной лицензии Spine у разработчика, и есть ограничения на
редистрибуцию. Поэтому предлагаю схему, которая заодно решает и вес бандла:
spine — **optional peerDependency** `@pix3/runtime` (и обычная dependency редактора),
подключается **ленивым `import()`**. Тогда pix3 не редистрибутит spine-код в своём npm-пакете,
а игровой проект (DeepCore) ставит его сам. Нужно твоё «ок» на такую модель.

### 0.2 Формат ссылки на ассет

**Вариант A (рекомендую, соответствует запросу):** три строковых свойства на ноде —
`skeletonPath`, `atlasPath`, `texturePath` (опциональный override для однопейджевого атласа;
по умолчанию страницы берутся из имён внутри `.atlas`, относительно каталога атласа).
UX-бонус: при выборе `skeletonPath` автоподставлять одноимённый `.atlas` из той же папки.

**Вариант B (позже, если понадобится):** ресурс-обёртка `.pix3spine` (по аналогии с
`.pix3anim`) с путями + дефолтными `defaultMix`/`skin`/`animation`. Даёт переиспользуемый
ассет и место для настроек, но добавляет редактор ресурса. В фазу 1 не берём.

### 0.3 Масштаб скелета

`SkeletonJson.scale` применяется **на этапе парсинга**, т.е. попадает в общий кэшируемый
`SkeletonData`. Поэтому: держим `scale = 1` при парсинге, размер регулируем трансформом
`Node2D.scale` (и/или свойством `skeletonScale`, которое пишет в `mesh.scale`). Иначе
ключ кэша `SkeletonData` придётся включать масштаб и мы потеряем шаринг между инстансами.

### 0.4 Спайк перед фазой 1 (обязателен, ~0.5 дня)

Проверить на живой сцене, что `SkeletonMesh` корректно живёт в нашем 2D-пассе:

1. Оси: 2D-камера рантайма — `OrthographicCamera(-halfW, halfW, halfH, -halfH)`
   (`SceneRunner.ts:920-928`), т.е. **Y-up с центром в нуле** — совпадает со Spine,
   флип не нужен. Подтвердить на реальном скелете (и отдельно — что anchor-layout Node2D
   не вносит y-down семантику).
2. Материалы: заставить через `materialCustomizer` → `transparent: true`,
   `depthTest: false`, `depthWrite: false`. Смешанные depth-флаги = спрайты пропадают за
   панелями (известная ловушка 2D-пасса).
3. Порядок отрисовки: `SkeletonMesh` создаёт **переменное число** дочерних batcher-мешей
   (по числу переключений материала/страницы/blend-режима). Наш `assign2DRenderOrder`
   (`core/render-order-2d.ts`) рекурсивно нумерует поддерево меша в порядке `children` —
   надо убедиться, что порядок `children` батчеров == порядок отрисовки Spine и стабилен
   между кадрами. Также: батчеры создаются лениво в первом `update()`, поэтому один
   `update(0)` должен пройти **до** первого назначения renderOrder.
4. Премультиплайд альфа: атласы часто экспортируются с `pma:true` — проверить блендинг
   и настройку текстур.
5. Blend-режимы слотов (multiply/screen/additive) в нашем пассе.

Результат спайка — короткая запись в этом файле (что подтвердилось, что пришлось обойти).
Документацию по API spine-рантайма при необходимости тянуть через context7.

---

## Фаза 1 — Runtime (`packages/pix3-runtime`)

1. **`src/core/lazy-spine.ts`** — по образцу `src/core/lazy-rapier.ts` (редактор) / ленивых
   загрузок рантайма: единый `ensureSpineLoaded(): Promise<SpineNamespace>` с
   кэшированием промиса и понятной ошибкой «Spine runtime is not installed —
   `npm i @esotericsoftware/spine-threejs@4.2`», если пакета нет. Никаких статических
   импортов spine в рантайме, иначе DeepCore и все экспорты платят за него всегда.

2. **`src/core/spine/SpineAsset.ts`** — загрузка и кэш:
   - `loadSpineAsset({skeletonPath, atlasPath, texturePath?})`:
     `resources.readText(atlasPath)` → `TextureAtlas`; для каждой страницы —
     `assetLoader.loadTexture(pagePath, { atlas: false })` (**обязательно `atlas:false`** —
     иначе пре-лаунч-атлас вернёт view с чужими UV и Spine нарисует мусор),
     `configure2DTexture()` (sRGB + `generateMipmaps=false`, см. баг с чёрными текстурами),
     затем `SkeletonJson`/`SkeletonBinary` → `SkeletonData`.
   - Кэш `SkeletonData` по ключу `skeletonPath|atlasPath` + in-flight-дедуп (как
     `AssetLoader.loadAnimationResource`). `SkeletonData` шарится между инстансами —
     инстансу принадлежат только `Skeleton` + `AnimationState`.
   - Понятная ошибка при несовпадении версий («skeleton exported from Spine 4.1,
     runtime is 4.2») — `SkeletonJson` бросает читаемое сообщение, прокинуть его наверх.
   - Метод в `AssetLoader`: `loadSpineAsset(...)` (тонкая обёртка, чтобы точка входа была
     одна и кэш жил рядом с остальными).

3. **`src/core/spine/SpineSkeletonView.ts`** — **общий** для рантайм-нода и прокси
   редактора класс-обёртка (тот же приём, что `core/tiled-sprite-geometry.ts`, но
   stateful): владеет `SkeletonMesh`, `AnimationState`, применяет материалы 2D-пасса,
   умеет `play/queue/stop/setSkin/setMix/setTimeScale/update(dt)/getBounds()/dispose()`.
   Прокси редактора и нод создают **каждый свой** `SpineSkeletonView` из одного
   `SkeletonData` — так задумано в Spine, и это снимает проблему «один Object3D в двух
   графах сцены».

4. **`src/nodes/2D/SpineSkeleton2D.ts`** — `extends Node2D`, `super(props,'SpineSkeleton2D')`,
   `isContainer = false`.
   - Свойства (и `props`): `skeletonPath`, `atlasPath`, `texturePath`, `animation`,
     `skin`, `isPlaying`, `loop`, `timeScale`, `defaultMix`, `freeOnFinish`,
     `previewInEditor` (см. фазу 2).
   - Инъекция ресурса извне, как у `AnimatedSprite2D`: `setSpineAsset(asset|null)`
     (грузит SceneLoader, нод сам ничего не фетчит).
   - `tick(dt)`: `view.update(dt * timeScale)`; на завершение непетлевого трека —
     `emit('animation-finished', name)` + `freeOnFinish → queueFree()` (та же дисциплина
     «только play-driven», что в `AnimatedSprite2D.tick`).
   - Spine-события (keyed events) → `emit('spine-event', name, ...args)`;
     `animation-start`/`animation-complete` через `AnimationStateListener`.
   - **Не** ставить `BATCHABLE_2D_KEY` — квад-батчер к динамической геометрии не применим.
   - `static getPropertySchema()`: группы `Spine` (пути ассетов, редакторы из фазы 3),
     `Animation` (animation/skin/isPlaying/loop/timeScale/defaultMix/freeOnFinish).
   - `getInstancePropertySchema()` (`InstancePropertySchemaProvider`) — **ключевой приём
     под «выбирать анимации»**: когда `SkeletonData` загружен, отдаём `animation` и `skin`
     как `type:'select'` с `ui.options` = реальные имена из скелета; пока не загружен —
     обычная строка. Именно так уже сделан per-instance-вклад shader-effects.
   - Публичный API для скриптов: `play(name, {loop, trackIndex, mixDuration})`,
     `queue(name, {loop, delay})`, `stop()`, `clearTrack(i)`, `setSkin(name)`,
     `setMix(from, to, duration)`, `getAnimationNames()`, `getSkinNames()`,
     `getSlotNames()`, `isAnimationPlaying(name?)`.
   - `disposeResources()`: диспозить только per-instance меш/материалы; `SkeletonData`
     и текстуры страниц принадлежат кэшу.

5. **Экспорт** в `src/index.ts` (нод + типы + `loadSpineAsset`).

6. **`SceneLoader.createNodeFromDefinition`**: `case 'SpineSkeleton2D':` + приватный
   `loadSpineSkeleton2DAsset(node, paths)` по образцу `loadAnimatedSprite2DAsset`
   (`SceneLoader.ts:2047`) — try/catch с `console.warn`, без падения загрузки сцены.

7. **`SceneSaver.serializeNodeProperties`**: `else if (node instanceof SpineSkeleton2D)`.
   Ключи loader/saver/схемы **должны совпадать** — по ним считается diff
   prefab-оверрайдов.

8. **Тесты** (`*.spec.ts`, happy-dom): загрузка/сериализация round-trip
   (`SpineSkeleton2DPersistence.spec.ts` по образцу существующих `*Persistence.spec.ts`),
   API `play/queue/stop`, эмит сигналов, `freeOnFinish`, поведение без установленного
   spine (мок ленивого модуля; проверить graceful degradation).

---

## Фаза 2 — Редактор: вьюпорт-прокси, создание нода

Напоминание (главная неочевидность): вьюпорт редактора **не рендерит** рантайм-меши 2D-нодов,
он строит параллельный набор прокси-групп (`src/services/viewport/Viewport2DProxyRegistry.ts`)
и рендерит их.

1. **Прокси `spineSkeleton2DVisuals`** в `Viewport2DProxyRegistry` — собственный
   `SpineSkeletonView` из того же `SkeletonData`. Провязать во всех точках:
   `processNodeForRendering`, `updateNodeTransform`, `updateNodeVisibility`,
   `syncAll2DVisuals`, `get2DVisual`, `get2DVisualRoot`, `getNodeOnlyLocalCorners`,
   `isScreenRectSelectable2DNode`, список кандидатов рейкаста, оба цикла cleanup/dispose.
2. **Порядок отрисовки:** зарегистрировать map прокси в `get2DVisualRoot` **и** в наборе
   `visualRoots` внутри `ViewportRenderService.assign2DVisualRenderOrder`; материалы
   контента — `transparent + depthTest:false + depthWrite:false`.
3. **Асинхронная загрузка в прокси** — latest-wins + liveness guard
   (`map.get(id) !== visualRoot || node.skeletonPath !== capturedPath`), иначе гонки и
   утечки на диспознутых прокси. После прихода ассета — `viewportRenderService.requestRender()`
   (вьюпорт рисует по требованию!).
4. **Границы/пикинг:** для стабильного selection-rect и `F` (Frame Selected) считать AABB
   по **setup pose** (`skeleton.getBounds()` на setup-позе), а не по текущему кадру, иначе
   рамка дёргается каждый кадр.
5. **Превью анимации в редакторе:** зарегистрировать нод в `ViewportPreviewTicker`
   (там уже живут превью анимаций/партиклов/компонентов) под флагом `previewInEditor`;
   тикер держит вьюпорт «грязным», пока превью активно.
6. **Создание нода:** `CreateSpineSkeleton2DOperation` + `CreateSpineSkeleton2DCommand`
   в `src/features/scene/`; регистрация в `src/services/scene/NodeRegistry.ts`
   (palette id `spineskeleton2d`, category `2D`, icon, keywords `spine, skeleton, bones,
   animation`); иконка в `src/ui/scene-tree/node-visuals.helper.ts`.
7. **Обновление вьюпорта по правкам инспектора:** добавить новые визуальные свойства в
   allowlist `is2DVisualProperty` (`src/features/properties/UpdateObjectPropertyOperation.ts`),
   иначе правки не перерисовывают вьюпорт.
8. `PROPERTY_GROUP_ORDER` в `src/ui/object-inspector/inspector-panel.ts` — группы
   `Spine` / `Animation`.
9. **Перезагрузка ассета при правке пути:** при смене `skeletonPath`/`atlasPath` нужно
   (а) перегрузить прокси и (б) дать **рантайм-ноду в редакторе** новый `SkeletonData`,
   иначе дропдаун анимаций останется пустым. Держать это в одном месте — небольшой
   `SpineAssetSyncService` (или ветка в существующем пути перезагрузки текстур), который
   после загрузки бампает ревизию в `appState.scenes` (инспектор подписан на неё,
   `inspector-panel.ts:221`) → инспектор перечитает per-instance-схему и покажет анимации.

---

## Фаза 3 — Инспектор и работа с ассетами

1. **Новые виды редакторов** в `PropertyUIHints.editor` (`fw/property-schema.ts`):
   вместо трёх узких видов лучше добавить **один общий** `'file-resource'` +
   `ui.extensions: string[]` (плюс, при желании, алиасы `'spine-skeleton-resource'` /
   `'spine-atlas-resource'` для дефолтных фильтров) — сейчас там уже 6 узких kind-ов
   (`texture-resource`, `audio-resource`, `model-resource`, …), плодить ещё два жаль.
   Рендер — в `src/ui/object-inspector/inspector-property-renderers.ts` рядом с
   `model-resource` (строка ~1020): пикер + drag&drop из Asset Browser
   (`onModelResourceDrop` как образец обработчика).
2. **Автоподбор соседей**: при выборе `.json`/`.skel` — искать одноимённый `.atlas`
   в той же папке и подставлять; из `.atlas` — вытащить имена страниц и подставить
   `texturePath`, если страница одна.
3. **Валидация в инспекторе**: бейдж/предупреждение, если атлас ссылается на отсутствующие
   PNG или версия скелета не совпадает с рантаймом.
4. **Asset Browser**: добавить `atlas`, `skel` в `src/core/asset-categories.ts`
   (в `animations` — Spine-ассеты логично группировать с анимациями; либо отдельная
   категория `spine`, если хочется видеть их отдельно), плюс иконку. Проверить, что
   импорт/копирование файлов не фильтрует незнакомые расширения.
5. **Дропдаун анимаций** — уже даёт per-instance-схема из фазы 1 + нудж инспектора из
   фазы 2.9. Кнопка ▶/⏸ рядом с `animation` для превью в редакторе (опционально).

---

## Фаза 4 — Экспорт, атлас, размер бандла

1. **`ProjectBuildService`** собирает ассеты сканом `res://` по сценам и скриптам —
   страницы Spine-атласа перечислены **внутри текста `.atlas`** и этому скану невидимы
   (ровно тот класс ассетов, о котором предупреждает комментарий в файле). Добавить
   парсер: для каждого `.atlas` в графе ассетов включить его страницы (и, для
   `skeletonPath`, сам `.json`/`.skel`).
2. **`TextureAtlasService`**: eligibility opt-in по типам 2D-нодов, так что страницы Spine
   в пре-лаунч-атлас не попадут сами; всё равно **явно** занести пути страниц Spine в
   `excluded` (defense in depth) — плюс сам нод грузит с `{ atlas: false }`.
3. **`BundleSizeService.CATEGORY_BY_EXTENSION`** — новые расширения.
4. **Ленивый чанк spine** должен попадать в playable-экспорт (`PlayableHtmlBuildService`) —
   проверить, что динамический импорт не теряется при сборке плеера, и что HTML-экспорт
   с одним скелетом играется офлайн.
5. Замер: вес чанка spine и стоимость `SkeletonMesh.update()` на кадр (CPU-скиннинг!) —
   в docs дать ориентир «единицы-десятки скелетов, не сотни».

---

## Фаза 5 — Документация и потребители

- `docs/node-types-reference.md` → секция `### SpineSkeleton2D` + строка в сводной таблице.
- `docs/nodes-and-systems.md` → каталог нодов + Scripts-facing API (`play/queue/…`, сигналы).
- `docs/pix3-specification.md` → «Scene File Format»: YAML-ключи нода; ченджлог/версия.
- CLAUDE.md — только если появится новая неочевидная ловушка (например про
  `atlas:false` и пре-лаунч-атлас) — одной строкой в «2D overlay rendering».
- `packages/pix3-runtime`: optional peerDependency + запись в README о `npm i` spine.
- `cd packages/pix3-runtime && npm run yalc:publish`, затем `yalc update` в `../DeepCore`;
  проверить живую сцену со скелетом в DeepCore.
- Проверка в живом редакторе через skill `debug-running-game` (состоянием/данными, а не
  скриншотами): создать нод, назначить ассеты, переключить анимации, дернуть API из скрипта.

---

## Ловушки (сводка)

| # | Ловушка | Митигация |
|---|---|---|
| 1 | Пре-лаунч-атлас подменяет текстуру страницы на view с чужими UV | `loadTexture(page, {atlas:false})` + явный exclude |
| 2 | Мипмапы на 2D-текстурах → прозрачно-чёрные текстуры на ANGLE/D3D11 | `configure2DTexture()` на каждую страницу |
| 3 | Смешанные depth-флаги в 2D-пассе → меши пропадают за панелями | `materialCustomizer`: transparent + depthTest/Write false |
| 4 | Переменное число batcher-мешей → нестабильный renderOrder | один `update(0)` до первого назначения; проверить порядок `children` в спайке |
| 5 | Вьюпорт рисует по требованию | `requestRender()` после async-загрузок; превью через `ViewportPreviewTicker` |
| 6 | Гонки async-загрузки прокси | latest-wins + liveness guard |
| 7 | `SkeletonJson.scale` пишется в общий `SkeletonData` | scale=1 при парсинге, размер — трансформом нода |
| 8 | Версия скелета ≠ версия рантайма | пин минора + читаемая ошибка в UI |
| 9 | Страницы атласа невидимы для `res://`-скана экспорта | парсинг `.atlas` в `ProjectBuildService` |
| 10 | Статический импорт spine раздувает рантайм всем потребителям | `lazy-spine.ts` + optional peerDep |
| 11 | Ключи loader/saver/схемы разошлись → ломается diff prefab-оверрайдов | одно место определения имён + persistence-спек |
| 12 | Лицензия Spine Runtimes | не редистрибутим: optional peerDep, ставит игровой проект |

## Оценка

| Фаза | Объём |
|---|---|
| 0. Спайк | 0.5 дня |
| 1. Runtime (нод, загрузка, view, loader/saver, тесты) | 1.5–2 дня |
| 2. Прокси вьюпорта + create-команда | 1–1.5 дня |
| 3. Инспектор/ассеты | 0.5–1 день |
| 4. Экспорт/атлас/бандл | 0.5 дня |
| 5. Docs + DeepCore + живая проверка | 0.5 дня |
| **Итого** | **~4.5–6 дней** |

Фазы 1 и 2 — критический путь и делаются последовательно (прокси зависит от
`SpineSkeletonView`); 3–4 можно вести параллельно после 2.
