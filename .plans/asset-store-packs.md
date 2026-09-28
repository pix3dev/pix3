# Pix3 Store: семантические паки ассетов

> Статус: ревью Codex, Gemini и Opus учтены (2026-09-27, см. §14). **Phase 0 реализована
> 2026-09-27** (§12): исправлены ключи текстур, добавлен `AnimatedSprite2D.play`,
> `core:CharacterVisual2D`, единая таблица reference-bearing типов, чистый `compileCharacter`;
> 2026-09-28 реальные Goblin/Knight (`samples/LibraryAssets/Project_Seven`) прошли автоматическую
> приёмку (`character-compiler.seven.spec.ts`); визуальная проверка в редакторе/экспорте ещё не
> проведена. Phases 1–4 не начаты.
> Решения ниже — контракт реализации; перед кодом сверять каноническую спецификацию
> (`docs/pix3-specification.md`, запись 1.41 в Change Log).
>
> Связанные планы: [asset-store-admin](frozen/asset-store-admin.md), Phase E;
> [asset-library](frozen/asset-library.md); [tilemap-2d](tilemap-2d.md).
> Этот план возобновляет только работу над паками, импортом и необходимыми ревизиями.
> Остальные пункты замороженных планов автоматически не переходят в работу.

## 1. Продуктовый результат и границы

Пользователь открывает Seven как один продукт с названием, обложкой и автором, выбирает
Goblin или Knight, переключает оружие и состояние, смотрит реальную анимацию и добавляет
готовый визуальный prefab в проект. Можно установить одного персонажа или весь пак.

```text
Seven — Pack
├── Characters
│   ├── Goblin — устанавливаемый Asset
│   │   ├── Sword — Variant: idle / run / attack / die
│   │   ├── Staff — Variant: idle / run / attack / die
│   │   └── Bow   — Variant: idle / run / attack / die
│   └── Knight — аналогичная структура
├── UI — устанавливаемый набор
└── Environment — устанавливаемый набор тайлов и props
```

Pack — единица представления и публикации. Asset — единица установки и загрузки.
Variant/state — навигация и семантика внутри ассета; отдельных карточек для каждого кадра нет.
Клип остаётся нативным клипом `.pix3anim`.

«Готовый персонаж» в первой версии означает prefab с рабочими анимациями, устойчивой точкой
привязки и API запуска состояния. Физика, управление, AI, нанесение урона, автоматические
переходы состояний и полноценная state machine в этот контракт не входят.

Первый вертикальный срез — два персонажа Seven. UI и окружение получают группировку и
установку файлов; создание семантических UI-контролов и TileMap имеют отдельные этапы.

## 2. Проверенный исходный материал

Путь: `C:\GameDevAssets\ASSETS\Murlyko\Project_Seven`.
Инвентаризация исходников выполнена 2026-09-27; абсолютный путь не попадает в публикуемые файлы.

| Раздел | Содержимое |
| --- | --- |
| Обложка | `cover.jpg`, 573×378 |
| Goblin | 135 PNG, все 100×100 |
| Knight | 135 PNG, все 100×100 |
| Environment | 29 PNG + `Ground.psd`; среди PNG 15 тайлов 50×50 |
| UI | 46 PNG; среди них 11 кадров `gems_*` и вероятные пары состояний |
| Всего | 347 файлов, 2 364 493 байта, около 2,255 MiB |

У каждого персонажа 12 клипов: 3 варианта × 4 состояния. `attack` содержит 8/10/12 кадров
для sword/staff/bow; `idle` — 12, `run` — 8, `die` — 15.
Токен `stuff` предлагается переименовать в `staff`, с подтверждением в рецепте импорта.

`sound0001/0002` и `Controls switch0001/0002` — кандидаты на UI-состояния, а не доказанные
анимационные последовательности. Импортёр обязан дать возможность исправить классификацию.
Файл лицензии в обследованной папке не найден. Публичный gate стора пропускает только
`STORE_LICENSE_WHITELIST` = `OFL-1.1 | CC0-1.0 | MIT | CC-BY-4.0`
(`src/services/library/store-validation.ts`), поэтому **публичная публикация Seven заблокирована
до подтверждения права на распространение**; Phase 0 работает только локально. Если лицензия
коммерческая, нужно отдельное решение: расширение whitelist или непубличная видимость пака.

## 3. Базис реализации и подтверждённые разрывы

Источники истины: [спецификация](../docs/pix3-specification.md) — нормативного раздела про Asset Store в ней
нет, есть записи Change Log 1.20 (Asset Library), 1.28 (Asset Store) и 1.41 (Phase 0 этого плана);
[каталог возможностей](../docs/nodes-and-systems.md), Flipbook animation, frame points,
Asset Library; [справочник](../docs/node-types-reference.md), AnimatedSprite2D.

| Область | Сейчас | Следствие для плана |
| --- | --- | --- |
| Bundle | `LibraryItemManifest`: один entry и список files | Asset сохраняет эту границу |
| Store upload | Удаляет каталог item и переписывает его | Нельзя переиспользовать для ревизий опубликованного пака |
| Sequence textures | **Исправлено (Phase 0).** Было: SceneLoader собирал `Map<number, path>` по индексу кадра внутри клипа, слитому по всем клипам; AnimatedSprite2D хранил `Map<number, Texture>` | Кадры разных клипов с одинаковым индексом перезаписывались; из idle(3)+attack(2) грузились только 3 файла. Editor viewport дефект **не показывал** (прокси держит текстуру по пути) — приёмка только play mode / экспорт |
| Проигрывание | **Исправлено (Phase 0).** Было: завершение one-shot ставит `isPlaying=false`; тот же currentClip не сбрасывает таймер; `findAnimationClip` молча подставляет первый клип | Добавлен явный `AnimatedSprite2D.play(name?, {restart})` |
| Publish to Library | **Исправлено (Phase 0).** Было: рекурсия только в scene/script, не в pix3anim. Export и insert-remap `.pix3anim` уже обходили | При повторном сохранении персонажа терялись кадры |
| Insertion | Dedup по наличию entry; запись файлов последовательно | Оборванная установка может выглядеть завершённой |
| Store preview | Статические изображения; `getBundle` скачивает все файлы неограниченным `Promise.all` **и шлёт download-ping на каждую материализацию** (`StoreLibraryProvider.ts`) | Нужен отдельный preview-host и ограниченная загрузка; preview не может идти через `getBundle`, иначе §8 «preview не увеличивает downloads» нарушается |
| Upload limits | 200 файлов, 100 MiB на файл, multer memoryStorage | Большие персонажи не проходят; простое увеличение лимита повышает расход памяти |
| TileMap | Не реализован; TiledSprite2D — nine-slice/tiling | Environment пока не обещает редактируемую карту |

