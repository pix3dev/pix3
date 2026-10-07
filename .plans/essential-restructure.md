# Essential: Pix3 как агентный стек (runtime + CLI + kit + редактор как точный инструмент)

Дата: 2026-10-07, ревизия 4 после ревью 1–3 (журнал в §G). Статус: план, P0 можно начинать.
Позиционирование задано brief и не пересматривается. Утверждения о коде проверены по исходникам,
рядом с каждым указан путь.

**Что заменяется в `.plans/external-agent-authoring.md`:**
- §1.2 — окно редактора как PWA с `editor.pix3.dev`;
- §9 — «не заменяем встроенного агента»;
- §11.1 — FSA-папка и ручной `pix3 serve` как основной путь.

Остальное (co-authoring, `expect`, подтверждение `generate_*`) остаётся в силе.

## 0. Коротко

1. **Сначала проверяем подход, потом режем.**
   - Последовательность: P0 → P1a (`2.0.0-alpha.1`, dogfood C1) → P1b (`alpha.2`) → P3 MVP → P4 решение.
   - Физический carve-out (P2) делается **после** успешного P4 и даёт `2.0.0`.
   - До решения на `main` разрешены только бесконфликтные удаления (A.2).
   - Hosted-сборка уже в P1 ограничена рамками essential. Каждое обращение к исключённому
     записывается как пробел продукта.
2. **Поток.**
   - `pix3 setup --write` создаёт глобальную запись MCP.
   - Процесс `pix3 mcp` запускает **отсоединённый workspace-сервер с idle-таймаутом** и работает его
     клиентом.
   - Сервер раздаёт редактор с того же origin. Ссылка содержит одноразовый `#pair=`.
   - Рестарт приложения, закрытие треда и SIGKILL процесса MCP сервер больше не убивают. Для редкой
     смерти самого сервера есть аварийный путь (C.2b, ~1 день), а не синхронизация черновиков.
3. **Спайк S15 (CDP-транспорт)** проверяет, может ли Chrome DevTools MCP с
   `window.__PIX3_DEBUG__` заменить наш agent lane. Если может, lane удаляется до P1a, а
   `ChannelToolRegistry` не пишется.
4. **`export_playable`** требует синхронизированных файлов, а не остановленной игры. HTML
   проверяется в отдельном браузерном контексте.
5. **Успех MVP** требует двух исходов: самостоятельность дизайнера и адекватность прототипа (арт не
   оценивается). Время становится обязательным только если владелец заранее запишет такое
   требование.
6. **Сроки:** P0 3–4 дня (уровень 1), P1a 9–12, P1b 7–10, P3 ~10, P4 1–2. Это **6–8 недель до
   решения**, затем P2 8–10 дней до `2.0.0`.

## A. Стратегия репозитория

### A.1 Факты

| Критерий | A: на месте | B: новый репо |
|---|---|---|
| Хирургия ~35 швов (B.2; `AgentToolRegistry.ts:1-158`, eager-агент через `game-tab.ts:10`, `logs-panel.ts:4`, `pix3-status-bar.ts:20-22`, `pix3-welcome.ts:19-25`, `main.ts`) | нужна | **та же** |
| История | целиком | клон с последующим удалением даёт ту же |
| npm OIDC и provenance | без изменений | перенастройка (минуты) |
| Один источник runtime/CLI на npm | да | две копии lockstep-линии |
| DeepCore | `@pix3/runtime` из npm `^1.6.2` (`../DeepCore/package.json:22`), 2.0-alpha не подтянет | то же |

### A.2 Решение: один репо, carve-out после решения

- **`main`.** Полный редактор и поток P1. Отсюда идут `2.0.0-alpha.N` в `next`; `latest` остаётся 1.6.3.
- **До P4 на `main` разрешены только бесконфликтные удаления.** Они не трогают швы shell, settings и
  welcome:
  - dead `link-server.ts` (512) и `mcp.ts` (129);
  - `bg-removal` вместе с `@huggingface/transformers` и `onnxruntime-web` — одновременно с переходом
    на chroma-key в P1b;
  - `sfx-gen` вместе с `@txt2sfx/*` (×5), потому что `generate_sfx` уходит из канала, а секция SFX
    исчезает из панели Generate;
  - `qrcode` (в скрытых карточках online/preview остаётся текстовый URL);
  - job bridge в `publish-packages.yml`;
  - `packages/pix3-collab-server` выводится из `workspaces` (скрипт запуска через `--prefix`).
- **Успех P4.**
  - Тег `pix3-full-<версия>`, ветка `full` от `main`.
  - Carve-out P2 (B) делается на `main`, один коммит на область, с гейтом D.4.
  - Затем `2.0.0` в `latest`.
- **Провал.** Carve-out не делается вовсе, 8–10 дней не выброшены.
- **`pix3dev/pix3-platform`** выделяется из `full` только по решению о платформе:
  `git filter-repo --path packages/pix3-collab-server/ --path src/services/{cloud,collab,library}/ --path src/ui/{collab,asset-library}/ --path src/player/ --path player.html`.

### A.3 CI, публикация, документация

- **`publish-packages.yml`** (сейчас `npm publish --access public`, стр. 60/108/136): `--tag next`,
  если в версии есть `-`. Job cli собирает `build:hosted` и проверяет tarball (C.3).
- **`ci.yml`** вместо `.disabled`: lint, type-check, vitest, `build:hosted`, `npm pack` с проверкой
  содержимого, браузерный гейт D.4.
- **Collab-сервер после P2.** В `full` `deploy-collab-server.yml` запускается по
  `on: push: branches: [full]`, потому что `workflow_dispatch` работает только из ветки по умолчанию.
  В `full` разрешены только security-фиксы collab (F.13).
