# Asset Library: каталог стандартных, шаренных и пользовательских ассетов в редакторе

**Статус:** дизайн-план, не начато. **Оценка:** L (фазами: MVP ~M, сервер ~M, agent ~S).
**Базис верификации:** рабочее дерево на 2026-07-12, ссылки на файлы проверены по исходникам.

## 1. Зачем

Для плейбла/прототипа нет смысла каждый раз генерировать или рисовать заново кнопку, рамку панели, шрифт, звук клика, шейдер-эффект или базовое поведение. Типовые сценарии:

1. **Стартовый набор** — стандартные UI-киты (кнопки, панели, слайдеры), шрифты, звуки, шейдеры, поведения — поставляются вместе с редактором.
2. **Переиспользование между проектами** — сделали красивый слайдер, упаковали в префаб, положили в библиотеку → доступен в следующем плейбле.
3. **Плейбл по игровому проекту** — графика основной игры загружена в шаренную библиотеку команды, плейблы её переиспользуют.
4. **Из генератора** — удачные результаты Asset Generator (nano banana / Gemini) сохраняются не только в проект, но и в библиотеку.
5. **Агент** — прежде чем генерировать/писать с нуля, агент ищет в каталоге и переиспользует готовое.

## 2. Ключевые решения

1. **Один item-формат, три источника (scope).** Не три разных подсистемы, а единая модель `LibraryItem` + три провайдера хранения: `builtin` (поставляется с редактором), `user` (личная библиотека), `team` (шаренная, на collab-сервере). UI, поиск и вставка работают поверх агрегата и не знают про источник.
2. **Item — это бандл, не одиночный файл.** Префаб тянет за собой текстуры/скрипты/звуки; item = папка с `item.json` (манифест) + файлы, пути внутри — относительные. Одиночная картинка — вырожденный случай бандла из одного файла.
3. **Вставка = копирование в проект (snapshot), не линк.** При вставке файлы item'а копируются в `res://assets/library/<item-slug>/…`, `res://`-пути внутри `.pix3scene`/скриптов ремапятся (прецедент ремапа путей есть в `ProjectService` move-remap и `SaveAsPrefabOperation`). Никаких «живых ссылок» на библиотеку из проекта — экспорт плейбла и оффлайн ничего не знают о библиотеке. Обновление item'а в библиотеке НЕ трогает проекты (versioning — вне MVP, §11).
4. **Библиотека — уровень редактора, не проекта.** `user`-scope живёт в OPFS + IndexedDB (рядом с `pix3-browser-projects` из [browser-storage-projects.md](browser-storage-projects.md) и `GenerationHistoryService`), переживает смену проекта.
5. **`team`-scope — на collab-сервере**, по образцу существующего project storage (`packages/pix3-collab-server/src/core/storage/storage-router.ts`: multer, manifest, resolveProjectAccess). Личная библиотека при залогиненности может синкаться туда же с `visibility: private` — тогда `user` и `team` это один серверный механизм с разной видимостью, а OPFS остаётся оффлайн-кэшем.
6. **Вставка в сцену — только через mutation gateway**: Command + Operation (undo обязан работать). Никаких прямых мутаций из панели.
7. **Формат префаба не изобретаем** — это уже существующий `.pix3scene` + `instance:`-ссылка (`SaveAsPrefabOperation.ts`).
8. **Docs policy:** новых `.md` в `docs/` не плодим — обновляем `docs/pix3-specification.md` и `docs/nodes-and-systems.md` (раздел для агентов).

## 3. Модель данных

