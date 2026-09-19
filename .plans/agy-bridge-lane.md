# Локальные агенты в мосте: Antigravity CLI (`agy`) как первая лана

Мост `tools/pix3-agent-bridge` умеет сегодня ровно одну локальную лану — Claude Code через
Agent SDK (`sessions.ts`) — плюс credential-injecting прокси к метрованным провайдерам. Этот план
добавляет **вторую локальную лану: Antigravity CLI (`agy`)**, чтобы редактор получал провайдера на
подписке, которую пользователь уже оплатил, с нулевой маржинальной стоимостью.

Референс подхода — [`nexu-io/open-design`](https://github.com/nexu-io/open-design) (Apache-2.0,
можно копировать с атрибуцией): `apps/daemon/src/runtimes/` + `apps/daemon/src/agent-protocol/`.
Они не используют вендорные SDK — гоняют **установленные CLI-бинари** как подпроцессы по
декларативному описанию `RuntimeAgentDef`, с общим конвейером «резолв бинаря → version-проба →
capability-проба → auth-проба → список моделей → спавн → нормализация стрима». 27 агентов в поставке.

Claude-лану переделывать под этот шаблон **не будем** — она работает. Берём из референса
инфраструктуру и заводим на ней `agy`.

---

## 1. Замеры `agy` 1.1.27 (сняты живьём, 2026-09-17)

Бинарь: `C:\Users\igor\AppData\Local\agy\bin\agy` — **не в PATH**. OAuth-логин, конфиг в `~/.gemini/`.

Флаги, которые нам нужны (`agy --help`):

| Флаг | Роль в плане |
| --- | --- |
| `--model <id>` | модель на процесс |
| `--effort low\|medium\|high` | маппится на наш reasoning-effort picker |
| `--output-format text\|json\|stream-json` | структурированный вывод |
| `--input-format text\|stream-json` | NDJSON по строке на turn из stdin; требует `--output-format stream-json` |
| `-c` / `--continue`, `--conversation <id>` | resume; `--conversation` = capture-style handle |
| `--log-file <path>` | пост-мортем тихих падений; ставить **до** `-p` |
| `--mode accept-edits\|plan`, `--agent`, `--json-schema` | заборы и структурный вывод |
| `agy models`, `agy mcp add\|list\|…` | программный каталог моделей и регистрация MCP |

`agy models` — живой список (id `\t` label): `gemini-3.8-flash-{high,medium,low}`,
`gemini-3.7-flash-{…}`, `gemini-3.6-flash-{…}`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

Форма `--output-format stream-json` — **своя схема, ни Anthropic, ни Claude Code**:

```
{"event":"init","conversation_id":"<uuid>","init":{model,cwd,tools:[~50 имён],permission_mode}}
{"event":"step_update","step_update":{conversation_id,step_index,state:"DONE",step_type:"user_input"}}
{"event":"step_update","step_update":{…,step_type:"agent_response",text_delta:"hi\n",
      duration_seconds,usage:{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}}}
{"event":"result","result":{conversation_id,status:"SUCCESS",response,num_turns,duration_seconds,usage}}
```

`usage` есть и по шагу, и итоговый, включая `cache_read_tokens`. `conversation_id` приходит в `init`
— значит resume у нас **capture-style**.

`init.tools` перечисляет ~50 **собственных** тулов agy: `run_command`, `write_to_file`,
`replace_file_content`, `grep_search`, `list_dir`, `browser_*` (click/dom/network/js/screenshot),
`generate_image`, `define_subagent`/`invoke_subagent`, `call_mcp_tool`, `finish`, …

### Декларацию open-design для agy копировать нельзя

`apps/daemon/src/runtimes/defs/antigravity.ts` писан под 1.0.3–1.1.13, где не было `--model`, и
поэтому обходит это записью модели в `~/.gemini/antigravity-cli/settings.json` с **глобальной
lock-chain на все спавны** и поллингом `--log-file` на строку
`Propagating selected model override to backend`. Плюс 8 статических label-ов вместо `agy models` и
`streamFormat: 'plain'`. В 1.1.27 всё это мёртвый код. Образец для формы декларации — их
`defs/claude.ts`; из их agy-def берём только идею «лог-файл на сессию для пост-мортема».

---

## 2. Центральное решение: почему только MCP-relay

Наша Claude-лана работает не потому, что SDK «отдаёт `tool_use` наружу», а потому что у неё есть
**точка останова**: хендлер `CallTool` in-process MCP-сервера блокируется (`onToolCall` → `pending`),
пока редактор не пришлёт `tool_result`. Вся эвристика `tryAssignAndFlush`/`orphanResults`/
`unparkedBlocks`/`seenToolUseIds` в `sessions.ts` — это борьба с тем, что SDK эмитит один и тот же
вызов дважды (блок + MCP).

У `agy` точка останова ровно одна — **MCP-сервер, к которому он подключился сам**: пока `tools/call`
не ответил, шаг висит. Отсюда:

- **Трансляция стрима в `tool_use` (вариант B) невозможна в принципе.** `step_update` — уже
  свершившиеся факты; agy не приостанавливается на своих тулах и вставить `tool_result` некуда.
  «Рендер-половина» B (текст/usage/внутренние шаги → блоки нашего wire) нужна в любом случае.
- **MCP-relay (вариант A) — единственный канал для редакторских тулов**, и он ложится на
  существующий паттерн **проще**, чем в SDK-лане: параллельного `tool_use`-блока нет, MCP-вызов и
  есть единственный сигнал → минтим `toolu_…` сами, паркуем, отвечаем `stop_reason: 'tool_use'`.
  Сопоставления по name+input не нужно.
