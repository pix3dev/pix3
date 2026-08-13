# Pix3AgentBridge

A small **local** service that connects the Pix3 editor's in-editor AI agent to LLM providers a
browser can't reach on its own — and keeps your API keys on your machine, never in the browser.

It runs on `127.0.0.1` and does two things:

1. **Claude Code (MAX) lane** — serves the agent from a real Claude Agent SDK session using your
   Claude Code Pro/MAX subscription (`claude login`). No API key, no per-token cost.
2. **Provider proxy lane** — a credential-injecting reverse proxy for **OpenAI**, the **Anthropic
   API**, **OpenCode Zen**, and any **custom OpenAI-compatible** endpoint. The editor authenticates
   to the bridge with a pairing token; the bridge adds the real provider key and forwards the request
   to the provider. Your keys live only in `~/.pix3/agent-bridge.json`.

Google Gemini is **not** proxied here — the editor calls it directly (it sends CORS headers), so a
basic user only needs a Gemini key and no bridge at all. The bridge is the "advanced" path that
unlocks the other providers.

## Requirements

- Node.js **24+**
- For the Claude Code lane: a logged-in Claude Code (`claude login`, Pro/MAX)

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
  never this machine's shell or filesystem.

## Config file

`~/.pix3/agent-bridge.json` holds the pairing token, the provider table (kind, base URL, key,
enabled) and optional `port` / `origins` / `stallTimeoutMs` overrides. It is migrated automatically
from the old `claude-bridge.json` (the pairing token carries over) on first run.

## Develop

```bash
npm install
npm start          # run from source (node runs the TS directly)
npm test           # node --test (session watchdog/reset unit tests + HTTP contract tests)
npm run type-check
npm run build
```