`item.json` (манифест item'а):

```jsonc
{
  "id": "uuid",                    // стабильный id (для sync/обновлений)
  "slug": "rounded-button-blue",   // папка при вставке в проект
  "name": "Rounded Button (Blue)",
  "type": "prefab",                // prefab | image | font | audio | shader | script | material | scene
  "tags": ["ui", "button", "casual"],
  "description": "9-slice кнопка с hover/pressed стейтами",
  "preview": "preview.png",        // thumbnail в бандле
  "entry": "button.pix3scene",     // главный файл (для prefab/scene/script)
  "files": ["button.pix3scene", "textures/btn-normal.png", "..."],
  "source": "generated|packed|imported", // происхождение (генератор/префаб/ручной импорт)
  "authorId": "…", "createdAt": "…", "updatedAt": "…"
}
```

- **Типы вставки по `type`:** `prefab`/`scene` → инстанс через `CreatePrefabInstanceOperation`; `image` → Sprite2D (как в `GeneratedAssetDropService`); `font`/`audio`/`shader`/`script`/`material` → просто копирование в проект + существующие flow назначения (inspector, drag на ноду).
- Классификация типов — переиспользовать канонический классификатор `src/core/asset-categories.ts`, не заводить второй.

## 4. Архитектура (клиент)

Новые сервисы в `src/services/`:

- **`AssetLibraryService`** — фасад: агрегирует провайдеров, держит поисковый индекс (name + tags + type + scope), выдаёт список/поиск/`getItemBundle(id)`. Valtio-стейт панели — в `appState.ui` (только UI-состояние: фильтры, выбранный item), сами item'ы — не в appState (они не UI-стейт, как и scene graph).
- **Провайдеры** (общий интерфейс `LibraryProvider { list(), getBundle(id), put?(item), delete?(id) }`):
  - `BuiltinLibraryProvider` — читает `public/library/index.json` + бандлы из статики редактора (fetch). Read-only.
  - `LocalLibraryProvider` — OPFS-папка `pix3-user-library/<itemId>/` + индекс в IndexedDB (паттерн — `GenerationHistoryService`). Учесть блокер `ensurePermission` для OPFS-handle из [browser-storage-projects.md §2](browser-storage-projects.md) — фикс общий для обеих фич.
  - `RemoteLibraryProvider` — HTTP к collab-серверу (§7), с OPFS-кэшем скачанных бандлов.
- **`LibraryInsertService`** — копирование бандла в проект: запись файлов через `FileSystemAPIService`, ремап `res://`-путей, дедупликация (item уже вставлялся → переиспользовать существующую папку, спросить при конфликте версий), затем dispatch команды вставки.

Фичи в `src/features/library/`:

- `InsertLibraryItemCommand` / `InsertLibraryItemOperation` — вставка в сцену (undo: удалить ноду; файлы, скопированные в проект, undo НЕ удаляет — как и обычный импорт ассета).
- `PublishToLibraryCommand` — упаковка выделенной ноды/префаба в item (см. §6). `didMutate: false` для сцены; это операция над библиотекой, история undo не нужна — диалог с подтверждением.
- `DeleteLibraryItemCommand`, `UpdateLibraryItemMetaCommand` (rename/tags) — для user/team scope.

## 5. UI: панель библиотеки

Новая Golden Layout панель **Library** (`src/ui/asset-library/`), а не таб внутри Asset Browser — у Asset Browser семантика «файлы текущего проекта», смешивать не стоит. Но паттерны берём оттуда:

- Сетка карточек с thumbnail (превью из бандла; для prefab без превью — плейсхолдер по типу; генерация превью рендером — вне MVP).
- Фильтры: тип (chips по `asset-categories`), scope (Built-in / My / Team), теги; текстовый поиск по name+tags+description. Поиск — простой substring/токенный, без внешних либ.
- Drag из карточки в viewport / scene tree — расширить `src/ui/shared/asset-drag-drop.ts` новым MIME `application/x-pix3-library-item` (payload: `{itemId}`), по образцу `GENERATION_DRAG_MIME`; drop-хендлеры зовут `LibraryInsertService`. Плюс контекст-меню «Insert into scene» / «Add files to project» (без инстанса).
- Карточка: имя, тип-бейдж, scope-иконка, теги; контекст-меню user/team item'ов: rename, edit tags, delete, «Copy id» (для агента).

## 6. Наполнение библиотеки

1. **Built-in стартовый пак** (входит в MVP, минимальный): 2–3 кнопки (9-slice, стейты), рамка панели, слайдер-префаб, 1–2 шрифта (с лицензией!), набор UI-звуков (клик/hover/win), 2–3 шейдер-эффекта из существующего каталога, базовые поведения-префабы. Формат — те же item-бандлы в `public/library/`. Лицензии фиксировать в манифесте (`license` поле) — блокер для распространения.
2. **Из Asset Generator**: в generation history рядом с «Save to project» — кнопка **«Save to Library»** (хук в `SaveGeneratedAssetDialogService` / панели генератора; blob уже лежит в `GenerationHistoryService`). Диалог: имя, теги, scope (My / Team).
3. **Упаковка префаба**: контекст-меню ноды в scene tree и `.pix3scene`-файла в Asset Browser → «Publish to Library». Сбор зависимостей: пройти YAML сцены, собрать все `res://`-ссылки (текстуры, звуки, скрипты, вложенные `instance:`), скопировать в бандл, пути переписать на относительные. Внешние скрипты `user:*` — скопировать `.ts` в бандл (при вставке регистрируются как обычные проектные скрипты).
4. **Ручной импорт**: «Add files…» в панели (файлы с диска → item).
5. **Из проекта игры** (кейс «переиспользуем графику основной игры»): мультиселект в Asset Browser → «Publish to Library» пачкой (каждый файл — item, общие теги задаются один раз). Массовый импорт каталогов — Phase 3.

## 7. Сервер (team-scope)

Новый роутер `packages/pix3-collab-server/src/core/library/` по образцу storage/projects:

- Таблицы: `library_items` (id, owner_id, visibility `private|team`, manifest JSON, created/updated), файлы — `LIBRARY_STORAGE_DIR/<itemId>/…` (path-traversal guard как в `resolveSafePath`).
- Эндпоинты: `GET /api/library/items?q=&type=&tags=&scope=` (поиск/список), `GET /api/library/items/:id` (манифест), `GET /api/library/items/:id/files/*` (скачивание), `POST /api/library/items` (multipart upload, лимит как у storage — 100MB), `PATCH` (мета), `DELETE`. Auth — существующий `requireAuth`; team-модели пока нет — в MVP `visibility: 'team'` означает «все аутентифицированные пользователи сервера» (инстанс сервера = команда), настоящие team'ы — вместе с их появлением в auth.
- Vite dev proxy `/api` уже настроен — новых портов не нужно.

## 8. API для агента

Два канала, оба нужны:

1. **Знание** (чтобы агент вообще искал в библиотеке): обновить шаблоны `src/templates/agent/AGENTS.md` и скилл `pix3-game-dev` правилом: «прежде чем генерировать графику или писать UI с нуля — поищи в Asset Library». Плюс новый скилл `pix3-asset-library` в `src/templates/agent/skills/` с curl-workflow.
2. **Действие** — два транспорта:
   - **Прямой HTTP к collab-серверу** (для builtin/team scope): `GET /api/library/items?q=…` + скачивание файлов — агент может сам положить их в проект и сослаться. Builtin-каталог сервер тоже отдаёт (проксирует статику редактора или держит копию) — иначе агент без запущенного редактора его не видит.
   - **Команды preview-сессии** (когда редактор запущен, паттерн Фазы 3 rapid-prototyping: `restart`/`set-property`/`snapshot` в `PreviewHostService`): добавить `library-search` и `library-insert {itemId, parentNodeId?, position?}` — редактор-хост исполняет через `AssetLibraryService`/`InsertLibraryItemCommand`, агент получает id созданной ноды. Это покрывает user-scope (OPFS доступен только редактору) и даёт вставку с undo.

## 9. Фазировка

**Phase 1 — MVP (M):** item-формат + `AssetLibraryService` + `BuiltinLibraryProvider` + `LocalLibraryProvider` (OPFS); панель Library (сетка, поиск, фильтры, drag-вставка); `LibraryInsertService` + Insert-команда с ремапом путей; «Save to Library» из генератора; «Publish to Library» для префаба (сбор зависимостей); минимальный builtin-пак. Результат: личная библиотека работает end-to-end без сервера.

**Phase 2 — Team + Agent (M):** серверный роутер + `RemoteLibraryProvider` + upload/скачивание с кэшем; scope-переключатель и publish в team; agent: скилл + HTTP-поиск + preview-команды `library-search`/`library-insert`; обновление AGENTS.md/pix3-game-dev шаблонов.

**Phase 3 — Rich (L, по мере надобности):** версионирование item'ов и «update available» для вставленных копий; генерация превью префабов рендером; массовый импорт каталога игры; коллекции/паки (несколько item'ов одним драгом — «UI kit»); рейтинг/сортировка по использованию; квоты и `storage.estimate()` для OPFS.