- **Текстовая лана без тулов (вариант C) — не альтернатива, а фаза 1** и самостоятельная ценность:
  роль `advisor` в редакторе текстовая по определению (`LlmModelRole = 'advisor'`), так что
  Gemini 3.1 Pro / `claude-opus-4-6-thinking` через agy как бесплатный второй-мнения-советник
  работает без relay. Для роли `main` без тулов бесполезен. `vision` — нет: флага для изображений
  у agy нет, `supportsImages: false`.
- Отвергнуто: «дать agy править файлы самому» — ломает инвариант моста «процесс моста никогда не
  трогает FS/shell/web от имени модели» (шапка `index.ts`), а проект редактора всё равно не лежит
  у agy на диске.

**Итог: A как канал тулов, поверх существующей инверсии «блокирующий CallTool → ответ с `tool_use`»;
поставка фазами, где фаза 1 = C.** agy остаётся хозяином своего цикла (свои тулы, свой контекст,
свой resume), редактор видит стандартный Anthropic-wire, pix3-тулы исполняются в браузере как сейчас.

### Что видит редактор

Редактор не стримит (`onDelta` в `AgentChatService` объявлен и не потребляется), так что на один
`POST …/messages` — одна assistant-message:

- **Граница `tool_use`**: agy позвал pix3-тул → `{content:[…text-блоки внутренних шагов…,
  {type:'tool_use', id:'toolu_<uuid>', name, input}], stop_reason:'tool_use'}`. Если к приходу
  следующего запроса накопилось несколько MCP-вызовов — все в одном ответе (та же логика
  «одного припаркованного достаточно» + буфер, что сейчас).
- **Граница `end_turn`**: `{event:'result', status:'SUCCESS'}` → `content:[{type:'text', …}]`,
  usage смаплен: `input_tokens`, `output_tokens` (+`thinking_tokens`),
  `cache_read_input_tokens ← cache_read_tokens`.
- **Внутренние шаги agy** (его `run_command`, `view_file`, браузер) — короткие `text`-блоки с
  маркером (`[agy] view_file …`), чтобы пользователь видел, что agy делал на диске.
- Все loop-breaker'ы редактора (повторы, verify-gate, nudges, `maxToolIterations`) продолжают
  работать: они смотрят на пары `tool_use`/`tool_result`, которые мы и отдаём.

### Привязка MCP-вызова к сессии: stdio-shim, а не прямой HTTP

Прямой `agy mcp add -t http pix3 http://127.0.0.1:8484/mcp` даёт две проблемы:

1. **Токен.** `-H 'x-pix3-…: …'` пишет секрет в `~/.gemini/config/mcp_config.json` — второй
   plaintext-файл, права не наши, может синкаться Antigravity IDE.
2. **Кто звонит.** N процессов agy стучатся в один URL, и `tools/call` приходит без признака
   сессии. Тайминг-корреляция ненадёжна: agy может подключаться лениво.

**Решение — stdio-shim.** Регистрируем `agy mcp add -t stdio pix3 node ~/.pix3/agy-mcp-shim.mjs`.
agy спавнит shim ребёнком → shim **наследует env agy**, а env мы задаём на каждый спавн
(`PIX3_BRIDGE_SESSION=<id>`, `PIX3_BRIDGE_MCP_URL`, `PIX3_BRIDGE_MCP_TOKEN`). Shim — ~100 строк без
зависимостей: NDJSON JSON-RPC со stdin → `POST /agents/agy/mcp/:sessionId` → ответы в stdout. На
стороне моста — per-session `Server` из `@modelcontextprotocol/sdk` с in-memory транспортом (та же
идея, что `type:'sdk'` в SDK-лане), тулы из запроса редактора. Путь shim стабилен, в отличие от
npx-кэша; мост перезаписывает файл при `agy setup`/старте, если встроенная версия отличается.

Отдельный **`mcpToken`** в `agent-bridge.json` (не pairing-token): утечка не тратит ни ключи
провайдеров, ни MAX. MCP-маршрут **отвергает любой запрос с заголовком `Origin`** (браузер туда
доходить не должен; рекомендация MCP-спеки против DNS-rebinding), Host-проверка общая.

Прямой HTTP остаётся фолбэком, **если** проба 0(d) покажет, что agy раскрывает `${VAR}` в `-H`
(как Claude Code в `.mcp.json`) — тогда `-H "x-pix3-session: ${PIX3_BRIDGE_SESSION}"` даёт тот же
per-session routing без shim.

### Системный промпт

У agy нет `--system-prompt`. cwd каждой сессии — одноразовый каталог
`~/.pix3/agy-workspaces/<session>/`; перед спавном пишем туда стабильную голову системного промпта
редактора как `AGENTS.md` (или `GEMINI.md` — проба 0(h)), волатильный хвост (контекст сцены) — в
user-сообщение через существующие `trackSystemDrift`/`<context-refresh>`. Голова должна прямо
говорить: «ты внутри редактора Pix3, проект не на этом диске, не используй файловые/терминальные/
браузерные тулы — только тулы сервера `pix3`».

---

## 3. Что берём из open-design

Apache-2.0 → атрибуция в README моста и в шапке файла-получателя.

