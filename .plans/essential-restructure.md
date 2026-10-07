# Essential: Pix3 как агентный стек (runtime + CLI + kit + редактор как точный инструмент)

Дата: 2026-10-07, ревизия 2 после независимого ревью (§G). Статус: план. Входные данные: brief и
карта связности от 2026-10-07. Позиционирование не пересматривается. Утверждения о коде проверены
по исходникам, рядом указан путь.

**Что этот план заменяет в `.plans/external-agent-authoring.md`:** §1.2 (окно редактора как PWA с
`editor.pix3.dev`), §9 («не заменяем встроенного агента» в анти-скоупе) и §11.1 (FSA-папка плюс
ручной `pix3 serve` как основной путь). Остальное (co-authoring, барьер синхронизации, `expect`,
подтверждение `generate_*`) остаётся в силе.

## 0. Коротко

1. **Сначала проверяем подход, потом режем.**
   - Порядок: P0 спайки → P1 поток agent-first на текущем редакторе в hosted-режиме (`2.0.0-alpha.1`)
     → P3 MVP-тест MY.GAMES на нём.
   - Carve-out (P2) идёт параллельно в ветке `essential`. Он вливается только после браузерного
     гейта и не раньше, чем пройдёт dogfood C1. MVP от carve-out не зависит.
   - При успехе: `main` → `full` (архив), `essential` → `main`.
2. **Поток.** Порядок: `pix3 setup --write` → глобальная запись MCP → процесс `pix3 mcp` хостит
   workspace-сервер **и раздаёт сборку редактора с того же origin** → ссылка с одноразовым
   `#pair=`. Если хост умирает, вкладка переходит в честный offline с журналом восстановления.
3. **Carve-out.** Из ~235k строк `src/` удаляется ~85–90k: встроенный агент, flow, llm, cloud,
   collab, library, model-gen, sprite-editor, uikit*, profiler, ao-bake, strophe, bg-removal. Плюс
   collab-server и agent-bridge. Около 35 файлов-швов. Подсистема проверки игры (~15k строк в
   `services/agent/`) **остаётся** и переезжает в `services/game-test/`.
4. **`AgentToolRegistry`** (6 224 строки) заменяется `ChannelToolRegistry`, где лежат только
   инструменты канала.
   - Звук: `sfx` в процессе CLI (офлайн-синт).
   - Картинки: `generate_asset` остаётся в редакторе, ключи на стороне CLI, подтверждение человека
     сохраняется.
   - Знание встроенного агента переносится в kit **до** заморозки.
5. **Сроки:** P0 3 дня, P1 10–12, P3 ~10 рабочих дней. Результат MVP — примерно через **5 недель**.
   P2 занимает 8–10 дней параллельно и не блокирует. `2.0.0` выходит ~через неделю после решения.

## A. Стратегия репозитория

### A.1 Факты

| Критерий | A: на месте | B: новый репо | Итог |
|---|---|---|---|
| Хирургия швов (B.2, ~35 файлов; `AgentToolRegistry.ts:1-158` тянет flow/uikit-editor/model-gen/image-gen/sfx-gen/llm; eager-агент через `game-tab.ts:10`, `logs-panel.ts:4`, `pix3-status-bar.ts:20-22`, `pix3-welcome.ts:19-25`, `main.ts`) | нужна | **та же** (копия переносит ту же связность) | ничья |
| История | целиком | `filter-repo --path` рвёт её. Клон с последующим удалением даёт ту же историю, что и A | ничья |
| npm Trusted Publishing (`publish-packages.yml`), `repository.url` для provenance | без изменений | перенастройка (минуты) | небольшой плюс A |
| Один источник runtime и CLI на npm | да | два репо на одной lockstep-линии | **плюс A** |
| DeepCore | берёт `@pix3/runtime` **из npm `^1.6.2`** (`../DeepCore/package.json:22`), а не через yalc. Caret на 1.x не подтянет 2.0-alpha. От выбора репо не зависит | — | — |
| Нетронутый рабочий 1.x во время теста | нужна ветка | да | **плюс B**, но его даёт и ветка |

### A.2 Решение: один репо, carve-out в ветке `essential`

- `pix3dev/pix3@main` во время теста — **полный** редактор плюс поток P1. Отсюда выходят
  `2.0.0-alpha.N` в dist-tag `next`, `latest` остаётся 1.6.3. Фиксы MVP делаются здесь.
- Ветка `essential` (worktree) — carve-out P2. Это один коммит на область, чтобы `git revert`
  возвращал её целиком. `main` регулярно вливается в неё. Конфликты малы: P1 трогает в основном
  `packages/pix3-cli` и три точки редактора (C.3, C.4).
- **Успех P3:** тег `pix3-full-<последняя 1.x/alpha>`, `main` → `full`, `essential` → `main`, выпуск
  `2.0.0` в `latest`. **Провал:** `essential` не вливается. В `main` остаются полезные части потока
  (setup, hosted, пара).
- `pix3dev/pix3-platform` создаётся только при одобрении платформы, из `full`:
  `git clone --no-local … && git filter-repo --path packages/pix3-collab-server/ --path src/services/{cloud,collab,library}/ --path src/ui/{collab,asset-library}/ --path src/player/ --path player.html`.
  Контракт: «редактор экспортирует playable, платформа его хостит».

### A.3 Цена и CI

- **Публикация:** в `publish-packages.yml` (`npm publish --access public`, стр. 60/108/136)
  добавляется `--tag next`, если версия содержит `-`. Без этого npm 11 откажет prerelease или
  отправит его в `latest`. Job cli получает шаг `npm run build:hosted` перед publish (C.3). Job
  bridge удаляется в `essential`.
- **CI:** `ci.yml.disabled` заменяется на `ci.yml`, который запускается на `main` и `essential`:
  lint, type-check, vitest, `build:hosted`, `npm pack` CLI плюс браузерный гейт (D, P2).