- **Kit drift spec** (`packages/pix3-cli/src/kit.spec.ts`) правится в P2: тест, читающий
  `AgentToolRegistry.ts` (~стр. 245), удаляется, «14 инструментов» заменяется новым списком,
  `engine-api-map.md` переносится в `kit-src/`. `src/core/agent-reference-docs.spec.ts` остаётся.
- **Документация в P2.** README, AGENTS.md, CLAUDE.md (включая неверную строку про yalc у consumer)
  и спецификация. Удалённые разделы сворачиваются до «удалено в 2.0, см. `full`». Новых `.md` нет.
- **Чистка дерева в P2.** Планы flow/vibe/agent-eval, `.env.development`, `.env.prod-backend`,
  `dev:prod`/`dev:collab*`, `src/sw.ts`, лишние записи `knip.json`.
- **Skills в P2.** `debug-running-game` (`SKILL.md:84-91` вызывает `scene_tree`/`create_node`)
  переписывается. `generate-sprites-in-editor` удаляется. В `pix3-game-dev` правится ссылка на
  Sprite Editor.

## B. Essential scope (P2, после P4)

Статусы:

| Статус | Значение |
|---|---|
| KEEP / TRIM / MOVE | в ядре |
| LABS | возвращается только как инструмент MCP или глагол CLI |
| PLATFORM | уходит в `pix3-platform` |
| FREEZE | остаётся только в `full` |
| DELETE | удаляется насовсем |

### B.1 Каталоги

| Каталог | Строк | Статус |
|---|---|---|
| `packages/pix3-runtime` | 62,6k | KEEP, сеть не трогаем (B.5) |
| `packages/pix3-cli` | 16k | KEEP и растёт (C) |
| `packages/pix3-collab-server`, алиасы `@pix3/collab-*` (vite, tsconfig, vitest) | 7,8k | PLATFORM |
| `tools/pix3-agent-bridge` | 7,6k | FREEZE |
| `services/agent` | 26,6k | **MOVE → `services/game-test/`** (~15k, без llm/flow): `GameTestService`, `GameInputService`, `GameBotHost`, `game-*.ts`, `NodeWatchRecorder`, `ProjectTraceStore`, `reachability-journal`, `nondeterminism-probe`, `key-for-code`, `renderability-note`, `pix3-test-bot-dts`. Остальное FREEZE (`agent-skills/` переносится в kit в P1, C.5) |
| `services/{flow,llm}`, `ui/{agent-chat,flow}`, `features/flow`, `src/templates/agent` | ~22k | FREEZE |
| `services/{cloud,collab}`, `services/library` **кроме `character-compiler.ts`**, `ui/{collab,asset-library,auth}`, `features/library`, `LocalSyncService` | ~19k | PLATFORM/FREEZE |
| `services/library/character-compiler.ts` (342, чистый: зависит только от runtime, `yaml` и `features/scene/animation-asset-utils`, тоже только runtime) | | **MOVE → `packages/pix3-cli/src/character/`** уже в P1 (C.5) |
| online/remote-preview (`services/play/{OnlineSession,PreviewHost,RemotePreviewTelemetry}Service`, `core/remote-preview/`, `src/player/`, `player.html`, карточки, две команды) | ~5k | PLATFORM |
| `model-gen`, `ui/model-lab`, `ui/sprite-editor` (с вкладкой `animation`, `LayoutManager.ts:44-48`), `uikit`, `uikit-editor`, `ui/{uikit-forge,tools}`, `src/tools/uikit-forge`, `features/uikit`, `ui/generate`, `ao-bake`, `features/render`, `ui/profiler` + `ProfilerSessionService`, `ui/home` + `ProjectHomeService` | ~43k | LABS |
| `services/strophe` | 1,2k | DELETE (`bg-removal` и `sfx-gen` удаляются раньше, A.2) |
| `services/image-gen` | 5,9k | TRIM: `AssetGen`, Gemini/OpenAI, реестр, настройки, история, типы. `image-ops.ts` **MOVE → `src/core/`** |
| `services/atlas`, локализация | | KEEP (play и экспорт) |
| `project/agent-kit`, `InstallAgentKitCommand`, `pix3-agent-handoff-dialog`, `ensure-agent-kit.mjs` | ~1,3k | DELETE |
| `editor/{WorkspaceMode,StudioViewportMount,UpdateCheck}Service`, `SwitchWorkspaceModeCommand`, `pix3-mode-switch` | | DELETE |
| `ui/shared`: `composer-attachments`, `pix3-image-annotator`, `pix3-project-sync-dialog`, `pix3-save-asset-dialog`, `pix3-animation-auto-slice-dialog` | | DELETE |
| `src/core`: `agent-eval`, `dev-backend`, `tool-routes` | | DELETE. `debug-bridge.ts` — по итогам S15 (C.5) |
| ядро редактора (viewport, scene-tree, inspector, assets, code-editor, runtime, logs, timeline; services viewport/play/scene/scripting/assets/editor/core/animation/export; project/{workspace,coauthoring,autosave,external-merge}; `src/templates/projects`) | ~80k | KEEP/TRIM. FSA/OPFS остаются без вложений |

### B.2 Швы (~35 сохраняемых файлов)

