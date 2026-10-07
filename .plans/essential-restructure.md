# Essential: Pix3 как агентный стек (runtime + CLI + kit + редактор как точный инструмент)

Дата: 2026-10-07. Ревизия 3: после ревью 1 и ревью 2 (журнал в §G). Статус: план, P0 можно
начинать. Позиционирование задано brief и не пересматривается. Утверждения о коде проверены по
исходникам, путь указан рядом.

**Что этот план заменяет в `.plans/external-agent-authoring.md`:**
- §1.2 — окно редактора как PWA с `editor.pix3.dev`;
- §9 — пункт «не заменяем встроенного агента»;
- §11.1 — FSA-папка и ручной `pix3 serve` как основной путь.

Остальное остаётся в силе: co-authoring, барьер §5 D, `expect`, подтверждение `generate_*`.

## 0. Коротко

1. **Сначала проверяем подход, потом режем.**
   - Последовательность: P0 спайки → P1a минимальный поток (`2.0.0-alpha.1`, dogfood C1) → P1b
     надёжность (`alpha.2`) → P3 MVP-тест.
   - Hosted-сборка уже в P1 ограничена рамками essential: исключённое видно, но недоступно, и каждое
     обращение пишется как пробел продукта.
   - Физический carve-out (P2) идёт параллельно в ветке `essential`.
2. **Поток.**
   - `pix3 setup --write` создаёт глобальную запись MCP.
   - Процесс `pix3 mcp` хостит workspace-сервер и раздаёт редактор с того же origin.
   - Ссылка содержит одноразовый `#pair=`.
   - Если хост умер, редактор переходит в **offline-черновик**. Это новая работа с явным контрактом
     (C.2b), а не «существующий путь».
3. **Carve-out.**
   - Удаляется ~85–90k из ~235k строк `src/`, плюс collab-server и agent-bridge. Около 35
     файлов-швов.
   - Подсистема проверки игры (~15k) остаётся и переезжает в `services/game-test/`.
   - `AgentToolRegistry` заменяется `ChannelToolRegistry`.
4. **`export_playable`** — барьерный инструмент. Он фиксирует ревизию входов и сам проверяет
   получившийся HTML, запуская его отдельно от редактора.
5. **Успех MVP** определяется двумя обязательными исходами: самостоятельность дизайнера и качество
   прототипа. Время — необязательное бизнес-требование, его владелец задаёт до теста.
6. **Сроки.**
   - P0 — 4 дня.
   - P1a — 8–10 дней.
   - P1b — 8–12 дней, точнее после спайков S1, S12 и S14.
   - P3 — ~10 дней.
   - Итого до решения 6–7 недель. P2 (8–10 дней) укладывается внутрь.

## A. Стратегия репозитория

### A.1 Факты

| Критерий | A: на месте | B: новый репо |
|---|---|---|
| Хирургия ~35 швов (B.2) | нужна | **та же**: копия переносит ту же связность (`AgentToolRegistry.ts:1-158`, eager-агент через `game-tab.ts:10`, `logs-panel.ts:4`, `pix3-status-bar.ts:20-22`, `pix3-welcome.ts:19-25`, `main.ts`) |
| История | целиком | клон с последующим удалением даёт ту же. `filter-repo --path` её рвёт |
| npm OIDC и provenance | без изменений | перенастройка (минуты) |
| Один источник runtime и CLI на npm | да | две копии lockstep-линии |
| DeepCore | берёт `@pix3/runtime` из npm `^1.6.2` (`../DeepCore/package.json:22`). Caret не подтянет 2.0-alpha | то же |
| Нетронутый 1.x на время теста | через ветку | да |

### A.2 Решение: один репо, carve-out в ветке `essential`

- **`main`.** Полный редактор плюс поток P1, hosted-сборка с ограничением (C.3). Отсюда выходят
  `2.0.0-alpha.N` в dist-tag `next`, а `latest` остаётся 1.6.3.
- **`essential`** (worktree). Это P2: один коммит на область, `main` регулярно вливается в эту
  ветку.
- **Если P4 успешен:**
  - ставится тег `pix3-full-<версия>`;
  - `main` переименовывается в `full`, а `essential` — в `main`;
  - выходит `2.0.0` в `latest`.
- **Если провал:** `essential` не вливается.
- **`pix3dev/pix3-platform`** выделяется из `full` только по решению о платформе:
  `git filter-repo --path packages/pix3-collab-server/ --path src/services/{cloud,collab,library}/ --path src/ui/{collab,asset-library}/ --path src/player/ --path player.html`.

### A.3 CI, публикация, документация

- **`publish-packages.yml`** (стр. 60/108/136, сейчас `npm publish --access public`):
  - добавить `--tag next`, если в версии есть `-`;
  - в job cli перед публикацией запускать `npm run build:hosted`, затем проверку архива (C.3);
  - job bridge в `essential` удаляется.
- **CI.** Вместо `ci.yml.disabled` — `ci.yml` на `main` и `essential`: lint, type-check, vitest,
  `build:hosted`, `npm pack` с проверкой содержимого, браузерный гейт (D.4).
- **Collab-сервер.** После переименования `deploy-collab-server.yml` в `full` запускается по
  `on: push: branches: [full]`, потому что `workflow_dispatch` работает только из ветки по
  умолчанию. В `full` разрешены только security-фиксы collab-сервера (F.13).
- **Kit drift spec** (`packages/pix3-cli/src/kit.spec.ts`):
  - тест, читающий `AgentToolRegistry.ts` (~стр. 245), удаляется в `essential`;
  - проверка «ровно 14 инструментов» меняется на новый список;
  - `engine-api-map.md` переезжает в `packages/pix3-cli/kit-src/`;
  - `src/core/agent-reference-docs.spec.ts` остаётся, путь в нём правится.
- **Документация (в `essential`).** Правятся README, AGENTS.md, CLAUDE.md (в том числе неверная
  строка про yalc у consumer) и спецификация. Удалённые разделы сворачиваются в одну строку
  «удалено в 2.0, см. `full`». Новых `.md` не появляется.