- **Collab-сервер после переименования.** GitHub запускает `workflow_dispatch` только для workflow
  из ветки по умолчанию, поэтому в `full` триггер `deploy-collab-server.yml` меняется на
  `on: push: branches: [full]`. Единственное разрешённое изменение в `full` — security-фикс
  collab-сервера, пока жив `cloud.pix3.dev` (F.13).
- **Lockstep:** без изменений. В `essential` `update-version.mjs` перестаёт штамповать
  collab-server.
- **Kit drift spec** (`packages/pix3-cli/src/kit.spec.ts`):
  - тест «names no editor-only tool» читает `AgentToolRegistry.ts` с диска (~стр. 245), в
    `essential` он удаляется;
  - «exactly 14 tools» меняется на новый список;
  - `engine-api-map.md` переносится в `packages/pix3-cli/kit-src/`;
  - `src/core/agent-reference-docs.spec.ts` остаётся, путь в нём правится.
- **Docs policy:** в `essential` правятся README, AGENTS.md, CLAUDE.md (в том числе неверная строка
  про yalc у consumer) и спецификация: удалённые разделы сворачиваются до «удалено в 2.0, см.
  `full`». Чистое дерево для агентов:
  - планы удалённого (`flow-autopilot`, `prompt-to-playable-flow`, `vibe-wow-first-prompt`,
    agent-eval*) остаются только в `full`;
  - удаляются `.env.development`, `.env.prod-backend`, скрипты `dev:prod`/`dev:collab*`, `src/sw.ts`
    и записи `knip.json` (`player-main`, `bg-removal.worker`, `sw.ts`).
- **Skills репо:**
  - `debug-running-game` вызывает `agentTools.execute('scene_tree'|'create_node')` (`SKILL.md:84-91`),
    в `essential` он переписывается на сокращённый `debug-bridge` (B.1);
  - `generate-sprites-in-editor` удаляется, потому что водит Sprite Editor;
  - ссылка на Sprite Editor в `pix3-game-dev` правится.

## B. Essential scope (выполняется в P2, ветка `essential`)

Статусы:
- **KEEP**: остаётся в ядре;
- **TRIM**: остаётся, вырезаются куски;
- **MOVE**: остаётся, но в другом месте;
- **LABS**: удаляется, может вернуться из `full` *только* как инструмент MCP или глагол CLI;
- **PLATFORM**: уходит в будущий `pix3-platform`;
- **FREEZE**: удаляется, остаётся только в `full`;
- **DELETE**: не возвращается.

### B.1 Каталоги

| Каталог | Строк | Статус / примечание |
|---|---|---|
| `packages/pix3-runtime` | 62,6k | KEEP. Сеть не трогаем (B.5) |
| `packages/pix3-cli` | 16k | KEEP и растёт (C). `link-server.ts` (512) и `mcp.ts` (129) — DELETE: у редактора нет для них клиента. `pix3 mcp` без флагов становится хостом |
| `packages/pix3-collab-server` и алиасы `@pix3/collab-*` в `vite.config.ts`/`tsconfig.json`/`vitest.config.ts` | 7,8k | PLATFORM |
| `tools/pix3-agent-bridge` | 7,6k | FREEZE (последняя версия остаётся на npm) |
| `services/agent` | 26,6k | Разделяется. **MOVE → `services/game-test/`** (~15k, 18 файлов, импорты без llm/flow): `GameTestService`, `GameInputService`, `GameBotHost`, `game-*.ts`, `NodeWatchRecorder`, `ProjectTraceStore`, `reachability-journal`, `nondeterminism-probe`, `key-for-code`, `renderability-note`, `pix3-test-bot-dts`. Остальное FREEZE (emoji-as-art уже есть в `pix3-cli/src/validate/level1.ts:597-609`). `agent-skills/` переносится в kit до заморозки (C.5) |
| `services/{flow,llm}`, `ui/{agent-chat,flow}`, `features/flow`, `src/templates/agent` | ~22k | FREEZE |
| `services/{cloud,collab,library}`, `ui/{collab,asset-library,auth}`, `features/library`, `services/project/LocalSyncService.ts` | ~19k | PLATFORM/FREEZE |
| `services/play/{OnlineSession,PreviewHost,RemotePreviewTelemetry}Service`, `core/remote-preview/`, `src/player/`, `player.html`, карточки online/preview в `ui/viewport`, `Start{RemotePreview,OnlineGame}Command` | ~5k | PLATFORM (уходит и `qrcode`) |
| `services/model-gen`, `ui/model-lab` | 8,7k | LABS |
| `ui/sprite-editor` (с вкладкой ресурса `animation`, `LayoutManager.ts:44-48`) | 9,9k | LABS. `.pix3anim` редактируется как YAML в code-tab, Monaco остаётся |
| `services/{uikit,uikit-editor}`, `ui/{uikit-forge,tools}`, `src/tools/uikit-forge`, `tools/uikit-forge.html`, `features/uikit` | ~10k | LABS. `skin_ui` вернётся по триггеру (B.4) |
| `services/image-gen` | 5,9k | TRIM: `AssetGenService`, `Gemini`/`OpenAIImageProvider`, `ImageGenProviderRegistry`, `AiImageSettingsService`, `GenerationHistoryService`, `ImageGenTypes`. `image-ops.ts` **MOVE → `src/core/`** (экспорт: `compressImageBlob`; инспектор: `readAlphaMask`) |
| `ui/generate`, `services/{sfx-gen,bg-removal,strophe}` | ~5k | LABS / DELETE ×3 |
| `services/ao-bake`, `features/render`, `ui/profiler` + `services/play/ProfilerSessionService`, `ui/home` + `ProjectHomeService` | ~3,6k | LABS |
| `services/atlas`, локализация (2,6k: связана с `GamePlaySessionService` и `ProjectBuildService`) | | KEEP |
| `services/project/agent-kit`, `InstallAgentKitCommand`, `pix3-agent-handoff-dialog`, `scripts/ensure-agent-kit.mjs` (из конфигов vite и vitest) | ~1,3k | DELETE: kit ставит `project_new`. Проектный `.mcp.json` спорит с глобальной записью |
| `services/editor/{WorkspaceMode,StudioViewportMount,UpdateCheck}Service`, `SwitchWorkspaceModeCommand`, `pix3-mode-switch` | | DELETE |
| `ui/shared` | 12,8k | DELETE: `composer-attachments`, `pix3-image-annotator`, `pix3-project-sync-dialog`, `pix3-save-asset-dialog`, `pix3-animation-auto-slice-dialog`. TRIM settings. KEEP: `pix3-agent-channel-indicator`, `pix3-workspace-*`, `pix3-merge-banner`, `pix3-recovery-menu` |
| `src/core` | 6,8k | DELETE `agent-eval`, `dev-backend`, `tool-routes`. KEEP `agent-introspection` и `net-kind-paths`. `debug-bridge.ts` (1 286) сокращается до ~300 строк: `ChannelToolRegistry` плюс дерево сцены через introspection для skill `debug-running-game` |
| ядро редактора (viewport, scene-tree, inspector, assets, code-editor, runtime, logs, timeline; services viewport/play/scene/scripting/assets/editor/core/animation/export; project/{workspace,coauthoring,autosave,external-merge}; `src/templates/projects`) | ~80k | KEEP/TRIM по B.2. FSA «Open Folder» и OPFS-проекты остаются как есть, без вложений |