| Файл | Тянет | Замена |
|---|---|---|
| `atlas/TextureAtlasService.ts:7` | `sha256Hex` из `core/remote-preview/protocol` | `src/core/hash.ts`; `guessMimeType` → `src/core/mime.ts` |
| `editor/EditorTabService.ts:20,52,439` | `PreviewHostService`; `pix3.projectTabs` с удаляемыми типами | убрать inject. Фильтр типов есть с P1. Layout не сохраняется (`LayoutManager.ts:1044`) |
| `core/LayoutManager.ts:14-34` | 19 панелей, базовый стек `background` | 10 панелей и `pix3-empty-stage` (из P1) |
| `image-gen/AssetGenService.ts:11,238,483-515` | `BackgroundRemovalService` | chroma-key / OpenAI `transparent` (уже в P1b) |
| `ImageGenProviderRegistry.ts:4-8,37-39`, `AiImageSettingsService.ts` | Strophe, SvgLlm, Codex, Bridge | только Gemini и OpenAI |
| `game-tab.ts:10,283`, `logs-panel.ts:4,110` | `composeFix`, карточки | «Copy for agent» (clipboard) |
| `inspector-panel.ts:43-44,61` | `contour-trace`, `library-inspector` | `contour-trace.ts` **MOVE → `src/core/`** |
| inspector renderers ×2, `scene-tree-panel`, `assets/{asset-tree,assets-content,assets-panel}`, `editor-tab` | collab presence, `LibraryInsertService`, `GeneratedAssetDropService`, `openInSpriteEditor` (`assets-content.ts:576`) | убрать |
| `pix3-editor-settings-dialog.ts` (2 455) | llm, agent, model-gen, strophe | остаются Editor/Viewport (ключи хранятся в CLI) |
| `pix3-status-bar.ts:10,20-22,32,44` | Bridge, LLM, `dev-backend`, `UpdateCheck`, collab | workspace, пилюля канала |
| `pix3-lightbox.ts:9,11` | `markdown-lite`, annotator | `markdown-lite` → `ui/shared` |
| `pix3-create-project-dialog.ts`, `ProjectLifecycleService.ts:16-26,86,92-229,307-351` | Auth, CloudProject, `withAgentKit` | убрать (`cli-manifest.spec.ts` правится) |
| `pix3-welcome.ts` (1 197) | cloud, llm, agent, flow | ~250 строк dev-режима |
| `pix3-editor-shell.ts` (2 158) | ~17 команд, сервисы, flow-shell, collab, forge, auth | вырезать (в том числе cloud-ветку ~1463-1471) |
| `main.ts`, `register-runtime-services.ts:3-5` | LibrarySync, Bridge, collab-регистрации | убрать |
| `OperationService.ts:24,292-335`, `CommandDispatcher`, `RouterService` | `Y.UndoManager`, collab, `#uikit` | убрать |
| `ProjectService.ts:43-44,~406-412,~1236` | Collaboration, `ideaTimeline`, LocalSync | убрать |
| `ProjectStorageService.ts:15`, `ProjectScriptLoaderService`, `ViewportRenderService` | `'cloud'`, `ApiClientError`, collab overlay, `workspaceMode` | `'local' \| 'workspace'` |
| `play-workspace.ts`, `state/{AppState,index}.ts` | срезы collaboration/auth/workspaceMode/flowAutopilot | удалить |
| `WorkspaceAgentToolBridge.ts:281` | `@injectLazy(AgentToolRegistry)` | по S15: удаляется вместе с lane или переходит на `ChannelToolRegistry` |
| `vite.config.ts` | PWA, `player`/`uikitForge`, облачные и AI-прокси, `__PIX3_DEV_BACKENDS__` | `/openai-proxy` (dev), rapier, manualChunks, `export-vendor` |

Последним идёт коммит knip (палитровый код `image-ops.ts` ~900 строк и прочее).

### B.3 Реестр инструментов канала (только если S15 не дал паритета)

`ChannelToolRegistry` (`src/services/agent-channel/`, ~1,5–2k строк). Переносятся обработчики
play_*, `game_input`, `game_observe`, `game_run`, `read_*`, `viewport_screenshot`, `get_selection`,
урезанный `generate_asset` (без idea-stage) и `export_playable`. Подсказки `channel-tool-hints.ts`
применяются к описаниям один раз, затем слой удаляется. **Если S15 дал паритет**, реестр не нужен:
lane удаляется (C.5).

### B.4 Генеративные инструменты

| Инструмент | Где |
|---|---|
| `sfx` | процесс CLI (`pix3-cli/src/sfx/`, без ключей) |
| `generate_asset` | редактор. Ключи, лимит 20 и подтверждение переезжают в прокси ключей CLI (C.3). Запрос подтверждается во вкладке-держателе lease, а не в той, что запросила |
| `character_compile` | CLI: кадры на диске → `.pix3anim` + префаб (C.5) |
| `skin_ui` | LABS. Триггер: UI-тяжёлый концепт и пройденный S11 (3 дня) |

### B.5 Сеть runtime

Не трогаем. `src/net/` (~7k, `core/SceneService.ts:8-9`) уже вырезается из playable
(`strippable-runtime-modules.ts`), DeepCore её не использует. Удаляются только редакторные
потребители.

## C. Поток agent-first (P1, `main`)

### C.1 `pix3 setup [codex|claude] --write`

Сейчас `mcp-config.ts:setupInstructions` только печатает. Новое поведение:

1. **Цель.** Аргумент или автоопределение. Основной путь — Codex (у Claude в MY.GAMES был 403,
   §11.14).
2. **Установка.** `npm install --prefix ~/.pix3/cli/<ver>`, плюс TypeScript в
   `~/.pix3/typescript/<PINNED>` и `esbuild`: ленивая установка в `check/typescript.ts` не найдёт
   npm из GUI-процесса.
3. **Запись MCP.** `command = process.execPath`, `args = [dist/index.js, "mcp"]`, `env.PATH`
   начинается с `dirname(execPath)`.
