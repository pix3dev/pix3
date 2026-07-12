# Browser-storage проекты (OPFS): «создать проект без выбора папки»

**Статус:** реализовано (MVP) на 2026-07-12; ручная проверка в редакторе — ожидает (Chrome MCP profile lock). **Оценка:** M.

## Отклонения от плана при реализации

- **Ключевая правка, которую план недооценил (§3.7):** `ProjectStorageService` содержит 11 позитивных проверок `=== 'local'` (строки 48/86/113/…), у которых `else` уходит в **cloud**-путь. Плюс сам метод `getBackend()` типизирован как `'local' | 'cloud'`, поэтому расширение union'а само по себе сломало бы типы. Исправлено в одном месте: `getBackend()` теперь возвращает `backend === 'cloud' ? 'cloud' : 'local'` — browser маршрутизируется через fs везде. Тем же покрыт `CodeDocumentService:188`.
- **Тесты:** покрыты юнитами новый `BrowserProjectStorageService` и fs-хелперы (`copyDirectoryContents` бинарно-безопасно, `pickDirectory` без сайд-эффекта, `isDirectoryEmpty`, `ensurePermission` no-op). Тяжёлый интеграционный спек на browser-ветку `ProjectService` (DI + template + IndexedDB) сознательно пропущен — покрывается типами + ручной проверкой.
- `copyDirectoryContents` реализован бинарно-безопасно (`arrayBuffer`), т.к. существующий `copyDirectory` — text-only и портил бы бинарные ассеты.

---

**Цель:** снять главный барьер входа — создание нового проекта без directory picker'а и без облака. Проект живёт в OPFS (Origin Private File System) браузера; позже его можно «повысить» до обычной папки на диске (MVP) или до облака (Phase 2).

Базис верификации: рабочее дерево на 2026-07-12, все ссылки на строки проверены по исходникам.

---

## 1. Ключевые решения (приняты, не пересматривать)

1. **Третий backend `'browser'`** в union `'local' | 'cloud'`, а не флаг на `'local'`. Причина: почти все ветки в коде — `=== 'cloud'` / `!== 'cloud'`, и browser-проект в них автоматически получает поведение local (обычные сейвы, нет collab, нет cloud-кэша) — это ровно то, что нужно. Ветки `=== 'local'` (hybrid sync, sync-dialog) исключают browser — тоже правильно для MVP.
2. **OPFS-handle — это обычный `FileSystemDirectoryHandle`** (`navigator.storage.getDirectory()`), поэтому весь стек `FileSystemAPIService` → `ProjectStorageService` → сцены/ассеты работает без изменений. Меняется только *источник* handle.
3. **Layout в OPFS:** `pix3-browser-projects/<projectSessionId>/` — корневая папка рядом с уже существующей `pix3-cloud-cache` (см. `CloudProjectCacheService.ts:7`). Внутри — обычная структура проекта (та же, что создаёт `createProjectStructure`).
4. **`'browser'` — дефолт в create-диалоге.** Иначе фича не снимет трение, а станет третьей незаметной опцией.
5. **«Save to Folder…» (move в обычную папку) входит в MVP.** Без пути «забрать черновик» фича — ловушка.
6. Никакого нового `.md` в `docs/` — обновляем `docs/pix3-specification.md` (docs policy).

---

## 2. Блокер №1: `ensurePermission` кидает для OPFS-handle