Из зависимостей уходят `@hocuspocus/provider`, `yjs`, `@huggingface/transformers`, `onnxruntime-web`,
`@txt2sfx/*` ×5, `qrcode` (+types), `vite-plugin-pwa`, `concurrently`.

### B.2 Швы: ~35 сохраняемых файлов

| Файл | Что тянет | Замена |
|---|---|---|
| `services/atlas/TextureAtlasService.ts:7` | `sha256Hex` из `core/remote-preview/protocol` (PLATFORM) | `src/core/hash.ts`. Туда же `guessMimeType` → `src/core/mime.ts` (нужен `ChannelToolRegistry`) |
| `services/editor/EditorTabService.ts:20,52,439` | `@inject(PreviewHostService)`. Сессия вкладок `pix3.projectTabs:<id>` хранит типы `animation`/`sprite-editor`/`model-lab`/`uikit-forge` (`state/AppState.ts:12-22`) | убрать inject. При восстановлении отфильтровать неизвестные типы. Layout **не** сохраняется (`LayoutManager.ts:1044` всегда грузит `DEFAULT_LAYOUT_CONFIG`) |
| `core/LayoutManager.ts:14-34` | 19 типов панелей, базовый стек — `background` (home) | 10 типов. Вместо home — пустое состояние `pix3-empty-stage` (сделано в P1, C.3) |
| `image-gen/AssetGenService.ts:11,238,483-515` | `BackgroundRemovalService` (ISNet в пресете `sprite`) | OpenAI: `transparent`. Gemini: плоский фон плюс `chromaKeyImage` (`image-ops.ts:642`). Это **регрессия качества**, проверяется на 10 реальных спрайтах (P1) |
| `image-gen/ImageGenProviderRegistry.ts:4-8,37-39`, `AiImageSettingsService.ts` | Strophe, SvgLlm, Codex, `BridgeConnectionService`, `bg-removal/types` | только Gemini и OpenAI |
| обработчик `generate_asset` (`AgentToolRegistry.ts` ~2132+) | flow: idea-stage, `references/`, роли | вырезается из копии (`role`, `overwrite`, idea-ветки) |
| `ui/viewport/game-tab.ts:10,283` | `composeFix`, карточки online/preview | «Copy for agent» (`buildPlayModeErrorPrompt` → clipboard), карточки убрать |
| `ui/logs-view/logs-panel.ts:4,110` | `composeFix` | то же |
| `ui/object-inspector/inspector-panel.ts:43-44,61` | `image-ops`, `ui/sprite-editor/contour-trace`, `library-inspector` | `contour-trace.ts` **MOVE → `src/core/`**, library убрать |
| `ui/object-inspector/inspector-{property,section}-renderers.ts`, `ui/scene-tree/scene-tree-panel.ts`, `ui/assets/{asset-tree,assets-content,assets-panel}.ts`, `ui/viewport/editor-tab.ts` | collab presence, `LibraryInsertService`, `GeneratedAssetDropService` | убрать. Двойной клик по картинке не открывает sprite editor |
| `ui/shared/pix3-editor-settings-dialog.ts` (2 455) | llm ×5, agent ×2, model-gen ×3, strophe, bg-removal | остаются «Editor/Viewport». Ключи картинок живут в CLI (C.3), не здесь |
| `ui/shared/pix3-status-bar.ts:10,20-22,32,44` | Bridge, LLM, AgentSettings, `core/dev-backend`, `UpdateCheckService`, `collab-status-bar` | остаются статус workspace и пилюля канала |
| `ui/shared/pix3-lightbox.ts:9,11` | `markdown-lite` (agent-chat), `pix3-image-annotator` | `markdown-lite` → `ui/shared`. Режим аннотаций убрать |
| `ui/shared/pix3-create-project-dialog.ts`, `services/project/ProjectLifecycleService.ts:16-26,86,92-229,307-351` | `AuthService`, `CloudProjectService`, `AgentKitService`/`withAgentKit`, auth-срез | убрать cloud и agent-kit. `src/templates/projects/cli-manifest.spec.ts` теряет часть про agent-kit |
| `ui/welcome/pix3-welcome.ts` (1 197) | cloud, llm, agent, flow | переписать (~250 строк, dev-режим): Open Folder, Connect to Workspace, Recent. Hosted-загрузка — отдельный компонент из P1 |
| `ui/pix3-editor-shell.ts` (2 158) | ~17 команд удаляемых областей, Auth/Cloud/LocalSync/AgentKit/WorkspaceMode/StudioMount, `<pix3-flow-shell>`, collab, `<pix3-uikit-forge>`, `<pix3-auth-screen>`, side-effect-импорты | вырезать, включая cloud-ветку открытия (~1463-1471) |
| `main.ts`, `core/register-runtime-services.ts:3-5` | `LibrarySync`/`Bridge`.initialize, Collaboration/AssetUpload/CollabOverlay | убрать |
| `services/core/OperationService.ts:24,292-335`, `CommandDispatcher.ts`, `RouterService.ts` | `Y.UndoManager`, collab read-only, `CollabJoinService`, `#uikit` | убрать |
| `services/project/ProjectService.ts:43-44,~406-412,~1236` | `CollaborationService`, `ideaTimeline`, `LocalSyncService`, `updateCollaborationReferencesAfterMove` | убрать |
| `services/project/ProjectStorageService.ts:15`, `services/scripting/ProjectScriptLoaderService.ts`, `services/viewport/ViewportRenderService.ts` | backend `'cloud'`, `ApiClientError`, collab overlay, `workspaceMode` | `'local' \| 'workspace'`, ветки убрать |
| `features/scripts/play-workspace.ts`, `state/{AppState,index}.ts` | срезы `collaboration`/`auth`/`workspaceMode`/`flowAutopilot` | удалить срезы и чтения |
| `WorkspaceAgentToolBridge.ts:281` | `@injectLazy(AgentToolRegistry)` | `ChannelToolRegistry` (B.3) |
| `vite.config.ts` | PWA, inputs `player`/`uikitForge`, прокси `/api`, `/collaboration`, `/preview`, tripo/zen/cerebras, cookie-routing, `__PIX3_DEV_BACKENDS__`, ensure-agent-kit | остаются `/openai-proxy` (dev), rapier define, manualChunks, `export-vendor` |