- **Чистка дерева.** Только в `full` остаются:
  - планы `flow-autopilot`, `prompt-to-playable-flow`, `vibe-wow-first-prompt`, agent-eval*;
  - `.env.development` и `.env.prod-backend`;
  - скрипты `dev:prod`/`dev:collab*`;
  - `src/sw.ts`;
  - записи `knip.json` для удалённых entry.
- **Skills репозитория.**
  - `debug-running-game` вызывает `scene_tree`/`create_node` (`SKILL.md:84-91`); переписывается на
    сокращённый `debug-bridge`.
  - `generate-sprites-in-editor` удаляется.
  - Ссылка на Sprite Editor в `pix3-game-dev` правится.

## B. Essential scope (P2, ветка `essential`)

Статусы: **KEEP** / **TRIM** / **MOVE** — в ядре. **LABS** — удаляется, возвращается только как
инструмент MCP или глагол CLI. **PLATFORM** — уходит в `pix3-platform`. **FREEZE** — остаётся только
в `full`. **DELETE** — не возвращается.

### B.1 Каталоги

| Каталог | Строк | Статус |
|---|---|---|
| `packages/pix3-runtime` | 62,6k | KEEP, сеть не трогаем (B.5) |
| `packages/pix3-cli` | 16k | KEEP, растёт. `link-server.ts` (512) и `mcp.ts` (129) — DELETE (у редактора нет клиента) |
| `packages/pix3-collab-server`, алиасы `@pix3/collab-*` (`vite.config.ts`, `tsconfig.json`, `vitest.config.ts`) | 7,8k | PLATFORM |
| `tools/pix3-agent-bridge` | 7,6k | FREEZE |
| `services/agent` | 26,6k | **MOVE → `services/game-test/`** (~15k, 18 файлов, импорты без llm/flow): `GameTestService`, `GameInputService`, `GameBotHost`, `game-*.ts`, `NodeWatchRecorder`, `ProjectTraceStore`, `reachability-journal`, `nondeterminism-probe`, `key-for-code`, `renderability-note`, `pix3-test-bot-dts`. Остальное — FREEZE. `agent-skills/` до этого переносится в kit (C.5) |
| `services/{flow,llm}`, `ui/{agent-chat,flow}`, `features/flow`, `src/templates/agent` | ~22k | FREEZE |
| `services/{cloud,collab,library}`, `ui/{collab,asset-library,auth}`, `features/library`, `LocalSyncService` | ~19k | PLATFORM/FREEZE |
| online/remote-preview: `services/play/{OnlineSession,PreviewHost,RemotePreviewTelemetry}Service`, `core/remote-preview/`, `src/player/`, `player.html`, карточки во viewport, две команды | ~5k | PLATFORM |
| `services/model-gen`, `ui/model-lab`, `ui/sprite-editor` (с вкладкой `animation`, `LayoutManager.ts:44-48`), `services/{uikit,uikit-editor}`, `ui/{uikit-forge,tools}`, `src/tools/uikit-forge`, `features/uikit`, `ui/generate`, `services/ao-bake`, `features/render`, `ui/profiler` + `ProfilerSessionService`, `ui/home` + `ProjectHomeService` | ~43k | LABS. `.pix3anim` редактируется как YAML в Monaco |
| `services/{sfx-gen,bg-removal,strophe}` | ~2,8k | DELETE |
| `services/image-gen` | 5,9k | TRIM: `AssetGenService`, `Gemini`/`OpenAIImageProvider`, `ImageGenProviderRegistry`, `AiImageSettingsService`, `GenerationHistoryService`, `ImageGenTypes`. `image-ops.ts` **MOVE → `src/core/`** (экспорт, инспектор) |
| `services/atlas`, локализация (2,6k, связана с play и экспортом) | | KEEP |
| `services/project/agent-kit`, `InstallAgentKitCommand`, `pix3-agent-handoff-dialog`, `scripts/ensure-agent-kit.mjs` | ~1,3k | DELETE (kit ставит `project_new`) |
| `services/editor/{WorkspaceMode,StudioViewportMount,UpdateCheck}Service`, `SwitchWorkspaceModeCommand`, `pix3-mode-switch` | | DELETE |
| `ui/shared` | 12,8k | DELETE: `composer-attachments`, `pix3-image-annotator`, `pix3-project-sync-dialog`, `pix3-save-asset-dialog`, `pix3-animation-auto-slice-dialog`. Остальное KEEP/TRIM |
| `src/core` | 6,8k | DELETE: `agent-eval`, `dev-backend`, `tool-routes`. `debug-bridge.ts` (1 286) → ~300 строк |
| ядро редактора: viewport, scene-tree, inspector, assets, code-editor, runtime, logs, timeline; services viewport/play/scene/scripting/assets/editor/core/animation/export; project/{workspace,coauthoring,autosave,external-merge}; `src/templates/projects` | ~80k | KEEP/TRIM. FSA и OPFS остаются без вложений |

Удаляемые зависимости: `@hocuspocus/provider`, `yjs`, `@huggingface/transformers`, `onnxruntime-web`,
`@txt2sfx/*` ×5, `qrcode`, `vite-plugin-pwa`, `concurrently`.

### B.2 Швы (~35 сохраняемых файлов)