## 10. Тесты и верификация

- Специфика: `LocalLibraryProvider` — мокать `navigator.storage` (happy-dom его не имеет; паттерн из плана browser-storage §4). Ремап путей в `LibraryInsertService` — чистые юнит-тесты на YAML-фикстурах. Сбор зависимостей префаба — фикстура сцены с текстурами+скриптом+вложенным `instance:`.
- Помнить про гочи: исключённые known-broken спеки в `vitest.config.ts`, CRLF-флуд в lint, ~32 pre-existing tsc-ошибки, unhandled rejection от `AssetLoader.loadTexture` при парсинге сцен с `res://`-текстурами (сидировать textureCache).
- Ручная верификация (chrome-devtools MCP): drag кнопки из builtin-пака в сцену → файлы в `assets/library/…`, нода в дереве, undo убирает ноду; publish слайдера-префаба → виден в My; save из генератора → виден в My; после перезагрузки user-библиотека на месте.

## 11. Открытые вопросы (решить до/в ходе Phase 1)

1. **Конфликт slug'ов при вставке** — item уже вставлялся, но файлы в проекте изменены руками. MVP: спрашивать (overwrite / keep both с суффиксом).
2. **Шрифты и лицензии builtin-пака** — только явно свободные (OFL), лицензия в манифесте. Кто собирает пак?
3. **user-scope sync между устройствами** — решение §2.5 (сервер с `visibility: private`) закладываем в схему сразу, реализация — Phase 2+.
4. **Превью для audio/shader/script** — иконки по типу в MVP; для shader можно превью-картинку требовать при publish.
5. **Скрипты в бандлах из team-библиотеки** — это чужой код, исполняемый в проекте. Для инстанса сервера «своей команды» риск принят; при любом расширении видимости (public) нужен отдельный разговор про доверие/ревью.