После этого — отдельный коммит knip: мёртвый палитровый код `image-ops.ts` (~900 строк, им
пользовался flow) и прочее.

### B.3 `ChannelToolRegistry`

Сегодня `WorkspaceAgentToolBridge` пропускает 14 инструментов через `AgentToolRegistry.execute`
(`:840`). Вместо этого создаётся `src/services/agent-channel/ChannelToolRegistry.ts` с тем же
`AgentToolSpec`/`execute`.

- Обработчики переносятся из `AgentToolRegistry.ts`: play_* (~1470-1512), `game_input` (~1513),
  `game_observe` (~1633), `game_run` (~1721), `read_logs`/`read_errors` (~2031-2041),
  `viewport_screenshot` (~2057), `get_selection` (~968), `generate_asset` (урезанный), а также
  `export_playable` из P1.
- Метод: скопировать файл и удалить недостижимое по `noUnusedLocals`.
- **Подсказки `channel-tool-hints.ts` применяются к описаниям один раз при копировании, итог
  «запекается», а сам слой удаляется.** Агент видит тот же текст.
- Объём ~1,5–2k строк, из них ~535 — описания. Спеки переносятся с файлами,
  `WorkspaceAgentToolBridge.spec.ts` получает новый мок.

### B.4 Генеративные инструменты

| Инструмент | Где | Почему |
|---|---|---|
| `sfx` | процесс CLI, `pix3-cli/src/sfx/` | без ключей и браузера. Редакторный `generate_sfx` требует LLM-полосу (`SfxGenService` → `LlmLaneResolver`), она уходит |
| `generate_asset` | редактор, через канал, подтверждение на соединение (лимит 20) | постобработке нужен canvas. Ключи хранятся на сервере CLI (C.3). `svg-llm` уходит: агент сам пишет SVG, `check` ловит `E_SVG_*` |
| `skin_ui` | LABS. Триггер: UI-тяжёлый концепт в P3 и пройденный S11 | писатель `uikit-editor/UiKitProjectWriter.ts:254` завязан на canvas. Перенос ядра `uikit` (оно host-agnostic, страж `host-agnostic.spec.ts`) в CLI — 3 дня по триггеру |

### B.5 Сеть runtime: не трогать

`src/net/` (~7k) встроен в пакет: значимый импорт в `core/SceneService.ts:8-9`, регистрация в
`behaviors/register-behaviors.ts`. Из playable сеть уже вырезается (`strippable-runtime-modules.ts`).
DeepCore сеть не использует. Вынос в `@pix3/runtime-net` стоит 2–3 дня и не даёт пользователю
ничего. Удаляются только редакторные потребители (PLATFORM). Вопрос пересматривается вместе с
`pix3-platform`.

## C. Поток agent-first (P1, на `main`, полный редактор)

### C.1 `pix3 setup [codex|claude] --write`

Сейчас `mcp-config.ts:setupInstructions` только печатает команды. Новое поведение:

1. **Цель.** Аргумент, иначе автоопределение (`CLAUDECODE=1`; переменную Codex проверяет S1).
   Основной путь — **Codex**: у Claude Code в MY.GAMES был организационный 403 (§11.14 внешнего
   плана).
2. **Установка.** `npm install --prefix ~/.pix3/cli/<ver> @pix3/cli@<ver>`. Здесь же ставятся
   **TypeScript** в `~/.pix3/typescript/<PINNED>` и `esbuild`. Иначе ленивый
   `npm install` в `check/typescript.ts` не найдёт npm из GUI-процесса.
3. **Запись MCP:**
   - `command` = `process.execPath`;
   - `args` = `[~/.pix3/cli/<ver>/node_modules/@pix3/cli/dist/index.js, "mcp"]`;
   - `env.PATH` начинается с `dirname(execPath)`.

   Это закрывает три проблемы: PATH GUI-приложений, походы npx в реестр при каждом старте и прокси.