| Файл | Что тянет | Замена |
|---|---|---|
| `atlas/TextureAtlasService.ts:7` | `sha256Hex` из `core/remote-preview/protocol` | `src/core/hash.ts`. `guessMimeType` → `src/core/mime.ts` |
| `editor/EditorTabService.ts:20,52,439` | `PreviewHostService`. В `pix3.projectTabs:<id>` лежат типы `animation`/`sprite-editor`/`model-lab`/`uikit-forge` | убрать inject. Фильтр неизвестных типов уже есть с P1 (C.3). Сам layout не сохраняется (`LayoutManager.ts:1044`) |
| `core/LayoutManager.ts:14-34` | 19 панелей, базовый стек — `background` (home) | 10 панелей и `pix3-empty-stage` (сделаны в P1) |
| `image-gen/AssetGenService.ts:11,238,483-515` | `BackgroundRemovalService` | OpenAI `transparent`. Для Gemini — плоский фон и `chromaKeyImage` (`image-ops.ts:642`). Это регрессия качества, проверяется на 10 спрайтах в P1b |
| `ImageGenProviderRegistry.ts:4-8,37-39`, `AiImageSettingsService.ts` | Strophe, SvgLlm, Codex, Bridge, `bg-removal/types` | оставить только Gemini и OpenAI |
| `generate_asset` в `AgentToolRegistry.ts` (~2132) | idea-stage, `references/`, роли (flow) | вырезать при переносе |
| `ui/viewport/game-tab.ts:10,283`, `logs-view/logs-panel.ts:4,110` | `composeFix`, карточки online/preview | «Copy for agent» (`buildPlayModeErrorPrompt` → clipboard) |
| `object-inspector/inspector-panel.ts:43-44,61` | `contour-trace` (sprite-editor), `library-inspector` | `contour-trace.ts` **MOVE → `src/core/`**, library убрать |
| inspector renderers ×2, `scene-tree-panel`, `assets/{asset-tree,assets-content,assets-panel}`, `viewport/editor-tab` | collab presence, `LibraryInsertService`, `GeneratedAssetDropService`, `openInSpriteEditor` (`assets-content.ts:576`) | убрать |
| `pix3-editor-settings-dialog.ts` (2 455) | llm, agent, model-gen, strophe, bg-removal | остаётся Editor/Viewport. Ключи хранятся в CLI |
| `pix3-status-bar.ts:10,20-22,32,44` | Bridge, LLM, `dev-backend`, `UpdateCheckService`, `collab-status-bar` | статус workspace, пилюля канала, состояние offline |
| `pix3-lightbox.ts:9,11` | `markdown-lite`, `pix3-image-annotator` | `markdown-lite` → `ui/shared`, аннотации убрать |
| `pix3-create-project-dialog.ts`, `ProjectLifecycleService.ts:16-26,86,92-229,307-351` | Auth, CloudProject, `AgentKitService`/`withAgentKit` | убрать. `cli-manifest.spec.ts` теряет часть про agent-kit |
| `pix3-welcome.ts` (1 197) | cloud, llm, agent, flow | ~250 строк для dev-режима. Hosted-загрузка — из P1 |
| `pix3-editor-shell.ts` (2 158) | ~17 команд, сервисы Auth/Cloud/LocalSync/AgentKit/WorkspaceMode, flow-shell, collab, uikit-forge, auth | вырезать, в том числе cloud-ветку (~1463-1471) |
| `main.ts`, `register-runtime-services.ts:3-5` | инициализация LibrarySync и Bridge; collab-регистрации | убрать |
| `OperationService.ts:24,292-335`, `CommandDispatcher.ts`, `RouterService.ts` | `Y.UndoManager`, collab read-only, `CollabJoinService`, `#uikit` | убрать |
| `ProjectService.ts:43-44,~406-412,~1236` | Collaboration, `ideaTimeline`, `LocalSyncService` | убрать |
| `ProjectStorageService.ts:15`, `ProjectScriptLoaderService.ts`, `ViewportRenderService.ts` | `'cloud'`, `ApiClientError`, collab overlay, `workspaceMode` | `'local' \| 'workspace'` |
| `features/scripts/play-workspace.ts`, `state/{AppState,index}.ts` | срезы `collaboration`/`auth`/`workspaceMode`/`flowAutopilot` | удалить |
| `WorkspaceAgentToolBridge.ts:281` | `@injectLazy(AgentToolRegistry)` | `ChannelToolRegistry` |
| `vite.config.ts` | PWA, `player`/`uikitForge`, прокси облака и AI, `__PIX3_DEV_BACKENDS__`, ensure-agent-kit | остаются `/openai-proxy` для dev, rapier, manualChunks, `export-vendor` |

Последним идёт отдельный коммит knip: палитровый код `image-ops.ts` (~900 строк) и прочее.

### B.3 `ChannelToolRegistry`

`src/services/agent-channel/ChannelToolRegistry.ts` сохраняет контракт `AgentToolSpec`/`execute`.

- **Что переносится из `AgentToolRegistry.ts`:** play_* (~1470-1512), `game_input` (~1513),
  `game_observe` (~1633), `game_run` (~1721), `read_logs`/`read_errors` (~2031-2041),
  `viewport_screenshot` (~2057), `get_selection` (~968), урезанный `generate_asset`, а также
  `export_playable` из P1.
- **Как:** скопировать файл и удалить недостижимое, ориентируясь на `noUnusedLocals`. Подсказки
  `channel-tool-hints.ts` применить к описаниям один раз, а сам слой удалить.
- **Объём:** ~1,5–2k строк.

### B.4 Генеративные инструменты

| Инструмент | Где | Почему |
|---|---|---|
| `sfx` | процесс CLI (`pix3-cli/src/sfx/`) | без ключей. Редакторному `generate_sfx` нужна LLM-полоса, она уходит |
| `generate_asset` | редактор, через канал, с подтверждением | постобработке нужен canvas. Ключи на сервере CLI (C.3). `svg-llm` не нужен: SVG пишет агент, `E_SVG_*` проверяет `check` |
| `skin_ui` | LABS. Триггер: UI-тяжёлый концепт и пройденный S11 | писатель `UiKitProjectWriter.ts:254` привязан к canvas. Ядро `uikit` host-agnostic, его перенос в CLI занимает 3 дня |

### B.5 Сеть runtime: не трогать

`src/net/` (~7k) встроен в пакет (`core/SceneService.ts:8-9`, `register-behaviors.ts`) и уже
вырезается из playable (`strippable-runtime-modules.ts`). DeepCore сеть не использует. Вынос стоит
2–3 дня и не даёт пользователю ничего. Удаляются только редакторные потребители.

## C. Поток agent-first (P1, `main`)

