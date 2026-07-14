# Встроенный AI-агент в редакторе (чат-панель, BYOK)

**Статус:** Все 4 фазы реализованы (2026-07-12) — A (LLM-провайдеры), B (тул-слой), C (AgentChatService + чат-панель + интеграция таба), D (полировка: скриншот-тул, generate_asset, selection-контекст, markdown, LLM-секция в настройках). Смоук в живом редакторе пройден (таб Agent, error-path без ключа, персист через reload, viewport_screenshot даёт непустой jpeg, generate_asset без ключа = friendly error, LLM-секция в Settings→AI). E2E с реальным ключом выполнен многократно в ходе agent-eval прогонов S1–S4 (2026-07-13/14, см. [agent-eval-results.md](../agent-eval-results.md)) — план закрыт, перенесён в done/ 2026-07-14. Дальнейшее развитие агента — в [agent-game-harness.md](../agent-game-harness.md). **Оценка:** L (разбит на 4 фазы, каждая шипуема отдельно).

## Отклонения от плана при реализации (фазы A + B)

- **`chat()` не отвергает неизвестный `modelId`** (в отличие от image-провайдеров, которые бросают `unknown`). Причина: OpenAI-совместимый провайдер обязан принимать произвольные имена локальных моделей (Ollama/LM Studio), а новые model-id не должны требовать правки кода. Провайдеры прокидывают `ctx.modelId` как есть и отвергают только *пустой* id. Anthropic сверяется со своим списком лишь чтобы подобрать дефолтный `max_tokens`, а не чтобы отклонить.
- **`LlmToolResultBlock` несёт опциональный `toolName`** (не был в списке блоков плана). У Gemini `functionResponse` матчится по *имени функции*, а не по id (на проводе id вызовов нет). Провайдер Gemini резолвит имя из `toolName`, а при его отсутствии — из tool-use блоков диалога (`collectToolNames`). Anthropic/OpenAI матчат по `toolUseId`.
- **fs-тулы не бампают `fileRefreshSignal` сами.** `ProjectStorageService.writeTextFile/deleteEntry` уже бампают его внутри (`applyAssetMutationSignal`), поэтому «переиспользование того же пути» из плана = просто вызов этих методов; прямой мутации `appState` нет.
- **`installErrorCapture` вынесен в общий модуль и сделан идемпотентным** (guard-флаг + `typeof window`-guard). `AgentToolRegistry` вызывает его в конструкторе, так error-capture работает и в проде, когда агент используется. Поведение `debug-bridge` (dev-only) не изменилось — он реэкспортирует всё из `agent-introspection` и его `window.__PIX3_DEBUG__` контракт прежний.
- **OpenAI-compat отвергает пустой ключ только для хостед-OpenAI** (`https://api.openai.com/v1`); кастомный/локальный base URL может быть без ключа (Ollama/LM Studio) — при пустом ключе заголовок `Authorization` не отправляется.
- **`run_command` whitelist — префиксный allow-список** (`scene./properties./selection./alignment./history./viewport./game.`) по MVP-эвристике плана §5. Замечание: часть команд редактора живёт под `scene.` независимо от feature-каталога (напр. правка свойств — `scene.update-object-property`), поэтому набор префиксов намеренно широкий внутри этих неймспейсов и отказывает всему остальному (диалоги/пикеры: `project.open`, `editor.*` и т.п.).
- **Стриминг (`onDelta`)** заложен в типах, но провайдеры возвращают ответ целиком (без SSE) — как допускает план.
- Списки моделей минимальны/иллюстративны; дефолт Anthropic — `claude-opus-4-8` (по скиллу claude-api).

## Отклонения от плана при реализации (фаза C)