4. **Codex** (`~/.codex/config.toml`):
   - наши таблицы `[mcp_servers.pix3]` и `[mcp_servers.pix3.*]` заменяются целиком;
   - пути пишутся TOML literal-строками `'…'` (обратные слэши Windows);
   - перед записью — бэкап с меткой времени;
   - после записи файл перечитывается и проверяется; если есть `codex`, ещё и `codex mcp list`;
   - `startup_timeout_sec = 30`, `tool_timeout_sec = 180`.
5. **Claude:** только `claude mcp add --scope user pix3 -- …`. Если `claude` нет в PATH, печатается
   инструкция или plugin-маршрут (S2). **`~/.claude.json` руками не трогаем**: Claude Code
   переписывает этот файл, пока работает.
6. **Глобальный skill** пишется только хосту, который не показывает MCP `instructions` (S6).
   `--remove` откатывает изменения.

Вход для человека — одна строка в README, которую он вставляет в чат: «Run
`npx -y @pix3/cli@<ver> setup --write`». Если Node нет, план Б (S3): агент скачивает портативный
Node в `~/.pix3/node` без прав администратора, а `engines` ослабляется до проверенного минимума.

### C.2 Процесс MCP хостит сервер. Жизненный цикл без иллюзий

Сейчас `mcp-workspace.ts` — только клиент lane. Новое поведение:

- **Старт.** stdio поднимается сразу, порт не занимается.
- **Привязка.** При `project_new`/`project_open {dir}` или при первом инструменте в найденном
  проекте вызывается `ensureHost(root)` → `openWorkspace` (`serve/open-workspace.ts`) с портами
  `[записанный, 8490..8499]`.
  - `started` — этот процесс хост;
  - `running` — работаем клиентом lane (второе окно);
  - `unresponsive` с мёртвым pid — lock забирается (`acquireServeLock` → `isProcessAlive` уже есть).
- **Несколько проектов.** Внутри `Map<root, …>`. Инструменты принимают `dir`.
- **stdout — это JSON-RPC.** Логи `WorkspaceServer` пишутся только в stderr, на это есть тест.
- **Хост умирает — у вкладки пропадают и I/O, и статика.** При backend `workspace` весь
  ввод-вывод идёт через сервер (`ProjectStorageService`). Поэтому:
  1. **Grace.** После конца stdin или SIGTERM хост остаётся жить, пока вкладка держит lease, но не
     дольше 10 минут без активности MCP. Новых MCP-запросов он не принимает, затем выходит. При
     SIGKILL grace нет. Это ограниченная задержка, а не демон, исключение из F.2 записано явно.
  2. **Offline-режим вкладки.** Если события отваливаются и запись не проходит, правки уходят в
     журнал восстановления. Журнал уже умеет писать в IndexedDB
     (`coauthoring/recovery-fallback-store.ts`, `RecoveryJournalService`). Баннер: «Связь с сессией
     агента потеряна. Правки сохранены в этом браузере — не перезагружайте вкладку. Попросите
     агента открыть редактор (`editor_link`): вкладка переподключится и запишет их на диск».
  3. **Переподключение.** Липкий порт → тот же origin → reconnect и rescan
     (`WorkspaceSessionService:406`). Записи offline-происхождения автоматически восстанавливаются
     через существующий путь журнала. Если диск изменился, появляется merge-баннер.
  4. **Повышение клиента.** Если lane получает ECONNREFUSED, клиент пробует `ensureHost` на тот же
     порт. Любой новый процесс MCP (рестарт приложения, вызов `editor_link`) поднимает хост там же.
- `pix3 serve` остаётся для терминала и dev. `mcp --workspace` — алиас.

### C.3 CLI раздаёт сборку редактора

- **Сборка.** `npm run build:hosted` = `vite build --mode hosted`, вывод в
  `packages/pix3-cli/editor/` (единственный путь, в gitignore; dev из checkout отдаёт эту же папку).
  - **Исключено:** PWA, inputs `player`/`uikitForge`, ONNX/bg-removal, загрузчик Spine. В hosted-режиме
    не вызывается `registerSpineModuleLoader`: Spine Runtimes License не подходит для распространения
    в CLI, SpineSkeleton2D нет ни в шаблонах, ни в DeepCore. Spine-проекты открываются в dev-пути.
  - `licenses:report` и THIRD_PARTY_NOTICES входят в пакет.
  - Порядок сборки: runtime (через алиас) → редактор → CLI (`build`, `build-runtime-types`,
    `build-kit`, `copy-editor`). В `files` добавляется `editor`.
- **Hosted-точки в редакторе** (пишутся один раз и переживают carve-out):
  - отдельный компонент `pix3-hosted-boot`, который обходит `pix3-welcome`;
  - `pix3-empty-stage` вместо home в layout;
  - скрыты переключатель Vibe и панели agentChat/profiler.
- **Сервер:**
  - статика без авторизации; `index.html` — `no-cache`, хэшированные ассеты — `immutable`;
  - в `index.html` подставляется `<meta name="pix3-workspace-id">`: это идентификатор, а не секрет;
  - Host-check остаётся (DNS rebinding);
  - `/openai-proxy/v1/*` и `/gemini-proxy/*` подставляют ключ **на стороне сервера** из
    `~/.pix3/keys.json` (0600; пишет `pix3 setup --image-key` или `doctor`). Ключ не попадает в
    браузер и одинаков для всех портов и origin. Маршруты доступны только same-origin и с токеном.
- **Авторизация:**
  - `isAllowedOrigin` проверяет **`Origin` == `http://` + заголовок `Host`** (loopback, любой порт:
    так продолжает работать проброс VS Code на другой локальный порт, §11.1) плюс dev :8123;
  - уходят `https://editor.pix3.dev` и эхо `Access-Control-Allow-Private-Network`
    (`workspace-server.ts:699`);
  - токен остаётся, потому что на общем сервере 127.0.0.1 видят другие пользователи. Lane агента не
    меняется;
  - `cli-version-gate` в hosted-режиме не нужен.