Код, проверенный при ревью:

- [SceneLoader](../packages/pix3-runtime/src/core/SceneLoader.ts), `loadAnimatedSprite2DAsset`;
- [AnimatedSprite2D](../packages/pix3-runtime/src/nodes/2D/AnimatedSprite2D.ts),
  `setFrameTexture`, `syncActiveClip`, `refreshTexturePresentation`;
- [PublishToLibraryService](../src/services/library/PublishToLibraryService.ts),
  `collectResourceFile`;
- [LibraryInsertService](../src/services/library/LibraryInsertService.ts);
- [store-router](../packages/pix3-collab-server/src/core/library/store-router.ts);
- [StoreUploadService](../src/services/library/StoreUploadService.ts);
- [ResourceManager](../packages/pix3-runtime/src/core/ResourceManager.ts);
- [disk-version](../src/services/project/coauthoring/disk-version.ts).

Мультиклиповый дефект воспроизведён тестом до исправления
(`AnimatedSprite2DAnimation.spec.ts`, «multi-clip sequence textures»: без правки загружались 3 файла
из 5). Живой прогон в браузере на реальном Seven ещё не выполнен.

## 4. Принятые для реализации решения

1. Pack содержит отдельно устанавливаемые assets. Оружие — вариант одного персонажа.
2. Сохраняем `type` для механики вставки и добавляем `assetKind` для семантики Store.
3. **Отдельного ресурса `.pix3character` нет** (снято на ревью Opus). Маппинг variant/state —
   это имена клипов `.pix3anim` по соглашению `<variant>.<state>`, а выбранная пара — config
   компонента `core:CharacterVisual2D` внутри prefab. Персонаж = один prefab + один flipbook;
   `pix3 validate` уже проверяет `core:`-config; регистрировать новый тип ресурса нигде не нужно.
4. Минимальный компонент управления визуальными состояниями входит в первый срез
   (реализован). Общую state machine с условиями переходов откладываем. Обоснование
   engine-level: это Unity Sprite Library (categories/labels) + Sprite Resolver, не AnimationTree.
5. Неизменяемые ревизии нужны с первого серверного среза. UI истории и обновлений — позже.
6. Публикация переключает указатель в SQLite после завершения записи новых ревизий.
7. Рецепт импорта сохраняет ручные решения и стабильные ID.
8. Новые assets устанавливаются в `assets/store/<publisherKey>/<packKey>/<assetKey>/`;
   старые standalone items сохраняют `assets/library/<slug>/`. Внутри asset — layout managed
   sprite folder (`<slug>/<slug>.pix3anim` + `<variant>_<state>_<nnnn>.png`), чтобы Sprite Editor
   показывал персонажа одной карточкой и умел писать кадры обратно.
9. Хэши доставки и защиты записи считаются по точным байтам. Нормализованный текстовый
   хэш — дополнительная классификация изменений, не замена точного хэша.
10. PSD и другие исходники доступны отдельным скачиванием и исключены из обычной установки.
11. Превью использует собственный набор ресурсов и не требует открытого проекта.
12. Хранилище остаётся на диске collab-server; миграция в S3/CDN не входит в первый срез.

## 5. Модель данных, идентичность и версии

### 5.1 Идентификаторы

`packId` и `assetId` выдаются один раз и сохраняются в рецепте. Переименование title/slug,
перемещение исходной папки и перестановка карточек не меняют ID.
При импорте без рецепта создаётся новый draft; режим «Reimport existing pack» привязывает
исходники к существующему рецепту. Совпадение имён само по себе не даёт права заменить пак.

`publisherKey/packKey/assetKey` — безопасные, неизменяемые сегменты пути, назначенные при создании,
с коротким ID-суффиксом для уникальности. Это не displayName и не текущий title.
Валидация учитывает Windows: регистр, reserved names, завершающие точки/пробелы, traversal.
Фактический путь установки хранится в lock и никогда не выводится заново из нового названия.

Разделяем `schemaVersion` (формат), `version` (человекочитаемая версия продукта) и
`revisionId` (точная неизменяемая поставка). Читающий клиент фиксирует revisionId до загрузки файлов.

### 5.2 Pack и Asset

Pack manifest содержит:

- schemaVersion, packId, publisherId, стабильные keys;
- name, description, tags, categoryPath, publisherName;
- version, changelog, cover, gallery;
- license, attribution и пути общих файлов;
- упорядоченный список `{assetId, assetRevisionId, section, sortOrder}`.

Asset manifest расширяет текущий LibraryItemManifest:

- `packId`, `revisionId`, `assetKind`;
- `type`, `entry`, `files` остаются контрактом bundle;
- для `character2d` — `entry` указывает на prefab; отдельного descriptor нет (см. §4 п.3);
- краткие `facets`: variants, states, clipCount, frameCount;
- для каждого файла — путь, размер, MIME, raw SHA-256 и роль;
- роль файла: runtime, attribution, preview или source.

В первом срезе каждый Asset самодостаточен: установка не требует другого Asset.
Общие runtime-файлы при компиляции дублируются внутри соответствующих bundle.
Межассетный граф зависимостей и его version solver отложены.
«Dependency closure» означает обход ресурсов внутри выбранного bundle.