- **Ключи/провайдер настраиваются в шапке самой панели** (селектор + key-popover + baseUrl для OpenAI-compat), `pix3-editor-settings-dialog` не расширялся — секцию LLM-ключей в общих настройках делать в фазе D, если понадобится.
- **Enter отправляет, Shift+Enter — перенос** (чат-конвенция вместо Ctrl+Enter из Asset Generator).
- **Ответы рендерятся plain-text** (pre-wrap); markdown — фаза D (план это допускал).
- **Лимит итераций** показывается notice-баннером со статусом `idle` (не error) — продолжение следующим сообщением.
- Хоткей `Mod+Shift+A` (проверен на отсутствие конфликтов); Gemini tool-use id теперь монотонный счётчик на инстансе провайдера (фикс коллизии между ходами, найден на ревью фаз A+B).

## Отклонения / решения при реализации (фаза D)

- **Мультимодальная доставка картинок через `AGENT_TOOL_IMAGES_KEY` (`__images`).** Тул-хендлер кладёт картинки в это зарезервированное поле возврата; `AgentChatService` вынимает их из JSON tool-result и добавляет в тот же user-ход настоящими `image`-блоками (модель видит пиксели, а не base64). JSON-часть результата при этом чистится от base64, чтобы не раздувать контекст.
- **`viewport_screenshot` снимает канвас редактора (edit-mode), не запущенную игру.** Захват — синхронный `renderFrame()` + `drawImage` в том же таске: `preserveDrawingBuffer` выключен, буфер не переживает композитинг. Точка захвата — `ViewportRenderService.captureScreenshot()` (jpeg q0.85, downscale до maxSize, дефолт 1024). Игровой канвас (SceneRunner/RuntimeRenderer в отдельном хосте) в MVP не снимается — если понадобится, добавить отдельный путь через `GamePlaySessionService`.
- **`generate_asset` — тонкая обёртка над `AssetGenService`** (генерация с ключом image-провайдера + save в проект + 256px-превью как image-блок; handle всегда `discard` в finally). Гейт: `status().keyConfigured` → без ключа friendly-error, без вызова API.
- **Markdown — свой мини-рендерер `markdown-lite.ts`** (не зависимость). Только lit-шаблоны, ни одного `innerHTML` — текст модели не может инжектить разметку; ссылки только http/https. Поддержка: заголовки, списки, fenced-code, inline code/bold/italic/links.
- **LLM-провайдер продублирован в Settings→AI** (секция «Agent (LLM) Provider», первой) в дополнение к шапке панели — общий вход для ключей рядом с image-провайдерами.
- **`window.__PIX3_DEBUG__.agentTools`** (dev-only) — `list()`/`execute(name,args)` поверх того же `AgentToolRegistry`; использовалось для смоука фазы D и пригодится для E2E.
- **Пост-фикс UX (2026-07-12):** первый вариант селектора модели был `<input list=datalist>` — datalist фильтрует опции по текущему значению, поэтому при уже выбранной модели показывал единственное совпадение (выглядело как тултип, выбор не работал). Заменён на настоящий `<select>` со списком моделей провайдера + опция «Custom…» (только для `requiresBaseUrl`-провайдеров, OpenAI-compat/локальные), раскрывающая текстовый ввод произвольного id. Исправлено и в панели, и в Settings→AI. Проверено в живом редакторе.
- **Пост-фикс layout (2026-07-12):** по просьбе — контролы провайдер/модель/ключ перенесены из верхней шапки в тулбар **под полем ввода** (как в приложении Claude). Верхнего `.agent-header` больше нет; композер вертикальный (textarea → toolbar с провайдером/моделью/ключом слева, usage/New chat/Send справа). Key-popover открывается вверх (`bottom: 100%`). Проверено в живом редакторе.
- **Пост-фикс Gemini schema (2026-07-12):** Gemini function-calling принимает только подмножество OpenAPI-схемы и отвечает 400 на `additionalProperties` (есть в каждом тул-inputSchema; Anthropic/OpenAI его принимают). Добавлен `sanitizeGeminiSchema` в `GeminiLlmProvider.buildBody` — рекурсивно вырезает `additionalProperties`/`$schema`/`$ref`/`definitions`/`patternProperties` из `parameters`. Тул-дефиниции общие для всех провайдеров, чистка только на границе Gemini. Покрыто юнит-тестом (вложенная схема).
- **Пост-фикс Gemini thought signatures (2026-07-12):** Gemini прикрепляет `thoughtSignature` к `functionCall`-части и требует эхо-возврата при реплее хода (иначе warning + деградация tool-качества). Добавлено опциональное `LlmToolUseBlock.signature` (провайдер-агностично, персистится в истории); `GeminiLlmProvider` захватывает его с части при парсинге и возвращает на `functionCall`-часть при сериализации. Anthropic/OpenAI поле игнорируют. Покрыто round-trip тестом.
- **Цена в дропдауне модели (2026-07-12):** `LlmModel.pricing?` (USD за 1M in/out) + хелпер `formatPricingHint`; опция дропдауна рендерит `Label · $in / $out per 1M`. Заполнено только для провайдеров со стабильным прайсингом — Gemini (2.5 Flash/Pro/Flash-Lite) и Anthropic (Opus 4.8 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5, из скилла claude-api). OpenAI-совместимый — без цен (локальные бесплатны, hosted-модель вводится вручную). Цены иллюстративные (дрейфуют). Проверено в живом редакторе (панель + Settings→AI).
- **Пост-фикс Gemini модели (2026-07-12):** `gemini-2.5-flash`/`-pro` больше не доступны новым API-ключам. Список Gemini заменён на `gemini-flash-latest` (дефолт) / `gemini-pro-latest` / `gemini-2.5-flash-lite` — `*-latest`-алиасы трекают текущие стабильные модели. Плюс `AgentSettingsService.getSelectedModelId` теперь для провайдеров с фиксированным списком (не `requiresBaseUrl`) откатывает сохранённый, но отсутствующий в списке id на первую модель — чтобы устаревшая persist-запись не продолжала слать мёртвый id (OpenAI-compat по-прежнему пропускает любые кастомные id). Покрыто тестом.

