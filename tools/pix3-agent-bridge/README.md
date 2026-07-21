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

Options: `--port <n>` (default 8484), `--origin <url>` (repeatable — extra allowed browser origins).

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

`~/.pix3/agent-bridge.json` holds the pairing token and the provider table (kind, base URL, key,
enabled). It is migrated automatically from the old `claude-bridge.json` (the pairing token carries
over) on first run.