UI-kit/environment без prefab используют явную установку «files only»: новый `LibraryItemType`
`'bundle'` (в `library-types.ts` подходящего значения нет, а `inferItemTypeFromPath` по умолчанию
даёт `image`, что включило бы `CreateSprite2DCommand`). Для них `entry` отсутствует; Add to scene
скрыт. `LibraryInsertService` уже корректно ведёт себя без `entry` (dedup по `targetDir`, без
вставки в сцену). Нельзя выбирать случайный первый PNG как представителя набора.

### 5.3 Общие файлы и атрибуция

У ревизии Pack свой файловый manifest: cover/gallery — preview; license/NOTICE — attribution;
PSD — source. Все пути относительны корню этой ревизии.

При компиляции каждого Asset необходимые license/attribution-файлы копируются в его bundle.
Так выборочная установка и последующий перенос в My Library сохраняют атрибуцию.
UI наследует лицензию от Pack; сервер проверяет её согласованность с каждым Asset.
Overrides лицензии детей в v1 не поддерживаются: несовместимые лицензии требуют разделения пака.

Preview и source не копируются в проект. PNG, одновременно являющийся кадром и миниатюрой,
остаётся runtime-файлом: роль preview не может удалить достижимую runtime-зависимость.
Download source — отдельное действие с указанием размера, не часть Add entire pack.

## 6. Персонаж и контракт рантайма

### 6.1 Ресурс и prefab

Реализовано в Phase 0 как выход `compileCharacter` (`src/services/library/character-compiler.ts`):

```text
prefabs/Goblin.pix3scene              Group2D root (+ core:CharacterVisual2D) → AnimatedSprite2D Visual
sprites/goblin/goblin.pix3anim        клипы sword.idle, sword.run, …, bow.die (и без варианта: die)
sprites/goblin/sword_idle_0001.png    managed sprite folder, <clip-prefix>_<nnnn>
LICENSE.txt / NOTICE.txt              атрибуция (§5.3)
```

Компонент на корне prefab:

```yaml
components:
  - id: goblin-character
    type: core:CharacterVisual2D
    enabled: true
    config: { variant: sword, state: idle, separator: '.' }
```

`spriteNodeId` пустой = первый `AnimatedSprite2D`-ребёнок корня. Descriptor-файла нет: набор
variants/states читается из имён клипов (`getVariants()` / `getStates(variant)`), facets для Store
компилятор считает из тех же имён. FPS, loop, кадры, events, points и размеры — только в `.pix3anim`.

Visual: `sizeMode: native`, `animationResourcePath: res://sprites/goblin/goblin.pix3anim`,
`currentClip: sword.idle`, `isPlaying: true`. В native-режиме `width`/`height` не участвуют в
раскладке — размер кадра берётся из `sourceSize`, который компилятор проставляет каждому кадру
(для Seven 100×100). Точка привязки проверяется по исходным кадрам при живой приёмке.

### 6.2 Исправление идентичности текстур — первый блокер

**Сделано (Phase 0).** Точки правки: `SceneLoader.loadAnimatedSprite2DAsset` (уникальные
`texturePath` по всем клипам, каждый грузится один раз) и `AnimatedSprite2D` (`frameTextures:
Map<string, Texture>` по `texturePath`; `setFrameTexture(path | index, texture)` — числовой индекс
оставлен как совместимый адаптер и адресует только кадры активного клипа; `refreshTexturePresentation`,
`resolveFrameSourceSize`, `disposeResources` переведены на путь). JSON-формат `.pix3anim` не менялся.
Единственный вызов `setFrameTexture` был в `SceneLoader`; DeepCore его не использует.

Editor viewport **не является доказательством** исправления: прокси `Viewport2DProxyRegistry` и до
правки держал текстуру текущего кадра по пути. Приёмка — play mode и экспорт.

Коллизия одинаковых `res://` путей между двумя preview-бандлами — не свойство ноды, а кэшей
`AssetLoader` (`textureCache`, `animationResourceCache` по пути): требование перенесено в §8
(отдельный `AssetLoader`/`ResourceManager` на каждый preview-host).

### 6.3 Запуск и повтор состояния

**Сделано (Phase 0).** `AnimatedSprite2D.play(name?, { restart?: boolean }): boolean` — та же
форма, что `SpineSkeleton2D.play`. Существование клипа проверяется явно по списку клипов ресурса
(не через `findAnimationClip`, который молча подставляет первый клип): неизвестное имя → `false`,
ничего не меняется. Другой клип всегда начинается с кадра 0 и сброшенного таймера; тот же клип
сохраняет позицию, `restart: true` начинает с нуля и оживляет завершённый one-shot.
Без имени — повтор текущего клипа. Добавлен `getClipNames()`.

Поведение до загрузки ресурса зафиксировано и покрыто тестом: `SceneLoader` грузит `.pix3anim`
асинхронно (`void this.loadAnimatedSprite2DAsset`), поэтому `onStart` компонента почти всегда
раньше. Имя принимается (`currentClip`, `isPlaying=true`) и разрешается в `setAnimationResource`;
если его там нет — `console.warn` с перечнем доступных клипов и прежний fallback на первый клип.
Сигнал `animation-started` не добавлен (не нужен для gate).

`core:CharacterVisual2D` (`packages/pix3-runtime/src/behaviors/CharacterVisual2DBehavior.ts`):
`playState(state, {restart})`, `setVariant(variant)` (сохраняет state, начинает клип заново; пара без
клипа → отказ без изменений), `getVariants()`, `getStates(variant?)`, `clipNameFor`, сигнал
`state-finished (state, variant)` на host-ноде поверх `animation-finished` текущего клипа.
Завершение one-shot удерживает последний кадр; переход в idle вызывает игра. Компонент не содержит
movement, physics, AI, damage и автоматических переходов; events/sockets остаются средствами pix3anim.
Приёмка (спеки `CharacterVisual2DBehavior.spec.ts`, `character-compiler.headless.spec.ts`):
повторный attack с кадра 0, возврат в idle, смена варианта после die, неизвестная пара → `false`.

### 6.4 Полный жизненный цикл ресурсов