4. **Codex.** Таблицы `[mcp_servers.pix3*]` заменяются целиком, пути — literal-строки `'…'`, бэкап с
   меткой времени, повторное чтение и `codex mcp list`. `startup_timeout_sec = 30`,
   `tool_timeout_sec = 180`. Если S15 прошёл — вторая запись `chrome-devtools`.
5. **Claude.** Только `claude mcp add --scope user`, иначе печать инструкции. `~/.claude.json`
   руками не трогаем.
6. **Skill.** Глобальный skill — только для хоста без поддержки `instructions` (S6). `--remove`
   откатывает изменения. Без Node — портативный Node в `~/.pix3/node` (S3).

### C.2 Отсоединённый workspace-сервер (W-SRV, 2–2,5 дня)

F.2 ослабляется: сервер — отдельный долгоживущий процесс с idle-таймаутом, но не глобальный демон.

- **Запуск.** `pix3 mcp` при `project_new`/`project_open` или при первом инструменте в проекте
  проверяет lock и запись (`serve/open-workspace.ts`). Если живого сервера нет, он запускает
  `node <cli> serve --detached --project <root>`:
  - `spawn(..., {detached: true, stdio: ['ignore', log, log], windowsHide: true}).unref()`;
  - лог пишется в `.pix3/serve.log`;
  - запуск ждёт появления записи `server` (≤5 с).

  Дальше `pix3 mcp` — клиент lane, **как сегодня** `mcp --workspace` (`lane-client.ts`). Тот же
  механизм использует `pix3 serve --detached`. Обычный `pix3 serve` по-прежнему работает на переднем
  плане.
- **Idle-таймаут N = 30 минут.** Отсчёт начинается, только когда **нет ни lease вкладки, ни
  присутствия MCP** (`agent-presence.ts`, heartbeat уже есть). Открытая вкладка или живой агент
  держат сервер сколь угодно долго. 30 минут покрывают закрытие и повторное открытие приложения и
  при этом не плодят сирот на дни.
- **Порт.** `lastPort` — новое поле `.pix3/workspace.json`. Сегодня `clearServer`
  (`state-file.ts:204`) при выходе обнуляет запись `server` вместе с портом. Сервер пробует порты
  `[lastPort, 8490..8499]`.
- **Кто останавливает.**
  - idle-таймаут;
  - `pix3 serve --stop [--project]` (`POST /ws/agent/shutdown` по control secret);
  - `doctor`.

  Каждый сервер пишет `~/.pix3/servers/<pid>.json` (root, порт, версия, время старта, idle),
  `doctor` перечисляет и чистит мёртвые записи.
- **Версии.** Если `cliVersion` сервера не совпадает с `pix3 mcp` и lease свободен, сервер
  перезапускается своей версией. Если lease занят, используется старый сервер (при совместимом
  `protocol`), `doctor` предупреждает.
- **stdout.** У сервера stdout не связан с JSON-RPC (лог в файл). У `pix3 mcp` stdout — только
  JSON-RPC, логи идут в stderr, это проверяется тестом.
- **Спайк S16.** На macOS, Linux и Windows сервер должен пережить выход приложения. Windows Job
  Objects с `KILL_ON_JOB_CLOSE` могут убить потомка, если нет breakaway.

### C.2b Аварийный путь: сервер мёртв (W-OFF, ~1 день)

Сервер почти всегда переживает сессию агента, поэтому синхронизации черновиков нет. Миграции
IndexedDB между портами и сканирования портов из вкладки тоже нет.

- **Что видит вкладка.** Если события упали и запись не проходит (`reconnecting`), вкладка
  переходит в режим «только чтение»:
  - правки блокируются, грязное состояние в памяти сохраняется;
  - баннер: «Сервер pix3 остановлен. Правки заблокированы, несохранённые изменения пока в этой
    вкладке — не закрывайте её. Попросите агента открыть редактор (`editor_link`)»;
  - кнопки [Скачать YAML сцены] и [Скопировать] для каждой грязной сцены;
  - существующее меню recovery остаётся доступным.
- **Возвращение сервера.** Если он поднялся на `lastPort`, работает существующий reconnect и rescan
  (`WorkspaceSessionService.ts:409`), autosave пишет грязное состояние. Если диск изменился,
  срабатывает существующий путь внешних изменений и merge-баннер. Если порт другой, баннер говорит:
  «Новая сессия на другом адресе — скачайте изменения и откройте ссылку».
- **Без молчаливого fallback в память.** `recovery-fallback-store.ts:47` при недоступном IndexedDB
  должен показывать это, а не уходить в память тихо.
- **Тесты.**
  - kill -9 сервера во время правки → блокировка, скачанный YAML совпадает с состоянием;
  - новый сервер на `lastPort` → байты на диске;
  - kill -9 процесса MCP → сервер жив, вкладка не заметила.

### C.3 Hosted-сборка, раздаваемая CLI

- **Сборка.** `npm run build:hosted` складывает результат в `packages/pix3-cli/editor/` (gitignore).
  Порядок: runtime → редактор → CLI (`build`, `build-runtime-types`, `build-kit`, `copy-editor`). В
  пакет входят `licenses:report` и THIRD_PARTY_NOTICES.
- **Исключено на этапе сборки:** PWA, `player`/`uikitForge`, ONNX и **Spine по обоим путям**:
  - алиас `@esotericsoftware/spine-threejs` → stub, `registerSpineModuleLoader` не вызывается;
  - `load`-плагин подменяет `spine-threejs.mjs?raw` из `import.meta.glob` экспортёра
    (`PlayableHtmlBuildService.ts:202-208`);
  - CI и `prepack` сканируют tarball на `esotericsoftware` и «Spine Runtimes License».

  Проект со Spine: runtime и так сообщает «Spine is not installed» (`spine-module.ts:225-231`).
  Редактор показывает это у узла с пояснением, экспорт отвечает `spine_unavailable`, `check` выдаёт
  `W_SPINE_HOSTED`.