| Берём | Донор | Что именно |
| --- | --- | --- |
| Резолв бинаря вне PATH | `runtimes/executables.ts` | `resolveAllOnPath` с `PATHEXT` (все совпадения, не первое), `executableFilePath` (Windows — проверка расширения, POSIX — `X_OK`), паттерн `*_BIN`-override → `PIX3_AGY_BIN`. Список well-known dirs свой: `%LOCALAPPDATA%\agy\bin`, `~/.local/bin`, `~/.agy/bin`, `/usr/local/bin`, `/opt/homebrew/bin`. Не берём codex-bundle, AMR, `rememberUnusableExecutable`. |
| Гигиена пробов | `runtimes/invocation.ts` | `cwd: os.tmpdir()` (их `opencode models` сделал `bun install` в рабочую копию и снёс pnpm-стор), `killSignal:'SIGKILL'` (у `execFile` `timeout` только **сигналит**, промис ждёт `close` → CLI с перехватом SIGTERM вешает проб навсегда), `maxBuffer`. `createCommandInvocation` не берём — agy нативный exe. |
| PATH дочернего процесса | `runtimes/launch.ts` | `applyAgentLaunchEnv`: регистронезависимый ключ `Path` на Windows, prepend `dirname(process.execPath)` (shim = `node …`, и `npx` внутри agy тоже хочет node) + каталог agy. |
| Поток детекции | `runtimes/detection.ts` (`probe`, ~560–790) | Порядок «version-проба гейтит доступность → параллельно models + auth → `{available,path,version,authStatus,diagnostics}`»; fault isolation (`detectAgent` catch → unavailable, discovery не падает); `versionPolicy.supportedVersionPattern` (`^1\.1\.\d+$`) → warning «непроверенная версия». `capabilityFlags`/`hiddenCapabilityFlags` **не берём** — в 1.1.27 все нужные флаги есть (вернём, если решим держать старые сборки). |
| `authProbe` | `runtimes/types.ts` (поле) + `runtimes/auth.ts` | У agy нет `auth status` → проба = `agy models` (требует бэкенда) + дешёвая pre-проверка наличия `~/.gemini/oauth_creds.json` без спавна. Квота-регексы `RESOURCE_EXHAUSTED\|Individual quota reached\|429`. Тексты подсказок адаптировать: у нас есть `--model`, совет «переключи модель в TUI» не нужен. |
| Диагностика | `runtimes/diagnostics.ts` | Форма `{reason,severity,message,detail}`. `fixActions` не берём — нет UI. |
| Таксономия resume | `runtimes/types.ts` (комментарии к `resumesSessionViaCli`, `capturesSessionIdFromStream`, `hasPriorAssistantTurn`) | Как словарь решений: agy — capture-style с CLI-resume; на resume шлём **только последний user-turn**, иначе двойной контекст (ровно их баг с повторной эмиссией `<question-form>`). Их парсеры стримов не берём — другие схемы. |
| Не берём вовсе | `plain-stream.ts`, `models.ts`, `registry.ts`, весь `agent-protocol/` (ACP, pi-rpc) | Не нужны на одном агенте. |

---

## 4. Контракт

### Мост

- `config.ts`: `RESERVED_PROVIDER_IDS = ['claude-bridge', 'agy']`; в `BridgeConfig` —
  `mcpToken: string` (генерится раз, как `token`) и `agy?: { bin?: string; skipPermissions?: boolean;
  maxSessions?: number }`. `ProviderKind` **не** трогаем — это семантика прокси.
- Новые файлы: `agy.ts` (резолв, пробы, статус, каталог моделей), `agy-session.ts`
  (`AgySession implements ManagedSession`, парсер stream-json, спавн), `tool-relay.ts`,
  `mcp-shim.mjs` (встраиваемый текст shim), `util.ts`.
- Типы стрима — дискриминация по `event`, без `any`:

  ```ts
  interface AgyUsage {
    input_tokens: number; output_tokens: number; thinking_tokens: number;
    cache_read_tokens: number; total_tokens: number;
  }
  type AgyEvent =
    | { event: 'init'; conversation_id: string;
        init: { model: string; cwd: string; tools: string[]; permission_mode: string } }
    | { event: 'step_update'; step_update: { conversation_id: string; step_index: number;
        state: 'RUNNING' | 'DONE' | string;
        step_type: 'user_input' | 'agent_response' | string;
        text_delta?: string; usage?: AgyUsage } }
    | { event: 'result'; result: { conversation_id: string; status: 'SUCCESS' | string;
        response: string; num_turns: number; usage: AgyUsage } }
    | { event: string; [k: string]: unknown };   // неизвестное — лог + heartbeat
  ```

- Discovery `GET /v1/providers` — **отдельный массив `agents`**, не в `providers`: старый редактор
  маппит незнакомый `kind` в `'openai'` и построил бы битый провайдер на `/providers/agy`.

  ```ts
  agents: Array<{ id: 'agy'; label: string; kind: 'agent-cli'; available: boolean; version?: string;
                  auth: 'ok' | 'missing' | 'unknown'; mcp: 'registered' | 'missing'; path?: string;
                  diagnostics?: Array<{ reason: string; severity: 'error' | 'warning';
                                        message: string; detail?: string }> }>
  ```

  `sessions` в discovery — сумма по обоим менеджерам.
- Маршруты: `GET /agents/agy/v1/models`, `POST /agents/agy/v1/messages` (тот же
  `parseMessagesRequest`), `POST /agents/agy/mcp/:sessionId` (auth `x-pix3-mcp-token`, запрет
  `Origin`). `/v1/*` остаётся Claude-ланой без изменений. `POST /v1/sessions/reset` — по обоим
  менеджерам (`sessionKey` у agy с префиксом `agy-`).