Регистрировать новый тип ресурса не нужно (§4 п.3). Обход графа: prefab → `.pix3anim` → PNG;
прямая ссылка Visual → pix3anim и есть единственная ссылка.

До Phase 0 «одной таблицы» reference-bearing типов не существовало — было не меньше восьми
разошедшихся списков (export знал `prefab`, publish — `pix3prefab`; move-remap переписывал только
`.pix3scene`, так что перенос папки кадров ломал ссылки из `.pix3anim`). **Сделано:**
`RESOURCE_GRAPH_EXTENSIONS` + `isResourceGraphPath` в `src/core/asset-categories.ts`
(`pix3scene | pix3prefab | prefab | pix3anim`) теперь питают publish-to-library
(`isResourceGraphReference`), playable export (`ProjectBuildService.isScannableResource`),
insert-remap (`TEXT_REFERENCE_EXTENSIONS`) и move-remap (`ProjectService.rewriteSceneFilesAfterMove`);
спека в `asset-categories.spec.ts` фиксирует состав таблицы. `PublishToLibraryService` рекурсирует в
`.pix3anim` (спека: prefab → pix3anim → все PNG в bundle).

Ещё не сведены к таблице и остаются follow-up (Phase 2/3, не блокируют gate): `packages/pix3-cli/src/validate/validate.ts`
`REFERENCING_EXTENSIONS`, `TextureAtlasService.ts`, `AssetImportService.ts`, `BundleSizeService.ts`,
и MIME-списки (`PlayableHtmlBuildService.ts`, `remote-preview/protocol.ts`,
`pix3-cli/src/serve/content-type.ts` — там `.pix3anim` отдаётся как `text/yaml`, хотя формат JSON).

Приёмка Phase 3: Store → проект → My Library → чистый проект → экспорт без подключения к Store.

## 7. Импорт и сохранённый рецепт

### 7.1 Wizard

New Store pack… принимает папку/ZIP. Этапы:
сканирование → дерево → настройки/preview → metadata/license → upload draft → publish.
Существующий single-item upload остаётся отдельным совместимым входом.

Scanner сначала восстанавливает рецепт, затем группирует по числовому суффиксу, сортируя численно.
Выявляет gaps, дубли frame number, смешанные размеры, ошибочные PNG и неоднозначные имена.
Не требует последовательности, начинающейся строго с 0001; gaps требуют решения автора.
Никаких правил, жёстко привязанных к имени Seven, в общем парсере.

### 7.2 Рецепт pack.json

**Phase 2** (перенесено из Phase 0 на ревью: рецепт завязан на packId/assetId из Phase 1 и для
runtime-gate не нужен). Рецепт — редактируемые входные данные компилятора, отдельно от публикуемого manifest.
Хранит schemaVersion/compilerVersion, packId, assetId, стабильные keys, cover selection,
исходные относительные пути и hashes, правила группировки, явные overrides, порядок кадров,
variant/state mappings, FPS, loop, anchors, исключения и source/runtime roles.
Существующие events/points и ручные изменения не теряются при reimport.

Хранится в admin-only данных draft на сервере; до первой загрузки — в локальном черновике.
Wizard предлагает экспорт pack.json для переносимого повторного импорта. Запись в исходную
папку — отдельное явное действие; загрузка рецепта возможна рядом с ZIP.
Публикуемые endpoints рецепт и локальные сведения автора не отдают.

Переименование сохраняет ID. Split создаёт новые ID с явной заменой состава draft.
Merge/removal показывает diff и не удаляет опубликованные ревизии.
Reimport сравнивает source hashes и повторно применяет решения; неоднозначные совпадения требуют
ручной привязки. Нет рецепта — New pack или явный Reimport existing, без перезаписи по title.

### 7.3 Компиляция

**Ядро сделано в Phase 0**: `compileCharacter(spec)` — чистая функция без DI, DOM и файловой
системы; вход — кадры, уже сгруппированные в клипы `{variant, state, frames[{path,width,height}], fps?,
loop?}`, выход — `.pix3anim` (объект + сериализованный JSON), prefab YAML, план копирования
`{sourcePath → targetPath}` и список warnings. Детерминирована: одинаковый вход даёт байт-в-байт
одинаковый выход; timestamps/revisionId — за её пределами. Исходные пути в выход не попадают.
`scanNumberedSequences(files)` — общий первый проход: группировка по `<dir>/<stem>` и числовому
суффиксу, численная сортировка, отчёт о gaps, дублях номеров и смешанных размерах; файлы без
номера — отдельный список, а не «клип из одного кадра». Никаких правил, привязанных к Seven.

Default FPS 12 — предлагаемое значение, не восстановленная авторская скорость; idle/run loop=true,
attack/die/hit loop=false (`ONE_SHOT_STATES`). Оба умолчания попадают в warnings, автор подтверждает
их в preview (Phase 2). Холст сохраняется как есть (`sourceSize` на каждом кадре, `sizeMode: native`),
автоматический trim выключен. Опция `anchor` задаёт якорь всех кадров (точка холста, попадающая
в позицию ноды). По умолчанию центр холста; для персонажа это линия ног. У Seven последний
непрозрачный ряд во всех кадрах idle/run/attack обоих персонажей равен 84 из 100, отсюда
`{x: 0.5, y: 0.85}`. Wizard (Phase 2) должен предлагать это значение из замера, а не угадывать.

Phase 2 добавляет поверх ядра: рецепт (§7.2), wizard, Pack media/attribution/source, manifests с
hashes и validation report. Опциональный atlas bake позже сохраняет anchors/events и проходит
сравнение с source sequence. Действующий pre-launch atlas проекта не считается готовым инструментом
компиляции Store-пака.

## 8. Превью до установки

Preview-host создаёт собственный ResourceManager/AssetLoader, renderer и AnimatedSprite2D.
Он работает без проекта, не использует DI-singleton ресурсов текущей сцены и не запускает
поставленные паком произвольные scripts.