### C.1 `pix3 setup [codex|claude] --write`

Сейчас `mcp-config.ts:setupInstructions` только печатает инструкцию. Новое поведение:

1. **Цель:** аргумент или автоопределение (`CLAUDECODE=1`, переменная Codex — из S1). Основной путь —
   Codex: у Claude в MY.GAMES был организационный 403 (§11.14 внешнего плана).
2. **Установка:** `npm install --prefix ~/.pix3/cli/<ver> @pix3/cli@<ver>`, плюс TypeScript в
   `~/.pix3/typescript/<PINNED>` и `esbuild`. Без этого ленивая установка в `check/typescript.ts`
   не найдёт npm из GUI-процесса.
3. **Запись MCP:** `command` = `process.execPath`; `args` = `[…/dist/index.js, "mcp"]`; `env.PATH`
   начинается с `dirname(execPath)`.
4. **Codex** (`~/.codex/config.toml`):
   - таблицы `[mcp_servers.pix3]` и `[mcp_servers.pix3.*]` заменяются целиком;
   - пути пишутся литеральными строками `'…'` (Windows);
   - бэкап с меткой времени;
   - перечитать файл после записи, плюс `codex mcp list`, если `codex` установлен;
   - `startup_timeout_sec = 30`, `tool_timeout_sec = 180`.
5. **Claude:** только `claude mcp add --scope user`, иначе печать инструкции или plugin-маршрута.
   `~/.claude.json` не трогаем: Claude Code сам его переписывает, пока работает.
6. **Глобальный skill** пишется только для хоста, который не показывает `instructions` (S6).
   `--remove` откатывает всё.
7. **Вход для человека:** одна строка в README для вставки в чат. Если Node нет, план Б — портативный
   Node в `~/.pix3/node` (S3).

### C.2 Процесс MCP хостит сервер

- **Старт.** stdio поднимается сразу, порт не занимается.
- **Привязка к проекту.** Срабатывает на `project_new`/`project_open {dir}` или на первом
  инструменте в найденном проекте: `ensureHost(root)` → `openWorkspace` с портами
  `[lastPort, 8490..8499]`.
  - `started` — процесс становится хостом;
  - `running` — процесс становится клиентом lane;
  - `unresponsive` с мёртвым pid — lock забирается (`acquireServeLock` → `isProcessAlive`).
- **`lastPort` — новое поле `.pix3/workspace.json`.** Сегодня `clearServer`
  (`serve/state-file.ts:204`) при штатном выходе обнуляет запись `server` вместе с портом, и
  «липкому» порту не на что опереться. `lastPort` переживает выход.
- **Несколько проектов.** В процессе `Map<root, …>`, у инструментов есть параметр `dir`.
- **stdout — это JSON-RPC.** Логи сервера идут только в stderr; на это есть тест.
- **Grace.** После конца stdin или SIGTERM хост живёт, пока вкладка держит lease, но не дольше
  10 минут без MCP. При SIGKILL grace нет. Это ограниченное исключение из F.2.
- **Повышение клиента.** Если lane отвечает ECONNREFUSED, клиент вызывает `ensureHost`. Любой новый
  процесс MCP (`editor_link`, рестарт приложения) поднимает хост.
- **`pix3 serve`** остаётся для терминала и dev; `mcp --workspace` — алиас.

### C.2b Offline-черновик — новая работа (W-OFF, 3–4 дня)

Сегодня такого пути нет. Reconnect только делает rescan (`WorkspaceSessionService.ts:409`),
восстановление версии — отдельная команда (`ExternalMergeService.ts:382`). Fallback журнала молча
уходит в память (`recovery-fallback-store.ts:47`), а смена порта меняет origin, и IndexedDB
становится недоступен. Контракт:

1. **Что и когда.** Пишутся только текстовые записи редактора в backend `workspace` (сцены, префабы,
   скрипты, `.pix3anim`, yaml/json), и только когда запись на сервер не прошла (сеть, `reconnecting`).
   Слой — workspace-ветка `ProjectStorageService`. Бинарные операции и move/delete в offline
   отказываются с причиной.
2. **Хранилище.** Новый `OfflineDraftStore`: IndexedDB `pix3-offline-drafts`, ключ
   `workspaceId|path`. Запись: `{baseHash, content, createdAt, seq}`, где `baseHash` — sha256
   версии на диске, которую редактор видел последней (манифест или ETag). Ring журнала с его
   прунингом сюда не подходит.
3. **Подтверждение долговременности.**
   - «Сохранено в браузере» показывается только после `transaction.oncomplete`.
   - При первом offline вызывается `navigator.storage.persist()`.
   - Если IndexedDB недоступен или `put` упал: красный баннер «НЕ сохранено — не закрывайте вкладку»,
     правки блокируются. Тихого ухода в память нет. Тот же фикс вносится в
     `recovery-fallback-store.ts`: сделать переход в память видимым.
4. **Баннер offline:** «Связь с сессией агента потеряна. N правок сохранено в этом браузере. Не
   перезагружайте вкладку. Попросите агента открыть редактор (`editor_link`)». Сервер мёртв, а
   статику раздаёт он же, поэтому F5 даст пустую страницу. Баннер прямо об этом предупреждает.
5. **Восстановление при reconnect.** Для каждого черновика сравнивается хэш на диске:
   - если он равен `baseHash` — PUT с `If-Match`, после успеха черновик удаляется;
   - если отличается (агент правил файл, пока вкладка была offline) — **не перезаписывать**.
     Черновик пишется версией в `.pix3/recovery/` (`RecoveryJournalService.recordVersion`), диск
     загружается, баннер называет файл и предлагает «Восстановить мою версию» — это существующий
     `ExternalMergeService.restoreVersion`, он undoable.