- `GET /agents/agy/v1/models`: живой `agy models` (парсер `split('\t')`, кэш на процесс + refresh не
  чаще N минут, статический fallback из §1). Семейства с суффиксом усилия схлопываются:
  `gemini-3.8-flash-{high,medium,low}` → одна модель `gemini-3.8-flash` с
  `reasoningEfforts:['low','medium','high']`. `contextWindow`/`maxOutputTokens` — статическая
  таблица по семейству; `supportsImages:false`; `supportsTools` = `mcp === 'registered'` (мост сам
  читает `~/.gemini/config/mcp_config.json` и проверяет запись `pix3` → на свой shim);
  `pricing: 0/0`.
- Ошибки в Anthropic-конверте: auth → 401 `authentication_error` («запустите `agy` в терминале один
  раз…»), квота → 429 `rate_limit_error` (`describeStatus(429)` и `extractErrorMessage` редактора
  покажут текст), agy не найден → 503, тихое падение → 502 с хвостом `--log-file`.
- CLI: `pix3-agent-bridge agy status|setup|unsetup` (`setup` пишет shim, вызывает
  `agy mcp add -t stdio pix3 node <shim>`, верифицирует по `mcp_config.json`).

### Переиспользование `sessions.ts`

Вытащить из `BridgeSession` **только** парковку: `PendingCall`, `resolveToolResults` (по
`toolUseId`), `cancelPendingCalls`, `toCallToolResult`, `buildMcpServer(tools)` (ListTools +
CallTool → `onToolCall`) — в `tool-relay.ts`. Эвристика `tryAssignAndFlush`/`orphanResults`/
`unparkedBlocks`/`seenToolUseIds` остаётся специфичной для SDK-ланы. `Deferred`, `AsyncQueue`,
`Logger` → `util.ts`. `SessionManager` переиспользуется как есть через `ManagedSession` (уже
интерфейс с фабрикой): **второй инстанс менеджера** для agy, чтобы зависшая Claude-сессия не
вытесняла agy и наоборот; `MAX_SESSIONS`/`HARD_MAX_SESSIONS` перевести из модульных констант в
опции конструктора (agy-пул меньше: каждая сессия = `agy.exe` + его MCP-дети, включая
`npx chrome-devtools-mcp` из конфига пользователя).

### Редактор

- `BridgeProviders.ts`: `BridgeProviderKind = 'openai'|'anthropic'|'agent-sdk'|'agent-cli'`;
  `BridgeProviderEntry` + необязательный `status` (available/auth/mcp/version);
  `class BridgeAgentCliProvider extends AnthropicLlmProvider` — id из entry,
  `defaultBaseUrl = ${bridge}/agents/${id}/v1`, `buildHeaders` только `x-api-key: <pairing>`,
  `apiKeySecretId = BRIDGE_TOKEN_SECRET_ID` (→ `viaBridge` в `AgentTurnOrigin` автоматически true),
  `defaultModelIds` `{main:'gemini-3.1-pro', advisor:'claude-opus-4-6-thinking'}`. `listModels`
  вынести из `ClaudeBridgeLlmProvider` в общий `fetchBridgeModels(baseUrl, ctx)`.
- `BridgeConnectionService.parseEntries`: читать `agents`, **пропускать** незнакомый `kind` (сейчас
  маппит в `'openai'` — это forward-compat дырка); порядок `providers`, затем `agents`, чтобы
  `getPreferred()` оставил Claude приоритетным.
- `LlmTypes` / `AgentSettingsService` — без изменений: `reasoningEffort` уже per (provider, model),
  `supportsTools:false` уже снимает тулы с запроса.

---

## 5. `--effort` и `--conversation`

**Effort.** Редактор шлёт `output_config.effort` только из списка, объявленного моделью → объявляем
`['low','medium','high']` и маппим 1:1; `xhigh`/`max` не объявляем, клампить нечего. Для схлопнутых
семейств effort → суффикс id (`gemini-3.8-flash` + `high` → `--model gemini-3.8-flash-high`) и
**дополнительно** `--effort`, если проба 0(e) покажет, что он что-то меняет поверх суффикса.
`--model`/`--effort` — флаги процесса («for the current CLI session») → смена = новый процесс; но
благодаря `--conversation <id>` это **тот же разговор**: сегодня в Claude-лане смена модели ведёт к
replay транскрипта, у agy — к `agy --conversation <id> --model new`, контекст сохраняется.

**Conversation = наш resume-handle (capture-style).** Процесс на сессию долгоживущий
(`--input-format stream-json --output-format stream-json`, турны — NDJSON-строки в stdin; фолбэк —
процесс-на-турн с `--conversation`, если схема stdin-сообщений окажется неудобной).
`init.conversation_id` захватываем и сохраняем в `~/.pix3/agy-sessions.json`:
`{ key → { conversationId, model, transcriptLen, updatedAt } }`, где `key` — SHA-256 от
`messages[0]` + `messages[1]` (одной первой реплики мало — «привет» коллидирует). Сценарии:

- процесс жив → обычный `handleRequest`, как сейчас;
- idle-eviction (45 мин) или **рестарт моста** → менеджер вместо `replay()` находит запись по ключу,
  проверяет `request.messages.length === transcriptLen + 1`, спавнит `--conversation <id>` и шлёт
  только последний user-turn; не сошлось (пользователь редактировал/регенерировал) → старый replay
  в новый разговор;
- abort от клиента → у agy нет `interrupt()`, убиваем процесс; разговор на диске, следующий turn —
  resume.

Это дешевле и честнее нынешнего replay и не требует изменений wire редактора. Издержки: файл-карте
нужен GC (записи старше 30 дней), в ней только хэши, без содержимого.

---