### C.4 Пара: одноразовый код, ключ — `workspaceId`

1. `editor_link` (и `project_new`/`project_open`) создаёт код: 128 бит, TTL 10 мин, один раз. Если
   процесс — клиент, код берётся через `POST /ws/agent/pair-code` по control secret. Ссылка:
   `http://127.0.0.1:<port>/#pair=<code>`. Долгоживущий токен в истории чата был бы вечной
   учётной записью.
2. Загрузка работает **по образцу `BridgeConnectionService.consumePairingLink`** (`:294`): сначала
   `replaceState`, затем `POST /ws/pair {code}`. Ответ — `{workspaceId, token}`, токен уходит в
   `WorkspaceCredentialStore` **по `workspaceId`**, как сейчас. В разные дни порт 8490 занимают
   разные проекты.
3. Повторная загрузка без кода: `workspaceId` берётся из meta, по нему токен. Нет ни того, ни
   другого — карточка «Откройте ссылку из чата ещё раз».
4. На сервере `token` → `tokens[]` (до 8 штук; неиспользуемые дольше 30 дней удаляются). Удалить
   файл — значит отозвать всё.
5. Браузер открывается сам на первом `project_new`, если нет `SSH_CONNECTION` и не задано
   `PIX3_OPEN_BROWSER=0`.

### C.5 Инструменты MCP и kit

| В процессе CLI | Через редактор |
|---|---|
| `doctor`, `project_new`, `project_open`, `editor_link`, `check`, `smoke`, `tree`, `sfx` | `project_status`, `play_start/stop/restart/status`, `game_run`, `game_input`, `game_observe`, `read_errors`, `read_logs`, `viewport_screenshot`, `get_selection`, `generate_asset`, **`export_playable`** (новый, P1: `PlayableHtmlBuildService` → `exports/<name>.html` через workspace-бэкенд плюс отчёт о размере). `generate_sfx` убирается из allowlist |

- **CLI-глаголы стали инструментами**, потому что в песочнице Codex сеть по умолчанию выключена и
  `npx` из shell агента ненадёжен.
- **`project_new {dir, template?, name?}`.**
  - Основа — `createProject` и `agentKitStep` **без `.mcp.json`**. `pix3 new` пишет его только с
    `--mcp-config`.
  - Проверку «не пусто» (`new-project.ts:72`) смягчаем для `.git`, `.codex`, `.claude`, `.vscode`,
    `.idea`, `.DS_Store`.
  - Описание инструмента перечисляет шаблоны из `listTemplates()`.
  - Ответ: ссылка плюс «прочитай AGENTS.md сейчас». Kit создан посреди сессии, хост его не загрузил.
- **MCP `instructions`** (~1 000 знаков): нет `pix3project.yaml` → `project_new {dir: <абсолютный
  путь>}` → прочитать AGENTS.md → давать ссылку кликабельной → править файлы, `check`, `game_run`
  → `doctor` при сбое.
- **`doctor`** возвращает список `{check, ok, fix}`:
  - Node, установка CLI, TypeScript;
  - версия kit против CLI;
  - lock и порт, держатель lease;
  - наличие `editor/`;
  - `keys.json`;
  - `SSH_CONNECTION`.
- **Знание встроенного агента переносится в kit до заморозки.** В `kit-src/skills/pix3-verify` и
  `pix3-scripts` через `{{include}}` попадает существенное из `agent-skills/verify-and-fix.md`
  (368 строк: каналы ввода, время и кадры, `GameDebugProvider`, без которого не работают предикаты
  `gameStateChanged` в `game_run`, bot policies, частые ошибки) и `game-prototype.md` (276 строк:
  инкременты, ловушки API, плейсхолдеры). В `kit-src` слова `GameDebugProvider` сейчас нет вообще.
  Блок `mcp-tools` и `kit.spec.ts` получают 22 инструмента.

### C.6 Вторая машина (репо на Linux-сервере, приложение на ноутбуке)

Процесс MCP запускается там же, где агент: VS Code Remote-SSH или удалённый режим приложения (S8).
Он слушает `127.0.0.1:8490` на сервере. Ссылка работает, если порт проброшен на тот же номер: VS Code
делает это сам. Если локальный порт переназначен, `editor_link` берёт адрес из `PIX3_PUBLIC_ORIGIN`
(в `env` записи MCP). Новый origin работает, потому что авторизация считается от `Host`, а пара — по
коду. Браузер при SSH сам не открывается. Токен на общем сервере обязателен.

## D. Фазы

### P0 — спайки (3 дня; Igor на живых приложениях, S10 делает агент)