6. **Смена порта или origin.**
   - (а) Вкладка ещё открыта. Она ищет свой `workspaceId` на портах `[lastPort, 8490..8499]`: GET `/`
     и `<meta name="pix3-workspace-id">`. Потом переподключается к новому порту по своему токену.
     Это кросс-портовый loopback-запрос, его разрешает текущий allowlist (C.3), так что черновики
     сливаются. `WorkspaceClient` уже принимает endpoint параметром.
   - (б) Вкладка закрыта. `lastPort` возвращает хост на тот же origin, новая вкладка видит черновики
     по `workspaceId`. Если `lastPort` занят другим проектом, черновики остаются в старом origin.
     `editor_link` и `doctor` об этом сообщают («черновики на :8490 — откройте его, когда порт
     освободится»). Это остаточное ограничение, и оно задокументировано.
7. **Тесты** (они же входят в гейт D.4):
   - kill -9 хоста во время правки в инспекторе → черновик в IndexedDB → новый хост → **байты на
     диске равны черновику**;
   - агент пишет тот же файл, пока вкладка offline → после reconnect на диске байты агента,
     черновик лежит версией в `.pix3/recovery/`, баннер есть;
   - вкладку закрыли в offline и открыли позже по ссылке → черновик слит;
   - смена порта при открытой вкладке → слит на новый порт;
   - IndexedDB отключён → красный баннер, слова «сохранено» нет.

### C.3 CLI раздаёт сборку редактора (hosted)

- **Сборка.** `npm run build:hosted` (`vite build --mode hosted`) кладёт результат в
  `packages/pix3-cli/editor/` — это единственный путь, он в gitignore. Порядок: runtime (через
  алиас) → редактор → CLI (`build`, `build-runtime-types`, `build-kit`, `copy-editor`). В `files`
  добавляется `editor`, плюс `licenses:report` и THIRD_PARTY_NOTICES.
- **Исключения на этапе сборки.** Нет PWA, inputs `player`/`uikitForge`, ONNX/bg-removal и
  **Spine — по обоим путям**:
  - алиас `@esotericsoftware/spine-threejs` → stub-модуль, а `registerSpineModuleLoader` не
    вызывается;
  - `load`-плагин режима hosted подменяет `spine-threejs.mjs?raw` из `import.meta.glob` экспортёра
    (`PlayableHtmlBuildService.ts:202-208`) на stub-строку;
  - CI и `prepack` сканируют распакованный tarball на `esotericsoftware` и «Spine Runtimes License».
    Найдено — сборка падает.
- **Проект со Spine в hosted.**
  - runtime и так кидает «Spine is not installed» без loader (`core/spine/spine-module.ts:225-231`);
  - редактор показывает это у узла и в логах с текстом «Spine не входит в hosted-редактор pix3;
    используйте dev-путь»;
  - `export_playable` и команда экспорта отказывают с `spine_unavailable`, если
    `ProjectBuildService.usesSpine`;
  - `pix3 check` выдаёт предупреждение `W_SPINE_HOSTED`.
- **Рамки essential уже в P1 (гейт `VITE_PIX3_HOSTED`).** Один список `src/core/hosted-scope.ts`:
  - **команды меню.** Sprite Editor, Model Lab, UI Kit Forge, Generate, Agent Chat, Home, Vibe,
    Library/Store, Online/Remote Preview, AO, Install Agent Kit;
  - **контекстные действия ассетов** (`openInSpriteEditor`, `assets-content.ts:576` и подобные);
  - **типы вкладок** из `pix3.projectTabs`;
  - **панели `LayoutManager`**.

  Исключённые пункты меню и контекстные действия **видны, но неактивны**, с подсказкой «Нет в
  Essential». Нажатие записывает строку в `.pix3/hosted-gaps.jsonl` (время, id, откуда). Вкладки
  исключённых типов при восстановлении отбрасываются, и это тоже пишется в журнал. Вместо home —
  `pix3-empty-stage`, вместо welcome — `pix3-hosted-boot`. Физически всё удаляется в P2.
- **Сервер.**
  - Статика без авторизации: `index.html` с `no-cache` и `<meta name="pix3-workspace-id">`,
    ассеты — `immutable`.
  - Host-check остаётся.
  - `/openai-proxy/v1/*` и `/gemini-proxy/*` подставляют ключ **на сервере** из `~/.pix3/keys.json`
    (0600). Ключи в браузер не попадают и одинаковы для всех портов. Маршруты только same-origin и
    с токеном.
- **Авторизация.**
  - `isAllowedOrigin` принимает loopback-origin с любым портом (решение §11.1). Это нужно и для
    проброса VS Code, и для слива черновиков на новый порт (C.2b.6).
  - Убираются `https://editor.pix3.dev` и эхо `Access-Control-Allow-Private-Network`
    (`workspace-server.ts:699`).
  - Токен обязателен. Lane агента не меняется. `cli-version-gate` в hosted не нужен.

### C.4 Пара по одноразовому коду, ключ — `workspaceId`

1. `editor_link` (и `project_new`/`project_open`) выдаёт код: 128 бит, TTL 10 минут, однократный.
   Процесс-клиент получает его через `POST /ws/agent/pair-code`. Ссылка:
   `http://127.0.0.1:<port>/#pair=<code>`. Долгоживущий токен в истории чата оставлять нельзя.
2. Редактор действует по образцу `BridgeConnectionService.consumePairingLink` (`:294`): сначала
   `replaceState`, затем `POST /ws/pair`. В ответ приходит `{workspaceId, token}`, токен уходит в
   `WorkspaceCredentialStore` по `workspaceId`.
3. Без кода редактор берёт `workspaceId` из meta, а токен — по нему. Если нет ни того, ни другого —
   карточка «Откройте ссылку из чата ещё раз».
4. На сервере `tokens[]`: до 8 токенов, неиспользуемые дольше 30 дней удаляются. Удалить файл —
   значит отозвать все.
5. Браузер открывается автоматически на первом `project_new`, если нет `SSH_CONNECTION` и не задано
   `PIX3_OPEN_BROWSER=0`.

### C.5 Инструменты MCP и kit