## 6. Фаза 0 — пробы, которые снимают развилки дизайна

Делать **до** кода; результаты дописать в этот файл (scratchpad живёт только одну сессию).

| # | Что проверяем | Что решает |
| --- | --- | --- |
| a | схема NDJSON-сообщения для `--input-format stream-json`; живёт ли процесс между турнами | долгоживущий процесс против процесс-на-турн |
| b | `step_type` и поля шага для tool-call и для thinking | рендер внутренних шагов, маппинг usage |
| c | print-mode на `run_command` **без** `--dangerously-skip-permissions`: авто-отказ / зависание / событие в стриме, на которое можно ответить через stdin; влияние `--mode plan` и `--sandbox` на MCP-вызовы | режим разрешений (см. риски) |
| d | наследует ли stdio-MCP env agy (временный echo-сервер); раскрывает ли agy `${VAR}` в `-H`; когда подключается (старт/лениво); таймаут `tools/call` на 3-минутном туле | shim против прямого HTTP; нужен ли progress-heartbeat |
| e | `--effort` против суффикса модели (смотреть `init.model` и `usage.thinking_tokens`) | маппинг effort |
| f | `--conversation <id>`: продолжает ли контекст, форма ошибки на неизвестный id | resume-путь и его фолбэк |
| g | `agy models` при `HOME` → пустой tmp (форма no-auth; таймаут — может ждать OAuth ~30 с) | классификатор auth |
| h | какой файл в cwd читается как инструкции (`AGENTS.md` / `GEMINI.md`) | доставка системного промпта |
| i | семантика `input_tokens` относительно `cache_read_tokens` на втором турне | чтобы не удвоить контекст в UI |

### Результаты (сняты живьём 2026-09-17, agy **1.2.5** — не 1.1.27)

Версия на машине уже **1.2.5**, так что `supportedVersionPattern` из §3 расширен до `^1\.[12]\.\d+$`.
`agy models` печатает первой строкой `Fetching available models...` — парсер берёт только строки с `\t`.
Добавился флаг `--print-timeout` (дефолт `5m0s`) — мост ставит его выше своего дедлайна.

**(a) Долгоживущий процесс — да, и это основной режим.** Событие входа — `user`, не `type`
(бинарь ругается `stream input message is missing the "event" field`, затем
`stream input "user" message is missing the "message" field`):

```
{"event":"user","message":{"role":"user","content":"текст" | [{"type":"text","text":"…"}]}}
```

Поддержан только блок `text`. `-p` — Go-флаг, требует аргумент: в stream-json-режиме передаём `-p ""`.
Один `result` на турн, `conversation_id` общий, контекст между турнами сохраняется (проверено:
«скажи one» → «скажи two», второй турн видел первый). Значит **процесс-на-сессию**, фолбэк
«процесс-на-турн» не нужен.

**(b) Тулы — отдельный `step_type: "tool"`**, thinking отдельным шагом **не приходит**:

```
{"event":"step_update","step_update":{…,"step_type":"tool","state":"ACTIVE"|"DONE","tool_name":"write_to_file",
   "tool_info":{"name":"write_to_file","parameters":{…},"output":"1 lines, 186 bytes"},"duration_seconds":…}}
```

Рассуждения учитываются как `usage.thinking_tokens` на шаге `agent_response` (проверено на
`gemini-3.1-pro`: 176 thinking-токенов, отдельного шага нет). Словарь `step_type` в 1.2.5:
`user_input`, `agent_response`, `tool`, `checkpoint`.

**(c) MCP-вызовы в print-mode по умолчанию АВТО-ОТКАЗЫВАЮТСЯ — это главная развилка.**
`permission_mode` в `init` = `request-review`; `call_mcp_tool` не доходит до сервера вовсе, а
итоговый `result` несёт **`denied_actions:[{"action":"mcp","display_name":"CallMcpTool"}]`**.
`--mode accept-edits` не помогает — отказ тот же. `trustedWorkspaces` в
`~/.gemini/antigravity-cli/settings.json` на MCP тоже не распространяется. Зависания нет, события
разрешения в стриме нет — отвечать через stdin нечего.

Следствие для дизайна: **relay физически не работает без `--dangerously-skip-permissions`**.
Решение остаётся тем, что заложено в рисках — флаг **не передаём по умолчанию**, он включается явно
(`agy.skipPermissions` в конфиге / `pix3-agent-bridge agy setup --allow-tools`), а `supportsTools`
гейтится обоими условиями сразу: `mcp === 'registered' && skipPermissions`. Иначе редактор
предлагал бы тулы, которые гарантированно отказывают. Собственные файловые тулы agy, в отличие от
MCP, **разрешены и в дефолтном режиме** — но пишет он не в cwd, а в свой
`~/.gemini/antigravity-cli/scratch/`, что снижает риск из §8.

**(d) stdio-shim подтверждён: env наследуется.** Временный echo-MCP, зарегистрированный
`agy mcp add -t stdio pix3probe node <shim>`, увидел у себя `PIX3_BRIDGE_SESSION=sess-abc123`,
выставленный на спавне agy, и унаследовал его cwd. Прямой HTTP не нужен. Детали протокола:
agy подключается **жадно, на старте процесса** (до первого сообщения модели), шлёт нестандартный
`server/discover` **до** `initialize` (shim обязан ответить на неизвестный метод, а не падать),
объявляет `protocolVersion: 2025-11-25` и принимает наш `2024-11-05`. Схемы тулов agy кладёт на диск
(`~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`) и иногда читает их своим `view_file`.
Таймаут `tools/call` измерить не удалось (вызовы отказываются до сервера — см. (c)); shim шлёт
`notifications/progress` раз в 15 с как страховку.

