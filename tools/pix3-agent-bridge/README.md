# Pix3AgentBridge

A small **local** service that connects the Pix3 editor's in-editor AI agent to LLM providers a
browser can't reach on its own — and keeps your API keys on your machine, never in the browser.

It runs on `127.0.0.1` and serves four lanes:

1. **Claude Code (MAX) lane** — serves the agent from a real Claude Agent SDK session using your
   Claude Code Pro/MAX subscription (`claude login`). No API key, no per-token cost.
2. **Antigravity (`agy`) lane** — the same thing for the [Antigravity CLI](https://antigravity.google),
   driven as a subprocess. Also a subscription you already pay for, also $0 marginal cost. See
   [Antigravity lane](#antigravity-agy-lane) below.
3. **Codex CLI lane** — serves your signed-in Codex CLI at `/agents/codex/v1/*`, using the same
   editor model picker and conversation wire. See [Codex lane](#codex-lane) below.
4. **Provider proxy lane** — a credential-injecting reverse proxy for **OpenAI**, the **Anthropic
   API**, **OpenCode Zen**, and any **custom OpenAI-compatible** endpoint. The editor authenticates
   to the bridge with a pairing token; the bridge adds the real provider key and forwards the request
   to the provider. Your keys live only in `~/.pix3/agent-bridge.json`.

Google Gemini is **not** proxied here — the editor calls it directly (it sends CORS headers), so a
basic user only needs a Gemini key and no bridge at all. The bridge is the "advanced" path that
unlocks the other providers.

## Requirements

- Node.js **24+**
- For the Claude Code lane: a logged-in Claude Code (`claude login`, Pro/MAX)
- For the Codex lane: an up-to-date, signed-in Codex CLI (`npm install -g @openai/codex@latest`,
  then `codex login`)

## Run

```bash
npx @pix3/agent-bridge
```

On start it prints a **pairing token**. In the editor: **Settings → AI Agent**, paste the token.
Providers you've enabled below then appear in the model picker.

Options: `--port <n>` (default 8484), `--origin <url>` (repeatable — extra allowed browser origins),
`--stall-timeout-ms <n>` (wedged-session watchdog, see below).

## Wedged sessions (Claude Code lane)

A Claude Code session can occasionally accept a message and then go silent forever. The bridge
detects that instead of leaving the editor stuck on "the model did not respond":

- **Progress tracking** — every message the CLI emits stamps the session. A turn that dies (client
  gave up, or the 20-minute request cap) after **≥ 120 s with no model output at all** marks the
  session *wedged*.
- **Routing** — wedged sessions are skipped, so the user's next message / "Try again" starts a fresh
  session (seeded with a transcript replay) instead of re-entering the dead one.
- **Watchdog** — a sweep every 60 s force-closes any session that is wedged, or that has been busy
  with **no output for longer than the stall timeout (default 5 minutes)**. The threshold sits well
  above the editor's own 180 s per-request timeout so it can never kill a merely slow turn. Override
  with `--stall-timeout-ms <n>`, `PIX3_BRIDGE_STALL_TIMEOUT_MS=<n>`, or `"stallTimeoutMs": <n>` in
  the config file (floor: 60000).
- **Capacity** — wedged sessions are the first eviction victims, so they can no longer permanently
  shrink the session pool. A session that is actively streaming is never evicted; the bridge
  temporarily exceeds its soft session cap instead.
- **Manual reset** — `POST /v1/sessions/reset` (pairing token required, like every API route):

  ```bash
  # close whatever looks wedged (empty body):
  curl -X POST http://127.0.0.1:8484/v1/sessions/reset -H "x-pix3-bridge-token: $TOKEN"
  # → {"closed":1,"remaining":0,"stalled":0,"scope":"stalled"}

  # close everything, or one session by the id the bridge logs:
  curl -X POST http://127.0.0.1:8484/v1/sessions/reset -H "x-pix3-bridge-token: $TOKEN" \
    -H 'content-type: application/json' -d '{"all":true}'
  curl -X POST http://127.0.0.1:8484/v1/sessions/reset -H "x-pix3-bridge-token: $TOKEN" \
    -H 'content-type: application/json' -d '{"sessionKey":"1a2b3c4d"}'
  ```

  It is idempotent and closing zero sessions is a success. `GET /v1/providers` also reports
  `sessions: { total, busy, stalled, stallTimeoutMs }` so the editor can surface the state.

## Antigravity (`agy`) lane

If the [Antigravity CLI](https://antigravity.google) is installed and signed in, the bridge finds it
(PATH, then `%LOCALAPPDATA%gyin` / `~/.local/bin` / `~/.agy/bin` / `/usr/local/bin` /
`/opt/homebrew/bin`; override with `PIX3_AGY_BIN`) and serves it at `/agents/agy/v1/*`. Nothing to
configure — it shows up in the editor's model picker as **Antigravity (agy)** with a live model list
from `agy models`.

```bash
pix3-agent-bridge agy status                # installed? signed in? tools enabled?
pix3-agent-bridge agy setup [--allow-tools] # register the pix3 MCP shim with agy
pix3-agent-bridge agy unsetup               # undo it
```

**Editor tools are off until you opt in, and the opt-in has a real cost.** `agy` auto-denies every
MCP call in print mode unless it is started with `--dangerously-skip-permissions` — measured; there
is no narrower flag, and `--mode accept-edits` does not help. That same flag also un-gates agy's own
shell, file and browser tools on this machine. So out of the box the lane is a **text-only** provider
(excellent as the editor's *advisor* — a free second opinion), and `agy setup --allow-tools` is the
deliberate step that turns the agent loop on. Without it the lane advertises `supportsTools: false`,
so the editor never offers it tools it cannot run.

How tools reach the editor once enabled: `agy setup` writes `~/.pix3/agy-mcp-shim.mjs` and registers
it with agy as the `pix3` stdio MCP server. agy spawns that shim as a child, so it inherits the
environment the bridge set on the agy process — which is how a tool call is tied to the chat that
made it. The shim posts to `/agents/agy/mcp/<sessionId>`, guarded by a **separate** `mcpToken` (not
the pairing token), and the bridge blocks that route for anything sending an `Origin` header.

Chats survive a bridge restart here, unlike the Claude Code lane: agy persists its own conversations,
so `~/.pix3/agy-sessions.json` maps a chat to an `agy` conversation id and the next turn resumes it
with `--conversation` instead of replaying the transcript.

Set `PIX3_AGY_DISABLED=1` to switch the lane off entirely (the bridge then never spawns `agy`).

## Codex lane

The bridge discovers a recent `codex` executable on PATH and exposes GPT-5.6 Sol, Terra, and Luna
through your Codex sign-in. The bridge uses `codex exec --json` and resumes its thread for follow-up
messages. It runs from a scratch directory and ignores your user config and rules, so a model selected
for unrelated Codex work does not silently change the Pix3 model picker. Set `PIX3_CODEX_BIN` to an
explicit executable path if discovery misses your installation. Set `PIX3_CODEX_DISABLED=1` to skip
the lane. The bridge reports an outdated CLI in discovery with an upgrade instruction.

Editor tools are always enabled for the Codex lane: a Pix3 agent without them cannot inspect or
change the browser-held project. `codex exec` denies MCP calls that need approval in unattended
mode, so the bridge uses Codex's `--dangerously-bypass-approvals-and-sandbox` flag. The bridge
disables Codex's shell, image, and web tools and tells it to use only Pix3 MCP tools, but the flag
still removes Codex's process sandbox; run the bridge only when that local access is acceptable.

The Pix3 MCP shim is configured only for each Codex subprocess. It receives the relay URL, session
id and separate MCP token through environment variables. No permanent change to your Codex MCP
configuration is needed. Codex conversation ids are saved in `~/.pix3/codex-sessions.json` so chats
can continue after a bridge restart.

For image generation, pair the bridge and select **Codex (ChatGPT)** as the image provider in
Pix3 Settings → AI Images, or pass `providerId: "codex"` to `generate_asset`. The bridge's
`POST /agents/codex/v1/images` starts an isolated ephemeral Codex app-server turn, captures its
native `imageGeneration` result and returns raster bytes to Pix3. It uses the local `codex login`
session rather than an image API key. Account limits still apply. A turn can take several minutes.
The image turn has no Pix3 editor tools; its temporary working directory is removed on exit.

## Manage providers

```bash
# Built-in presets — just supply a key:
npx @pix3/agent-bridge provider add openai        --key sk-...
npx @pix3/agent-bridge provider add anthropic     --key sk-ant-...
npx @pix3/agent-bridge provider add opencode-zen  --key ...

# A custom OpenAI-compatible endpoint (arbitrary id + explicit base URL):
npx @pix3/agent-bridge provider add my-router \
  --base-url https://openrouter.ai/api/v1 --key sk-or-... --kind openai --label OpenRouter

npx @pix3/agent-bridge provider list
npx @pix3/agent-bridge provider disable openai
npx @pix3/agent-bridge provider enable  openai
npx @pix3/agent-bridge provider set-key openai sk-...
npx @pix3/agent-bridge provider remove  my-router
```

`--kind openai` forwards `Authorization: Bearer <key>` (OpenAI Chat Completions, gateways, local
Ollama/LM Studio). `--kind anthropic` forwards `x-api-key` + `anthropic-version` (native Anthropic
Messages API). Presets set the right kind for you.

Changes take effect on the editor's next availability probe — no server restart needed for key/enable
changes (a base-URL/kind change to a provider you're actively using is picked up on reconnect).

## Security

- Binds to `127.0.0.1` only; `Host` must be localhost (blocks DNS-rebinding).
- Every API call requires the pairing token; browser `Origin` is allowlisted.
- The proxy's upstream host is fixed per provider (never taken from the request) → no open relay / SSRF.
- Outbound requests carry only `content-type` + the injected key — the pairing token, cookies and
  other inbound headers are stripped, so nothing leaks upstream.
- The Claude Code session runs with zero built-in tools — the model can only call pix3 editor tools,
  never this machine's shell or filesystem. The Antigravity lane is the one exception, and only when
  you ask for it: `agy setup --allow-tools` lets `agy` use its own shell/file/browser tools too,
  because that is the only way it will answer an MCP call at all. It runs in a throwaway working
  directory and is told the project is not on this disk, but the capability is real — that is why it
  is off by default. The Codex lane also uses full-access mode, but always enables its Pix3 MCP relay;
  its built-in shell, image, and web tools remain disabled, as described above.
- The MCP relay has its own token (`mcpToken`), so the shim file on disk cannot spend provider keys
  or the MAX subscription even if it is read by another local process.

## Config file

`~/.pix3/agent-bridge.json` holds the pairing token, the MCP relay token, the provider table (kind,
base URL, key, enabled) and optional `port` / `origins` / `stallTimeoutMs` / `agy` overrides
(`agy.bin`, `agy.skipPermissions`, `agy.maxSessions`). It is migrated automatically
from the old `claude-bridge.json` (the pairing token carries over) on first run.

## Develop

```bash
npm install
npm start          # run from source (node runs the TS directly)
npm test           # node --test (session watchdog/reset unit tests + HTTP contract tests)
npm run type-check
npm run build
```