| В процессе CLI | Через редактор |
|---|---|
| `doctor`, `project_new`, `project_open`, `editor_link`, `check`, `smoke`, `tree`, `sfx` | `project_status`, `play_start/stop/restart/status`, `game_run`, `game_input`, `game_observe`, `read_errors`, `read_logs`, `viewport_screenshot`, `get_selection`, `generate_asset`, `export_playable`. `generate_sfx` убран |

- **CLI-глаголы стали инструментами:** в песочнице Codex сеть выключена, а `npx` ненадёжен.
- **`project_new {dir, template?, name?}`:**
  - `createProject` + `agentKitStep` **без** `.mcp.json`;
  - «не пусто» допускает `.git`, `.codex`, `.claude`, `.vscode`, `.idea`, `.DS_Store`
    (`new-project.ts:72`);
  - шаблоны берутся из `listTemplates()`;
  - ответ: ссылка + «прочитай AGENTS.md сейчас».
- **`instructions`** (~1 000 знаков): нет `pix3project.yaml` → `project_new {dir}` → AGENTS.md →
  кликабельная ссылка → правка файлов, `check`, `game_run` → при сбое `doctor`.
- **`doctor`** возвращает `{check, ok, fix}` по пунктам: Node, CLI, TS, версия kit, lock/порт/
  `lastPort`, держатель lease, `editor/`, `keys.json`, `SSH_CONNECTION`, черновики в другом origin.
- **Знание встроенного агента переносится в kit до заморозки.** Из `agent-skills/verify-and-fix.md`
  (368 строк; `GameDebugProvider`, без которого не работают предикаты `gameStateChanged`) и
  `game-prototype.md` (276) — в `kit-src/skills/pix3-verify` и `pix3-scripts` через `{{include}}`.
  Сейчас слова `GameDebugProvider` в `kit-src` нет. `kit.spec.ts` проверяет 22 инструмента.

### C.5b Контракт `export_playable` (W-EXP, 2 дня)

Барьер §5 D сегодня включён только для `play_start`, `play_restart` и `game_run`
(`workspace-agent/tools.ts:21`). Экспортёр читает файлы с диска, а точку входа берёт из активной
вкладки редактора (`ProjectBuildService.resolveEntryScenePath` → `getActiveScenePath`). Контракт:

1. **`export_playable` входит в `BARRIER_TOOLS`.** Порядок такой:
   - сначала сохраняются все грязные сцены через обычный путь сохранения;
   - затем `sync_barrier` (держит autosave, ждёт стабилизации и сборки скриптов);
   - затем сверка `expect`.
2. **Отказ с причиной:**
   - `save_failed` — ручная правка не сохранилась;
   - `pending_merge` — висит merge- или recovery-баннер;
   - `expectation_stale` — ревизия агента не совпала;
   - `offline_drafts` — есть неслитые черновики;
   - `spine_unavailable`.
3. **Детерминизм:** `entryScene` — явный аргумент, по умолчанию сцена экспорта по умолчанию из
   проекта. Активная вкладка не используется никогда.
4. **Ревизия входов.** Набор `{path: sha256}` по всему, что прочитала сборка, плюс workspace
   `revision` до и после. Если ревизия за время сборки изменилась — `inputs_changed`, файл не
   пишется. Набор попадает в `exports/<name>.report.json`.
5. **Независимая проверка.** Записанные байты перечитываются с диска и сверяются по sha. Потом HTML
   запускается в sandbox-iframe из этих байтов. Это отдельный документ с отдельным экземпляром
   runtime, редактор в нём не участвует. Player-entry runtime получает opt-in сигнал: при
   `#pix3-verify` он шлёт родителю `postMessage` `pix3:ready`/`pix3:error`. Результат инструмента:
   `{path, bytes, sha256, bootMs, framesRendered, errors[], inputsHash}`. Нет `ready` за 15 секунд
   или есть ошибки — `ok:false`.

### C.6 Вторая машина

Процесс MCP запускается там же, где агент (Remote-SSH или удалённый режим приложения, S8), и слушает
`127.0.0.1:8490` на сервере. VS Code пробрасывает этот номер сам. Если локальный порт другой, ссылку
берём из `PIX3_PUBLIC_ORIGIN`. Loopback-origin с любым портом разрешён. При SSH браузер
автоматически не открывается, токен обязателен.

## D. Фазы

### D.1 P0 — спайки (4 дня)

| # | Вопрос | Pass / fail → |
|---|---|---|
| S1 | Codex desktop: подхватывает ли глобальный `[mcp_servers]`/`CODEX_HOME`, cwd, процесс на тред или на приложение, держит ли порт 30+ мин, **чем завершает (stdin, SIGTERM, SIGKILL), есть ли idle-reaping**, есть ли `~/.codex/skills` | заглушка видна, порт доступен, способ завершения записан. Если SIGKILL — grace бесполезен, вся надежда на W-OFF |
| S2 | Claude Code desktop: то же; приоритет проектного `pix3` (DeepCore на 1.6.2) | иначе plugin-маршрут. Приоритет ниже Codex |
| S3 | Ноутбук дизайнера: Node; `dist` на Node 22 и 26 | иначе портативный Node |
| S4 | Ссылка `#pair=` кликается, фрагмент сохраняется | иначе `?pair=` + `replaceState` |
| S5 | Chrome, Safari, Firefox на hosted | иначе «нужен Chrome» |
| S6 | Видит ли модель MCP `instructions` | нет — пишем skill |
| S7 | Setup в песочнице Codex | ≤1 одобрение |
| S8 | Удалённый сценарий Igor | иначе `PIX3_PUBLIC_ORIGIN` |
| S9 | `npm pack` hosted: размер, холодная установка, нет Spine и ONNX | <30 МБ, <60 с; иначе `@pix3/editor-dist` |
| S10 | Прототип: `WorkspaceServer` отдаёт hosted + `#pair`; **базовый замер: kill -9 `pix3 serve` во время правки на текущем коде — что теряется** | замер записан |
| S11 | 9-slice с SVG | иначе `skin_ui` остаётся в LABS |
| S12 | Windows: TOML, `isProcessAlive`, нет SIGTERM, закрытие stdin | исправления в P1b, или Windows вне MVP |
| S13 | Встроенная генерация картинок в Codex desktop | есть — ключ дизайнеру не нужен |
| S14 | Долговременность IndexedDB на hosted-origin: `storage.persist()`, Safari ITP (вытеснение через 7 дней), инкогнито | Chrome надёжно; Safari — по замеру |
| S15 | Кросс-портовый loopback-fetch из вкладки (поиск `workspaceId` на другом порту) в Chrome и Safari без LNA-запроса | иначе C.2b.6(а) отпадает, остаётся только `lastPort` |

