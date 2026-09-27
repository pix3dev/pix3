# Pix3 Store: семантические паки ассетов

> Статус: переработанный проект для ревью, 2026-09-28. Реализация не начата.
> Объединяет исходное обсуждение, ревью Codex и предоставленное ревью Gemini.
> Решения ниже — предлагаемый контракт реализации; перед кодом сверять каноническую спецификацию.
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
Файл лицензии в обследованной папке не найден; публикация требует явных лицензионных метаданных
и необходимых текстов атрибуции.

## 3. Базис реализации и подтверждённые разрывы

Источники истины: [спецификация](../docs/pix3-specification.md), описание Asset Store;
[каталог возможностей](../docs/nodes-and-systems.md), Flipbook animation, frame points,
Asset Library; [справочник](../docs/node-types-reference.md), AnimatedSprite2D.

| Область | Сейчас | Следствие для плана |
| --- | --- | --- |
| Bundle | `LibraryItemManifest`: один entry и список files | Asset сохраняет эту границу |
| Store upload | Удаляет каталог item и переписывает его | Нельзя переиспользовать для ревизий опубликованного пака |
| Sequence textures | SceneLoader собирает `Map<number, path>` из всех клипов; AnimatedSprite2D хранит `Map<number, Texture>` | Кадры разных клипов с одинаковым индексом перезаписываются |
| Проигрывание | Завершение one-shot ставит `isPlaying=false`; тот же currentClip не сбрасывает таймер | Нужен явный restart/play API |
| Publish to Library | Рекурсия только в scene/script, не в pix3anim | При повторном сохранении персонажа теряются кадры |
| Insertion | Dedup по наличию entry; запись файлов последовательно | Оборванная установка может выглядеть завершённой |
| Store preview | Статические изображения; getBundle скачивает все файлы | Нужен отдельный preview-host и ограниченная загрузка |
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

Это проверка исходников, а не отчёт о воспроизведении в браузере. Перед исправлением
мультиклипового дефекта Phase 0 должна получить независимый воспроизводимый тест.

## 4. Принятые для реализации решения

1. Pack содержит отдельно устанавливаемые assets. Оружие — вариант одного персонажа.
2. Сохраняем `type` для механики вставки и добавляем `assetKind` для семантики Store.
3. `.pix3character` — публичный ресурс проекта, достижимый из prefab и работающий в экспорте.
4. Минимальный компонент управления визуальными состояниями входит в первый срез.
   Общую state machine с условиями переходов откладываем.
5. Неизменяемые ревизии нужны с первого серверного среза. UI истории и обновлений — позже.
6. Публикация переключает указатель в SQLite после завершения записи новых ревизий.
7. Рецепт импорта сохраняет ручные решения и стабильные ID.
8. Новые assets устанавливаются в `assets/store/<publisherKey>/<packKey>/<assetKey>/`;
   старые standalone items сохраняют `assets/library/<slug>/`.
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
- `characterResource` — bundle-relative путь для character2d;
- краткие `facets`: variants, states, clipCount, frameCount;
- для каждого файла — путь, размер, MIME, raw SHA-256 и роль;
- роль файла: runtime, attribution, preview или source.

В первом срезе каждый Asset самодостаточен: установка не требует другого Asset.
Общие runtime-файлы при компиляции дублируются внутри соответствующих bundle.
Межассетный граф зависимостей и его version solver отложены.
«Dependency closure» означает обход ресурсов внутри выбранного bundle.

UI-kit/environment без prefab используют явную установку «files only».
Для них `entry` необязателен; Add to scene скрыт, пока нет вставляемого entry.
Нельзя выбирать случайный первый PNG как представителя набора.

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

```text
Goblin.pix3scene
goblin.pix3character
goblin.pix3anim
frames/{sword,staff,bow}/...
LICENSE.txt
NOTICE.txt
```

Пример descriptor внутри bundle:

```json
{
  "schemaVersion": 1,
  "animationResourcePath": "res://goblin.pix3anim",
  "defaultVariant": "sword",
  "defaultState": "idle",
  "variants": {
    "sword": {
      "idle": "sword.idle",
      "run": "sword.run",
      "attack": "sword.attack",
      "die": "sword.die"
    },
    "staff": {
      "idle": "staff.idle",
      "run": "staff.run",
      "attack": "staff.attack",
      "die": "staff.die"
    },
    "bow": {
      "idle": "bow.idle",
      "run": "bow.run",
      "attack": "bow.attack",
      "die": "bow.die"
    }
  }
}
```

В bundle `res://` адресует виртуальный корень bundle. При установке он переписывается в
проектный namespace. Относительного к descriptor отдельного механизма разрешения путей нет.
FPS, loop, кадры, events, points и размеры хранятся только в `.pix3anim`.

Prefab: Group2D root → AnimatedSprite2D Visual, `sizeMode: native`,
`animationResourcePath: res://goblin.pix3anim`, начальный клип sword.idle.
На Visual — новый минимальный `core:CharacterVisual2D` с `characterResourcePath`.
Descriptor и Visual обязаны ссылаться на один animation resource; валидатор отказывает при расхождении.
Размер visual задаётся явно 100×100 для Seven; точка привязки проверяется по исходным кадрам.

### 6.2 Исправление идентичности текстур — первый блокер

Ключ текстуры должен соответствовать пути ресурса либо паре clip/frame, а не голому frameIndex.
Предпочтение: loader загружает уникальные texturePath, node выбирает текстуру по текущему frame.
Ключ учитывает область ресурсов: два preview-бандла с одинаковым `res://frames/1.png`
не должны делить неверную текстуру.

Аудит всех вызовов setFrameTexture обязателен. Старый index-based API при необходимости сохраняется
как явно ограниченный совместимый адаптер для текущего клипа, без потери данных других клипов.
Проверить disposal клонов, spritesheet mode, atlas UV, mixed-size frames, editor proxy и экспорт.
Исправление не должно менять существующий JSON-формат pix3anim.

### 6.3 Запуск и повтор состояния

Добавить к AnimatedSprite2D минимальный явный контракт
`playClip(name, {restart: true})`: проверить имя, сбросить frame и внутренний таймер,
включить isPlaying даже после завершённого one-shot. Неизвестный clip возвращает ошибку/false
без тихого выбора первого клипа. Повтор того же attack обязан начинаться с нулевого кадра.
При restart:false того же клипа позиция сохраняется; при смене клипа начинается новый клип.

CharacterVisual2D — тонкое разрешение `variant + state → clip`:
`playState(state, {restart: true})`, `setVariant(variant)`, доступные states/variants,
`state-finished` с именами состояния и варианта.
setVariant сохраняет выбранное состояние, начинает соответствующий клип заново; отсутствующая
пара возвращает отказ, без скрытого fallback. Завершение one-shot удерживает последний кадр;
переход в idle вызывает игра. Это не система автоматических игровых переходов.

Компонент не содержит movement, physics, AI или damage. События кадра и sockets остаются
обычными средствами pix3anim. Runtime умеет их читать уже сейчас; расширенный авторинг в wizard позже.
Приёмка обязательно включает повторный attack, возврат в idle и смену варианта после die.

### 6.4 Полный жизненный цикл ресурсов

До поставки зарегистрировать pix3character в классификаторе, загрузке, валидации, remap,
dependency scanning и build/export. Общий обход должен следовать:
prefab → component.characterResourcePath → pix3character → pix3anim → PNG.
Прямая ссылка Visual → pix3anim остаётся валидной.

PublishToLibraryService должен рекурсивно читать pix3anim и pix3character, не только scene/script.
Одна проверяемая таблица reference-bearing типов должна предотвращать расхождение publish/export/remap.
Неизвестные schemaVersion отвергаются с понятной диагностикой.
Приёмка: Store → проект → My Library → чистый проект → экспорт без подключения к Store.

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

Рецепт — редактируемые входные данные компилятора, отдельно от публикуемого manifest.
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