- **Рамки essential (`src/core/hosted-scope.ts`, гейт `VITE_PIX3_HOSTED`).** Один список
  ограничивает:
  - команды меню: Sprite Editor, Model Lab, UI Kit Forge, Generate, Agent Chat, Home, Vibe,
    Library/Store, Online/Remote Preview, AO, Install Agent Kit;
  - контекстные действия ассетов (`openInSpriteEditor`, `assets-content.ts:576`);
  - типы вкладок из `pix3.projectTabs`;
  - панели `LayoutManager`.

  Исключённое видно, но неактивно («Нет в Essential»). Нажатие и отброшенная вкладка пишутся в
  `.pix3/hosted-gaps.jsonl`. Home заменяется на `pix3-empty-stage`, welcome — на `pix3-hosted-boot`.
- **Сервер.**
  - Статика без авторизации, `index.html` — `no-cache`.
  - `GET /ws/hello` — JSON `{workspaceId, protocol, cliVersion}` без авторизации, с CORS для
    loopback-origin. Это единственный маршрут обнаружения, статика для discovery не используется.
  - Host-check остаётся.
  - `/openai-proxy/v1/*` и `/gemini-proxy/*` подставляют ключ из `~/.pix3/keys.json` (0600) на
    сервере, ведут лимит генераций и запрашивают подтверждение (B.4).
- **Авторизация.**
  - `isAllowedOrigin` принимает loopback-origin с любым портом (решение §11.1; проброс VS Code на
    другой локальный порт).
  - `https://editor.pix3.dev` убирается. Эхо `Access-Control-Allow-Private-Network`
    (`workspace-server.ts:699`) убирается как ненужное: от него ничего не зависит, loopback →
    loopback PNA/LNA не гейтит.
  - Токен обязателен, `cli-version-gate` в hosted не нужен.

### C.4 Пара

- `editor_link`, `project_new` и `project_open` выдают одноразовый код: 128 бит, TTL 10 минут.
  Клиент получает его через `POST /ws/agent/pair-code`. Ссылка: `http://127.0.0.1:<port>/#pair=<code>`.
- Редактор поступает **по образцу `BridgeConnectionService.consumePairingLink`** (`:294`):
  `replaceState`, затем `POST /ws/pair` → `{workspaceId, token}`. Токен хранится в
  `WorkspaceCredentialStore` по `workspaceId`.
- Без кода `workspaceId` берётся из `/ws/hello`. Если нет токена — карточка «откройте ссылку из
  чата».
- На сервере `tokens[]`: максимум 8, неиспользуемые дольше 30 дней удаляются. Браузер открывается
  сам на первом `project_new`, если нет `SSH_CONNECTION`.

### C.5 Инструменты MCP и kit

**Всегда в процессе `pix3 mcp`:** `doctor`, `project_new`, `project_open`, `editor_link`, `check`,
`smoke`, `tree`, `sfx`, `character_compile`. CLI-глаголы стали инструментами, потому что в песочнице
Codex сеть выключена, а `npx` ненадёжен.

**Взаимодействие с редактором — два варианта по S15:**

- **(A) S15 дал паритет: CDP вместо lane.**
  - Агент работает через Chrome DevTools MCP в **своей** Chrome-вкладке (собственный профиль: Chrome
    ≥136 не даёт отлаживать профиль по умолчанию). Вкладка спаривается через `editor_link` и
    подключается вторым клиентом workspace **без lease** (play разрешён, запись нет).
  - `debug-bridge.ts` (сейчас только DEV, `src/main.ts:79`) входит в hosted как стабильный
    `window.__PIX3_DEBUG__` и получает `waitForRevision(expect)` вместо серверного барьера.
  - Kit отдаёт snippets (`game_run`, `game_observe`, `export_playable`).
  - Удаляются: CLI `workspace-agent/*` (~1,2k), lane в `mcp-workspace.ts`, `/ws/agent/*` кроме
    `pair-code`/`shutdown`/`presence`, `WorkspaceAgentToolBridge` (872), лишняя часть
    `AgentKeepaliveService` (211), B.3.
  - Подтверждение `generate_*` и лимит живут в прокси ключей.
- **(Б) Паритета нет: гибрид.**
  - Lane остаётся. Если S15 частично лучше, `pix3 mcp` получает 5 типизированных инструментов,
    вызывающих страницу через CDP.
  - Иначе остаются текущие 14 минус `generate_sfx` плюс `export_playable` через `ChannelToolRegistry`
    (B.3).

**Прочее:**
- **`project_new {dir, template?, name?}`.** `createProject` + `agentKitStep` без `.mcp.json`.
  Проверка «не пусто» допускает `.git`, `.codex`, `.claude`, `.vscode`, `.idea`, `.DS_Store`
  (`new-project.ts:72`). Ответ: ссылка и «прочитай AGENTS.md сейчас».
- **`instructions`** (~1 000 знаков) и **`doctor`**: Node, CLI, TS, версия kit, сервер (pid, порт,
  idle, версия), lease, `keys.json`, `SSH_CONNECTION`.
- **Перенос знаний в kit (P1).**
  - `agent-skills/verify-and-fix.md` (368 строк, включая `GameDebugProvider`, без которого не
    работают предикаты `gameStateChanged`) и `game-prototype.md` (276) — через `{{include}}`;
  - **справочник формата `.pix3anim`**: клипы, кадры, fps, anchor, sizeMode, points, events.
    Источник — `runtime/core/AnimationResource.ts` (интерфейсы `AnimationClip`, `AnimationFrame`,
    `AnimationFramePoint`), `AssetLoader.ts:192`, `nodes/2D/AnimatedSprite2D.ts` и
    `### AnimatedSprite2D` в `docs/node-types-reference.md`. Страж в `kit.spec.ts` сверяет имена
    полей с интерфейсами runtime;
  - `kit.spec.ts` синхронизирует список инструментов.