Параллельно P0: политика MY.GAMES (данные, лицензии Codex, прокси npm) и корпоративный ключ картинок.

### D.2 P1a — минимальный поток (8–10 дней) → `2.0.0-alpha.1`

Состав: setup (1,5); хост, `lastPort`, grace, повышение клиента (2); hosted-сборка с исключениями
Spine/ONNX/PWA и проверкой архива (1,5); hosted-scope и журнал пробелов (1); пара (1); инструменты
CLI, `doctor`, `instructions`, kit (2); итерации с живым Codex (1–2).

**Артефакт:** Igor в Codex desktop, Chrome, без терминала, собирает dogfood C1. Offline-черновика
пока нет, Igor об этом знает.

### D.3 P1b — надёжность (8–12 дней) → `2.0.0-alpha.2`, условие для stranger

Состав: W-OFF (3–4); W-EXP (2); chroma-key на 10 спрайтах (0,5); браузерный гейт D.4 как приёмка
(2); Windows и Safari по итогам S12/S14 (0–3); фиксы по C1 (1).

**Что сдвигает срок.**
- S1: если завершение — только SIGKILL и процесс живёт на тред, W-OFF становится главным путём и
  требует больше тестов (+1–2).
- S14/S15: если Safari ненадёжен, остаётся «только Chrome» (−2), иначе работа над хранилищем (+1).
- S12: Windows либо вне MVP (−2), либо полная поддержка (+2–3).

### D.4 Браузерный гейт (приёмка P1b, гейт каждого шага P2)

Скриптованный прогон hosted-сборки через chrome-devtools MCP или Playwright, плюс второй процесс MCP.
Каждая проверка смотрит **независимые доказательства**, а не успешный ответ MCP.

| Сценарий | Доказательство |
|---|---|
| `#pair` → сцена → правка в инспекторе → сохранение | байты `.pix3scene` на диске содержат значение |
| play → `game_run` | `play_status` + свойство узла в запущенной сцене через introspection |
| `export_playable` | HTML на диске, sha совпадает, iframe дал `pix3:ready`, `framesRendered > 0` |
| перезапуск хоста посреди сессии (kill -9, новый процесс) | черновик в `pix3-offline-drafts`, после reconnect байты на диске |
| одновременная ручная и агентная правка одного файла | байты агента на диске, версия в `.pix3/recovery/`, баннер в DOM |
| два окна приложения, передача lease | lease у второго, запись первого отклонена, данные не потеряны |
| открытие существующего проекта после обновления CLI | `doctor` показывает дрейф kit, сцены грузятся, `check` зелёный |
| нажатие исключённой команды | строка в `.pix3/hosted-gaps.jsonl` |

### D.5 P2 — carve-out в ветке `essential` (8–10 дней, параллельно)

1. `ChannelToolRegistry` и MOVE game-test (2).
2. Агент, flow и llm со швами (2).
3. Cloud, collab, library, platform (2).
4. LABS, `LayoutManager`, shell, vite, `package.json`, CI (1,5).
5. Docs, skills, knip, чистка (1).
6. Гейт D.4 (1).

Дополнительно на каждом шаге: `type-check`, тесты, `pix3 smoke` по шаблонам, size-spec playable.
Слияние — после гейта и C1.

### D.6 P3 — MVP MY.GAMES (~10 рабочих дней, на `alpha.2`)

Протокол фиксируется письменно до старта, включая решение владельца о требовании по времени.

- **Концепты.** Три из бэклога: 2D hyper-casual, UI- или мета-тяжёлый, 3D-lite. C1 и C2 делает
  Igor — это верхняя граница по качеству и времени. C3 — stranger (дизайнер с Codex desktop, чистый
  ноутбук, наблюдатель молчит), по возможности второй stranger.
- **Три исхода измеряются раздельно.**
  - **(а) Самостоятельность дизайнера** — только stranger-прогоны. Считаются терминальные
    вмешательства, вмешательства программиста, подсказки, время до первой запущенной игры.
  - **(б) Качество** — все три концепта. Форма продюсера разделяет два вопроса: «идея стоит
    продолжения?» (да / нет / не уверен) и «**прототип** адекватно представляет идею для решения?»
    (нет / внутренний greenlight / CPI-тест). Против инструмента считается только второй вопрос:
    слабая идея — не провал инструмента.
  - **(в) Время** — человеко-часы всех ролей против **фактического** Unity-базиса (оценка только при
    отсутствии фактов, с пометкой), состав ролей, итерации, токены, размер playable и запуск в канале.
- **Пробелы продукта.** Строки `.pix3/hosted-gaps.jsonl`, наблюдения («искал редактор анимаций») и
  попытки агента вызвать отсутствующий инструмент сводятся в таблицу с подсчётом. Это вход в
  решение о LABS.
- **Успех = (а) и (б):**
  - stranger запустил игру ≤2 ч и дошёл до прототипа за день, без терминальных вмешательств и без
    программиста, с ≤2 подсказками;
  - ≥2 из 3 прототипов получили «адекватно ≥ greenlight».
- **(в)** обязательна только если владелец до теста записал бизнес-требование (например, «≤50 %
  Unity»). Иначе это показатель для питча, а не kill.
- **Kill:** провал (б); или провал (а) после одной итерации исправлений онбординга; или провал (в)
  при записанном требовании.

### D.7 P4 — решение (1–2 дня)