Компилятор — чистая функция над файлами и рецептом с детерминированными outputs.
Генерация timestamps/revisionId выполняется за его пределами.
Default FPS 12 — предлагаемое значение, не восстановленная авторская скорость.
idle/run loop=true, attack/die=false; автор подтверждает их в preview.
Сохраняем холст 100×100, sourceSize и стабильный anchor; автоматический trim выключен.

Выход: bundle каждого Asset, Pack media/attribution/source, manifests с hashes и validation report.
Опциональный atlas bake позже сохраняет anchors/events и проходит сравнение с source sequence.
Действующий pre-launch atlas проекта не считается готовым инструментом компиляции Store-пака.

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

- store_packs: packId, owner, стабильные keys, visibility, currentPublishedRevisionId.
- store_pack_revisions: packRevisionId, packId, version, manifest, draft generation,
  состояние подготовки и публикации.
- store_assets: assetId, packId, assetKind, стабильный key.
- store_asset_revisions: assetRevisionId, assetId, manifest/hash, состояние complete.
- store_pack_revision_assets: packRevisionId → assetId + assetRevisionId + section/order.
- admin import recipe: draft revision → recipe JSON.
- Существующие library_items и endpoints сохраняются для standalone items.
  Провайдер объединяет записи для UI, но legacy POST не может перезаписывать revision assets.

Assets принадлежат одному Pack. Одинаковые неизменённые ревизии можно повторно использовать в
новом pack release; каждый release фиксирует полный состав, включая общие файлы и порядок.
Колонки facets — вычисленный индекс descriptor, а не отдельная редактируемая истина.

### 9.2 Диск и публикация

```text
LIBRARY_STORAGE_DIR/
├── <legacy-itemId>/...
├── store-packs/<packId>/<packRevisionId>/{media,attribution,source}/...
├── store-assets/<assetId>/<assetRevisionId>/...
└── staging/<uploadSessionId>/...
```

Новые файлы никогда не заменяют опубликованные байты. Upload пишет во временный каталог на
том же filesystem, проверяет содержимое/manifest/hash, закрывает запись, затем rename переводит
завершённую ревизию в её постоянный каталог. Только после этого БД помечает её complete.
Сбой между rename и БД оставляет неиспользуемые байты, а не публичную битую ссылку.
Повтор upload идемпотентен по session/file hash; complete revision не меняется.

Publish проверяет complete всех детей/общих файлов и одной транзакцией SQLite переключает
currentPublishedRevisionId. Предыдущий release и скачивания по его pinned URL продолжают работать.
Publish использует ожидаемую draft generation: два админа не должны затереть правки друг друга.
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
| PUT /packs/:id/drafts/:draftId/recipe | Admin-only рецепт с generation precondition |
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
Удаление draft и сборка неиспользуемых staging-каталогов допустимы; опубликованные bytes
не собираются GC в первом срезе. Установленные проекты продолжают работать автономно.
Изменение состава детей — новый release, не удаление строки из старого состава.

### 9.5 Лимиты и память

Seven проходит нынешние 200 файлов на Asset, но 240-кадровый персонаж уже не проходит.
Для нового revision upload начальный профиль: 500 файлов, 100 MiB на файл, 256 MiB на Asset,
512 MiB распакованных данных на Pack. Это проектные ограничения, а не замер вместимости production.
Сервер выдаёт capabilities; клиент валидирует по ним до загрузки, сервер повторяет проверку.
Legacy upload сохраняет прежние лимиты.

Новый route пишет multipart потоком на диск с лимитом общего тела и числа файлов;
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

Скачивание и планирование — read-only. Мутации файлов и сцены оформляются через команды/операции
с учётом project ownership/lease и backend. Scene undo удаляет instance, установленные файлы
сохраняются как при обычном импорте. Отмена во время загрузки не создаёт scene nodes.

### 10.2 Store lock

.pix3/store-lock.json имеет schemaVersion, origin и ключ origin+assetId.
Запись хранит packId/packRevisionId, assetRevisionId, display version, targetDir,
installedAt, remapperVersion и список фактически установленных project-relative путей.
Для каждого файла: sourceRawSha256, installedRawSha256, optional installedTextSha256.
Роль attribution сохраняется. Preview/source в список установленных файлов не входят.