- **`character_compile {frames, name}`.** `character-compiler.ts` переезжает в CLI. Размеры кадров
  берутся из заголовка IHDR PNG, без зависимостей. На выходе `.pix3anim` и префаб с
  `core:CharacterVisual2D`.

### C.5b Контракт `export_playable` (W-EXP, 2 дня)

Экспорт — не `BARRIER_TOOL` (`workspace-agent/tools.ts:21`) и игру дизайнера не останавливает.
Новое предусловие **«файлы синхронизированы»** отделено от барьера play:

1. **Предусловие.** Грязные сцены сохраняются обычным путём. Ожидается окно стабилизации и сборка
   скриптов (часть `ProjectSyncService.barrierRevision` без остановки play и без удержания
   autosave). Сверяется `expect`.
2. **Отказы с причиной:** `save_failed`, `pending_merge`, `expectation_stale`, `server_offline`,
   `spine_unavailable`.
3. **`entryScene`** задаётся явно (по умолчанию — сцена экспорта из проекта). Активная вкладка
   (`ProjectBuildService.getActiveScenePath`) не используется.
4. **Входы.** Набор `{path: sha256}` и workspace `revision` до и после сборки. Если ревизия
   изменилась — `inputs_changed`, файл не пишется. Отчёт пишется в `exports/<name>.report.json`.
5. **Проверка — в отдельном браузерном контексте**, не во фрейме редактора. У player-entry runtime
   есть opt-in `#pix3-verify`: он пишет `pix3:ready`/`pix3:error` и число кадров в `POST /ws/verify/<id>`.
   Сервер отдаёт файл по одноразовому `/verify/<id>`.
   - Агент с CDP (S15) открывает URL в своей вкладке.
   - Без CDP дизайнер нажимает «Проверить» в тосте экспорта (жест пользователя, новая вкладка).
   - Результат появляется в `project_status.lastExport.verification`.
6. **Ограничение MVP.** Экспорт выполняется во вкладке редактора. Без открытой вкладки ответ —
   `no_editor`. В потоке дизайнера вкладка всегда есть. Автономный путь (без человека) работает
   только через CDP-вкладку агента (S15).

### C.6 Вторая машина

MCP и сервер работают там же, где агент (Remote-SSH, S8). VS Code пробрасывает порт. Если локальный
порт другой, используется `PIX3_PUBLIC_ORIGIN`. Loopback с любым портом разрешён, токен обязателен,
браузер при SSH сам не открывается.

## D. Фазы

### D.1 P0 — спайки

**Уровень 1, блокирующий (дни 1–3, максимум 4).**

| # | Вопрос | Pass / fail → |
|---|---|---|
| S1 | Codex desktop: глобальный `[mcp_servers]`/`CODEX_HOME`, cwd, процесс на тред или на приложение, чем завершает процесс MCP, есть ли `~/.codex/skills` | записано. Явный `dir` в любом случае |
| S4 | `#pair=` кликается, фрагмент сохраняется | иначе `?pair=` + `replaceState` |
| S6 | Видит ли модель MCP `instructions` | нет → skill |
| S10 | Прототип: сервер отдаёт hosted + `#pair`; kill -9 `pix3 serve` во время правки на текущем коде — что теряется | замер записан |
| S12 | Windows: TOML, `isProcessAlive`, нет SIGTERM, закрытие stdin | исправить в P1, или Windows вне MVP |
| S15 | **CDP-транспорт.** Codex с chrome-devtools MCP проходит сценарии S1–S3 из `.plans/done/agent-eval-scenarios.md` на hosted-редакторе через `window.__PIX3_DEBUG__` (debug-bridge включён в hosted). Сравнение с lane по времени, ошибкам и токенам. Проверить: вкладка агента без lease грузит и играет; спаривание её через `editor_link`; надёжность «пиши JS» против типизированных инструментов | **Паритет** (ошибок не больше, время и токены ±20 %) → lane удаляется до P1a (C.5 A). **Хуже, но работает** → гибрид из 5 типизированных инструментов через CDP. **Не работает** → lane (C.5 Б) |
| S16 | Отсоединённый сервер переживает выход Codex на macOS, Linux и Windows (Job Objects). `doctor` его видит | иначе сервер на время работы приложения + W-OFF |

**Уровень 2 — параллельно P1a:**
- S2 — Claude Code desktop, приоритет проектного `pix3`;
- S3 — Node на ноутбуке дизайнера, работа на 22/26;
- S5 — Chrome, Safari, Firefox;
- S7 — setup в песочнице;
- S8 — удалённый сценарий;
- S9 — `npm pack` <30 МБ, нет Spine и ONNX;
- S11 — 9-slice с SVG;
- S13 — встроенная генерация картинок в Codex.

Не код: политика MY.GAMES и корпоративный ключ картинок.

### D.2 P1a — минимальный поток (9–12 дней) → `2.0.0-alpha.1`

| Работа | Дни |
|---|---|
| Setup | 1,5 |
| W-SRV | 2–2,5 |
| Hosted-сборка, исключения, проверка архива | 1,5 |
| hosted-scope, журнал пробелов | 1 |
| Пара, `/ws/hello` | 1 |
| CLI-инструменты, `doctor`, `instructions`, kit (с `.pix3anim`), `character_compile` | 2,5 |
| Итерации с живым Codex | 1–2 |
| **При S15-паритете:** удаление lane + стабильный `__PIX3_DEBUG__` + snippets | +0–1 (нетто: удаление почти бесплатно, стабилизация API — работа) |