**(e) Effort — флагом, суффикс не нужен.** `--model gemini-3.8-flash --effort low` принимается,
`init.model` показывает **голое** имя семейства. Более того, голое имя **требует** `--effort`:
`error: invalid model selection (--model "gemini-3.8-flash" --effort ""): --model gemini-3.8-flash
requires --effort (available: low, medium, high)` — то есть CLI сам отдаёт список допустимых
усилий. Значит схлопнутые семейства публикуем под голым id и всегда шлём `--effort`; у
`gemini-3.1-pro` доступны только `low|high`, у `claude-*` и `gpt-oss-120b-medium` вариантов нет
вовсе (это цельные id, `--effort` им не передаём).

**(f) Resume работает, неизвестный id деградирует мягко.** `--conversation <id>` продолжил
контекст (секретное слово из прошлого процесса воспроизведено), `num_turns` продолжил счёт.
На несуществующий id — `warning: conversation … not found` в stderr и **новый** разговор, без
ненулевого кода возврата. Значит фолбэк на replay нужен не для ошибки, а по расхождению
`transcriptLen`.

**(g) Форму no-auth снять не удалось** — подмена `HOME`/`USERPROFILE` на Windows не отвязала
Go-бинарь от уже выданных креденшелов, `agy models` отработал штатно. Классификатор поэтому
строится терпимым: дешёвый пре-чек наличия `~/.gemini/oauth_creds.json` + классификация
stderr/кода возврата `agy models` по регексам, неизвестное → `unknown`, а не `missing`.

**(h) Ни `AGENTS.md`, ни `GEMINI.md` в cwd не читаются** (обе пробы: модель отвечала про себя, а не
кодовым словом из файла) — cwd для agy не workspace, у него своя модель проектов (`--project`,
`--new-project`, `--add-dir`). Поэтому **системный промпт доставляется префиксом первого
user-сообщения** сессии, а дрейф — существующим `<context-refresh>`. Одноразовый scratch-cwd
остаётся (изоляция), но как носитель инструкций не используется.

**(i) `result.usage` — НАРАСТАЮЩИЙ ИТОГ ПРОЦЕССА, а не размер промпта.** Измерено: шаги турна
дали `input_tokens` 14007 и 14216, а `result.usage.input_tokens` = 28223 — ровно их сумма; на
втором турне `result` суммирует и оба турна (13996 + 14068 = 28064). Брать его как «размер
контекста» — значит показывать удвоение на каждом шаге. Поэтому маппинг такой: **`input_tokens` и
`cache_read_tokens` — из ПОСЛЕДНЕГО шага турна** (это и есть размер промпта), а `output_tokens` и
`thinking_tokens` — **сумма по шагам турна**. `cache_read_tokens` наблюдался ненулевым (8120) на
повторном спавне — кеш есть.

---

## 7. Фазы и что проверяемо живьём

**Фаза 1 — текстовая лана (C как веха).** `agy.ts` (резолв/пробы/статус/модели), `agy-session.ts`
без relay, маршруты `/agents/agy/v1/*`, `agents:[…]` в discovery, `supportsTools:false`; редактор —
kind `agent-cli` + `BridgeAgentCliProvider`.
*Проверка:* `curl /v1/providers` показывает `agy` со статусом; `curl /agents/agy/v1/messages`
«say hi» → Anthropic-ответ с usage; в редакторе провайдер «Antigravity» отвечает, монограмма
turn-origin верная, `advisor` назначается на agy и `ask_advisor` работает; список моделей живой.

**Фаза 2 — MCP-relay.** shim + `agy setup`, per-session `Server` + in-memory транспорт,
`tool-relay.ts` вынесен из `BridgeSession` (SDK-лана — регрессионно `sessions.test.ts` и
`tool-batching.test.ts`), `supportsTools` гейтится регистрацией, рендер внутренних шагов.
*Проверка:* «перечисли ноды сцены» → в чате `tool_use`, исполняется в браузере, agy отвечает по
результату; две параллельные вкладки-чата не путают сессии; `agy status` → `mcp: registered`;
`agy mcp list` показывает `pix3`.

**Фаза 3 — сессии.** Захват `conversation_id`, `agy-sessions.json`, resume вместо replay, смена
модели/effort без потери контекста, `/v1/sessions/reset` и `sessions` по двум менеджерам.
*Проверка:* убить мост посреди чата, поднять, продолжить — agy помнит предыдущее (в логе «resumed
conversation», не «replaying transcript»); переключить модель — контекст на месте.

**Фаза 4 — закалка.** Классификация auth/quota → 401/429 с подсказками, хвост `--log-file` в 502,
предупреждение о непроверенной версии, tree-kill на Windows, семафор спавна, README моста +
CLAUDE.md. Тесты: парсер стрима на живой фикстуре, менеджер с фейковой фабрикой, HTTP-контракт
discovery/`models` при отсутствующем agy (503 с внятным текстом).

---

## 8. Риски

- **Собственные тулы agy** (`run_command`, `write_to_file`, browser) — он будет к ним тянуться.
  Закрытие слоями: scratch-cwd на сессию; промпт-забор в `AGENTS.md`; `--sandbox`; режим разрешений
  по результату пробы 0(c). Если print-mode авто-отказывает — `--dangerously-skip-permissions`
  **не передаём по умолчанию** (`agy.skipPermissions` — явный opt-in в конфиге); если запросы
  разрешений приходят событиями — мост отвечает «allow» только для `pix3`-тулов; если висит —
  skip-permissions + `--mode plan` + `--sandbox`, и это документируется как отличие от SDK-ланы.
  Метрика проверки в фазе 2 — доля внутренних шагов против `pix3`-вызовов в тестовом сценарии.