installedRawSha256 вычисляется после remap и проверяется чтением реальных файлов.
sourceRawSha256 проверяет доставку; его нельзя сравнивать с переназначенным текстом проекта.
Хэши ставит код, не доверяет значению из произвольного локального manifest.

Lock и install journal не входят в playable export. License/NOTICE входят в экспортный набор
атрибуции, включая zip; для single-file HTML определить место атрибуции в build metadata/UI.
Хранение lock/journal проверить на local, OPFS, workspace и cloud backend; отсутствие доступа
к .pix3 не должно приводить к объявлению безопасной установки без provenance.

### 10.3 Хэши текста и CRLF

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

1. Зафиксировать revision, проверить manifest и raw hashes загрузки.
2. Построить полный список целей после remap, проверить containment и коллизии.
3. Если цель уже есть без lock: идентичные ожидаемые байты можно принять; различающиеся —
   конфликт или новый namespace, без молчаливой перезаписи.
4. Создать pending journal: revision, цели, ожидаемые/исходные hashes, backups для изменяемых файлов.
5. Записать зависимости, затем entry; перечитать все записанные файлы и проверить хэши.
6. Зафиксировать complete lock только после проверки всего набора.
7. Закрыть journal и только затем создать instance.

Наличие entry само по себе никогда не означает завершённую установку.
На local/OPFS/cloud нет предположения об атомарной транзакции нескольких файлов.
При сбое journal позволяет retry/repair; rollback удаляет только созданные этой установкой файлы,
хэши которых всё ещё совпадают с записанными. Более поздние внешние изменения сохраняются.
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

- Воспроизвести межклиповую коллизию на двух синтетических клипах с разными цветами/длинами.
- Исправить ключи textures; добавить явный playClip/restart.
- Ввести schema/loader CharacterVisual2D и pix3character, связать prefab и resource graph.
- Исправить обход pix3anim/pix3character в publish/export/remap.
- Чистый compiler + сохранённый recipe для Seven; synthetic fixtures для CI.
- Проверить реальный Goblin/Knight локально, не добавляя частный пак в git.

Gate: правильные pixels для всех 12 клипов, idle→attack→idle→attack, variants после die,
round-trip через My Library и экспорт. Кодовые tests плюс работающий редактор/экспорт.
Никаких серверных upload для прохождения этой фазы.

### Phase 1 — серверный контракт ревизий

- Миграции Pack/Asset/revision/recipe, дисковый staging и immutable storage.
- Publish transaction, generation preconditions и матрица доступа.
- Общие файлы, роли, limits/capabilities, streaming upload.
- Совместимость standalone endpoints; никакой записи ревизий через legacy POST.

Gate: сбой любой стадии upload оставляет старый опубликованный release полностью доступным;
параллельный download получает байты ровно pinned revision; draft недоступен всем публичным routes.
Migration проверяется с существующими private/public items и файлами.

### Phase 2 — compiler wizard и витрина

- Семантическое дерево, ручная коррекция, save/export recipe и reimport diff.
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
| Multi-clip textures | Красные/синие synthetic source PNG; сравнить реальные rendered pixels разных клипов, не только currentClip |
| Seven compiler | Перечитать исходные filenames/размеры отдельно от compiler; проверить порядок и все 135 кадров каждого персонажа |
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
| Gemini: публичный descriptor, варианты, PSD отдельно, namespace, visual-only | Принято; минимальный state playback включён сразу, физика/AI исключены (§4–6) |

Конфликтующие предложения разрешены явно. Для повторного импорта опубликованного пака
неизменяемость байтов — условие корректности, даже если интерфейс истории отложен.
Для CRLF различаем эквивалентность текста и факт изменения файла; общие правила co-authoring
не ослабляются. Основной объём работ остаётся персонажами Seven, но включает необходимые
исправления рантайма и надёжный путь доставки до проекта.