**Артефакт:** Igor в Codex, Chrome, без терминала собирает dogfood C1.

### D.3 P1b — надёжность (7–10 дней) → `2.0.0-alpha.2`, условие для stranger

| Работа | Дни |
|---|---|
| W-OFF | 1 |
| W-EXP | 2 |
| Chroma-key на 10 спрайтах и удаление bg-removal | 0,5 |
| Гейт D.4 как приёмка | 2 |
| Windows/Safari по S12/S5 | 0–3 |
| Фиксы по C1 | 1 |
| Бесконфликтные удаления (A.2) | 0,5 |

**Что сдвигает срок:** S16 (сервер не переживает приложение → W-OFF снова нужен полностью, +2–3);
S12 (Windows вне MVP −2 или полностью +2–3); S5 (Safari).

### D.4 Браузерный гейт (приёмка P1b; гейт шагов P2)

Скриптованно через chrome-devtools MCP. Каждый сценарий проверяется **независимым** доказательством,
а не ответом MCP.

| Сценарий | Доказательство |
|---|---|
| `#pair` → правка в инспекторе → сохранение | байты `.pix3scene` на диске |
| play → `game_run` | свойство узла в запущенной сцене (introspection) |
| `export_playable` во время play дизайнера | play не остановлен; HTML на диске, sha совпадает, `/verify` прислал `ready` и `frames > 0` |
| kill -9 процесса MCP | сервер жив, правка вкладки дошла до диска |
| kill -9 сервера | вкладка заблокирована, скачанный YAML равен состоянию; после `editor_link` на `lastPort` — байты на диске |
| одновременная ручная и агентная правка | байты агента на диске, merge-баннер в DOM, версия в `.pix3/recovery/` |
| два окна приложения, передача lease | lease у второго, данные не потеряны |
| существующий проект после обновления CLI | `doctor` показывает дрейф kit, сцены грузятся, `check` зелёный |
| нажатие исключённой команды | строка в `hosted-gaps.jsonl` |

### D.5 P3 — MVP MY.GAMES (~10 рабочих дней, на `alpha.2`)

Протокол и решение владельца о требовании по времени фиксируются письменно до старта.

- **Концепты.** Три из бэклога: 2D hyper-casual, UI/мета, 3D-lite. C1 и C2 делает Igor — это
  верхняя граница результата. C3 — stranger (дизайнер с Codex desktop, чистый ноутбук, наблюдатель
  молчит), по возможности два прогона.
- **Арт.** У рецептов есть плейсхолдеры `ph-*.png` (`recipe-*/files/sprites/`), агент пишет SVG,
  `check` проверяет `E_SVG_*`. В форме продюсера прямо сказано: **качество арта не оценивается** при
  оценке адекватности прототипа. Новых asset-паков нет. Корпоративный ключ — вопрос P0.
- **Три исхода.**
  - **(а) Самостоятельность** — только прогоны stranger. Считаются терминальные вмешательства,
    вмешательства программиста, подсказки, время до первой запущенной игры.
  - **(б) Качество** — все три концепта. Форма разделяет два вопроса: «идея стоит продолжения?»
    (да/нет/не уверен) и «**прототип** адекватно представляет идею для решения?» (нет / greenlight /
    CPI-тест). Против инструмента считается только второй.
  - **(в) Время** — человеко-часы всех ролей против **фактического** Unity-базиса (оценка — только
    при отсутствии фактов, с пометкой), состав ролей, итерации, токены, размер playable, запуск в
    канале.
- **Пробелы.** `hosted-gaps.jsonl`, наблюдения (включая «нужен UI анимации/кадров») и вызовы
  отсутствующих инструментов сводятся в таблицу с подсчётом. Это вход для решения о LABS.
- **Успех = (а) и (б).**
  - (а): stranger запустил игру за ≤2 часа, за день получил прототип, ни разу не открыл терминал,
    обошёлся без программиста и не больше чем с двумя подсказками.
  - (б): ≥2 из 3 прототипов признаны адекватными на уровне ≥ greenlight.
  - (в) обязательно только при заранее записанном требовании.
- **Kill:** провал (б); или (а) после одной итерации исправлений онбординга; или (в) при записанном
  требовании.

### D.6 P4 — решение (1–2 дня) и P2 (8–10 дней)

- **Успех.** P2 по §B на `main`, с гейтом D.4 на каждом шаге:
  1. реестр/lane по S15 и MOVE game-test — 2 дня;
  2. агент, flow, llm — 2;
  3. cloud, collab, library, platform — 2;
  4. LABS, shell, vite, CI — 1,5;
  5. docs, skills, knip — 1;
  6. гейт — 1.

  Затем `2.0.0`. `editor.pix3.dev` остаётся последней полной сборкой: там OPFS и recents. Миграция —
  «Move Project to Folder» (`MoveProjectToFolderCommand.ts`), затем `project_open`. LABS возвращаются
  по таблице пробелов, только как MCP/CLI.
- **Провал (а).** Онбординг, один повтор.
- **Провал (б).** P2 не делается. Runtime, CLI и kit остаются внутренним инструментом, своего
  harness нет.

**Итого:** P0 3–4 + P1a 9–12 + P1b 7–10 + P3 10 + P4 1–2 = 30–38 рабочих дней, то есть **6–8 недель
до решения** (C1 идёт параллельно с P1b). Затем P2 — ещё ~2 недели до `2.0.0`.

## E. Риски