- **Таймаут MCP-вызова внутри agy** на долгих тулах (`game_run`, медленный человек). Проба 0(d);
  при необходимости shim шлёт `notifications/progress` раз в 10–15 с.
- **Quota/auth.** Тихие падения → `--log-file` на сессию (`~/.pix3/logs/agy-<id>.log`, ротация),
  классификаторы из их `auth.ts`, коды 401/429; pre-check `oauth_creds.json`; `agy models` как
  auth-проба. Интерактивный OAuth из моста не запускать никогда (проба с таймаутом и `SIGKILL`).
- **Конкурентные спавны.** Семафор «один agy стартует в момент» (дёшево при пуле ≤2–4): страхует от
  гонки обновления OAuth-токена в `oauth_creds.json` и от нагрузочного пика (каждый agy поднимает
  **все** MCP-серверы пользователя, включая `npx chrome-devtools-mcp`). Раздельные менеджеры на лану,
  `maxSessions` для agy ниже.
- **Стоимость старта agy** (OAuth refresh + все MCP пользователя). Долгоживущий процесс
  амортизирует; глобальный `agy mcp disable` чужих серверов делать нельзя — это конфиг пользователя,
  только документировать.
- **Windows.** `agy.exe` нативный → `spawn` без `shell`, без `windowsVerbatimArguments`; резолв
  строго по имени `agy.exe` (рядом лежит `agy.exe.<ts>.old`); промпт через stdin (лимит командной
  строки 32 КБ); `child.kill()` = TerminateProcess без дерева → `taskkill /T /F` для force-close,
  иначе сироты shim/npx держат память; ключ `Path` регистронезависимо.
- **HTTP-MCP на localhost.** Отдельный `mcpToken`, запрет `Origin`, привязка к `:sessionId`, тот же
  127.0.0.1-слушатель, Host-проверка; shim держит токен только в env процесса.
- **Совместимость редактор↔мост.** `agents:[…]` аддитивно: старый редактор игнорирует, новый
  пропускает незнакомые `kind`.
- **Схема stream-json может меняться между версиями agy.** Парсер терпим к неизвестным
  `event`/`step_type` (лог + heartbeat), `supportedVersionPattern` даёт предупреждение, фикстуры — из
  живых захватов.

---

## 9. Generic-реестр `RuntimeAgentDef` — не вводить сейчас

**За:** контракт open-design уже написан и проверен на 27 агентах; второй CLI (codex / opencode /
gemini-cli) вероятен; резолв и пробы агент-агностичны по природе.

**Против:** у них `RuntimeAgentDef` — 40+ полей, рождённых зоопарком транспортов (ACP,
profile-stdio, plain, json-event-stream, 4 вида MCP-инъекций); нам нужно ~6. Инвариант нашей ланы —
не «как спавнить CLI», а «блокирующий MCP-relay + Anthropic-wire», а переменная часть (парсер
стрима, аргументы, resume) на одном агенте будет **угадана, а не извлечена**. Стиль моста — мелкие
конкретные файлы.

**Решение: не вводить.** Оставить три узких шва, нужных уже первому агенту и заведомо переживающих
второго:

1. агент-агностичные `resolveExecutable(name, wellKnownDirs)` / `probeExecutable` (копия из них);
2. `ManagedSession` + `SessionManager` с опциями вместо модульных констант (уже почти есть);
3. минимальный `AgentLane = { id, label, discover(), listModels(), createSession() }` — ровно
   столько, сколько нужно роутеру, чтобы не хардкодить `agy` в `index.ts`.

Декларативный def извлекать **на втором агенте**, из двух реальных реализаций.

---

## 10. Что реализовано и чем реализация отличается от плана

Фазы 1–4 сделаны; проверено живьём против `agy 1.2.5` (кроме одной ноги, см. ниже).

**Файлы моста:** `util.ts` (`Deferred`/`AsyncQueue`/`Logger`, вынуты из `sessions.ts`),
`executables.ts` (резолв + пробы, порт из open-design с атрибуцией), `agy.ts` (детект, каталог,
классификаторы), `agy-session.ts` (`AgySession`, парсер стрима, спавн), `agy-lane.ts`, `tool-relay.ts`,
`mcp-shim.ts`, `agy-conversations.ts`, `agy.test.ts`. Правлены `config.ts`, `index.ts`, `sessions.ts`,
`cli.ts`, README. **Редактор:** `BridgeModels.ts` (общий `fetchBridgeModels`), `BridgeProviders.ts`
(`agent-cli` + `BridgeAgentCliProvider`), `BridgeConnectionService.ts` (`agents[]`, пропуск
незнакомых kind), `ClaudeBridgeLlmProvider.ts` (listModels вынесен).

Отличия от §4 и почему:

1. **Вместо per-session `Server` из `@modelcontextprotocol/sdk` — прямой обработчик.** Shim уже
   говорит JSON-RPC, а маршрут получает разобранный `{method, params}`; SDK-сервер с in-memory
   транспортом добавлял бы слой без единого нового свойства. Валидация схем не теряется — тулы
   приходят из нашего же редактора через `parseMessagesRequest`.
2. **`agy-lane.ts` и `agy-conversations.ts` — отдельные файлы**, которых в списке §4 не было:
   `index.ts` остаётся роутером, а ConversationStore тестируется без HTTP.
