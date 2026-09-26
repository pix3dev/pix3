# Phase 0 — cold `npx` start of `@pix3/cli` (external-agent-authoring.md, "Холодный старт `npx`")

Measured 2026-09-25 on Linux x64, Node v24.21.0, npm 11.19.0, against the public npm registry
(network available). Package: `packages/pix3-cli` @ 1.6.0 (unpublished; installed from the
`npm pack` tarball, so its dependencies come from the registry and the package itself from disk).
All times are wall clock, 3 runs each unless noted; they include registry latency from this
machine and will differ on a user's network.

## Package size

| | |
|---|---|
| tarball (`npm pack`) | **2.0 MB** (1 962 729 B), 135 files |
| tarball unpacked | 2.4 MB (dist 68 KB; the rest is the templates copy) |
| of which three copies of `sprites/pix3-logo.png` (empty-2d, empty-3d, playable-2d) | **1.8 MB** (609 824 B each) |
| installed dependency tree (`_npx/<hash>/node_modules`) | **33 MB, 93 packages** |
| biggest deps (all via `@modelcontextprotocol/sdk`) | zod 8.2 MB, `@modelcontextprotocol` 6.2 MB, hono 3.7 MB, ajv 2.5 MB, yaml 1.4 MB, express + friends |
| npm cache after one cold install | 61 MB |

The CLI's own dependencies are only `yaml` and `@modelcontextprotocol/sdk`; everything else is the
SDK's transitive tree (it ships its HTTP transports — express, hono, cors, jose, … — which a stdio
server never loads). No `typescript`.

## Timings

| command | cold (empty cache) | warm (cached) | without npx (`node dist/index.js`) |
|---|---|---|---|
| `new recipe-tapper-2d my-game` | 4.15 / 3.73 / 3.63 s | 0.92 / 0.88 / 0.90 s | 0.09 s (`node src/index.ts`: 0.14 s) |
| `mcp` → `GET /hello` answers | 4.19 / 3.50 / 3.93 s | 1.08 / 1.06 / 1.40 s | — |
| `mcp` → MCP `initialize` answered on stdio | 3.92 s (1 run) | 1.06 / 1.05 / 1.06 s | 0.23 / 0.24 / 0.22 s |
| `mcp` → first `project_status` result | 3.93 s | 1.07 s | 0.24 s |

Reading:

- **Cold is ~4 s, all of it npm installing the SDK's 93-package tree.** The CLI itself starts in
  ~0.1 s (`new`) / ~0.23 s (`mcp`, SDK import included).
- **Warm `npx` costs ~0.8 s on top of the CLI** — npm's own start and its check of the `_npx` cache.
  This was measured with a local tarball spec; the pinned registry spec the kit will write
  (`npx -y @pix3/cli@X.Y.Z mcp`) cannot be measured until the package is published, and may add a
  registry metadata round trip on some npm versions.
- Against the agents' MCP start-up limits: Codex's `startup_timeout_sec` defaults to 10 s and
  Claude Code's `MCP_TIMEOUT` is larger (to the best of my knowledge — verify against the current
  docs of both before relying on it). ~4 s cold fits both, with less margin on a slow network.
- Against the plan's "~2 s" for `new`: **warm meets it, cold does not** (3.6–4.2 s).

## What would bring cold under 2 s (not done — decisions for phase 1)

1. **Bundle the CLI into one file with zero runtime dependencies** (esbuild at `prepack`:
   `dist/index.js` + a lazily imported `dist/mcp.js` chunk that inlines only the stdio server path
   of the SDK, zod and yaml). npx then fetches a single tarball and installs nothing, so cold ≈
   tarball download. Largest lever by far.
2. **Deduplicate the template binaries**: three byte-identical 610 KB logos are 90 % of the
   tarball. Either shrink `pix3-logo.png` in the templates, or have `copy-templates` store shared
   binaries once and `new` copy them from there.

## Exact commands

```bash
# pack (runs prepack: copy-templates + tsc build; postpack removes the templates copy)
cd packages/pix3-cli && npm pack --pack-destination "$M/pack"
TGZ="$M/pack/pix3-cli-1.6.0.tgz"

# NB: this machine exports NPM_CONFIG_CACHE, which beats a lower-case npm_config_cache —
# unset it, or the "cold" run silently uses the user's warm cache.

# new — cold: a fresh empty cache per run, empty working dir, no node_modules
env -u NPM_CONFIG_CACHE npm_config_cache="$M/cache-newN" \
  npx -y --package "$TGZ" pix3 new recipe-tapper-2d my-game
# new — warm: same command, reusing cache-new1

# mcp → /hello: spawn in the created project, poll 127.0.0.1:8490-8499 every 25 ms until
# GET /hello returns that project's metadata.projectId, then kill the process group
node measure-mcp.mjs "$TGZ" "$M/w1/my-game" "$M/cache-mcpN"

# mcp → initialize / first tool call over stdio (what the agent host waits for)
node measure-init.mjs "$M/cache-init" "$M/w1/my-game" npx -y --package "$TGZ" pix3 mcp
node measure-init.mjs - "$M/w1/my-game" node "<_npx dir>/node_modules/@pix3/cli/dist/index.js" mcp
```

`measure-mcp.mjs` / `measure-init.mjs` were throwaway scripts in the session scratchpad
(`spawn` + `performance.now()`; the first polls `/hello`, the second writes JSON-RPC
`initialize` then `tools/call project_status` to stdin and times the responses).

## Not measured here

- The first `pix3 check` with a lazily fetched TypeScript (phase 1: `check` does not exist yet).
- Anything browser-side: Local Network Access prompt, PWA `fetch` to loopback, long-poll
  survival under the Service Worker / in a backgrounded window — needs a real installed PWA.