| Риск | Как снять |
|---|---|
| PATH/npm в GUI-процессе | `execPath`, `env.PATH`, предустановка; S1/S2 |
| Нет Node | S3, портативный Node |
| AGENTS.md не загружен в сессии создания | ответ `project_new` + `instructions`; C1 |
| Сервер-сирота | idle 30 мин, `~/.pix3/servers/`, `doctor`, `serve --stop`; S16 |
| Смерть сервера | W-OFF, S10 |
| «Пиши JS» через CDP ненадёжен | порог S15, гибрид из 5 инструментов |
| Агент подтверждает свою генерацию через CDP | подтверждение только во вкладке-держателе lease, лимит в прокси |
| Экспорт не того состояния | W-EXP |
| Тест подтверждает удаляемое | hosted-scope + журнал пробелов |
| Анимация без UI | справочник `.pix3anim`, `character_compile`, учёт в пробелах |
| Spine в пакете | два пути исключения + скан tarball |
| Размер пакета, Safari | S9, S5 |
| Политика MY.GAMES | вопрос в P0 |

## F. Анти-скоуп

1. Никакого чата, подсказчика или агентного статуса в редакторе.
2. Никаких tray, Electron и глобального демона на фиксированном порту. Отсоединённый сервер
   проекта с idle-таймаутом (C.2) разрешён.
3. Никакого фреймворка плагинов. Возврат — `git checkout full -- <path>`.
4. Не выносить сеть runtime. Публичный API `@pix3/runtime` не трогать (`#pix3-verify` в player-entry
   к API не относится).
5. Никаких мутирующих сцену MCP-инструментов. `game_controls`/`game_time` — только при доказанной
   нужде.
6. Никакой серверной компиляции скриптов и headless-экспорта в CLI.
7. Не переносить `src/templates/projects`, не переименовывать ради красоты.
8. Никаких «lite»-редакторов, включая анимационный: формат и `character_compile` вместо UI.
9. Никакого FSA-discovery и LNA. Никакой синхронизации черновиков между origin.
10. Setup только для `codex` и `claude` (+ `chrome-devtools` при S15).
11. Не выпускать bridge.
12. Онбординг — одна setup-строка.
13. В `full` — только security-фиксы collab.
14. Физический carve-out — только после P4.

## G. Журнал ревью

### Ревью 1

| Замечание | Решение | Где |
|---|---|---|
| R1 P2 вне критического пути | принято; в ревизии 4 — P2 после P4 | A.2, D.6 |
| R2 жизненный цикл хоста | принято; в ревизии 4 — отсоединённый сервер | C.2 |
| R3 швы, регрессия chroma-key | принято | B.2, D.3 |
| R4 браузерный гейт | принято | D.4 |
| R5 `--tag next`, `workflow_dispatch`, `full` | принято | A.3, F.13 |
| R6 знания агента в kit | принято | C.5 |
| R7 setup и Windows | принято | C.1, S12 |
| R8 `workspaceId`; origin | `workspaceId` принят. Сужение «Origin == Host» отклонено: loopback с любым портом — решение §11.1 | C.3, C.4 |
| R9 skills, замена плана | принято | A.3, шапка |
| R10 `editor.pix3.dev`/OPFS | принято | D.6 |
| R11 Spine | принято | C.3 |
| R12 `projectTabs` | принято | B.2, C.3 |
| R13 сроки | принято, пересчитано | D |
| Рек. 1–8 | приняты, кроме `game_controls`/`game_time` (растёт поверхность) | A, B, C, D.5, F.5 |

### Ревью 2

| Замечание | Решение | Где |
|---|---|---|
| 1. Offline-восстановление — новая работа | принято; в ревизии 4 упрощено до аварийного пути, потому что сервер больше не умирает вместе с MCP | C.2, C.2b |
| 2. Spine по второму пути | принято | C.3 |
| 3. MVP подтверждает удаляемое | принято: hosted-scope, журнал пробелов | C.3, D.5 |
| 4. Контракт `export_playable` | принято; барьер заменён предусловием «файлы синхронизированы» (ревью 3) | C.5b |
| 5. Метрика и kill | принято: (а)/(б)/(в) | D.5 |
| 6. Гейт с негативными сценариями, сроки | принято | D.4, D.2–D.3 |

### Ревью 3

| Замечание | Решение | Где |
|---|---|---|
| 1. W-OFF — оверинжиниринг, ловушка origin; сервер как отсоединённый процесс | принято: W-SRV (idle 30 мин, `servers/`, `doctor`, `--stop`, S16), W-OFF ~1 день, без миграции и сканирования; discovery через JSON `/ws/hello` с CORS | C.2, C.2b, C.3 |
| 1. «Удаление эха `Access-Control-Allow-Private-Network` сломает кросс-портовые loopback-запросы» | **отклонено**: PNA/LNA гейтит переход из более публичного адресного пространства в менее публичное, loopback→loopback не гейтится. Эхо убираем как ненужное | C.3 |
| 2. Экспорт без вкладки; iframe; остановка play | принято: предусловие «файлы синхронизированы», проверка в отдельном контексте через `/verify`, iframe с WebGL снят; честное ограничение MVP, автономный путь — через S15 | C.5b |
| 3. P2 параллельно P1 — парадокс | принято: P2 после P4, до него только бесконфликтные удаления | §0, A.2, D.6 |
| 4. `.pix3anim` без UI, `character-compiler` в PLATFORM | принято: справочник формата со стражем, `character_compile` в CLI, учёт в пробелах | B.1, C.5, D.5 |
| 5. Арт и greenlight | принято частично: плейсхолдеры и SVG уже есть; в форме арт не оценивается; asset-паков нет | D.5 |
| 6. Уровни P0 | принято | D.1 |
| Вопрос владельца: CDP вместо lane | добавлен S15 с правилом решения и вариантами A/Б | §0, B.3, C.5, D.1, D.2 |
