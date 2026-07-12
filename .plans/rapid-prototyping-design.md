# Rapid Prototyping — бесшовный сценарий «прототип игры по идее»

Дизайн-документ. Статус: фазы 1–4 реализованы (см. пометки в фазировке).

## Целевой сценарий

1. Пользователь открывает Pix3 как PWA на editor.pix3.dev (или localhost при разработке).
2. Создаёт новый локальный проект: имя, референсный размер, шаблон (2D/3D, playable, minigame), целевая платформа (mobile/desktop/universal → пресет качества).
3. Визард показывает обложки-скриншоты шаблонов.
4. В проекте предсоздана папка `design/` — туда пользователь кладёт ГДД и визуальные референсы.
5. При создании в проект копируются скиллы для агентов (`.claude/skills/`), `AGENTS.md`, `CLAUDE.md`. Папка создаётся через File System Access API.
6. Пользователь открывает папку проекта в агентском приложении (Claude Code и т.п.).
7. Просит агента собрать игру по ГДД и референсам, используя скиллы.
8. Агент изучает ТЗ, генерирует сцены/скрипты, графику (при наличии ключа) или заглушки; запускает игру через remote preview, снимает логи/метрики/скриншоты, итерирует.
9. Пользователь дорабатывает игру интерактивно с агентом.
10. Экспорт в единый HTML или архив.

## Принятые решения

- **Remote preview = живой relay** (Construct3-style), не snapshot: standalone-плеер получает сцену и ассеты on-demand через WS-комнату на collab-сервере; редактор отдаёт `res://`-файлы из FS-handle.
- **Агент взаимодействует через HTTP API** на collab-сервере + скилл в папке проекта (curl-workflow), без chrome-devtools MCP и без доступа к редактору.
- Первый этап — локальные проекты; облако позже.

## Фазировка

- **Фаза 1 — Project bootstrap** ✅: PWA, визард нового проекта с каталогом шаблонов, папка `design/`, копирование скиллов и AGENTS.md, платформенные пресеты качества.
- **Фаза 2 — Remote preview (живой relay)** ✅: preview-сессии на collab-сервере (`/api/preview` + WS `/preview`), standalone-плеер (`player.html`, `src/player/`), relay ассетов из редактора (`PreviewHostService`, hash-ревалидация + Cache API), QR-диалог (`project.start-remote-preview`).
- **Фаза 3 — Agent HTTP API + скилл** ✅: commands (restart / reload-from-disk / screenshot / set-property / snapshot / inspect / game-action с ack), logs (курсор), metrics, screenshot (`?fresh=true`); `.pix3/preview-session.json` пишется при старте сессии; скилл `pix3-remote-preview` в шаблонах переписан на реальный curl-workflow.
- **Фаза 4 — Полировка экспорта** ✅: `project.export-playable-zip` (index.html + ассеты файлами, jszip, без base64-оверхеда; `ResourceManager('./')` в runtime main для хостинга из подпапки); PlayableSDK — DAPI `openStoreUrl()` в цепочке CTA, `getViewport()/getOrientation()/onResize()` (window + MRAID `sizeChange` + DAPI `adResized`). MRAID/DAPI lifecycle-адаптеры глубже (ready/viewable) — вне v1.
- **Фаза 5 — Телеметрия устройств в редакторе** ✅: модалка remote preview заменена карточкой в Game-вкладке (`pix3-remote-preview-card`: QR, ссылка, статус, живой список устройств); команда открывает Game-вкладку и поднимает Profiler/Logs; закрытие вкладки останавливает сессию. Плеер шлёт `device-info` (UA, GPU, экран, память, ядра; переотправка при реконнекте хоста) и расширенные метрики (`maxFrameMs`, `longFrameCount`, `jsHeapUsedMb`), логи rate-limited (25/500мс + счётчик дропов). Новый `RemotePreviewTelemetryService` (по clientId) зеркалит логи в `LoggingService` с `source`-тегом (чип + фильтр в Logs-панели), Profiler-панель получила переключатель источника (Editor / каждое устройство, автовыбор живого устройства при неактивном локальном Play) с 1Гц-историей, Device-секцией и спайками. Relay хранит device-info по клиенту и отдаёт в статусе сессии (`players[]`) для агента. Отложено: detailed-режим frame-impact активностей по запросу, символикация стеков через sourcemap бандла.

---

## Фаза 1: Project bootstrap

### Манифест (`pix3project.yaml`)

Новые поля (нормализация в `src/core/ProjectManifest.ts`):

```yaml
projectType: 2d | 3d
targetPlatform: mobile | desktop | universal
quality:            # дефолты выводятся из targetPlatform
  antialias: boolean
  shadows: boolean
  maxPixelRatio: number   # mobile: 2, desktop/universal: без жёсткого капа
```

`templateId` хранится в `metadata`. Пресет применяется в `GamePlaySessionService.startRuntime` (создание `RuntimeRenderer`), в `RuntimeRenderer` (maxPixelRatio) и в экспорте (`PlayableHtmlBuildService`).

### Каталог шаблонов

`src/templates/projects/<id>/{template.yaml, cover.png, files/**}` — бандлится `import.meta.glob`, читается новым `ProjectTemplateService`. `ProjectService.createProjectStructure(templateId, …)` копирует дерево `files/**` + общий overlay.