**Цель:** чат с агентом прямо в редакторе — пользователь подключает свой API-ключ (Gemini / Anthropic / OpenAI-совместимый endpoint, включая локальные модели) и получает агента, который читает/правит скрипты и ассеты, инспектирует сцену, мутирует её через command gateway (= undo/redo), запускает play mode и верифицирует результат. Работает для всех трёх backend'ов проекта (local / browser-OPFS / cloud), целиком client-side.

Базис верификации: рабочее дерево на 2026-07-12, ссылки на строки проверены по исходникам.

---

## 0. Отклонённая альтернатива (зафиксировать, не возвращаться)

**Remote-fs через preview-relay** (агентский HTTP API `fs-read/write/list` → collab server → WS → хост-редактор → `ProjectStorageService`) — **отклонено**. Аудитория «внешний CLI-агент + принципиально нет папки проекта» практически пуста: пользователь, которому нужна тяжёлая артиллерия (Claude Code), повышает browser-проект через уже существующий **Move to Folder** (`MoveProjectToFolderCommand`) и получает нативную работу агента в папке + весь remote-preview стек с `.pix3/preview-session.json`. Headless-доступ к cloud-проектам (CI) — отдельная Phase-2 история напрямую к серверному хранилищу с настоящей auth, не через relay на открытый редактор.

## 1. Ключевые решения