| # | Вопрос | Pass | Fail → |
|---|---|---|---|
| S1 | Codex desktop: подхватывает глобальный `[mcp_servers]` (или `CODEX_HOME`) после рестарта; cwd процесса; один процесс на тред или на приложение; держит ли порт 30+ мин; **чем завершает процесс (закрытие stdin, SIGTERM или SIGKILL), есть ли idle-reaping**; есть ли `~/.codex/skills` | заглушка (listen + 1 инструмент) видна, порт доступен, после выхода сирот нет, способ завершения записан | явный `dir`. Если SIGKILL — grace не работает, полагаемся на offline-журнал |
| S2 | Claude Code desktop: то же для `--scope user` и plugin; приоритет проектного `pix3` (DeepCore закреплён на 1.6.2) над пользовательским | то же | plugin-маршрут. Приоритет ниже Codex |
| S3 | Чистый ноутбук дизайнера MY.GAMES: есть ли Node; работает ли `dist` на Node 22 и 26 | Node есть или ставится без админа | портативный Node (C.1) |
| S4 | Ссылка `#pair=` в чате кликается, открывает системный браузер, фрагмент сохраняется | подключение ≤5 с | `?pair=` плюс `replaceState` |
| S5 | Chrome, Safari, Firefox на hosted-сборке | Chrome и Safari: полный цикл | «нужен Chrome» |
| S6 | Видит ли модель MCP `instructions` (Codex, Claude) | да → глобальный skill не нужен | skill |
| S7 | `npx … setup --write` в песочнице Codex | ≤1 одобрение | инструкция в промпте |
| S8 | Удалённый сценарий Igor | ссылка работает | `PIX3_PUBLIC_ORIGIN` |
| S9 | `npm pack` CLI с hosted-сборкой (без ONNX и Spine) и холодная установка | <30 МБ, <60 с | `@pix3/editor-dist` |
| S10 | Ветка: `WorkspaceServer` отдаёт hosted-сборку, работает `#pair` | цикл работает | инженерный риск |
| S11 | Runtime 9-slice с SVG-текстурой | рендер как у PNG | `skin_ui` остаётся LABS |
| S12 | Windows: экранирование TOML, `isProcessAlive`, отсутствие SIGTERM, закрытие stdin | setup и lifecycle проходят | исправления в P1 |
| S13 | Встроенная генерация картинок в Codex desktop | есть → постобработка на CLI, ключ дизайнеру не нужен | ключи через `keys.json` |

Не код, но тоже в P0: политика MY.GAMES (данные в OpenAI/Anthropic, лицензии Codex, прокси npm) и
корпоративный ключ картинок. Вопрос продюсеру и IT.

### P1 — поток на `main` (10–12 дней) → `2.0.0-alpha.1` (`next`)

| Работа | Дни |
|---|---|
| C.1 setup: Codex и Claude, TOML, установка TS и esbuild, `--remove` | 1,5 |
| C.2 хост, grace, повышение клиента, offline-режим и баннер | 3 |
| C.3 `build:hosted` (без PWA, ONNX, Spine), статика, прокси с ключами, CORS от `Host`, `pix3-hosted-boot`, `pix3-empty-stage` | 2 |
| C.4 код пары, `tokens[]`, meta | 1 |
| C.5 инструменты CLI, `export_playable`, `doctor`, `instructions`, перенос знания в kit | 2 |
| Итерации с перезапуском настоящих приложений, Windows, упаковка, publish `--tag next` | 1,5–2,5 |

**Артефакт:** Igor в Codex desktop без терминала проходит путь «connect → пустая папка → идея →
ссылка → игра → `export_playable`». Это dogfood-концепт C1, 2 дня с замерами. Затем проверка
`chromaKeyImage` на 10 спрайтах.

### P2 — carve-out в ветке `essential` (8–10 дней, параллельно P1/P3, не блокирует)

Агенты в worktree, Igor ревьюит. Шаги:
1. `ChannelToolRegistry`, MOVE game-test, переключение bridge — 2 дня;
2. агент, flow и llm со швами — 2 дня;
3. cloud, collab, library, platform — 2 дня;
4. LABS, `LayoutManager`, shell, vite, `package.json`, CI — 1,5 дня;
5. docs, skills, knip, чистка дерева — 1 день;
6. гейт и фиксы — 1 день.

**Гейт на каждом шаге:**
- `type-check`, тесты;
- `pix3 smoke` на всех шаблонах;
- golden-размер playable (`PlayableHtmlBuildService.size.spec.ts`);
- **скриптованный браузерный прогон hosted-сборки** (chrome-devtools MCP или Playwright):
  `#pair` → открыть сцену → правка в инспекторе → сохранение → play → `game_run` через MCP →
  `export_playable`. Ловит пропавший side-effect-импорт Lit-элемента, который типы не ловят.

**Слияние** — только после гейта и после C1.

### P3 — MVP MY.GAMES (~10 рабочих дней, на `2.0.0-alpha.1` + фиксы)

Метрики фиксируются письменно до старта.

- **Концепты.** 3 из бэклога: 2D hyper-casual, UI- или мета-тяжёлый, 3D-lite. C1 и C2 делает Igor
  в Codex. Это **верхняя граница** результата, а не типичный случай. C3 — stranger test. Если
  получится, проводится второй незнакомец.
- **Unity-базис.** **Фактические** часы студии на сопоставимый прототип. Оценка допускается только
  при отсутствии фактов и помечается.
- **Замеры:**
  - человеко-часы внимания **и состав ролей** (дизайнер один или дизайнер плюс программист);
  - итерации;
  - стоимость токенов;
  - время до первой запущенной игры;
  - дефекты;
  - вердикт продюсера (`нет` / `внутренний greenlight` / `CPI-тест`);
  - размер playable и запуск в целевом канале.
- **Метрика питча.** Главная: «прототип уровня greenlight без программиста». Вторая: скорость.
- **Stranger.** Codex desktop, чистый ноутбук, без терминала, наблюдатель молчит. Цель: игра
  запущена ≤2 ч, 0 терминальных вмешательств, ≤2 подсказки, прототип к концу дня.
- **Kill-критерий** (любой из пунктов):
  - ≥2 из 3 концептов с вердиктом `нет`;
  - медиана человеко-часов (все роли) >50 % фактического Unity-базиса;
  - stranger не запустил игру за 2 ч и после одной итерации исправлений онбординга.

### P4 — решение (1–2 дня)

- **Успех.** Вливание `essential` → переименования из A.2 → `2.0.0` в `latest`. LABS возвращаются
  только как MCP или CLI. Платформа — по решению.
  - `editor.pix3.dev` **остаётся** последней полной сборкой: OPFS-проекты и recents привязаны к
    этому origin.
  - Путь миграции: «Move Project to Folder» (`features/project/MoveProjectToFolderCommand.ts`,
    OPFS → папка) → `project_open {dir}`.
  - Посадочная страница с setup-строкой размещается отдельно (README или `pix3.dev`).