Шаблоны v1: `empty-3d`, `empty-2d`, `playable-3d`, `playable-2d` (tap-to-start разблокировка аудио, финальный CTA-экран), `minigame-2d` (меню, префаб `settings-window.pix3scene` с тумблерами Music/SFX по аудио-шинам, кнопка открытия).

Engine-уровень (в `@pix3/runtime`): `core:AudioUnlockGate` (разблокировка аудио по первому тапу), `PlayableSDK`-шим (`openStore(url)`, `gameEnd()` — в редакторе console.log, в экспорте window.open, MRAID/DAPI позже). Оверлеи/меню/окна — шаблонные сцены и user-скрипты.

### Overlay во все шаблоны

```
design/README.md + design/references/
.claude/skills/pix3-game-dev/       # game-project версия скилла + копии
                                    # nodes-and-systems.md, node-types-reference.md
.claude/skills/pix3-remote-preview/ # v1-заглушка (реальный API — фаза 3)
AGENTS.md, CLAUDE.md                # правила для агента в папке игры
.pix3/template.json                 # id+версии шаблона/скиллов для будущих апдейтов
```

Исходники — `src/templates/agent/**`.

### PWA

`vite-plugin-pwa` (autoUpdate), webmanifest (standalone, иконки 192/512), precache app shell включая `esbuild.wasm`. Легаси `src/sw.ts` не регистрируется, помечен к удалению.

---

## Фаза 2: Remote preview — живой relay

### Компоненты

**Preview-сессия на collab-сервере** (`packages/pix3-collab-server`):
- `POST /api/preview/sessions` → `sessionId`, `joinUrl`, `hostToken`, `agentToken`, `guestToken`. Для локальных проектов — анонимная сессия с TTL, вход только по токенам.
- Новый WS-путь `/preview` (расширить маршрутизацию upgrade в `sync/hocuspocus.ts` — сейчас всё, кроме `/collaboration`, получает 404).
- Роли: `host` (редактор, один), `player` (много), `agent` (через HTTP).
- Протокол: JSON-сообщения + бинарные фреймы для файлов (request/response, correlation id). Сервер — тупой relay + кольцевые буферы (логи, последний скриншот, метрики) для HTTP API.

**Standalone-плеер** — отдельный лёгкий entry `player.html` в том же Vite-приложении (только `@pix3/runtime` + `PreviewPlayerClient`, без редактора):
- `https://editor.pix3.dev/player.html?session=…&token=…`.
- `RemoteResourceManager extends ResourceManager`: `res://` уходит host'у через relay; кеш по content-hash в Cache API.
- Скрипты компилирует редактор (`ScriptCompilerService`), плеер получает готовый бандл и исполняет через blob-URL import (esbuild в плеере нет).
- `SceneRunner.startScene()`; на `scene-updated` — рестарт с инвалидацией изменённых файлов (v1 — полный рестарт).
- Назад: console/errors, агрегаты `SceneRunnerFrameSample` (раз в секунду), скриншот по запросу (`canvas.toBlob('image/jpeg')`).

**Редактор-host** — `PreviewHostService` (`src/services/`):
- Команда `project.start-remote-preview` → создать сессию, коннект host'ом, диалог с QR (`qrcode`) и ссылкой.
- File-request: `ProjectStorageService.readBlob` + sha-256; манифест файлов сцены — переиспользовать обход зависимостей `ProjectBuildService.buildRuntimeProjectModel`.
- `scene-updated` при сохранении сцены/скрипта.
- Команда `reload-from-disk`: перечитать изменённые файлы, перезагрузить открытые сцены — ключ к циклу «агент правит файлы на диске → видит результат».

Сервер обязателен даже для локального проекта: файлы за `FileSystemDirectoryHandle` извне недоступны, телефон не достучится до вкладки напрямую; relay решает NAT и мобильный доступ. WebRTC DataChannel (сервер как signaling) — возможная оптимизация позже.

---

## Фаза 3: Agent HTTP API

Поверх preview-сессий, аутентификация `agentToken`:

- `GET  /api/preview/sessions/:id` — статус (host online, players, playModeStatus).
- `POST /api/preview/sessions/:id/commands` — `restart | reload-from-disk | screenshot | set-property | game-action` (роутится host'у/плееру, с ack).
- `GET  /api/preview/sessions/:id/logs?since=cursor`
- `GET  /api/preview/sessions/:id/metrics` — агрегат в духе `ProfilerSessionSnapshot`.
- `GET  /api/preview/sessions/:id/screenshot` — JPEG от плеера.
- Диагностика через `__PIX3_GAME_DEBUG__`-провайдер плеера (`inspect`, `snapshot`).

Связка с папкой проекта: при старте сессии редактор пишет `.pix3/preview-session.json` (sessionId, api base URL, agentToken, expiry) через FS-handle; агент находит его и работает curl'ом. Скилл `pix3-remote-preview` документирует цикл: проверить сессию → reload-from-disk → restart → logs/metrics/screenshot → итерация. Fallback'а без открытого редактора нет — скилл просит пользователя нажать Start Remote Preview.

---

## Фаза 4: Экспорт

- Вариант «HTML + assets zip» (jszip) рядом с существующим single-file экспортом.
- Довести `PlayableSDK` до реального API: `openStore()`, `gameEnd()`, MRAID/DAPI-адаптеры, orientation/resize (по ROADMAP).