### Как это решают Unity Asset Store / Godot Asset Library (выводы для Pix3)

Обе площадки решают лицензии и доверие процессом, не техникой: стандартизованная лицензия + модерация + идентичность публикующего. Unity: единая Asset Store EULA, декларация сторонних компонентов в Publisher Agreement, ревью сабмишенов, но editor-код исполняется прямо при импорте (главный риск). Godot: обязательная OSI-лицензия из белого списка, только исходники (без бинарников), ручная модерация каждого обновления, editor-плагины после установки **выключены по умолчанию**.

Что берём в Pix3:

- **Инвариант: сам акт вставки не исполняет код из item'а.** Скрипты из бандла — только компоненты нод, работают в play mode. Всё, что item'у нужно «сделать с проектом» при установке (автолоады, input actions, настройки), выражается **декларативно в манифесте** и применяется доверенным кодом редактора через обычные команды с подтверждением в диалоге вставки (бонус: undo и прозрачность). Инвариант сознательно НЕ запрещает будущие механизмы с собственным opt-in: editor-плагины — как отдельный тип item'а с Godot-моделью «установка ≠ включение»; если движок получит tool-режим скриптов (исполнение в edit mode) — tool-скрипты подсвечиваются/включаются явно в диалоге вставки, т.к. после вставки они становятся проектными.
- **`license` — обязательное поле манифеста**; для builtin/public — белый список (OFL, CC0, MIT, CC-BY) + **текст лицензии файлом внутри бандла**: OFL/CC-BY требуют распространять атрибуцию вместе с ассетом, а snapshot-вставка (§2.3) автоматически уносит её в проект и в экспорт плейбла. Для team-scope поле без валидации списка (внутренняя графика).
- **Диалог вставки со списком файлов** — отдельно подсветить добавляемые скрипты (аналог import-диалога Unity).
- **Public-видимость (если появится)** — минимум godot-набора: очередь модерации, обязательные исходники, идентичность публикующего.