[FileSystemAPIService.ts:133-138](../src/services/FileSystemAPIService.ts#L133-L138): если у handle нет `queryPermission`/`requestPermission` — бросается `FileSystemAPIError('unsupported')`. У OPFS-handle этих методов **нет**, а доступ к OPFS по спецификации всегда granted.

**Фикс:** при отсутствии permission-API — молча `return` (считать granted), не бросать. Это же открывает дорогу Firefox/Safari (там OPFS есть, а permission-API на handle — нет).

Проверить/обновить `FileSystemAPIService.spec.ts` — если там есть assert на `'unsupported'`, перевернуть ожидание.

Примечание: `LocalSyncService.queryPermission` ([LocalSyncService.ts:899](../src/services/LocalSyncService.ts#L899)) уже защищён — возвращает granted при отсутствии API. Не трогать.

---

## 3. Изменения по файлам

### 3.1 Типы (расширить union на `'browser'`)

| Файл | Что |
| --- | --- |
| `src/state/AppState.ts` | `project.backend: 'local' \| 'cloud'` → `+ 'browser'` |
| `src/services/ProjectService.ts` | `RecentProjectEntry.backend`; нормализация в `getRecentProjects()` ([ProjectService.ts:80](../src/services/ProjectService.ts#L80)) сейчас схлопывает всё не-cloud в `'local'` — сохранить `'browser'` |
| `src/services/ProjectLifecycleService.ts` | `CreateProjectParams.backend`, `CreateProjectDialogInstance.initialBackend`, параметр `showCreateDialog()` |
| `src/ui/shared/pix3-create-project-dialog.ts` | `initialBackend`, `@state() backend` |

`ProjectStorageService.getBackend()` возвращает `appState.project.backend` — тип расширится сам; его ветки `=== 'cloud'` (строки 277, 382, 483) не трогать: browser корректно уходит в local-путь.

### 3.2 Новый сервис `src/services/BrowserProjectStorageService.ts`

Маленький `@injectable()`-сервис (по образцу `CloudProjectCacheService`, но без sync-логики):

- `isSupported(): boolean` — есть ли `navigator.storage?.getDirectory`.
- `getRoot(): Promise<FileSystemDirectoryHandle>` — `getDirectory()` → `getDirectoryHandle('pix3-browser-projects', { create: true })`.
- `createProjectDirectory(id: string): Promise<FileSystemDirectoryHandle>` — `{ create: true }`; бросить, если уже существует.
- `getProjectDirectory(id: string): Promise<FileSystemDirectoryHandle | null>` — без create; `null`, если нет.
- `deleteProject(id: string): Promise<void>` — `root.removeEntry(id, { recursive: true })`.
- `requestPersistence(): Promise<void>` — best-effort `navigator.storage.persist()`, ошибки глотать. Вызывать при создании первого browser-проекта.

Зарегистрировать в `src/services/index.ts` по общему паттерну.

### 3.3 `ProjectService` — создание и открытие

**`createNewProjectWithOptions`** ([ProjectService.ts:558](../src/services/ProjectService.ts#L558)): добавить в `CreateProjectOptions` поле `backend?: 'local' | 'browser'` (default `'local'`).

- `'local'` — как сейчас (picker).
- `'browser'` — id создать **до** получения handle (`createProjectSessionId()`), handle = `browserStore.createProjectDirectory(id)`, затем **явно** `this.fs.setProjectDirectory(handle)` (в picker-пути это делает `requestProjectDirectory`; без этого вызова не будет ни рабочего fs, ни handle для service worker — см. §5). Empty-check можно оставить (новая папка вернёт `[]`). Всё остальное (структура из шаблона, appState, recents c `backend: 'browser'`, `persistProjectDirectoryHandle`) — тот же код; вынести общую часть, не копипастить.

**`openRecentProject`** ([ProjectService.ts:275](../src/services/ProjectService.ts#L275)): новая ветка `entry.backend === 'browser'`:

- handle: сначала `getPersistedProjectDirectoryHandle(entry.id)` (OPFS-handle сериализуется в IndexedDB как обычный), при отсутствии — re-derive через `browserStore.getProjectDirectory(entry.id)`.
- **Не** падать в picker-fallback (строка 328) — для browser это бессмысленно. Если директории нет (хранилище вычищено) — удалить запись из recents и бросить понятную ошибку («Project data was removed from browser storage»).
- `ensurePermission` можно звать (после фикса §2 он no-op для OPFS).

**`openLocalSession`** ([ProjectService.ts:335](../src/services/ProjectService.ts#L335), используется Router'ом для deep-link): сейчас хардкодит `backend = 'local'` (строка 349). Брать backend из recents-записи по `sessionId` (fallback `'local'`). Бонус: browser-проекты восстанавливаются после перезагрузки **без** permission-промпта — deep-link и auto-open работают молча.

### 3.4 `ProjectLifecycleService`

В `createProjectInternal` ([ProjectLifecycleService.ts:181](../src/services/ProjectLifecycleService.ts#L181)):

- ветка `params.backend === 'browser'`: auth-проверка не нужна; `projectService.createNewProjectWithOptions({ ..., backend: 'browser' }, { beforeActivate })`; перед созданием — `browserStore.requestPersistence()` (best-effort, не await-блокировать UX дольше необходимого).
- дефолт `showCreateDialog(initialBackend = 'browser')` — но только если `browserStore.isSupported()`, иначе `'local'`.

### 3.5 UI

**`pix3-create-project-dialog.ts` (+ `.ts.css`):** в backend-toggle ([строки 193-220](../src/ui/shared/pix3-create-project-dialog.ts#L193)) третья опция, первая по порядку и дефолтная:

- Label: `In Browser`, остальные — `Folder`, `Cloud`.
- Copy для browser (блок `backend-copy`): «Instant start — the project is stored inside this browser. No folder or account needed. You can move it to a folder or the cloud later.»
- Если `!browserStore.isSupported()` — опцию скрыть/задизейблить.

**`pix3-welcome.ts`:**

- `getProjectBadgeLabel` ([:303](../src/ui/welcome/pix3-welcome.ts#L303)): `'browser'` → `Browser`.
- `getProjectIcon` ([:314](../src/ui/welcome/pix3-welcome.ts#L314)): подобрать существующую иконку у `iconService` (например globe/браузер; проверить доступные имена, не изобретать новую).
- `getLocalProjectItems` ([:326](../src/ui/welcome/pix3-welcome.ts#L326)): фильтр `backend === 'local' || backend === 'browser'` — browser-проекты должны попадать в список Recent.

**`pix3-editor-shell.ts`** ([:640](../src/ui/pix3-editor-shell.ts#L640)): auto-open последнего проекта — включить `'browser'` в предикат (browser даже предпочтительнее: открывается без permission-промпта).

### 3.6 «Save to Folder…» (promote, входит в MVP)

Новая команда `src/features/project/MoveProjectToFolderCommand.ts` (id `project.moveToFolder`, `menuPath: 'file'`, `addToMenu: true`, `didMutate: false`), precondition: `appState.project.backend === 'browser'`. Логика — в `ProjectLifecycleService.moveBrowserProjectToFolder()`:

1. Confirm-диалог через `DialogService`: «Move this project to a folder on disk? The browser copy will be removed after a successful move.»
2. Выбрать папку. **Не** через `fs.requestProjectDirectory` — он немедленно подменяет активный `directoryHandle` ([FileSystemAPIService.ts:113](../src/services/FileSystemAPIService.ts#L113)). Добавить в `FileSystemAPIService` метод `pickDirectory(mode): Promise<FileSystemDirectoryHandle>` — тот же picker + `ensurePermission`, но без сайд-эффекта на `this.directoryHandle`.
3. Проверить, что папка пуста (как в `createNewProjectWithOptions`).
4. Сохранить dirty-табы (`editorTabService.saveDirtyTabs()`), затем рекурсивно скопировать дерево: helper `copyDirectoryContents(src, dst)` — обход `entries()`, `getDirectoryHandle(..., {create:true})` для папок, для файлов `dst.getFileHandle(..., {create:true})` → `createWritable()` → `write(await file.arrayBuffer())` → `close()`. Разместить helper в `FileSystemAPIService`.
5. Переключить проект: `fs.setProjectDirectory(newHandle)`, `appState.project.backend = 'local'`, `appState.project.directoryHandle = ref(newHandle)`, `persistProjectDirectoryHandle(id, newHandle)`, обновить recents-запись (тот же id, `backend: 'local'`).
6. Только после успеха пунктов 4-5 — `browserStore.deleteProject(id)`. При любой ошибке копирования OPFS-копию **не** трогать.

### 3.7 Что сознательно НЕ трогаем (матрица веток)

| Место | Ветка | Поведение для `'browser'` | Действие |
| --- | --- | --- | --- |
| `EditorTabService` (:435, :652, :781), `SaveSceneCommand`, `SaveActiveResourceCommand`, `SaveAnimationCommand` | `=== 'cloud'` | как local — обычные сейвы | ничего |
| `CollaborationService`, share-диалоги, `collab-status-bar` | `=== 'cloud'` | collab/share недоступны | ничего |
| `LocalSyncService` (:107, :179, :293, :785, :869), `pix3-project-sync-dialog` | `=== 'local'` | hybrid sync исключён | ничего (Phase 2) |
| `ProjectStorageService` (:277, :382, :483) | `=== 'cloud'` | local-путь через fs | ничего |
| `RouterService` (:86) | `=== 'cloud'` | local-схема URL c `localSessionId` | проверить руками, что deep-link открывает browser-проект |

---

## 4. Тесты

- `BrowserProjectStorageService.spec.ts` — happy-dom **не имеет** `navigator.storage.getDirectory`: мокать `navigator.storage` (паттерн фейковых handle уже есть в `FileSystemAPIService.spec.ts` / `LocalSyncService.spec.ts`).
- Обновить `FileSystemAPIService.spec.ts` под новый контракт `ensurePermission` (§2) + спека на `copyDirectoryContents` и `pickDirectory` на фейковых handle.
- Спека на ветку `backend: 'browser'` в `createNewProjectWithOptions` / `openRecentProject` (без picker, re-derive, удаление recents-записи при отсутствии директории).
- `npm run test`, `npm run type-check`, `npm run lint` — помнить: (а) в suite есть исключённые known-broken спеки в `vitest.config.ts` — не «чинить» их заодно; (б) lint флудит `Delete ␍` на CRLF — смотреть только на свои файлы; (в) на чистом дереве уже есть ~32 pre-existing tsc-ошибки и 1 падающая спека `UpdateCheckService` — не считать их своими.

## 5. Верификация вручную (chrome-devtools MCP / debug-running-game)

1. New Project → «In Browser» дефолт → создание **без** пикера и промптов → редактор открылся, main.pix3scene на месте.
2. Сохранение сцены, добавление нод — перезагрузка страницы — проект авто-открылся без промптов, изменения на месте.
3. Play mode (game preview через service worker): sw читает handle `project-root` из IndexedDB ([sw.ts:9-30](../src/sw.ts#L9-L30)) — `setProjectDirectory` его туда кладёт; OPFS-handle доступен из SW того же origin. Проверить, что превью грузит ассеты.
4. Recents на welcome: бейдж `Browser`, открытие по клику.
5. File → Move Project to Folder…: выбрать пустую папку → файлы на диске, backend стал local, OPFS-копия удалена, recents обновлён.
6. Deep-link URL с `localSessionId` browser-проекта → открывается после reload.

## 6. Вне скоупа (Phase 2 — отдельным заходом)

- **Move to Cloud** для browser-проекта (реюз upload-механики `LocalSyncService` / создания cloud-проекта).
- Управление browser-проектами на welcome: удаление, индикатор занятого места (`navigator.storage.estimate()`).
- Верификация Firefox/Safari (OPFS там есть, `showDirectoryPicker` — нет; после §2 browser-backend потенциально открывает эти браузеры целиком; проверить write-пути — `createWritable` в Safari появился поздно).
- «Quick Start» one-click на welcome (создание с дефолтным шаблоном в один клик, вообще без диалога).
- Предупреждение о eviction/квоте в UI.

## 7. Известные ограничения (задокументировать в спецификации)

- OPFS привязан к браузеру + профилю + **origin**: проект, созданный на `localhost:8123`, не виден на проде и наоборот. Это ожидаемо для черновиков, но должно быть сказано в UI-копирайте («stored inside this browser»).
- Браузер может вычистить OPFS при нехватке места, если `persist()` не granted — риск принят для черновиков, поэтому «Move to Folder…» обязателен в MVP.