- **Провал только на stranger.** Онбординг (Node, setup, doctor) и один повторный прогон.
- **Провал по вердикту или скорости.** `essential` не вливается. Runtime, CLI и kit остаются
  внутренним инструментом. Возврата к своему harness нет.

**Итого:** P0 3 + P1 11 + P3 10 ≈ 24 рабочих дня (~5 недель) до решения, плюс ~1 неделя до `2.0.0`.
P2 укладывается внутрь.

## E. Риски и открытые вопросы

| Риск / вопрос | Как снять дешевле всего |
|---|---|
| PATH и npm в GUI-процессе | `execPath`, `env.PATH`, предустановка TS и esbuild (C.1). S1/S2 |
| Нет Node | S3, портативный Node |
| AGENTS.md не загружен в сессии, где создан проект | текст в ответе `project_new` и в `instructions`. dogfood C1 |
| Хост убит без grace (SIGKILL) | offline-журнал плюс повышение клиента (C.2). S1 меряет |
| F5 в offline отдаёт пустую страницу | баннер «не перезагружайте». После ссылки агента всё восстанавливается из журнала |
| Качество вырезки Gemini через chroma-key | 10 спрайтов в P1. Хуже — по умолчанию OpenAI `transparent` |
| Размер пакета | S9, `@pix3/editor-dist` |
| Safari | S5 |
| Carve-out ломает редактор | ветка, браузерный гейт, MVP идёт без него |
| Два MCP с именем `pix3` (проектный 1.6.2 и пользовательский) | S2. `doctor` предупреждает |
| Политика MY.GAMES | вопрос продюсеру и IT, параллельно с P0 |
| Расхождение `main` и `essential` | регулярно вливать `main`. P1 трогает мало файлов редактора |

## F. Анти-скоуп

1. Никакой чат-панели, подсказчика или агентного статуса в редакторе. Пилюля канала — максимум.
2. Никакого демона, tray, Electron или глобального фиксированного порта. Единственное исключение —
   ограниченный grace хоста (C.2).
3. Никакого фреймворка плагинов для панелей и команд. Возврат делается через
   `git checkout full -- <path>`.
4. Не выносить сеть runtime. Не трогать публичный API `@pix3/runtime`.
5. Не добавлять мутирующие сцену MCP-инструменты. `game_controls`/`game_time` появятся только при
   доказанной нужде в C1.
6. Никакой серверной компиляции скриптов и headless-экспорта в CLI.
7. Не переносить `src/templates/projects`, не переименовывать сервисы ради красоты.
8. Никаких «lite»-версий sprite editor или uikit forge.
9. Никакого FSA-discovery и LNA.
10. Setup только для `codex` и `claude`.
11. Не выпускать `@pix3/agent-bridge`, не держать collab в `essential`.
12. Никакого онбординга, кроме одной setup-строки.
13. Не коммитить в `full`, кроме security-фиксов collab-сервера (A.3).
14. Не делать carve-out на `main` до решения P4.

## G. Журнал ревью

| Замечание ревью | Решение | Где изменено |
|---|---|---|
| R1 P2 вне критического пути, ветка `essential` | принято | §0, A.2, D |
| R2 хост живёт столько же, сколько вкладка; grace; замер в S1 | принято (grace 10 мин, offline-журнал) | C.2, S1, F.2 |
| R3 пропущенные швы (atlas, EditorTab, image-gen ×3, lightbox, ProjectService, status-bar, game-tab, срезы, agent-kit в lifecycle) | принято, пересчитано ~35 файлов | B.2, P2 |
| R3 chroma-key — регрессия качества | принято | B.2, P1, E |
| R4 браузерный гейт | принято | P2 |
| R5 `--tag next`, `workflow_dispatch` только из ветки по умолчанию, противоречие A.2 и F.13 | принято | A.3, F.13 |
| R6 перенос знания агента в kit | принято, в P1 | C.5 |
| R7 `~/.claude.json` не трогать, TOML на Windows, PATH и TS, stdout, Windows-спайк | принято | C.1, C.2, S12 |
| R8 ключ по `workspaceId`, origin от `Host`, лимит `tokens[]` | принято (`workspaceId` из meta) | C.3, C.4 |
| R9 skills, поправка к внешнему плану | принято | A.3, шапка |
| R10 `editor.pix3.dev` и OPFS | принято: сайт остаётся, миграция через Move Project to Folder | P4 |
| R11 Spine в пакете | принято: исключён из hosted-сборки, плюс NOTICES | C.3 |
| R12 layout не сохраняется, сохраняются `projectTabs`; замена home | принято | B.2 |
| R13 сроки | принято: P1 10–12, P2 8–10 | D |
| Рек. 1 цена B завышена, DeepCore из npm | принято | A.1 |
| Рек. 2 «запечь» hints | принято. `game_controls`/`game_time` отклонены до доказательства в C1: растёт поверхность | B.3, F.5 |
| Рек. 3 uikit в LABS | принято | B.1, B.4 |
| Рек. 4 ключи на сервере CLI, встроенная генерация Codex | принято | C.3, S13 |
| Рек. 5 ONNX вне P1-сборки, один путь вывода | принято | C.3 |
| Рек. 6 портативный Node | принято | C.1, S3 |
| Рек. 7 фактические часы Unity, состав ролей, второй незнакомец, Codex основным | принято | P3, C.1 |
| Рек. 8 чистое дерево | принято | A.3 |
| Вопросы владельцу (§5 ревью) | решены в плане: ветка `essential`; grace да; FSA и OPFS остаются без вложений; Monaco в ядре (точный инструмент, `.pix3anim` как YAML); сайт остаётся; Spine исключён; ключи на CLI; метрика — «без программиста». Igor может переиграть любое | A.2, B.1, C.2, C.3, P3, P4 |