Для локального draft ресурсы поступают из Map<bundlePath, Blob>.
Для Store сначала загружается конкретный assetRevisionId; файлы собираются в такую же карту.
Adapter разрешает res:// только внутри этого manifest, поддерживает readText/readBlob/texture URLs
и отказывает при missing resource без fallback к проекту или произвольной сети.
Полезную часть адаптера переиспользовать с имеющимся ResourceManager вместо второго playback engine.

Загрузка — максимум 6 запросов одновременно, отмена при уходе и игнорирование устаревших ответов.
Кэш в памяти ключуется по origin + assetRevisionId + file hash; повтор выбора не скачивает те же
байты. Это не обещание офлайн-доступа после перезагрузки: постоянный OPFS-кэш отложен.
Число запросов при первом preview всё ещё равно числу файлов; память не устраняет этот расход.

На карточке — static preview, animated WebP опционален позже. Один активный интерактивный preview
в detail-view: variant/state, play/pause/restart, speed, scale, background. Закрытие освобождает
GPU resources, object URLs, listeners и playback loop; очистка cache имеет ограничение по объёму.
Preview не увеличивает downloads: install ping отправляется отдельно после успешной установки.

## 9. Сервер: ревизии, публикация и права чтения

### 9.1 Минимальная схема с первого релиза

Три таблицы вместо пяти (упрощение по ревью Opus; неизменяемость от этого не страдает):

- `store_packs`: packId, owner, стабильные keys, visibility (`draft | published | unlisted |
  withdrawn` — статус живёт здесь, не в `library_items.status`, где `withdrawn` нет), currentPublishedRevisionId.
- `store_pack_revisions`: packRevisionId, packId, version, pack manifest, draft generation, состояние
  подготовки/публикации, admin-only recipe JSON.
- `store_pack_revision_assets`: packRevisionId → assetKey, assetKind, asset manifest + hash, section,
  order, состояние complete. `assetRevisionId` = `packRevisionId` + `assetKey`.

Переиспользование неизменённых asset-ревизий между релизами — оптимизация объёма, не условие
неизменяемости; откладывается. Существующие `library_items` и endpoints сохраняются для standalone
items; провайдер объединяет записи для UI, legacy POST не может перезаписывать revision assets.
**Отдельное пространство id от `library_items` обязательно**: сейчас `upsertPublicItem` делает
`ON CONFLICT(id) DO UPDATE SET owner_id=…, visibility='public'` без проверки владельца, то есть
store POST с id приватного item'а перехватывает его — существующий дефект, заведён в `TODO.md`.
Колонки facets — вычисленный индекс по именам клипов, не отдельная редактируемая истина.

### 9.2 Диск и публикация

```text
LIBRARY_STORAGE_DIR/
├── <legacy-itemId>/...
├── store-packs/<packId>/<packRevisionId>/{media,attribution,source}/...
├── store-packs/<packId>/<packRevisionId>/assets/<assetKey>/...
└── staging/<uploadSessionId>/...
```

Новые файлы никогда не заменяют опубликованные байты. Upload пишет во временный каталог на
том же filesystem, проверяет содержимое/manifest/hash, закрывает запись, затем rename переводит
завершённую ревизию в её постоянный каталог. Только после этого БД помечает её complete.
Сбой между rename и БД оставляет неиспользуемые байты, а не публичную битую ссылку.
Повтор upload идемпотентен по session/file hash; complete revision не меняется.

Publish проверяет complete всех детей/общих файлов и одной транзакцией SQLite переключает
currentPublishedRevisionId. Предыдущий release и скачивания по его pinned URL продолжают работать.
Publish принимает `expectedGeneration` (дёшево); отдельного `PUT recipe` с preconditions в первом
срезе нет — в prod один админ (frozen asset-store-admin §11.1).
Публичные файлы раздаются через проверяющий route, не через открытый static mount.

История версий и update UI не обязательны сейчас, но immutable revision storage обязателен.
Статусы скрывают незавершённый новый пак; сами по себе они не изолируют изменения уже опубликованных
файлов — поэтому вариант «те же itemId + только draft в БД» не принимается.

### 9.3 Минимальная форма API

Под /api/library/store:

| API | Назначение |
| --- | --- |
| GET /packs | Карточки доступных паков |
| GET /packs/:id | Текущий опубликованный manifest и pinned revision |
| GET /packs/:id/revisions/:revisionId | Состав конкретного release |
| GET /packs/:id/revisions/:revisionId/files/* | Cover/gallery/attribution/source |
| GET /assets/:id/revisions/:revisionId | Manifest выбранного bundle |
| GET /assets/:id/revisions/:revisionId/files/* | Файл из manifest |
| POST /packs/:id/drafts | Создание draft от текущего release или нового пака |
| PUT /packs/:id/drafts/:draftId/recipe | Admin-only рецепт (precondition — только в publish) |
| POST /packs/:id/drafts/:draftId/uploads | Сессия загрузки asset или общих файлов |
| POST /packs/:id/drafts/:draftId/publish | Проверка и атомарная публикация |
| PATCH /packs/:id | Visibility/curation, без изменения immutable bytes |

Точный multipart/session wire фиксируется в Phase 1 вместе с resume/cancel и server capabilities.
Downloads — отдельный идемпотентный install event, не побочный эффект GET/preview.
Pack download count — одна установка пака; asset count — успешные установки детей.
Retry одного installId не увеличивает счётчик повторно.

### 9.4 Матрица видимости

| Состояние | Каталог анонимно | Прямая ссылка / files анонимно | Admin |
| --- | --- | --- | --- |
| Только draft, нет release | Нет | 404 | Draft preview/upload |
| Published + новый draft | Текущий published | Только опубликованные ревизии | Также новый draft |
| Unlisted | Нет | Опубликованные ревизии доступны | Все разрешённые операции |
| Withdrawn | Нет | 404 для всех pack/asset/source URLs | Просмотр и восстановление |

У детей нет независимо переключаемой публичности: доступ выводится из Pack и членства assetRevision
в опубликованном release. Draft revision не становится доступной просто по знанию её ID.
Все file routes применяют эту же проверку и manifest allowlist. Admin writes требуют текущую
аутентификацию/CSRF-проверки; publisherId определяется сервером.

В v1 удаление опубликованного пака означает withdrawn, не физическое уничтожение ревизий.
Это **заменяет решение frozen asset-store-admin §7 (hard delete + audit) для pack-ревизий**;
legacy standalone items сохраняют hard delete (`store-router.ts` DELETE).
Удаление draft и сборка неиспользуемых staging-каталогов допустимы; опубликованные bytes
не собираются GC в первом срезе. Установленные проекты продолжают работать автономно.
Изменение состава детей — новый release, не удаление строки из старого состава.

### 9.5 Лимиты и память

Seven проходит нынешние 200 файлов на Asset, но 240-кадровый персонаж уже не проходит.
Для нового revision upload начальный профиль: 500 файлов, 100 MiB на файл, 256 MiB на Asset,
512 MiB распакованных данных на Pack. Это проектные ограничения, а не замер вместимости production.
Сервер выдаёт capabilities; клиент валидирует по ним до загрузки, сервер повторяет проверку.
Legacy upload сохраняет прежние лимиты.

Новый route пишет multipart потоком на диск (`multer.diskStorage` в staging вместо
`memoryStorage`, отдельной архитектуры не требуется) с лимитом общего тела и числа файлов;
поднятие files до 500 поверх memoryStorage не принимается.
ZIP сканируется с лимитами распакованного объёма и числа записей, duplicate paths и traversal
отвергаются. Размер PNG после decode также учитывается в бюджете preview.
При превышении — понятная ошибка и возможность разделить Asset; молча отбрасывать кадры нельзя.
Позже compiler atlas bake может сократить запросы и файлы, но не заменяет корректную валидацию.

## 10. Установка, журнал и обновления

### 10.1 Действия

Add to project устанавливает один Asset. Add to scene завершает установку и создаёт prefab instance
через CommandDispatcher. Add entire pack фиксирует одну pack revision и устанавливает детей
по очереди, показывая результат каждого; сцена не заполняется автоматически.
В первом срезе whole-pack install допускает частичный успех, явно показанный в UI; retry продолжает
недостающих детей той же pinned revision.

Скачивание и планирование — read-only. Как и в `LibraryInsertService` сейчас (и по
asset-store-admin §2.6): **копирование файлов и запись lock — сервисный шаг вне undo**, с учётом
project ownership/lease и backend; через `CommandDispatcher` идёт только создание instance
(`CreatePrefabInstanceCommand`). Scene undo удаляет instance, установленные файлы сохраняются как при
обычном импорте. Отмена во время загрузки не создаёт scene nodes.

### 10.2 Store lock

.pix3/store-lock.json имеет schemaVersion, origin и ключ origin+assetId.
Запись хранит packId/packRevisionId, assetRevisionId, display version, targetDir,
installedAt, remapperVersion и список фактически установленных project-relative путей.
Для каждого файла: sourceRawSha256, installedRawSha256, optional installedTextSha256.
Роль attribution сохраняется. Preview/source в список установленных файлов не входят.

installedRawSha256 вычисляется после remap и проверяется чтением реальных файлов.
sourceRawSha256 проверяет доставку; его нельзя сравнивать с переназначенным текстом проекта.
Хэши ставит код, не доверяет значению из произвольного локального manifest.

Lock закрывает открытый вопрос §11.5 frozen asset-store-admin (формат маркера «Update available»).
Lock и install journal не входят в playable export — `.pix3/` уже исключён
(`ProjectBuildService.ts`). License/NOTICE входят в экспортный набор
атрибуции, включая zip; для single-file HTML определить место атрибуции в build metadata/UI.
Хранение lock/journal проверить на local, OPFS, workspace и cloud backend; отсутствие доступа
к .pix3 не должно приводить к объявлению безопасной установки без provenance.

### 10.3 Хэши текста и CRLF

**Phase 4** (перенесено на ревью: установка v1 никогда не перезаписывает отличающийся файл — §10.4
п.3, — так что нормализованный хэш нужен только для классификации изменений при обновлении).
SHA-256 точных байтов остаётся обязательным для download integrity, If-Match и pre-write check,
в соответствии с disk-version.ts/co-authoring contract.

Для известных текстовых ресурсов дополнительно считать text-v1 hash: UTF-8 decode,
CRLF → LF; остальное, включая BOM, сохранять. JSON/YAML не пересериализовывать для сравнения.
Это позволяет отличить изменение только переводов строк от изменения содержимого.
Такая разница показывается как formatting-only; при обновлении сохраняется обнаруженный стиль
переводов строк, затем фиксируется новый raw hash. Смешанные окончания строк — ручной конфликт.
Даже при совпадении text hash непосредственно перед записью проверяется raw hash текущего файла.
Неизвестные расширения и binary сравниваются исключительно по байтам.

### 10.4 Устойчивая установка

В v1 установка создаёт только новые файлы в свежем namespace; изменяемых файлов нет, поэтому
backups не нужны, а journal и lock — одна запись:

1. Зафиксировать revision, проверить manifest и raw hashes загрузки.
2. Построить полный список целей после remap, проверить containment и коллизии.
3. Если цель уже есть без lock: идентичные ожидаемые байты можно принять; различающиеся —
   конфликт или новый namespace, без молчаливой перезаписи.
4. Записать lock-запись со `state: 'pending'`, revision, целями и ожидаемыми hashes.
5. Записать зависимости, затем entry; перечитать все записанные файлы и проверить хэши.
6. Перевести запись в `state: 'complete'` только после проверки всего набора.
7. Только затем создать instance.

Наличие entry само по себе никогда не означает завершённую установку.
На local/OPFS/cloud нет предположения об атомарной транзакции нескольких файлов.
При сбое pending-запись позволяет retry/repair; rollback удаляет только созданные этой установкой
файлы, хэши которых всё ещё совпадают с записанными. Более поздние внешние изменения сохраняются.
Для workspace применять штатный lease/If-Match; для остальных backend повторный pre-write check.
Изменение проекта между download и commit отменяет применение к новому проекту.

### 10.5 Обновления — отдельная последующая фаза

Повторная установка той же revision проверяет/восстанавливает пропуски и не затирает изменения.
Новая revision не устанавливается поверх старой скрытно: до update UI показать
«другая версия уже установлена» и предложить отдельную копию.

Update UI строит diff: unchanged → safe replacement; changed → конфликт;
removed upstream → удаление только при подтверждённом совпадении с базой;
new upstream + existing local path → конфликт. Применяется тот же journal и raw precondition.
Side-by-side получает новый namespace, свои remapped references и lock record;
существующие scene instances сохраняют старые ссылки до отдельной команды миграции.

## 11. Представление Store и совместимость

Catalogue показывает одну карточку Seven с обложкой и counts.
Pack detail: Overview / Characters / UI / Environment.
Goblin и Knight — две карточки, каждая открывает variant/state preview.
Поиск может находить персонажа и открывать его внутри пака; каталог не дублирует всех детей
как standalone items.

Сохранить обычные standalone library items, My Library, fallback public/library и существующий
drag MIME. Новый payload различает pack/asset и несёт pinned revision; drag Asset создаёт instance,
drag всего Pack не должен превращаться в сотню нод.
UI принимает поздние сетевые ответы только для актуального выбора.

Для UI/environment в v1: thumbnails и Add section/files only.
Кнопки с состояниями, nine-slice metadata и UI-prefab generation — расширение импорта.
До реализации tilemap-2d набор называется Environment; никаких обещаний tile painting/autotiling.
Исходный Ground.psd доступен только через Download source.

## 12. Фазы и критерии завершения

### Phase 0 — runtime и переносимый персонаж

**Реализована 2026-09-27** (запись 1.41 в спецификации). Сделано:

- Воспроизведение межклиповой коллизии спекой до правки (`AnimatedSprite2DAnimation.spec.ts`).
- Ключи текстур по `texturePath`; `AnimatedSprite2D.play(name?, {restart})`, `getClipNames()`;
  зафиксированное поведение до загрузки ресурса (спека с отложенным loader).
- `core:CharacterVisual2D` (`getPropertySchema`, регистрация в `register-behaviors.ts`, экспорт из
  `@pix3/runtime`, запись в `STRIPPABLE_RUNTIME_MODULES` + `importers` у `nodes/2D/AnimatedSprite2D`).
- `RESOURCE_GRAPH_EXTENSIONS` для publish/export/insert-remap/move-remap; рекурсия publish в `.pix3anim`.
- Чистый `compileCharacter` + `scanNumberedSequences` с синтетическими спеками; headless-прогон
  скомпилированного prefab через реальный `SceneLoader` (`character-compiler.headless.spec.ts`).
- Документация: `node-types-reference.md` (AnimatedSprite2D), `nodes-and-systems.md` (рецепт
  «Character with variants/states», строка `core:` в таблице), CLAUDE router, changelog 1.41;
  пересобраны `packages/pix3-cli` runtime-types и kit, `kit.spec.ts` зелёный.
- Recipe/ID/reimport — перенесены в Phase 2 (§7.2).

Gate (пересмотрен: pixel-проверка в **play mode и HTML-экспорте, не во viewport**):
правильные pixels для всех 12 клипов, idle→attack→idle→attack, variants после die, round-trip через
My Library и экспорт. Автоматическая часть закрыта спеками, в том числе на реальных кадрах:
`character-compiler.seven.spec.ts` сканирует 2×135 PNG, проверяет длины 12 клипов, отсутствие
gaps/дублей, линию ног и якорь, а через реальный `SceneLoader` сверяет декодированные пиксели
показанного файла с исходным кадром для каждого кадра каждого клипа. Собранный из них проект
проходит `pix3 validate` (0/0) и `pix3 smoke` (120 кадров, 0 ошибок). **Визуальная проверка в
редакторе и HTML-экспорте, а также round-trip через My Library ещё не проведены**: нужен браузер.
Серверных изменений в Phase 0 нет.

Пак лежит в git (`samples/LibraryAssets`, коммит `ab431700`) вопреки исходному «частный пак не в
git»; лицензия по-прежнему не подтверждена (§2).

### Phase 1 — серверный контракт ревизий

- Миграции Pack/Asset/revision/recipe, дисковый staging и immutable storage.
- Publish transaction, generation preconditions и матрица доступа.
- Общие файлы, роли, limits/capabilities, streaming upload.
- Совместимость standalone endpoints; никакой записи ревизий через legacy POST.

Gate: сбой любой стадии upload оставляет старый опубликованный release полностью доступным;
параллельный download получает байты ровно pinned revision; draft недоступен всем публичным routes.
Migration проверяется с существующими private/public items и файлами.

### Phase 2 — compiler wizard и витрина

- Рецепт pack.json (§7.2): стабильные ID, overrides, save/export recipe, reimport diff.
- `LibraryItemType` `'bundle'` для files-only наборов (§5.2); сведение оставшихся списков
  расширений к `RESOURCE_GRAPH_EXTENSIONS` (§6.4).
- Семантическое дерево, ручная коррекция.
- Pack/Asset manifests, роли исходников/атрибуции, license gate.
- Независимый preview-host, ограниченная загрузка, cancel/dispose.
- Pack catalogue/detail, variants/states, upload draft/publish.

Gate: folder picker Seven → две корректные character cards → reimport без потери исправлений;
смена title не меняет assetId; preview работает без открытого проекта.
События/sockets, отсутствующие в recipe, не обязательны для публикации v1.

### Phase 3 — установка и законченный первый срез

- Store namespace, pinned download, remap, lock и pending journal.
- Add Asset to project/scene, Add entire pack с отчётом частичного успеха.
- Preflight conflicts, resume/repair, backend ownership/lease.
- Docs и CLAUDE router для новых runtime API и форматов.

Gate: один Goblin устанавливает только его runtime/attribution files; interruption/retry безопасен;
My Library round-trip и автономный playable проходят; старый standalone flow сохранён.

### Phase 4 — последующие расширения

- Update diff/conflict UI, side-by-side и явная миграция ссылок.
- Полноценный авторинг events/sockets/collision hints через переиспользование Sprite Editor.
- UI-state mappings и генерация UI-prefab.
- Опциональный atlas compiler с независимым pixel comparison.
- TileSet integration после отдельного TileMap gate.
- Постоянный offline cache/CDN по замерам, без обещания в первом срезе.

## 13. Независимая верификация

| Проверка | Независимое доказательство |
| --- | --- |
| Multi-clip textures | ✅ спека: 5 файлов из 5 загружены, `material.map` каждого кадра каждого клипа — свой файл. Живой pixel-тест в play mode/экспорте — отдельно, не во viewport |
| Seven compiler | ✅ `character-compiler.seven.spec.ts`: listing и размеры читаются независимо от компилятора, 135 кадров каждого персонажа, порядок и длины клипов, пиксели каждого кадра. Синтетика: ✅ `character-compiler.spec.ts` |
| Выравнивание (замер) | ✅ линия ног 84/100 во всех кадрах idle/run/attack обоих персонажей; die опускается до 97 (падение тела). Якорь 0.5/0.85 |
| Выравнивание | Сравнить исходную sequence и runtime при одинаковом canvas/anchor; screenshot нужен для этой визуальной проверки |
| Publish | Прервать upload и читать старый release анонимно; hashes сверить с сохранённым исходным release |
| Права доступа | Проверить draft/withdrawn через index, detail, asset files и source URLs |
| Preview | Без проекта; одинаковые пути в двух разных assets; отмена загрузки и отсутствие stale texture |
| Install | Сбой после entry/нескольких кадров; retry и полное чтение с диска, не вывод installer |
| Хэши | Raw differs при CRLF; text hash совпадает; изменённый токен даёт конфликт; post-remap база корректна |
| Reimport | Rename/reorder, новые/удалённые кадры, сохранённые FPS/anchor/ID |
| Round-trip | Store → project → My Library → другой project → HTML/zip offline |
| Backend | local/OPFS/workspace/cloud: провал записи lock, смена проекта, lease conflict и внешняя правка |
| Limits | 240 frames accepted; 501 files/oversized body/ZIP expansion rejected до публикации |

Живая проверка ведётся в локальном editor/backend, с synthetic fixtures для автоматических тестов.
Частные Seven-файлы остаются локальным приёмочным материалом.
После проверки удалить созданные fixtures из тестовых проектов и подтвердить
`git status samples/` пустым. Новые API документировать в существующих канонических docs;
отдельные новые markdown-справочники не создавать.

## 14. Как учтены оба ревью

| Замечание | Решение |
| --- | --- |
| Codex: атомарность несовместима с overwrite itemId | Immutable revisions с Phase 1, publish pointer transaction (§9) |
| Codex: partial install и неверная база hashes | Pending journal, post-remap raw hashes, repair (§10) |
| Codex: статусы Pack/детей не связаны | Единая release visibility и матрица всех read routes (§9.4) |
| Codex: reimport теряет ручной труд/ID | Admin recipe, независимые от title ID, explicit reimport (§7) |
| Codex: descriptor не включён в resource graph | Публичный ресурс + минимальный компонент + обход publish/export (§6) |
| Codex: currentClip недостаточен для повторного attack | playClip/restart и playState contract (§6.3) |
| Codex: cover/license/source без хранилища | Pack revision files и attribution в каждом Asset (§5.3, §9) |
| Gemini: sequence frameIndex collision | Подтверждено исходниками, первый воспроизводимый runtime blocker (§3, §6.2) |
| Gemini: 200 файлов мало | 500 в новом route вместе с aggregate limits и streaming, atlas позже (§9.5) |
| Gemini: preview без установленного проекта | Scoped resource adapter/Blob map, отдельный host (§8) |
| Gemini: достаточно draft-статусов без staging | Принята DB-транзакция публикации; overwrite старых bytes отклонён, необходимы новые revisions (§9.2) |
| Gemini: нормализовать CRLF hashes | Дополнительный text hash; raw integrity/preconditions сохранены (§10.3) |
| Gemini: публичный descriptor, варианты, PSD отдельно, namespace, visual-only | Принято; минимальный state playback включён сразу, физика/AI исключены (§4–6). Descriptor как отдельный файл позже снят (см. Opus) |
| Opus: `.pix3character` дублирует ссылку и требует ~10 мест регистрации | Снят; маппинг = имена клипов + config компонента в prefab (§4 п.3, §6.1) |
| Opus: export/remap уже обходят pix3anim, «одной таблицы» нет | Формулировка исправлена; таблица `RESOURCE_GRAPH_EXTENSIONS` создана и подключена к четырём обходам (§6.4) |
| Opus: `playClip` расходится с `SpineSkeleton2D.play`; fallback через `findAnimationClip` | `play(name?, {restart})`, явная проверка имени, поведение до загрузки покрыто тестом (§6.3) |
| Opus: `sizeMode: native` vs «100×100 явно» | `sourceSize` на каждом кадре, `width/height` в native не участвуют (§6.1) |
| Opus: recipe не нужен для gate; strippable-реестр, docs, kit пропущены | Recipe → Phase 2; недостающее добавлено в Phase 0 (§12) |
| Opus: лицензия Seven не проходит whitelist; withdrawn отменяет frozen §7; мутации файлов не через undo; id-перехват в `upsertPublicItem` | §2, §9.4, §10.1 уточнены; дефект заведён в `TODO.md` (§9.1) |
| Opus: CRLF/text hash, journal с backups, 5 таблиц, generation preconditions, streaming — избыточно для v1 | §10.3 → Phase 4; §10.4 без backups; §9.1 три таблицы; precondition только в publish; `diskStorage` (§9.5) |

Конфликтующие предложения разрешены явно. Для повторного импорта опубликованного пака
неизменяемость байтов — условие корректности, даже если интерфейс истории отложен.
Для CRLF различаем эквивалентность текста и факт изменения файла; общие правила co-authoring
не ослабляются. Основной объём работ остаётся персонажами Seven, но включает необходимые
исправления рантайма и надёжный путь доставки до проекта.