1. **Всё client-side, BYOK.** Ключи — в `SecretStorageService` (шифрованное хранилище, паттерн Asset Generator), вызовы провайдеров — напрямую из браузера. Никакой серверной зависимости: работает даже для анонимного browser-проекта. Проксирование через collab-сервер (скрыть ключ, серверный биллинг) — Phase 2.
2. **Мутации сцены — только через `CommandDispatcher`.** Агентские правки попадают в undo/redo — главное преимущество перед внешним агентом. Файловые записи (скрипты/ассеты) идут через `ProjectStorageService` + бамп `fileRefreshSignal` — как «внешние изменения», ровно как сейчас при агенте в локальной папке. Gateway не нарушается.
3. **Каталог тулов — это существующий debug-bridge, переехавший в прод.** `src/core/debug-bridge.ts` уже содержит выверенные JSON-safe DTO (scene/node/find/selection/liveScene/components/errors/play/setProperty/command + assets.*). Bridge dev-only; переиспользуемую интроспекцию выносим в отдельный модуль, bridge и агент импортируют её оба.
4. **Провайдерский слой — по образцу image-gen.** `ImageGenProvider`/`ImageGenProviderRegistry`/`AiImageSettingsService` ([ImageGenTypes.ts](../src/services/image-gen/ImageGenTypes.ts), [AiImageSettingsService.ts](../src/services/AiImageSettingsService.ts)) — проверенный шаблон: registry + типизированные capabilities + ключи по `apiKeySecretId` + не-секретные prefs в localStorage. Копируем структуру, не абстрагируем поверх обоих (image и LLM API слишком разные).
5. **Чат — это editor tab** (как asset-generator: не входит в layout по умолчанию, открывается командой). Паттерн: `EditorTabService.ts:256-266` (`'asset-generator'`, URI `asset-generator://new`) + `LayoutManager.ts:27,46` (component type → тег элемента) + исключения из save/restore-логики (`EditorTabService.ts:102,113,358`).
6. **Один активный диалог на проект, in-memory + сериализация в IndexedDB** (история переживает reload, но без веток/множественных чатов в MVP).

## 2. Архитектура (4 слоя = 4 фазы)

```
pix3-agent-chat-panel (Lit, editor tab)
        │
AgentChatService  ── agentic loop: LLM ⇄ tool calls, стриминг, отмена, лимиты
        │                │
LlmProviderRegistry      AgentToolRegistry ── JSON-schema дефиниции + хендлеры
 (Gemini/Anthropic/           │
  OpenAI-compatible)     существующие сервисы: introspection (из debug-bridge),
        │                CommandDispatcher, ProjectStorageService,
SecretStorageService     ScriptCompilerService, LoggingService, play-команды
```

### Фаза A — LLM-провайдерский слой (M)

Новая папка `src/services/llm/`:

| Файл | Что |
| --- | --- |
| `LlmTypes.ts` | `LlmProvider` (id, label, models[], `apiKeySecretId`, `chat(params, ctx)`), `ChatParams` (messages, tools, system, signal, onDelta), контент-блоки text/image/tool-use/tool-result, `LlmError` c kind (по образцу `ImageGenError`) |
| `GeminiLlmProvider.ts` | `generateContent` + function calling; CORS открыт (паттерн вызова уже есть в `GeminiImageProvider.ts`) |
| `AnthropicLlmProvider.ts` | Messages API + заголовок `anthropic-dangerous-direct-browser-access: true` |
| `OpenAICompatLlmProvider.ts` | Chat Completions c **настраиваемым base URL** — одной опцией покрывает OpenAI, Ollama (`OLLAMA_ORIGINS`), LM Studio; URL хранится в prefs |
| `LlmProviderRegistry.ts` | по образцу `ImageGenProviderRegistry` |
| `AgentSettingsService.ts` | по образцу `AiImageSettingsService.ts:43`: prefs в localStorage (`pix3.agentSettings:v1`: selectedProviderId, modelByProvider, customBaseUrl, maxToolIterations), ключи делегируются `SecretStorageService` |

Стриминг: SSE у всех трёх; MVP допустим и без стриминга (ответ целиком), но интерфейс `onDelta` заложить сразу.

### Фаза B — тул-слой (M)

1. **Вынос из debug-bridge:** `safeSerialize`, `nodeToDTO`, `componentToDTO`, `liveObjectToDTO`, error-ring-buffer (`installErrorCapture`) из [debug-bridge.ts](../src/core/debug-bridge.ts) → `src/core/agent-introspection.ts` (прод-модуль без dev-гейта). Bridge реэкспортирует/импортирует оттуда — его поведение не меняется, `main.ts` продолжает грузить его только в DEV. Error-capture теперь ставится и в проде (дёшево, ring buffer 200 записей).
2. **`src/services/agent/AgentToolRegistry.ts`** — дефиниции `{name, description, inputSchema (JSON Schema), handler}`; хендлеры возвращают JSON-safe значения (готовые DTO из п.1). Набор MVP:

| Тул | Реализация |
| --- | --- |
| `scene_tree(maxDepth)`, `node_inspect(nodeId)`, `find_nodes(text)`, `get_selection` | introspection-модуль (готово) |
| `set_property({nodeId,propertyPath,value})` | `UpdateObjectPropertyCommand` — undoable, hot-reload в play mode (как в bridge:679) |
| `run_command(commandId)` | `CommandDispatcher.executeById`; **whitelist по metadata** — только команды без диалогов/пикеров (см. §5 Безопасность) |
| `list_commands()` | из `CommandRegistry` (метаданные уже есть — id, title, menuPath) |
| `fs_list(path)`, `fs_read(path)`, `fs_write(path, content)`, `fs_delete(path)` | `ProjectStorageService.listDirectory/readTextFile/writeTextFile/deleteEntry`; после мутаций — бамп `fileRefreshSignal`; запрет `..` (паттерн `PreviewHostService.handleFileRequest:396`); `fs_read` бинарных файлов — метаданные вместо контента |
| `compile_scripts()` | `ScriptCompilerService.bundle` ([ScriptCompilerService.ts:123](../src/services/ScriptCompilerService.ts#L123)) по механике сбора файлов из `PreviewHostService.collectScriptFiles:597` — синтаксическая проверка правок агента до запуска |
| `play_start / play_stop / play_restart / play_status` | команды `game.start/stop/restart` + `appState.ui` (как bridge:661-677) |
| `read_logs(since?)` | `LoggingService` (реюз данных logs-панели) |
| `read_errors()` | error-ring-buffer из introspection-модуля |
| `viewport_screenshot()` | канвас вьюпорта/игры → downscale → image-блок в диалог (все три провайдера мультимодальны). Точку захвата уточнить при реализации: viewport-канвас у `ViewportRenderService`; game-превью — same-origin iframe (SW), канвас достижим |
| `generate_asset(...)` | тонкая обёртка над `AssetGenService.generate/save` (headless-пайплайн уже есть, bridge:703-749) — агент сможет и картинки делать, если у пользователя настроен image-ключ |

### Фаза C — цикл и UI (L)

**`src/services/agent/AgentChatService.ts`:**

- Состояние диалога (messages, running/idle, текущий tool-call), подписка для UI.
- Loop: system prompt + история + тулы → провайдер → пока в ответе tool-use: выполнить хендлер, добавить tool-result, повторить. Лимит итераций из prefs (default ~25), `AbortController` на кнопку Stop.
- System prompt: краткие правила + контекст проекта (manifest, список сцен, активная сцена, дерево до depth 2) — собирается на каждый запрос, не кэшируется. Digest каталога нод — bundled `?raw`-импортом выжимки из `docs/nodes-and-systems.md` (Phase 2, если промпт окажется слаб).
- Персист истории в IndexedDB по `projectSessionId`.
- **Undo-семантика:** каждый выполненный командный тул ложится в history отдельной операцией (MVP). Батчинг «один ход агента = одна undo-группа» — Phase 2 (потребует transaction API в `HistoryManager` — не изобретать сейчас).

**UI `src/ui/agent-chat/pix3-agent-chat-panel.ts` (+ `.ts.css`):**

- Лента сообщений (markdown-рендер ответов — лёгкая зависимость типа `marked` + sanitize, либо честный plain-text в MVP), collapsible-блоки tool-call'ов (имя, аргументы, результат), стриминг-индикатор, Stop, «новый диалог».
- Селектор провайдера/модели + key-popover — реюз паттерна из asset-generator-panel / `pix3-editor-settings-dialog.ts` (там уже есть секция API-ключей image-провайдеров — добавить рядом LLM-ключи).
- Пустое состояние: onboarding-подсказка «подключи ключ» + ссылки, где взять (`apiKeyHelpUrl`).

**Интеграция:** tab type `'agent-chat'` в `EditorTabService` (по всем точкам, где перечислен `'asset-generator'`: `:102,113,256,265,358`), component type в `LayoutManager.ts:27,46,565`, команда `agent.open-chat` (`menuPath` — рядом с Asset Generator, shortcut например `Ctrl+Shift+A`) в `src/features/editor/`.

### Фаза D — полировка (S, после обкатки)

Скриншот-в-диалог по кнопке пользователя; передача текущего selection в контекст; «примени к выделенному»; счётчик токенов/стоимости из usage-ответов провайдера.

## 3. CORS-матрица (задокументировать в спецификации)

| Провайдер | Из браузера | Примечание |
| --- | --- | --- |
| Gemini | да | уже используется Asset Generator'ом |
| Anthropic | да | нужен `anthropic-dangerous-direct-browser-access: true` |
| OpenAI | да | официально допускает browser-вызовы (ключ у пользователя — риск принят, BYOK) |
| Ollama / LM Studio | да, после настройки | пользователь выставляет `OLLAMA_ORIGINS` / включает CORS в LM Studio — дать инструкцию в UI ошибки network |

## 4. Тесты

- `LlmProviderRegistry` / `AgentSettingsService` — юниты по образцу image-gen спеков (`OpenAIImageProvider.spec.ts` — мок fetch).
- Провайдеры: маппинг messages/tools → wire-формат и обратно (tool-use парсинг) на фикстурах ответов — по одному спеку на провайдера.
- `AgentToolRegistry`: fs-тулы на фейковых handle (паттерн `FileSystemAPIService.spec.ts`), запрет `..`, бамп `fileRefreshSignal`; интроспекция — на фикстурном scene graph.
- `AgentChatService`: loop с мок-провайдером (tool-use → result → финальный текст), лимит итераций, abort.
- Помнить: pre-existing ~32 tsc-ошибки, спека `UpdateCheckService`, CRLF-флуд в lint — не свои.

## 5. Безопасность / ограничения

- `run_command` — whitelist: исключить команды, открывающие диалоги/пикеры (`project.open`, move-to-folder и т.п.) и деструктивные без подтверждения. MVP-эвристика: явный allow-список категорий (scene/properties/selection/alignment/history/viewport + game.*), остальное — отказ с пояснением.
- fs-тулы заперты в корне проекта самим `ProjectStorageService` + явный запрет `..`.
- Никакого `eval`/произвольного JS-тула в MVP. Скрипты агент пишет файлами — исполняются они только в play mode, как любые пользовательские.
- Ключи не логировать; в system prompt не включать секреты.

## 6. Вне скоупа (Phase 2+)

- Прокси LLM через collab-сервер (серверный ключ, биллинг, cloud-проекты без BYOK).
- Headless-доступ к cloud-хранилищу для CI-агентов (настоящая auth, мимо редактора).
- MCP-сервер редактора поверх того же `AgentToolRegistry` (заменит ручной `__PIX3_DEBUG__`-workflow через chrome-devtools).
- Undo-батчинг «ход агента = одна группа», мульти-чаты/ветки, RAG по docs.
- Автономные длинные задачи (пока: один запрос — один ограниченный loop).

## 7. Ручная верификация

1. Browser-проект (OPFS, без аккаунта): подключить Gemini-ключ → «создай скрипт вращения и повесь на куб» → агент пишет файл в `scripts/`, `compile_scripts` зелёный, компонент присоединён через команды, play mode — куб крутится, Ctrl+Z откатывает присоединение.
2. `fs_write` скрипта при открытой вкладке кода → вкладка подхватывает изменение через `fileRefreshSignal`.
3. Anthropic и Ollama (LM Studio) как провайдеры — happy path + понятная ошибка CORS с инструкцией.
4. Reload страницы → история чата на месте (IndexedDB), ключ не спрашивается заново.
5. Stop посреди tool-loop — цикл останавливается, состояние консистентно.