3. **Effort — флагом, без суффиксов** (проба (e)), и голое имя семейства **требует** `--effort`,
   поэтому для схлопнутых семейств он передаётся всегда.
4. **Системный промпт — префикс первого user-сообщения**, а не `AGENTS.md` в cwd (проба (h)).
   Scratch-cwd остался как изоляция. На resume преамбула НЕ повторяется — она уже в разговоре.
5. **`supportsTools` гейтится двумя условиями**, а не одним: регистрация shim **и**
   `agy.skipPermissions`. Это прямое следствие пробы (c).
6. **Добавлен `PIX3_AGY_DISABLED=1`** — герметичность тестов и выключатель для пользователя;
   детект спавнит реальный процесс, в CI этого быть не должно.
7. **`supportedVersionPattern` — `^1\.[12]\.\d+$`** (на машине 1.2.5, а не 1.1.27 из §1).
8. **Discovery ограничена 8 с** на холодном детекте и отвечает «ещё проверяю»: `agy --version` +
   `agy models` — это два спавна, и editor не должен ждать их на первом пробе.

Дефекты, найденные **живой проверкой**, а не тестами (все исправлены и закрыты регрессиями):

- **Роутинг по длине истории путал чаты.** Два чата по 2 сообщения на одной модели неразличимы для
  `SessionManager`, и он отдал продолжение второго чата сессии первого — та ответила из СВОЕЙ
  истории («BRIDGE-OK» на вопрос «какое было кодовое слово?»). Добавлен необязательный
  `ManagedSession.matchesChat(request)`; `AgySession` реализует его как «первое user-сообщение то же
  И assistant-сообщение, от которого продолжают, — это мой последний ответ». SDK-лана метод не
  реализует, её поведение не изменилось.
- **Ключ разговора не был стабилен между 1-м и 2-м запросом чата** (он хэширует ПАРУ
  «первая реплика + первый ответ», которой на первом запросе ещё нет), из-за чего продолжение уходило
  в replay вместо своей же сессии. Ключ теперь пересчитывается на каждом запросе и «затвердевает» со
  второго турна — ровно тогда, когда нужен для resume.
- **Стена квоты выглядела как зависший чат.** Gemini ответил `RESOURCE_EXHAUSTED (429): Individual
  quota reached… Resets in 122h`, `agy` начал ретраить его с бэкоффом (4с, 6с, 10с, 22с…) и на каждую
  попытку слал шаг `step_type: "error_message"`, которого мост не знал: в консоли — только
  `ignoring unknown step_type "error_message"`, причина — лишь в `~/.pix3/logs/agy-<id>.log`. Хуже,
  что каждый такой шаг — это прогресс, поэтому watchdog `SessionManager` не срабатывал, а ретраи
  жили бы до `--print-timeout 24h` и держали бы следующий турн в очереди. Теперь `error_message`
  логируется целиком, а квота/аутентификация (`looksLikeQuota`/`looksLikeAuth`) сразу валит турн
  в 429/401 и закрывает сессию; ретраибельные ошибки (503 «no capacity») по-прежнему просто
  heartbeat.
- **Shim выходил по закрытию stdin, обрывая вызов в полёте.** Найдено прогоном настоящего shim
  против живого моста. Теперь выход откладывается до дренажа; `SHIM_VERSION` = 2.

**Что проверено живьём:** discovery со статусом и диагностикой; живой `GET /agents/agy/v1/models`
(семейства схлопнуты, efforts верные); текстовый турн (`BRIDGE-OK`); многотурновый чат на одном
процессе без повторного спавна; разведение двух чатов одинаковой длины; **resume после убийства
моста** (в логе `resuming c3c86b4b…`, модель помнит контекст); shim против живого relay — `tools/list`,
404 на неизвестную сессию, 401 на чужой токен.

**Что НЕ проверено мной:** сам вызов pix3-тула через `agy` — он требует запуска `agy` с
`--dangerously-skip-permissions`, и эту команду заблокировал классификатор сессии. Плумбинг по обе
стороны от неё проверен (shim↔мост живьём, парковка и `stop_reason:'tool_use'` юнит-тестами), но
финальную ногу нужно подтвердить руками:
`pix3-agent-bridge agy setup --allow-tools`, перезапустить мост, и в редакторе попросить агента
перечислить ноды сцены.

## Критические файлы

- `tools/pix3-agent-bridge/src/sessions.ts` — донор `ManagedSession`/`SessionManager`,
  `PendingCall`/`buildMcpServer`/`onToolCall` для `tool-relay.ts`; `MAX_SESSIONS` → опции.
- `tools/pix3-agent-bridge/src/index.ts` — маршруты `/agents/:id/v1/*`, `/agents/agy/mcp/:sessionId`,
  `agents:[…]` в discovery, второй менеджер, reset по обоим.
- `tools/pix3-agent-bridge/src/config.ts` — `mcpToken`, секция `agy`, `RESERVED_PROVIDER_IDS`.
- `src/services/llm/BridgeProviders.ts` — kind `agent-cli`, `BridgeAgentCliProvider`, вынос
  `listModels` из `ClaudeBridgeLlmProvider.ts`.
- `src/services/llm/BridgeConnectionService.ts` — `parseEntries` читает `agents`, пропускает
  незнакомые kind.
- Референс для копирования (Apache-2.0, с атрибуцией): `apps/daemon/src/runtimes/`
  {`executables.ts`, `invocation.ts`, `launch.ts`, `auth.ts`, `detection.ts`, `diagnostics.ts`,
  `types.ts`, `defs/claude.ts`} из `nexu-io/open-design`.
