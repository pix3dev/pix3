# Asset Store: админ-наполнение из редактора + категоризация

**Статус:** **Phase A (сервер) реализована 2026-07-25** на ветке `feat/asset-store-admin` — миграция БД, `store-router.ts` (12 эндпоинтов), store-слой в `library-service.ts`, `store-validation.ts`, `library-storage.ts`; 49 спек сервера зелёные (и они наконец запускаются: `packages/pix3-collab-server/src/**/*.spec.ts` добавлены в `vitest.config.ts` — раньше серверные спеки были вне `include`). Живой смоук на настоящей sqlite+HTTP: 30/30. **Phase B (клиент) реализована 2026-07-26** на ветке `feat/asset-store-client`: `StoreLibraryProvider` + scope `'store'`, `canEditSource`, серверная таксономия в рельсе + чипы подкатегорий, статус-чипы, админ-инспектор, `store-category-editor`, `PublishToStoreCommand`; проверено живьём в редакторе против локального сервера (gate, publish, featured, CRUD категорий с пере-привязкой, невидимость draft'ов для не-админа). **Phase C (OS drag&drop + массовая заливка) реализована 2026-07-26** на ветке `feat/asset-store-upload`: `StoreUploadService` (+16 спек), `store-upload-dialog` (+5 спек), интеграция в `library-panel` (drop `Files` + тулбар-кнопки с file/folder-пикером), бонус — OS-drop в личную библиотеку. Phases D–E не начаты. Продолжение [asset-library.md](asset-library.md): превращаем декоративный источник «Pix3 Store» (сейчас — статический builtin-пак `public/library/`) в наполняемый сервером каталог. Писать могут только админы (`users.is_admin`), читать — все, включая незалогиненных. **Оценка:** L суммарно (фазами: сервер ~M, клиент-провайдер+админ-UI ~M, OS drag&drop ~M, lifecycle-добивка ~S–M).
**Базис верификации:** рабочее дерево на 2026-07-25; все пути/строки проверены по исходникам.

## 1. Зачем

1. **Официальный каталог** — команда Pix3 курирует стартовый контент (UI-киты, звуки, шейдеры, префабы), не пересобирая редактор: сейчас добавить item в Store = закоммитить в `public/library/` и задеплоить редактор.
2. **Наполнение из рабочего места** — админ пакует контент там же, где его делает: publish ноды из сцены, файл из Asset Browser, или перетаскивание готовой папки/зипа прямо из ОС.
3. **Категоризация** — плоский список не масштабируется; нужна курируемая таксономия (категория → подкатегория, по образцу Unity Asset Store / Fab), управляемая с сервера, + свободные теги.
4. **Агент** — публичный HTTP-каталог позволяет агенту искать/качать ассеты без запущенного редактора (задел из asset-library.md §8).

## 2. Ключевые решения

1. **Store = существующий серверный library-роутер + `visibility: 'public'`.** Подтверждаю вектор: `packages/pix3-collab-server/src/core/library/` уже умеет всё тяжёлое — multipart-бандлы (multer memoryStorage, 100MB/200 файлов), path-traversal guard `resolveSafePath`, файлы в `LIBRARY_STORAGE_DIR/<itemId>/`, манифест JSON в `library_items`. Store — это те же бандлы с другой видимостью и другим auth: писать `requireAuth+requireAdmin`, читать без auth (`attachOptionalAuth` — чтобы админ видел drafts тем же эндпоинтом). *Почему не отдельный сервис/CDN:* один инстанс collab-сервера = вся инсталляция; дублировать upload/storage-механику ради второго процесса — чистый оверхед. CDN-вынос — эволюция раздачи файлов, не архитектуры (§11.3).
2. **Статический `public/library/` остаётся offline-fallback и сидом.** `BuiltinLibraryProvider` не удаляется, а становится внутренним делегатом нового `StoreLibraryProvider`: когда сервер недоступен/пуст — показываем статический пак; при мердже дубликаты по `manifest.id` выигрывает сервер. Плюс одноразовый сид: скрипт/админ-действие «Import builtin pack to Store».
3. **Новый scope `'store'`, миграция с `'builtin'`.** В `LibraryScope` (`src/services/library/library-types.ts:12`) добавляется `'store'`; запись `store` в `LIBRARY_SOURCES` (`library-sources.ts:69-85`) меняет `scope: 'builtin'` → `'store'`. `StoreLibraryProvider` (scope `'store'`) регистрируется в `AssetLibraryService` **вместо** прямой регистрации `BuiltinLibraryProvider` (`AssetLibraryService.ts:29-31`) и сам ре-эмитит fallback-item'ы со scope `'store'`. Значение `'builtin'` в типе остаётся (совместимость сериализованных ссылок нигде нет — scope не хранится в манифесте, так что риск нулевой). *Почему не переиспользовать `'builtin'`:* «builtin» семантически = «зашито в редактор»; серверные item'ы это не builtin, а фильтрация `itemsForSource` по scope делает подмену источника бесплатной.
4. **`editable` из конфига → вычисляемая capability.** Флаг `LibrarySourceConfig.editable` остаётся как «editable-by-design» (user/team). Новая чистая функция в `library-sources.ts`:
   ```ts
   export function canEditSource(source: LibrarySourceConfig, ctx: { isAdmin: boolean }): boolean {
     return source.editable || (source.kind === 'store' && ctx.isAdmin);
   }
   ```
   Панель/инспектор заменяют все чтения `source.editable` (панель: `dropAllowed` :286, футер рельса :474; инспектор: `isEditable` :89-92) на `canEditSource(source, { isAdmin: appState.auth.user?.is_admin ?? false })` и подписываются на `appState.auth` (valtio `subscribe`), чтобы админ-хром появлялся/исчезал при логине. Чистая функция с параметром — а не чтение appState внутри `library-sources.ts` — ради тестируемости конфиг-модуля.
5. **Категории Store — серверная таксономия, user/team — как были.** Для store категории приходят с сервера (таблица `library_categories`, §4), два уровня: `categoryPath: 'ui/buttons'`. localStorage-модель `addCustomCategory` (`library-sources.ts:150-161`) и поле `manifest.category` для user/team **не трогаем** — они про личную раскладку, синкающуюся через манифест. Store-item'ы используют новое поле `categoryPath`; `category` у них не заполняется.
6. **Мутации Store — сервисные вызовы, undo не нужен.** Прецедент — `PublishToLibraryCommand` (`didMutate: false`, вне undo-стека) и прямые вызовы `publishService.publishNode` из панели на drop. Undo-стек редактора — про состояние *сцены*; отмена «загрузил в стор» потребовала бы ре-аплоада на сервер и конфликтует с многопользовательским стором (другой админ уже поправил item). Отмена = обычные админ-действия (delete/unlist) + audit log. Команды заводим только там, где нужны меню/палитра: `PublishToStoreCommand`.
7. **Инвариант из asset-library.md §11 сохраняется:** вставка item'а из Store не исполняет код; скрипты бандла подсвечиваются в диалоге вставки; для public-контента `license` обязателен и из белого списка, текст лицензии — файлом в бандле.

## 3. Жизненный цикл и качество контента (лучшие практики сторов)

Что подтверждено практикой площадок и что берём:

| Практика | Откуда | Берём в MVP | Позже |
|---|---|---|---|
| Статусы `draft → published → unlisted` (unlisted = доступен по прямому id, не в листинге) | Unity AS, itch.io | ✅ | — |
| Gate обязательных полей перед publish: name, categoryPath, license (белый список), preview, description, ≥1 тег | Unity submission checklist, Godot AL | ✅ | — |
| Галерея превью (несколько картинок), не только thumbnail | все | поле в манифесте + рендер в инспекторе | загрузка галереи из UI |
| Версия item'а + changelog | Unity AS, Fab | поля `version`/`changelog` в манифесте | «Update available» для вставленных копий (маркер-файл, §11.5) |
| Featured / кураторские подборки | Figma Community, Fab | колонка `featured` + сортировка featured-first в агрегате «Featured» | коллекции-паки |
| Счётчик загрузок + сортировка по популярности | все | ✅ (явный ping-эндпоинт) | — |
| Audit log действий (кто/что/когда опубликовал, удалил, переименовал категорию) | внутренние сторы | ✅ таблица, admin-эндпоинт чтения | UI-вьюер |
| Идентичность публикующего | Godot AL (обязательна) | `publisherId` = user id админа, отображение `publisherName` («Pix3 Team» по умолчанию — сейчас синтезируется в `library-view-model.ts:59-64`) | несколько издателей |
| Модерация сторонних сабмишенов | Unity/Godot | ❌ не нужна: писать могут только админы | очередь модерации, если писать смогут не-админы |
| Лицензия из белого списка + файл лицензии в бандле | Godot AL | ✅ `STORE_LICENSE_WHITELIST = ['OFL-1.1','CC0-1.0','MIT','CC-BY-4.0']` | расширение списка |

Ratings/отзывы/цены — сознательно вне плана: стор внутренний и бесплатный; `priceLabel` остаётся синтезированным («Free»/«CC0»).

## 4. Модель данных

**Расширение `LibraryItemManifest`** (`src/services/library/library-types.ts`) — всё опционально, старые item'ы валидны без изменений:

```ts
status?: 'draft' | 'published' | 'unlisted';   // только store; отсутствие = published (для user/team не читается)
categoryPath?: string;                          // 'ui/buttons' — store-таксономия; user/team продолжают жить на `category`
version?: string;                               // semver-строка, default '1.0.0' при publish
changelog?: Array<{ version: string; date: number; notes: string }>;
gallery?: string[];                             // bundle-relative пути доп. превью
publisherId?: string;                           // user id админа (сервер проставляет сам, клиенту не верит)
publisherName?: string;                         // отображаемое имя ("Pix3 Team")
downloads?: number;                             // read-only, инжектится сервером в отдаваемый манифест из колонки
featured?: boolean;                             // read-only для клиента, меняется PATCH'ем
```

**Что в колонках БД, а что в манифесте:** колонки — всё, по чему сервер фильтрует/сортирует/авторизует (`visibility`, `status`, `category_path`, `featured`, `downloads`, `published_at`); манифест — presentation-детали (gallery, changelog, description…). Колонки `status`/`category_path` дублируют манифест — это осознанно: SQL-фильтрация листинга без JSON-парсинга; сервер при upsert синхронизирует колонки из манифеста (одна точка записи).

**Миграция `library_items`** (`packages/pix3-collab-server/src/core/db.ts:60-70`). Две проблемы:
1. `CHECK(visibility IN ('private','team'))` — SQLite не умеет ALTER CHECK. `runMigrations` сейчас только `CREATE TABLE IF NOT EXISTS`, значит существующие БД сохранят старый CHECK. Миграция — table rebuild, guard через `sqlite_master`:
   ```ts
   const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name='library_items'`).get();
   if (ddl && !ddl.sql.includes("'public'")) { /* BEGIN; ALTER TABLE ... RENAME TO _old; CREATE TABLE (новая схема без CHECK либо с ('private','team','public')); INSERT INTO ... SELECT ...; DROP _old; COMMIT */ }
   ```
   **Уточнение 2026-07-25:** на боевом `cloud.pix3.dev` пользователь один (владелец), критичных данных в `library_items` нет. Поэтому `INSERT … SELECT` — вежливость, а не требование: если rebuild окажется занозой, допустим `DROP TABLE library_items` + пересоздание (личная библиотека владельца переедет заново обычным `LibrarySyncService`-пушем из редактора, он local-first). Бэкап sqlite-файла перед деплоем всё равно снимаем — минута работы.
2. Новые колонки — идемпотентные `ALTER TABLE ADD COLUMN` с guard по `PRAGMA table_info(library_items)`: `status TEXT NOT NULL DEFAULT 'published'`, `category_path TEXT`, `featured INTEGER NOT NULL DEFAULT 0`, `downloads INTEGER NOT NULL DEFAULT 0`, `published_at INTEGER`. Индекс: `CREATE INDEX IF NOT EXISTS idx_library_items_public ON library_items(visibility, status, category_path) WHERE visibility='public'`.

**Новые таблицы:**

```sql
CREATE TABLE IF NOT EXISTS library_categories (
  id TEXT PRIMARY KEY,              -- стабильный slug: 'ui', 'ui/buttons' (полный путь = id, парсинг не нужен)
  parent_id TEXT REFERENCES library_categories(id) ON DELETE CASCADE,  -- NULL = верхний уровень; глубина ≤2 валидируется кодом
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS library_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- 'item.upload'|'item.publish'|'item.unlist'|'item.delete'|'item.meta'|'category.create'|'category.update'|'category.delete'
  item_id TEXT,
  detail TEXT,                      -- JSON: что изменилось
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Удаление категории:** item'ы с `category_path` под удалённой веткой сервер пере-привязывает к родителю (подкатегория) или обнуляет (верхний уровень → item виден только в агрегате «Featured/All»); одним UPDATE в той же транзакции + запись в audit log. *Почему не запрет удаления непустой:* блокирует реорганизацию таксономии, ради которой всё затевается.

**Счётчики категорий** не хранятся — считаются в листинге (`GROUP BY category_path`), объёмы смешные.

## 5. Архитектура (клиент)

Новые файлы в `src/services/library/`:

- **`StoreLibraryProvider.ts`** — провайдер scope `'store'`:
  ```ts
  export class StoreLibraryProvider implements LibraryProvider {
    readonly scope = 'store';
    constructor(private readonly fallback = new BuiltinLibraryProvider()) {}
    isSupported(): boolean;                          // typeof fetch !== 'undefined'
    list(): Promise<LibraryItem[]>;                  // GET store index → merge с fallback.list() по id (сервер выигрывает); не-админу сервер уже отдал только published
    getBundle(id): Promise<LibraryBundle | null>;    // сервер → fallback; после успешной сборки — fire-and-forget ping счётчика загрузок
    getPreviewUrl(id): Promise<string | null>;       // прямой URL файла (превью публичны, cookie не нужны)
    put(bundle): Promise<LibraryItem>;               // admin upload (XHR с progress, см. StoreUploadService)
    delete(id): Promise<void>;                       // admin
    listCategories(): Promise<StoreCategory[]>;      // GET categories, кэш до invalidate
    patchMeta(id, patch: StoreItemMetaPatch): Promise<LibraryItem>;  // status/category/featured/поля манифеста
    subscribe(listener): () => void;                 // нотификация после собственных писем
  }
  ```
  Кэш: индекс в памяти, рефетч при открытии панели/фокусе окна (паттерн триггеров `LibrarySyncService.initialize`, но **односторонний pull** — двусторонний sync стору не нужен, конфликтов нет: единственный писатель на item — админ через сервер). OPFS-кэш скачанных бандлов — не в MVP (§11.4).
- **`StoreUploadService.ts`** — ингест OS drag&drop и массовая заливка. Итоговая (реализованная) сигнатура:
  ```ts
  export interface IngestEntry { kind: 'file' | 'directory'; name: string; file?(): Promise<File>; children?(): Promise<IngestEntry[]> }
  export interface StagedBundle { id: string; manifest: LibraryItemManifest; files: Map<string, Blob>; sourceLabel: string; oversize: boolean; issues: string[] }
  export interface StoreIngestPlan { bundles: StagedBundle[]; issues: string[] }
  captureEntries(dt: DataTransfer): IngestEntry[];        // СИНХРОННО в drop-хендлере: webkitGetAsEntry() умирает после первого await
  entriesFromFileList(files: FileList): IngestEntry[];    // file-picker: пересобирает дерево из webkitRelativePath
  buildPlan(entries: IngestEntry[]): Promise<StoreIngestPlan>;
  upload(bundles: StagedBundle[], opts: { onProgress?(bundleId, loaded, total): void; signal?: AbortSignal }): Promise<UploadOutcome[]>;
  ```
  Отличия от первоначального наброска (осознанные): `upload` принимает **массив бандлов**, а не весь план — диалог сам решает, что заливать (заблокированные исключены, и порядок его); возвращает `UploadOutcome[]` (`ok` / `error` + серверные `issues` / `cancelled`) вместо `LibraryItem[]`, потому что частичный успех — нормальный исход и его надо показать построчно; `signal`/`onProgress` опциональны. Добавлен `entriesFromFileList` для пикера. В `ApiClient` добавлен экспорт `storeItemUrl(itemId)` — XHR должен бить ровно в тот же URL, что и fetch-путь, и дублировать `BASE_URL` было бы багом ожидания.

  Правила группировки: верхнеуровневая **папка = один бандл** (если внутри `item.json` — уважаем его, включая `id`, что даёт идемпотентный re-upload/обновление; сам `item.json` в файлы бандла не попадает — он и есть multipart-поле `manifest`; иначе синтез манифеста: entry — первый scene/prefab, затем код, затем не-картинка; type по `inferItemTypeFromPath`, name из имени папки, `status:'draft'`, preview — `preview.*` иначе первая картинка по алфавиту); **одиночный файл = один item**; **`.zip` = папка** (ленивый `await import('jszip')`; одна обёрточная корневая папка внутри архива срезается, `__MACOSX`/`.DS_Store` выбрасываются). Обход директорий: `FileSystemDirectoryEntry.createReader()` — `readEntries()` отдаёт ≤100 записей за вызов, читается в цикле до пустого массива. Лимиты согласованы с сервером: 100MB/200 файлов на бандл, валидируются в `buildPlan` (бандл-нарушитель помечается `oversize` — по смыслу «заблокирован», включая пустой бандл — и исключается из заливки с человекочитаемым `issues[]`; остальные бандлы того же дропа заливаются). Пути прогоняются через `normalizeBundlePath` + отбрасывание `.`/`..`/пустых. Прогресс: `fetch` не даёт upload-progress → загрузка через `XMLHttpRequest` (`xhr.upload.onprogress`), отмена через `signal` → `xhr.abort()`; это единственное место, где ApiClient-паттерн (fetch) не подходит — локализовано в этом сервисе и объяснено в шапке файла.
- **`store-validation.ts`** — publish-gate:
  ```ts
  export const STORE_LICENSE_WHITELIST = ['OFL-1.1', 'CC0-1.0', 'MIT', 'CC-BY-4.0'] as const;
  export function validateStorePublish(manifest: LibraryItemManifest): StoreValidationIssue[];  // name, categoryPath, license∈whitelist, preview, description, tags.length≥1
  ```
  Тот же валидатор дублируется на сервере (~40 строк в `store-router.ts`): `src/` и collab-server — разные TS-проекты без общего пакета; заводить workspace-пакет ради 40 строк — не сейчас (§11.6).

Правки существующих файлов:

- `library-types.ts:12` — `LibraryScope` + `'store'`; манифест — поля из §4.
- `library-sources.ts` — store-запись: `scope: 'store'`; `canEditSource()` (§2.4); `categoriesForSource(source, sourceItems, declared?)` — третий опциональный параметр перекрывает конфиг-категории серверными (панель передаёт их для store); статический `categories` записи store остаётся offline-fallback. `countItemsInCategory` — для store сравнение по префиксу `categoryPath`.
- `AssetLibraryService.ts:29-31` — `providers = [this.store, this.local]` (где `store = new StoreLibraryProvider()`); новые делегаты `putStoreItem(bundle)`, `deleteStoreItem(id)`, `getStoreCategories()`, `patchStoreItemMeta(id, patch)` (симметрично cloud-sync-мостику :148-184 — инвалидация кэша централизована).
- `PublishToLibraryService.ts` — `PublishNodeParams` + `target?: 'user' | 'store'`; `publishNode`/`publishAssetPath` роутят `putUserItem` vs `putStoreItem`; для `target:'store'` синтез манифеста получает `status:'draft'`.
- `src/services/cloud/ApiClient.ts` (после :382) — `getStoreIndex(params: StoreListParams)`, `getStoreItem(id)`, `downloadStoreFile(id, path)`, `deleteStoreItem(id)`, `patchStoreItemMeta(id, patch)`, `pingStoreDownload(id)`, `getStoreCategories()`, `createStoreCategory(input)`, `updateStoreCategory(id, patch)`, `deleteStoreCategory(id)`. (Upload — в StoreUploadService из-за XHR, см. выше.)
- `src/features/library/PublishToStoreCommand.ts` — новый, клон `PublishToLibraryCommand` с `target:'store'`, precondition + `appState.auth.user?.is_admin`, `didMutate: false`, `menuPath: 'edit'`, виден в меню только при isAdmin (через precondition scope).
- `src/state/AppState.ts` — изменений не нужно: `AuthUser.is_admin` уже есть (:397).

## 6. UI

Всё — Lit Light-DOM + `ComponentBase`, стили в сибling `.ts.css`, иконки строго через `IconService` (skill `pix3-ui-conventions`).

**Не-админ не видит ничего нового:** Store как сейчас — read-only рельс (`lib-readonly` футер), карточки только `published`, никаких статус-чипов/кнопок.

**Админ-режим панели** (`library-panel.ts`):
- Бейдж `shield` (Feather) рядом с именем источника Store в рельсе + hint «official · admin».
- `dropAllowed` (:285-295): при `canEditSource(...)` дополнительно принимает `types.includes('Files')` (OS-драг манифестируется типом `Files`). `handleDropInto` (:329): новая ветка — `storeUploadService.captureEntries(dataTransfer)` синхронно, затем открытие **диалога загрузки**.
- **Диалог загрузки** `src/ui/asset-library/store-upload-dialog.ts` (+ `.ts.css`, скоуп всех правил под тегом — урок dialog-css-scoping-leak): слева список staged-бандлов (имя, тип, файлов/размер, оверлимит краснит), справа мета выбранного (name, category+subcategory селекты из серверной таксономии, license-селект из белого списка, tags, description, preview-подстановка), внизу прогресс-бар на бандл + Cancel (AbortSignal). Кнопки «Upload as drafts» / «Upload & publish» (вторая прогоняет `validateStorePublish` и блокируется с перечнем issues). Диалог также открывается кнопкой тулбара **«New Store item…»** (файл-пикер `<input type="file" multiple webkitdirectory>` как альтернатива драгу — и a11y, и путь для MCP-верификации).
- **Статус-чипы** на карточках/строках store-источника для админа: `draft` (пунктирная рамка, серый чип), `unlisted` (амбер-чип), `featured` (звёздочка `star` через IconService). Данные уже в манифесте — правки в `renderGridCard`/`renderListRow`/`cardMeta`.
- **Редактор категорий**: кнопка `settings` у заголовка CATEGORIES (видна только store+admin) → диалог `store-category-editor.ts`: дерево двух уровней, добавить/переименовать/удалить/перетащить порядок (`sort_order`), подтверждение удаления с числом затронутых item'ов. Рельс store рисует серверные категории верхнего уровня; выбор категории показывает **чипы подкатегорий** над гридом (рядом с type-чипами) — рельс остаётся плоским, как сейчас.
- `afterPublish` (:391-399) параметризуется источником: `afterPublish(sourceId: 'user' | 'store', categoryId?)`.

**Инспектор** (`library-inspector.ts`): для admin+store — редактирование name/description/tags/license/category, переключатель статуса (draft/published/unlisted — publish прогоняет gate), тумблер featured, кнопка Delete с подтверждением, блок changelog/version (read-only в MVP), галерея превью (рендер `gallery`-файлов). `isEditable` (:89-92) → `canEditSource`.

## 7. Сервер

Новый файл `packages/pix3-collab-server/src/core/library/store-router.ts` (существующий `library-router.ts` не трогаем — приватный sync-контракт замораживаем), mount в `server.ts` рядом с :70: `app.use('/api/library/store', storeRouter)`. Логика записей — в `library-service.ts` (новые функции `listPublicItems(filter, includeDrafts)`, `upsertPublicItem(...)`, `hardDeletePublicItem(id)`, `listCategories()`, `upsertCategory()`, `deleteCategory(id)`, `bumpDownloads(id)`, `appendAudit(...)`).

Эндпоинты (все — `attachOptionalAuth`; мутации — ещё `requireAuth, requireAdmin`):

| Метод/путь | Auth | Семантика |
|---|---|---|
| `GET /items?q=&category=&type=&status=&sort=` | публичный | листинг `visibility='public'`; не-админ всегда получает `status='published'`; админ может `status=all/draft/unlisted`; sort: `updated`/`downloads`/`featured` |
| `GET /items/:id` | публичный | манифест; `unlisted` отдаётся (по прямому id), `draft` — только админу |
| `GET /items/:id/files/*` | публичный | скачивание файла бандла (`resolveSafePath`, как в library-router.ts:27-33); draft — только админу |
| `POST /items/:id/download` | публичный | +1 к `downloads`, fire-and-forget с клиента после успешной сборки бандла. *Почему не инкремент на GET файла:* бандл = N файлов, двойной счёт |
| `POST /items/:id` | admin | multipart, тот же формат что library-router.ts:77-130 (manifest+paths+files, те же лимиты 100MB/200); `visibility='public'`, `publisherId=req.user.id` (принудительно, клиенту не верим), синхронизация колонок status/category_path из манифеста; server-side `validateStorePublish` если `status==='published'`; audit `item.upload` |
| `PATCH /items/:id` | admin | JSON: `{ status?, categoryPath?, featured?, manifestPatch? }`; publish-переход — через gate; audit |
| `DELETE /items/:id` | admin | **hard delete** + файлы; томбстоун не нужен — store не участвует в двустороннем sync (клиенты только читают, консистентность = следующий рефетч индекса); история — в audit log |
| `GET /categories` | публичный | дерево с `sort_order` + счётчики published-item'ов |
| `POST /categories` / `PATCH /categories/:id` / `DELETE /categories/:id` | admin | CRUD; глубина ≤2; delete → пере-привязка item'ов (§4); audit |
| `GET /audit?limit=&offset=` | admin | лента audit log |

Vite dev-proxy `/api` уже покрывает всё — новых портов/проксей не нужно.

## 8. API для агента

Read-часть Store публична и без cookie — агенту достаточно curl:
`GET /api/library/store/items?q=button&category=ui` → манифесты; `GET /api/library/store/items/:id/files/<path>` → файлы, которые агент кладёт в проект сам. Это закрывает пункт «HTTP к collab-серверу» из asset-library.md §8 для store-scope. Действия в редакторе (вставка с undo) — через уже запланированные preview-команды `library-search`/`library-insert` (asset-library.md §8.2), без изменений. Обновить шаблон `src/templates/agent/AGENTS.md` одной строкой («ищи в Store до генерации»); заливка в Store агенту не даётся (admin-only, и это правильно).

## 9. Фазировка

- **Phase A — сервер (M):** миграция БД (rebuild CHECK + колонки + 2 таблицы), `store-router.ts` + расширение `library-service.ts`, server-side gate, audit, счётчик загрузок; `store-router.spec.ts`. Результат: curl-able публичный каталог.
- **Phase B — клиент-каталог + админ-мета (M):** `StoreLibraryProvider` (+fallback-мердж), scope-миграция `'store'`, `canEditSource`, ApiClient-функции, серверные категории в рельсе + чипы подкатегорий, статус-чипы, админ-инспектор (мета/статус/featured/delete), редактор категорий, `PublishToStoreCommand` + publish-роутинг в `PublishToLibraryService`. Результат: админ наполняет стор из сцены/Asset Browser, все видят каталог.
- **Phase C — OS drag&drop + массовая заливка (M): ✅ 2026-07-26.** `StoreUploadService` (entries-обход, zip, группировка, лимиты, XHR-заливка), `store-upload-dialog.ts` + `.ts.css` (мета, gate-подсветка, прогресс, отмена, outcome-строки), интеграция в `dropAllowed`/`onDropTargetDrop` (захват entries **до** первого await) + тулбар «New Store item…» с двумя пикерами (файлы / папка через `webkitdirectory`). Бонус выполнен: OS-drop в user-библиотеку идёт тем же `buildPlan`, но пишется напрямую через `putUserItem` без диалога — у личной библиотеки нет ни таксономии, ни лицензии, ни publish-gate, так что общий диалог был бы пустым на 80%.
- **Phase D — добивка (S):** сид builtin-пака в стор, gallery-рендер в инспекторе, audit-вьюер **третьей вкладкой существующей веб-админки** (`packages/pix3-collab-server/src/admin/index.html`, 271 строка на Alpine+CDN Tailwind, вкладки Пользователи/Проекты — лента аудита это админский, а не редакторский экран, и там она стоит ~30 строк вместо нового Lit-компонента), обновление `docs/pix3-specification.md` (раздел Asset Library) — новых `.md` в `docs/` не заводим.
- **Phase E — позже (M/L):** versioning + «Update available» (маркер `assets/library/<slug>/.pix3-library.json` при вставке, сравнение с каталогом), коллекции-паки, OPFS-кэш бандлов, CDN-раздача.

## 10. Тесты и верификация

- **Сервер** (`packages/pix3-collab-server/src/core/library/store-router.spec.ts`, рядом с существующим `library-router.spec.ts` и по его паттерну — express-app + supertest, мок auth): анонимный листинг видит только published; draft недоступен не-админу (404), доступен админу; POST без admin → 403; publish без license/preview → 400 с перечнем issues; path-traversal в files → 400; delete категории пере-привязывает item'ы; downloads инкрементится один раз на ping; миграция — короткая спека на `runMigrations` поверх БД со старым CHECK (создать старую схему, прогнать, убедиться что `visibility='public'` вставляется). Сохранность данных при rebuild не тестируем — на проде терять нечего (§4).
- **Клиент** (vitest, happy-dom; на win32-arm64 запускать с `--pool=threads`): `StoreLibraryProvider.spec.ts` — fetch-мок: мердж сервер+fallback по id, деградация в fallback при 500/оффлайне, не-админский список; `StoreUploadService.spec.ts` (16 спек, зелёные) — обход через интерфейс `IngestEntry` (happy-dom не имеет `webkitGetAsEntry` — тесты кормят синтетические деревья), группировка папка/файл/zip (zip собирается в тесте самим jszip), уважение `item.json` (тот же `id`), синтез манифеста и выбор preview, нормализация/отбрасывание опасных путей, лимиты (>200 файлов, >100 МБ), заливка через подменённый `XMLHttpRequest`: конверт multipart + `withCredentials`, частичный успех с серверными `issues`, отмена по сигналу; `store-upload-dialog.spec.ts` (5 спек) — список бандлов и пометка заблокированных, блокировка publish с перечнем issues и подсветкой полей, publish при полной мете, drafts + счётчик в close-событии, редактирование меты in place; `store-validation.spec.ts` — gate-матрица; `library-sources.spec` — `canEditSource`, `categoriesForSource` с declared-категориями (не сломать localStorage-путь user/team). Помнить гочу `AssetLoader.loadTexture` (сидировать textureCache, если фикстуры со сценами).
- **Ручная верификация (chrome-devtools MCP):** `npm run dev:collab`; в локальной БД админа завести руками (`UPDATE users SET is_admin=1`) — на боевом `cloud.pix3.dev` аккаунт `igor@gritsenko.biz` уже Admin, так что сценарий «не-админ» проверяется вторым, обычным аккаунтом. Проверять состоянием, не скриншотами: (1) под админом — бейдж и dropzone у Store, «New Store item…» через file-picker (MCP `upload_file` — реальный OS-драг из MCP недоступен, поэтому пикер обязателен) → item со статусом draft в гриде; publish без категории блокируется gate'ом; после заполнения — publish; (2) `evaluate_script` → анонимный `fetch('/api/library/store/items')` видит item; (3) под не-админом — рельс read-only, draft'ы невидимы; (4) вставка store-item'а в сцену → файлы в `assets/library/…`, undo убирает ноду; (5) удаление категории → item'ы переехали к родителю, счётчики сошлись.

## 11. Открытые вопросы

1. ~~**Как назначается первый админ**~~ — **закрыт (2026-07-25):** админ уже есть на боевом `cloud.pix3.dev` (`igor@gritsenko.biz`, роль Admin в `/admin`), механика назначения не блокирует фичу. Массового онбординга админов не планируется; при необходимости — ручной UPDATE или вкладка в существующей админ-панели.
2. **Team-scope ещё не реализован** (asset-library.md Phase 2 «осталось»): store-роутер строим так, чтобы `visibility:'team'` лёг в те же функции `library-service.ts` (фильтр по visibility, а не копипаста) — но team отдельной задачей.
3. **CDN/квоты** — файлы public-item'ов раздаются Express'ом с диска; для инсталляции «одна команда» достаточно, порог пересмотра — когда каталог перевалит за гигабайты.
4. **Оффлайн-кэш store-бандлов** (OPFS) — нужен ли вообще, если fallback-пак покрывает оффлайн? Отложено до жалоб.
5. **Формат маркера вставки** для «Update available» (Phase E): `.pix3-library.json` в папке item'а vs общий реестр в `project.pix3` — решить перед Phase E, влияет на export-пайплайн (маркер не должен попадать в плейбл).
6. **Общий пакет валидации** клиент/сервер — при третьем дубле кода заводим workspace-пакет `@pix3/library-shared`; до тех пор — две копии с перекрёстной ссылкой в комментарии.
7. **Локализация label'ов категорий** — сейчас label один; если редактор пойдёт в мультиязычие UI, `label` станет ключом — таксономию это не ломает (id стабильны).