- **Успех.**
  - Вливание `essential`, переименования по A.2, `2.0.0`.
  - LABS возвращаются по таблице пробелов и только как MCP- или CLI-возможность.
  - `editor.pix3.dev` остаётся последней полной сборкой: там OPFS-проекты и recents. Миграция —
    «Move Project to Folder» (`features/project/MoveProjectToFolderCommand.ts`), затем
    `project_open {dir}`.
  - Посадочная страница — отдельно (README / `pix3.dev`).
- **Провал (а).** Онбординг и один повтор.
- **Провал (б).** `essential` не вливается. Runtime, CLI и kit остаются внутренним инструментом.
  Возврата к своему harness нет.

**Итого:** P0 4 + P1a 9 + P1b 10 + P3 10 ≈ 33 рабочих дня, то есть **6–7 недель** до решения (C1
идёт параллельно с P1b). Затем ~1 неделя до `2.0.0`.

## E. Риски

| Риск | Как снять |
|---|---|
| PATH и npm в GUI-процессе | `execPath`, `env.PATH`, предустановка (C.1), S1/S2 |
| Нет Node | S3, портативный Node |
| AGENTS.md не загружен в сессии создания | ответ `project_new` + `instructions`, проверяется в C1 |
| Хост убит, правки в вкладке | W-OFF (C.2b), S1, S10, S14 |
| Черновики в недоступном origin | `lastPort`, кросс-портовый слив (S15), предупреждение `doctor` |
| Экспорт не того состояния | W-EXP (C.5b) |
| Тест подтверждает удаляемое | hosted-scope с P1 + журнал пробелов |
| Качество chroma-key | 10 спрайтов, иначе OpenAI `transparent` |
| Spine в пакете | два пути исключения + скан tarball |
| Размер пакета, Safari | S9, S5 |
| Carve-out ломает редактор | ветка + гейт D.4 |
| Два MCP с именем `pix3` | S2, `doctor` |
| Политика MY.GAMES | вопрос продюсеру и IT во время P0 |

## F. Анти-скоуп

1. Никакого чата, подсказчика или агентного статуса в редакторе.
2. Никаких демонов, tray и Electron. Единственное исключение — ограниченный grace хоста (C.2).
3. Никакого фреймворка плагинов. Возврат делается через `git checkout full -- <path>`.
4. Не выносить сеть runtime. Публичный API `@pix3/runtime` не трогать (сигнал `#pix3-verify` в
   player-entry к API не относится).
5. Не добавлять мутирующие сцену MCP-инструменты. `game_controls`/`game_time` — только при
   доказанной нужде в C1.
6. Никакой серверной компиляции скриптов и headless-экспорта в CLI.
7. Не переносить `src/templates/projects`, не переименовывать ради красоты.
8. Никаких «lite»-редакторов.
9. Никакого FSA-discovery и LNA.
10. Setup только для `codex` и `claude`.
11. Не выпускать bridge, не держать collab в `essential`.
12. Онбординг — одна setup-строка.
13. В `full` не коммитить ничего, кроме security-фиксов collab.
14. Carve-out на `main` не делать до P4. Offline-черновик не превращать в синхронизацию: только
    слив и отказ при конфликте.

## G. Журнал ревью

### Ревью 1

| Замечание | Решение | Где |
|---|---|---|
| R1 P2 вне критического пути, ветка `essential` | принято | §0, A.2, D |
| R2 жизненный цикл хоста, grace, замер в S1 | принято; в ревизии 3 развито в W-OFF | C.2, C.2b, S1 |
| R3 пропущенные швы; chroma-key — регрессия | принято, ~35 файлов | B.2, D.3 |
| R4 браузерный гейт | принято; в ревизии 3 расширен | D.4 |
| R5 `--tag next`, `workflow_dispatch`, A.2 против F.13 | принято | A.3, F.13 |
| R6 знание агента в kit | принято | C.5 |
| R7 `~/.claude.json`, TOML, PATH/TS, stdout, Windows | принято | C.1, C.2, S12 |
| R8 ключ по `workspaceId`; origin от `Host`; лимит `tokens[]` | принято частично. В ревизии 3 сужение «Origin == Host» отменено: loopback с любым портом нужен для слива черновиков на новый порт (C.2b.6). Проброс по-прежнему работает | C.3, C.4 |
| R9 skills, замена внешнего плана | принято | A.3, шапка |
| R10 `editor.pix3.dev`, OPFS | принято | D.7 |
| R11 Spine | принято; в ревизии 3 дополнено | C.3 |
| R12 `projectTabs` вместо layout | принято | B.2, C.3 |
| R13 сроки | принято; пересчитано заново в ревизии 3 | D |
| Рек. 1–8 | приняты; `game_controls`/`game_time` отклонены до C1 (растёт поверхность) | A, B.3, B.4, C.1, C.3, D.6, F.5 |

### Ревью 2

| Замечание | Решение | Где |
|---|---|---|
| 1. Offline-восстановление — новая работа; молчаливый уход в память; `clearServer` обнуляет порт; смена origin | принято: W-OFF с контрактом и тестами, `lastPort`, видимый fallback, кросс-портовый слив, S10/S14/S15 в P0 | C.2, C.2b, D.1, D.3 |
| 2. Spine по второму пути (`?raw` в экспортёре) | принято: два пути, скан архива, явная ошибка и `spine_unavailable` | C.3 |
| 3. MVP может подтвердить удаляемое | принято: hosted-scope в P1 (меню, контекстные действия, вкладки, панели), `hosted-gaps.jsonl`, подсчёт в P3 | C.3, D.6 |
| 4. `export_playable` без контракта | принято: барьер, отказы с причиной, явный `entryScene`, ревизия входов, проверка через iframe по байтам с диска | C.5b |
| 5. Метрика против kill | принято: исходы (а)/(б)/(в), форма продюсера «идея / прототип», время — только требованием владельца | D.6 |
| 6. Гейт только для благополучного сценария; сроки P1 | принято: 8 сценариев с независимыми доказательствами; P1 разделён на P1a/P1b с зависимостью от спайков | D.2–D.4 |
