# @pix3/cli

Command line for Pix3:

```text
pix3 new [<recipe> [dir]] [--name <n>]        create a project from a recipe/template
pix3 mcp --workspace [--project <dir>]        stdio MCP server for your agent, through `pix3 serve`
pix3 mcp [--project <dir>] [--agent <name>]   phase-0 prototype: stdio MCP + FSA link server
pix3 setup [claude|codex]                     print how to register the MCP server
pix3 serve [--project <dir>] [--port <n>] [--new-token]
                                              serve a project folder to a Pix3 editor
pix3 validate [paths…] [--json]               strict scene check
pix3 check [--json] [--no-hydrate] [--offline] [--project <dir>]
                                              validate + tsc over the scripts + merge-log + versions
pix3 kit [--update] [--project <dir>]         install / update the agent kit in a project
pix3 read <path>                              print a file and ack its bytes' sha256
pix3 ack <path> --sha256 <hash>               ack a version you read (hash of raw bytes)
```

`new`, `kit`, `mcp`, `serve`, `read`/`ack` load neither TypeScript nor the kit generator: the kit
and the runtime types are prebuilt into the package (`kit/`, `runtime-types/`, at `prepack`).

`read` / `ack` append `{ path, sha256, at }` to `.pix3/ack.json`. The editor, merging the next
version of that file you write, lifts the protection of the manual edits that version contained
and removes the ack (one-shot); see `docs/pix3-specification.md` → "Co-authoring mode".

## `pix3 check` — everything an agent should run after a batch of edits

`pix3 check` = `pix3 validate` (both levels) + a TypeScript type-check of the project's scripts +
the newest `.pix3/merge-log.jsonl` entries + a version check. Exit 0 = no errors (warnings
allowed), 1 = at least one error, 2 = could not run. Diagnostics are one list, validate's plus:

| Code | Severity | When |
| --- | --- | --- |
| `E_TYPE` | error | a tsc diagnostic (`message` starts with `TS<code>:`; `file`, `line`) |
| `E_TYPECHECK_UNAVAILABLE` | error | TypeScript could not be found or installed (`fix` = the command to run) |
| `W_RUNTIME_VERSION_MISMATCH` | warning | own `tsconfig.json`, and `node_modules/@pix3/runtime` is not this CLI's version |
| `W_RUNTIME_NOT_INSTALLED` | warning | own `tsconfig.json`, and no `node_modules/@pix3/runtime` |
| `W_KIT_OUTDATED` | warning | `metadata.agentKit.version` is not this CLI's version (`pix3 kit --update`) |

`--json`:

```text
{
  "ok": true, "projectRoot": "…", "errorCount": 0, "warningCount": 2,
  "level2": { "state": "ran", "filesHydrated": 5, "filesSkipped": 0 },
  "files": [{ "file": "scenes/main.pix3scene", "sha256": "<hex of the raw bytes>" }],
  "diagnostics": [{ "severity", "code", "file", "line?", "nodeId?", "path?", "message", "fix?" }],
  "notes": [],
  "typecheck": { "ok": true, "errors": 0, "tsconfig": ".pix3/tsconfig.check.json", "mode": "pix3-types",
                 "files": 5, "typescript": { "version": "5.8.3", "source": "cache" } },
  "mergeLog": [{ "at", "file", "event", "…": "the newest 10 lines of .pix3/merge-log.jsonl" }],
  "kit": { "version": "1.6.0", "cliVersion": "1.6.0", "upToDate": true },
  "timingsMs": { "validate": 190, "typecheck": 1180, "total": 1380 }
}
```

`files` holds every scene validated and every script type-checked, hashed over the **raw bytes** —
the hashes `expect` (barrier tools) and `pix3 ack --sha256` take. `typecheck.errors` counts the
`E_TYPE` / `E_TYPECHECK_UNAVAILABLE` entries of `diagnostics`.

**Which tsconfig.** A project with its **own** root `tsconfig.json` (a Vite project, or one the
editor's *build from templates* turned into one) is checked with it, as is, against its own
`node_modules` (`mode: "project"`); nothing is written into it. Otherwise (`mode: "pix3-types"`)
`check` uses `.pix3/tsconfig.check.json` against the bundled types in `.pix3/types/`, and first
(re)writes both when they are missing or from another CLI build.

**Where TypeScript comes from** — it is not a dependency of `@pix3/cli`: (1) the project's own
`node_modules/typescript` (or an ancestor's); (2) the CLI's sibling install
(`import.meta.resolve('typescript')`, e.g. the monorepo); (3) `~/.pix3/typescript/5.8.3/`,
installed there once with `npm install --prefix ~/.pix3/typescript/5.8.3 typescript@5.8.3 …`
(printed before it runs). `--offline` never installs: it fails with `E_TYPECHECK_UNAVAILABLE` and
the command. `PIX3_TYPESCRIPT=<package dir>` overrides the search. Loaded with a dynamic `import()`.

Measured (recipe-tapper-2d, 5 scripts, packed CLI installed outside the repo, fresh `HOME`):
first `check` 2.1 s including the TypeScript install, then 1.45 s (validate ~0.2 s, tsc ~1.2 s).

## `pix3 kit` — the agent kit

`pix3 kit` installs the agent kit into an existing project (one the editor created, or after a CLI
upgrade); `pix3 new` runs the same step. What lands in the project:

| Path | What |
| --- | --- |
| `AGENTS.md` | Root rules (read by Codex, Cursor, …). If the project already has its own, it is kept and the kit goes to `AGENTS.pix3.md` (the command prints the line to add). |
| `CLAUDE.md` | `@AGENTS.md` (plus `@AGENTS.pix3.md` in that case). A `CLAUDE.md` of the project's own is never touched — the command prints the line to add. |
| `.claude/skills/pix3-{scene-format,nodes,scripts,verify}/SKILL.md` + `reference.md` | Skills loaded on demand; the `reference.md` files are generated from `docs/` and the runtime's registry |
| `.mcp.json` | The pinned `pix3 mcp --workspace` entry; other servers kept |
| `.gitignore` | `.pix3/` appended when not covered; existing content kept |
| `tsconfig.json`, `.pix3/tsconfig.check.json`, `.pix3/types/` | Only without a `tsconfig.json` of the project's own (see below) |
| `pix3project.yaml` | `metadata.agentKit: { version, files }` (everything else as written) |
| `.pix3/kit-manifest.json` | sha256 of every file the kit wrote |

Without `--update`, existing files are never replaced (missing ones are written; an unchanged file
from an older kit is reported `outdated`). `--update` replaces every kit file whose bytes still
match the hash in `.pix3/kit-manifest.json` and **skips** (and reports) every file edited since.
`.pix3/` is gitignored, so on a fresh clone the manifest is gone and every differing kit file counts
as edited.

**Generated, not copied.** `scripts/build-kit.mjs` (run at `prepack`; a repo checkout regenerates
`kit/` automatically whenever an input changed) expands the templates in `kit-src/`: hand-written
prose plus `{{include:<repo path>#<heading>}}` / `{{include:<repo path>@<paragraph>}}` directives
over `docs/pix3-specification.md`, `docs/node-types-reference.md`, `docs/nodes-and-systems.md`,
`src/services/agent/agent-skills/engine-api-map.md` and this README, and `{{generated:…}}` blocks
computed from code (the `core:` component table from the runtime's registry, the MCP tool list,
the barrier error codes). Syntax: `src/kit/generate.ts`. `src/kit.spec.ts` builds the kit and fails
on drift: an unresolved directive, a `pix3` command or flag not in the usage text, a tool name
outside the 14, a diagnostic code no command emits, a node type the loader does not know, a
property in the nodes skill's tables that the disk-format descriptor
(`packages/pix3-runtime/src/core/scene-disk-format.ts`) does not accept, a `core:` component that
does not exist.

### Script types (`.pix3/types/`)

`scripts/build-runtime-types.mjs` (at `prepack`; rebuilt on demand in a checkout when the runtime
sources change) runs `tsc -p packages/pix3-runtime/tsconfig.types.json` (declarations of what
`src/index.ts` reaches — no specs, samples or `testing/`) into `runtime-types/@pix3/runtime/`, and
copies `@types/three` (without its `node_modules`) to `runtime-types/@types/three/` — the runtime's
public types extend three.js. `lit` (re-exported `property`/`state` decorators), `postprocessing`
and the Spine runtime are not shipped: they are only reached from inside declaration files, which
`skipLibCheck` leaves alone (they type as `any`). In a project without its own `tsconfig.json`:

```text
.pix3/types/@pix3/runtime/**      the runtime's .d.ts (+ package.json with the version)
.pix3/types/@types/three/**       three.js types
.pix3/types/version.json          which CLI build wrote them
.pix3/tsconfig.check.json         paths → ./types/…, strict, noEmit, skipLibCheck, lib ES2022 + DOM,
                                  include ../scripts/**/*.ts and ../src/scripts/**/*.ts
tsconfig.json                     { "extends": "./.pix3/tsconfig.check.json" } — so an IDE sees them
```

## `pix3 serve` — workspace server

Serves one project folder to the Pix3 editor over **one loopback port**, without File System
Access. Built for a project that lives on a remote machine (VS Code Remote SSH): run `pix3 serve`
there, forward the port, and connect the editor on your computer with the address and token.

- Binds `127.0.0.1` only. `--port N`: exactly N; if it is busy the command fails (no silent
  switch). Without `--port`: the first free port of 8490–8499.
- Project root: `--project`, else the nearest ancestor of the cwd with `pix3project.yaml`.
  A folder without `pix3project.yaml` is refused.
- **One server per root.** A second `pix3 serve` on the same root prints the running server's
  address and exits 0 (`--new-token` then rotates the token of the running server).
- Stops on Ctrl+C / SIGTERM. stdout is for humans; the event log goes to stderr.

Protocol version: **`WORKSPACE_PROTOCOL = 1`** (`src/protocol.ts`), reported as `protocol` in
`hello` and `/ws/status`. It is independent of the CLI's lockstep product version.

### Pairing and server state

- On the first run the server mints a **token**: `p3ws_` + base64url of 32 random bytes. It is
  printed **once** and never stored in plaintext. `pix3 serve --new-token` issues a new one; the
  old token stops working at once, live sockets authenticated with it are closed.
- State lives in `<root>/.pix3/` (mode 0700, with a `.gitignore` of `*`):
  - `workspace.json` (mode 0600):

    ```json
    {
      "version": 1,
      "workspaceId": "<uuid, minted once per root>",
      "root": "<canonical absolute root>",
      "token": { "sha256": "<hex sha256 of the token>", "issuedAt": "<ISO time>" },
      "server": {
        "pid": 1234,
        "port": 8490,
        "serverSession": "<uuid>",
        "control": "<secret>",
        "startedAt": "<ISO time>"
      }
    }
    ```

    `server` is `null` while no server runs. **Revoke = delete this file**: a running server
    notices within ~2 s, closes every socket and refuses the old token.
    If `root` differs from the folder's canonical path (the project was copied), the server
    mints a new `workspaceId` and token instead of trusting the copied file.
  - `serve.lock` — pid of the server owning the root.
  - `tmp/` — staging for atomic writes.
  - `link/` — challenge files of the FSA link server.
- **Server-private** = `.pix3` itself, `.pix3/workspace.json`, `.pix3/serve.lock`, `.pix3/tmp/**`
  and `.pix3/link/**` (names compared case-insensitively): unreachable through every route
  (`403 reserved_path`) and never listed.
- **Everything else under `.pix3/`** is the editor's co-authoring bookkeeping
  (`protected.json`, `merge-log.jsonl`, `recovery/**`, `ack.json`, …) and is readable and
  writable like any other path. It is **never part of the revision set**: it does not move
  `revision` and produces no `change` events — with one exception, `.pix3/ack.json` (see
  `ChangeEvent` below). `/ws/manifest` lists it (see there).

### Common rules (every HTTP route)

- **Host**: `localhost`, `127.0.0.1` or `[::1]`, **with any port or none** (a forwarded local
  port may differ from the server's). Anything else → `403 forbidden_host`.
- **Origin**: absent (a local process) or one of `https://editor.pix3.dev`,
  `http://localhost:8123`, `http://127.0.0.1:8123`. Anything else → `403 forbidden_origin`,
  without CORS headers. Allowed origins get `Access-Control-Allow-Origin: <origin>`,
  `Vary: Origin`, and `Access-Control-Expose-Headers: ETag, Content-Range, Content-Length,
  Accept-Ranges, X-Mutation-Replayed`.
- **Preflight** `OPTIONS` (no auth): `204`, `Access-Control-Allow-Methods: GET, HEAD, PUT,
  POST, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type, If-Match,
  If-None-Match, X-Mutation-Id, Range`, `Access-Control-Max-Age: 600`.
- **Auth**: `Authorization: Bearer <token>` on every route. Missing/wrong/revoked →
  `401 unauthorized` with `WWW-Authenticate: Bearer`. After **10 failures within 60 s**, every
  attempt (valid token or not) gets `429 rate_limited` with `Retry-After: <s>` and
  `retryAfter` in the body, until the window moves on.
- **Errors** are JSON: `{ "error": "<code>", "message": "<text>", ...extra }`.
- **Paths** are POSIX, relative to the root, case preserved: `scenes/main.pix3scene`. Refused
  with `400 bad_path`: empty, absolute (`/…`), backslashes, a drive prefix (`C:`), NUL, empty
  segments (leading/trailing/double `/`), `.` or `..` segments. A server-private path (see
  above) → `403 reserved_path`.
  `?path=` is percent-decoded **exactly once** (a literal `%2e%2e` after that one decoding is a
  file name, not `..`); JSON bodies are not decoded. **No operation passes through a symlink**:
  a symlink anywhere on the path, parents of a path being created included, →
  `403 symlink`. A file where a parent directory is expected → `409 not_a_directory`.

### Revision set, manifest and `revision`

The **revision set** is what an export ships (the walk of `ProjectBuildService`): every file under
the root except inside directories named `node_modules`, `.git`, `.yalc`, `.vscode`, `.idea`,
`dist`, `build`, `out`, `coverage`, `.cache` (at any depth) and `.pix3/` at the root. A *file*
named like one of those is included. Symlinks are neither listed nor followed.

`revision` = lowercase hex sha256 of the UTF-8 text formed by the lines `<path>:<sha256>` of every
**file** of the set, sorted by JavaScript string comparison (UTF-16 code units), joined with `\n`,
no trailing newline. Directories do not contribute. (Empty set → sha256 of the empty string.)

### Routes

#### `GET /ws/manifest`

A **full scan** of the disk (hashes cached by inode + size + mtime), so it also reconciles
anything the watcher missed — differences it finds are broadcast as a `change` frame first.

```json
{
  "workspaceId": "…",
  "serverSession": "…",
  "revision": "<hex>",
  "seq": 12,
  "files": [
    { "path": "scenes", "kind": "dir", "size": 0, "mtime": 1790373745915 },
    { "path": "scenes/main.pix3scene", "kind": "file", "size": 9, "mtime": 1790373745915, "sha256": "<hex>" }
  ]
}
```

`files` is sorted by path; `mtime` is integer epoch milliseconds; `sha256` is present on every
file and absent on directories. Not an atomic snapshot of a folder others keep writing to.

`files` is the revision set **plus** the non-private part of `.pix3/` (`.pix3` itself as a `dir`,
then e.g. `.pix3/protected.json`, `.pix3/recovery/…`), so a client can list and find its
bookkeeping the same way it would in a local folder. `revision` is computed from the revision set
only: a client recomputing it from `files` must leave out every path under `.pix3/`.

#### `GET /ws/file?path=<p>` (and `HEAD`)

Raw bytes. Headers: `Content-Type` (by extension; unknown → `application/octet-stream`),
`Content-Length`, `ETag: "<sha256 of the bytes>"`, `Accept-Ranges: bytes`,
`Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`.

- `If-None-Match: "<sha256>"` (list, `W/` and `*` accepted) → `304` with the `ETag`, no body.
- `Range: bytes=a-b` | `bytes=a-` | `bytes=-n` (one range) → `206` with
  `Content-Range: bytes a-b/size`; unsatisfiable → `416` with `Content-Range: bytes */size`.
  Several ranges or an unparsable header → the whole file, `200`.
- A directory → `400 not_a_file`; missing → `404 not_found`.

#### `PUT /ws/file?path=<p>`

Body = the new bytes (≤ 1 GiB). Written to `.pix3/tmp/`, then renamed over the target (atomic on
one filesystem; the file mode of a replaced file is kept). Missing parent directories are created.

- `If-Match: "<baseHash>"` — optional. Current content hash ≠ base →
  `409 { "error": "base_mismatch", "currentHash": "<hex>" | null, … }` and nothing is written.
  `If-Match: *` = the file must exist.
- `If-None-Match: *` — create only; existing file → `409 { "error": "exists", "currentHash" }`.
- The target is a directory → `409 not_a_file`.
- `X-Mutation-Id` — see *Mutation journal*.

→ `200 { "path": "…", "sha256": "<hex>", "size": 10, "mtime": 1790373745915, "seq": 13 }`

The check and the rename are serialised with the server's other writes, but they are **not** a
compare-and-swap against a process writing the folder directly (the agent): that race remains.

#### `POST /ws/mkdir` — `{ "path": "<p>" }`

Recursive. → `200 { "path", "created": true | false, "seq" }` (`false` = already a directory);
a file in the way → `409 exists`.

#### `POST /ws/delete` — `{ "path": "<p>", "recursive"?: boolean }`

→ `200 { "path", "kind": "file" | "dir", "seq" }`. Missing → `404 not_found`; non-empty
directory without `recursive: true` → `409 not_empty`.

#### `POST /ws/move` — `{ "from": "<p>", "to": "<p>", "overwrite"?: boolean }`

Creates missing parents of `to`. → `200 { "from", "to", "kind": "file" | "dir", "sha256"?, "seq" }`
(`sha256` for files). `to` exists → `409 exists` (unless `overwrite: true` and both are files);
`to` equal to or inside `from` → `400 bad_move`; `from` missing → `404 not_found`.

#### `POST /ws/hash` — `{ "paths": ["<p>", …] }` (≤ 20 000)

Hashes of the disk **now** (for the sync barrier). → `200 { "hashes": { "<p>": "<hex>" | null }, "seq" }`;
`null` = missing or not a file. Any invalid path fails the whole request (`400 bad_path`,
`403 reserved_path`, `403 symlink`).

#### `GET /ws/status`

→ `200 { "workspaceId", "serverSession", "protocol", "cliVersion", "root", "pid", "port",
"revision", "seq", "leased" }`. Accepts the bearer token **or** `X-Pix3-Control: <server.control>`
from `workspace.json` (how another local `pix3` process confirms a live server is the one the file
describes; beyond this route and `GET /ws/revision`, the control secret grants only the agent
lane below — never the file API).

#### `GET /ws/revision`

→ `200 { "revision", "seq", "serverSession" }` — no scan, the table as it is. Bearer token or
`X-Pix3-Control`.

### Mutation journal (`X-Mutation-Id`)

`PUT /ws/file`, `/ws/mkdir`, `/ws/delete`, `/ws/move` accept `X-Mutation-Id: <1–128 chars of
[A-Za-z0-9_.:-]>`. Within one `serverSession`, the first request with an id is applied and its
answer recorded (success **and** failure). A retry with the same id — also while the first is
still in flight — is **not applied again**: it gets the recorded status and body plus
`X-Mutation-Replayed: true` (a PUT retry's body is drained and discarded). The same id on a
different request (other route, path or conditions) → `422 mutation_id_reused`. The journal keeps
the last 2 000 ids and is lost on restart: after a new `serverSession`, the outcome of an
unanswered mutation is unknown and must be checked against the disk, not retried blindly.

### `seq`

One counter per `serverSession`, starting at 0. Every change of the file table takes the next
value: an external change batch (sent as a `change` frame) or one of the server's own mutations
(returned in its response, **not** sent as a frame). So `seq` is monotonic but **not dense** on the
event stream — a gap is a write made through the API, not a lost event. Nothing is replayed: a
client that reconnects gets the current `revision`/`seq` in `hello` and must re-scan
(`/ws/manifest`) if its revision differs.

### WebSocket `/ws/events`

Same Host/Origin rules as HTTP (checked at the upgrade; refused → `403` before the handshake).
**The token is never in the URL.** All frames are JSON text objects; binary frames close the
socket (`1003`).

**Client → server**

| Frame | Meaning |
| --- | --- |
| `{ "type": "auth", "token": "<token>" }` | Must be the **first** frame, within **5 s**. |
| `{ "type": "pong" }` | Answer to `ping`. |
| `{ "type": "ping" }` | Server answers `{ "type": "pong" }`. |
| `{ "type": "lease", "action": "acquire", "leaseId"?: "<id>" }` | Take the free lease; with the previous `leaseId`, resume it during the grace period. |
| `{ "type": "lease", "action": "takeover" }` | Take the lease from whoever holds it. |
| `{ "type": "lease", "action": "release" }` | Give it up. |
| `{ "type": "call-result", "id": "<call id>", "result": { "content": [Block, …], "isError"?: true, "_meta"?: {…} } }` | Answer a `call` (lease holder only). `Block` = `{ "type": "text", "text" }` or `{ "type": "image", "data": "<base64, no data: prefix>", "mimeType": "image/png" }`. `_meta.pix3 = { playRevision, stale }` on observing tools (see the agent lane). |

**Server → client**

| Frame | When |
| --- | --- |
| `{ "type": "hello", "workspaceId", "serverSession", "protocol": 1, "cliVersion", "revision", "seq", "root", "projectId": string \| null, "projectName", "lease": "held" \| "free", "leaseGraceMs": 10000 }` | Right after a valid `auth`. `root` is the server's absolute path, `projectName` is `metadata.projectName` (else the folder name), `projectId` is `metadata.projectId`, `leaseGraceMs` is the lease grace (below). |
| `{ "type": "change", "seq", "revision", "events": [ChangeEvent, …] }` | External changes, debounced ~100 ms (at most ~1 s under a steady stream). `revision` is the revision after the batch. |
| `{ "type": "ping" }` | Every 10 s. A socket silent (no frame at all) for 30 s is terminated. |
| `{ "type": "lease", "state": "granted", "leaseId", "resumed": boolean }` | Lease granted (`resumed: true` = same lease after a reconnect). |
| `{ "type": "lease", "state": "busy", "inGrace": boolean }` | Someone else holds it (`inGrace`: its holder is disconnected but may come back). |
| `{ "type": "lease", "state": "lost", "reason": "taken_over" \| "expired" \| "revoked", "leaseId" }` | Sent to the holder that lost it. |
| `{ "type": "lease", "state": "released" }` | Answer to `release`. |
| `{ "type": "call", "id", "name", "input", "agent"? }` | An MCP tool call for the lease holder. `agent = { name, session, verified: false }` on agent-lane calls: `name` is what the `pix3 mcp` process calls itself (its MCP client's `clientInfo.name`, else `--agent` / `PIX3_AGENT`), `session` a random id per `pix3 mcp` process. Nothing verifies either. |
| `{ "type": "error", "error": "<code>", "message", "id"? }` | `unauthorized`, `auth_timeout`, `rate_limited`, `revoked` (then the socket closes), or `bad_frame`, `unknown_frame`, `not_lease_holder`, `bad_result`, `unknown_call`. |

`ChangeEvent`:

```json
{ "op": "create" | "modify" | "delete" | "rename", "path": "<p>", "kind": "file" | "dir", "sha256"?: "<hex>", "from"?: "<p>" }
```

`sha256` on file `create`/`modify`/`rename`; `from` only on `rename` (a delete + create of the same
content in one batch, when unambiguous). Events are sorted by `path`. A file touched without a
content change produces no event. Changes made **through this API** never appear as events.
Nothing under `.pix3/` produces events, except an outside change of `.pix3/ack.json` (what
`pix3 read` / `pix3 ack` write): it comes as its own frame with one `create` / `modify` /
`delete` event for that path, and the frame's `revision` is unchanged. Clients may also poll it.
Events are hints, not a guarantee of seeing every write — the barrier re-checks with
`/ws/manifest` or `/ws/hash`.

**Close codes**: `4401` unauthorized / auth timeout / revoked, `4429` rate limited, `1003` binary
frame, `1001` server shutting down.

**Lease.** One holder at a time; it is the window that edits and answers MCP calls. When the
holder's socket closes, the lease is kept for a **10 s grace**: the same window reconnecting
sends `acquire` with its `leaseId` and gets `resumed: true` (calls it had been handed are sent
again); anyone else gets `busy` with `inGrace: true`. After the grace, the lease is free and
pending calls fail. The server does **not** announce that expiry: a client answered
`busy {inGrace: true}` should send `acquire` again after `leaseGraceMs` (the editor adds 500 ms,
and falls back to 11 s for a server that omits the field), repeating until `granted` or a
`busy {inGrace: false}`. The editor keeps its `leaseId` per workspace in `sessionStorage`, so a
reloaded tab resumes its own lease; another tab never shares it. On `takeover`, the old holder
gets `lost/taken_over` and calls it had not
answered go to the new holder. On `release`, pending calls fail. The HTTP routes do not check the
lease (v1): a window without it is expected to stay read-only.

**Calls.** `WorkspaceServer.enqueueCall(name, input, timeoutMs = 60 000, extra?) →
Promise<ToolCallResult>` (in process; the agent lane below is its HTTP face). With no lease holder
it resolves at once with an error result (`isError: true`, `relayFailure: 'no_editor'`); otherwise
the call is delivered to the holder (`extra` becomes extra fields of the `call` frame) and the
promise settles with its `call-result`, or an error result on timeout (`relayFailure: 'timeout'`)
or lease loss (`'cancelled'`). A reconnecting holder that resumes its lease gets the calls it had
been handed again, with the same ids — the editor answers a repeated id once.

### Agent lane — `/ws/agent/*`

The routes a local `pix3 mcp --workspace` process drives. **Auth: `X-Pix3-Control: <server.control>`
only** (from `.pix3/workspace.json`, 0600 — a process of the same user; the plan's trust model).
The browser's bearer token is refused (`401 unauthorized`), and so is any request carrying an
`Origin` (`403 forbidden_origin`): browsers never call this lane.

| Route | Answer |
| --- | --- |
| `GET /ws/agent/status` | `/ws/status` fields plus `holder: "connected" \| "grace" \| null`, `projectName`, `projectId`. |
| `GET /ws/agent/tools` | `{ tools: [{name, description, inputSchema}], serverSession }` — the window's own tool definitions for the v1 allowlist (it answers an internal `tools_manifest` call within 5 s). `409 no_editor` without a window. |
| `POST /ws/agent/call` `{ name, input, timeoutMs?, agent? }` | Parks the call for the lease holder and answers when it replies: `200 { result }` (the window's result as is, error results included). `timeoutMs` is clamped to 1–120 s (default 120 s). `409 no_editor` at once when no window holds the lease (message: open `<root>` in Pix3 — File → Connect to Workspace…); `504 no_editor_reply` when it does not answer in time; `409 lease_lost` when the lease ended under the call (on a takeover the call goes to the new holder instead); `429 too_many_calls`. `agent` → the `call` frame's `agent`. |
| `POST /ws/agent/hash` `{ paths }` | Same as `POST /ws/hash`. |
| `POST /ws/agent/expect` `{ expect: { path: sha256 } }` | The agent's expectations against the disk **now**: `{ matchesAgent, differing: [{ path, diskHash \| null, agentHash, recovery, mergeLog? }], hashes, seq }`. `recovery` = the wire path of a file under `.pix3/recovery/<encodeURIComponent(path)>/` whose bytes hash to `agentHash` (every journaled version of that path is hashed), else `null` — a copy is named only when it exists. `mergeLog: true` when `.pix3/merge-log.jsonl` has a line for that path whose `mergedHash`/`hash` is the disk hash, or one no older than the file's mtime minus 5 s — the editor wrote those bytes. |
| `GET /ws/agent/changes?since=<seq>` | Rescans the whole revision set first (the watcher may have missed a write; differences go out as a `change` frame), then `{ since, seq, revision, paths, complete, entries }`: `paths` = distinct revision-set **files** changed after `since` — external writes and writes through the file API alike (`.pix3/` never, directories never); `entries` = one `{ seq, path, origin }` per recorded change, `origin` = `external` (seen by the watcher or this rescan) or `editor` (a mutation through the file API, i.e. the editor window). The server keeps the last 5 000 file changes; `complete: false` = the ring no longer reaches back to `since`, so an empty list proves nothing. |

## `pix3 mcp --workspace` — the live channel

A stdio MCP server the agent starts from its config (`.mcp.json`, `pix3 setup`). It has no port
of its own: it finds the running `pix3 serve` of the project (`--project`, else the nearest
ancestor of the cwd with `pix3project.yaml`) through `.pix3/workspace.json` and confirms it with
`GET /ws/agent/status` + the control secret. When none runs, every tool answers
`no_workspace_server` and stderr says ``Workspace server is not running. Run `pix3 serve` in
<root>``; the next call looks again, so the agent never restarts its MCP server.

**Tools (v1, exactly):** `project_status`, `play_start`, `play_stop`, `play_restart`,
`play_status`, `game_run`, `game_input`, `game_observe`, `read_errors`, `read_logs`,
`viewport_screenshot` (the PNG comes back as an MCP image block), `generate_asset`,
`generate_sfx`, `get_selection`. No scene-mutating tool: the agent edits files. Schemas are the
window's (`GET /ws/agent/tools`), with a static fallback so `tools/list` works before a window
connects (a `notifications/tools/list_changed` follows once a window's schemas are known).
`play_start` / `play_restart` / `game_run` also take `expect: { path: sha256 }` — the sha256 of the
raw bytes of every file the agent wrote.

**The sync barrier** (plan §5 D) runs before `play_start`, `play_restart` and `game_run`:

1. **Agent's expectations.** `expect` is checked against the disk (`/ws/agent/expect`) before
   anything syncs. Any mismatch → `disk_differs_from_agent` with, per file: merged by the editor
   (`mergeLog: true` — re-read it), or overwritten — with `recovery: ".pix3/recovery/…"` only when
   a copy with exactly those bytes exists, else "no copy exists — write the file again". Nothing
   starts. Without `expect` the answer says `agentExpectations: "none"`.
2. **Editor = disk.** The window's internal `sync_barrier` holds autosave (edits accumulate and are
   saved after the run), stops play, runs `syncNow()` (waits for the stabilisation window and the
   script build; re-reads `pix3project.yaml` when the disk holds another version) and returns
   `{loaded: {path: sha256}, errors}` — every open scene/prefab (any path), every source the last
   script build read (the entry scripts **and every module the bundle pulled in**, e.g. `src/**`;
   the hash recorded when the build read it, so nothing is re-read) and `pix3project.yaml`. An open
   scene the editor holds no disk version of is a `load_failed` error, never silently left out. The
   MCP process gives this call 100 s. These hashes (plus `expect`) are compared with `/ws/agent/hash` at that moment;
   a mismatch retries the editor's sync for up to ~5 s. Then: loader/compiler errors →
   `load_failed` (`{file, line, message, kind}`); a file that stays unreadable →
   `pending_external`; hashes that never agree → `sync_timeout` with the differing paths. The
   window then starts the game (`game_run` starts play itself; `play_restart` of a stopped game is
   a start) and answers only once the game is actually running: up to 30 s, as soon as it runs,
   failing fast (`load_failed` with the play-mode error) when play mode stops instead; `startupMs`
   says how long the start took. The MCP process gives the tool call 120 s (the server's cap). The
   hold is released (`sync_release`) after the run.
3. **After the run** (for `game_run` when it finished; for `play_start` / `play_restart` right
   after the start was acknowledged) the verified files are hashed again and
   `/ws/agent/changes?since=<seq of the verification>` is read: `changedDuringRun` and
   `editorWroteDuringRun`.

The answer of a barrier tool:

```json
{
  "revision": { "<path>": "<sha256 of the verified version>" },
  "startupMs": 8123,
  "matchesAgent": true,
  "matchesDisk": true,
  "changedDuringRun": [],
  "editorWroteDuringRun": [],
  "editorChangedSinceAgentWrite": [],
  "result": { "…": "the editor tool's own result" }
}
```

`matchesAgent` is `null` (with `agentExpectations: "none"`) without `expect`; `matchesDisk` is
whether every verified hash still matched the disk at the final check; `changedDuringRun` is what
the barrier did not verify: every file changed meanwhile by someone other than the editor, plus
every verified file whose hash moved between the two checks with no editor write on record
(`changeLogIncomplete: true` when the server's ring did not reach back); `editorWroteDuringRun` is
every file whose only changes since the verification are the editor's own writes through the file
API (e.g. a run report under `design/tests/reports/`) — known to the server, so not a
detection. Both list files only, never directories; `editorChangedSinceAgentWrite` is
the `expect` paths the merge log says the editor wrote after the check. **A green answer without
marks means: at start disk = agent's expectations = verified version; at the final check the
verified hashes match disk; detected changes are listed.** It does not mean the disk did not change
during the run: `v1 → v2 → v1` between the two checks is invisible, and the game reads resources
lazily.

**Observing tools** (`play_status`, `game_input`, `game_observe`, `viewport_screenshot`,
`read_errors`, `read_logs`) neither stop nor sync: `{ revision, stale, result }`, where `revision` is
what the running game was verified against (`null` when play was not started through the barrier)
and `stale: true` when the editor saw an external change during play or a `revision` path's disk
hash moved since. Other tools (`project_status`, `play_stop`, `get_selection`, `generate_*`) answer
with the editor's result as is. `project_status` without a window answers
`{ connected: false, server, editor: null, message }` (not an error).

**Error codes** (every error is `isError: true` with `{ "error": "<code>", "message", … }`):

| Code | When |
| --- | --- |
| `disk_differs_from_agent` | Step 1: the disk does not hold the `expect` versions (`differing[]` with `recovery`, `mergeLog`, `hint`). |
| `sync_timeout` | Step 2: the editor's loaded hashes did not match the disk within ~5 s (`differing[]` with `loadedHash` / `agentHash` / `diskHash`). |
| `load_failed` | Step 2: the loader or the script compiler failed on the current files, or an open scene has no verified version (`errors[]`). At the start: the game was not running within 30 s, or play mode stopped (`result` carries it, with `startupMs`). |
| `pending_external` | Step 2: a file stays unreadable (partial / invalid write); the editor keeps its last good version. |
| `no_editor` | No window holds the lease, it did not answer (`reason: "no_reply"`), or it lost the lease mid-call (`reason: "lease_lost"`). |
| `permission_denied` | `generate_*`: the human denied, or did not answer within 60 s. |
| `no_workspace_server` | No `pix3 serve` runs for the project root. |

Anything else the editor refuses (`unknown_tool`, `agent_disabled` when the human switched the
channel off) is passed through as the editor wrote it.

**Generation permission.** The first `generate_asset` / `generate_sfx` of a connection (server
session + lease + `pix3 mcp` process) opens a prompt in the editor naming the process and what it
calls itself (unverified); the call waits up to 60 s. Allowed → 20 generations, then it asks again.
In memory only: a reconnect, a new `pix3 serve` run, a lease takeover or a new `pix3 mcp` process
resets it; the status-bar Agent pill has a revoke button and switches the channel off.

## MCP configuration and `pix3 setup`

`pix3 new` and `pix3 kit` write the project's `.mcp.json` (Claude Code's project format), **pinned
to the CLI version that wrote it** — never a bare `@pix3/cli`:

```json
{ "mcpServers": { "pix3": { "command": "npx", "args": ["-y", "@pix3/cli@<X.Y.Z>", "mcp", "--workspace"] } } }
```

`pix3 setup [claude|codex]` prints (never runs) the registration for a project without one:
`claude mcp add pix3 -- npx -y @pix3/cli@<X.Y.Z> mcp --workspace` (run in the project folder), and
for Codex a `~/.codex/config.toml` block — `[mcp_servers.pix3]` with `command`, `args` (plus
`--project <root>`, since that config is global) and `tool_timeout_sec = 180`. The Codex keys are
the ones `tools/pix3-agent-bridge` passes to `codex exec -c mcp_servers.pix3.*`; the file form is
best-effort, check `codex mcp --help` of your Codex version.

**Dev mode.** From a checkout of the pix3 repo (the CLI runs from `packages/pix3-cli/src/`), or
with `PIX3_CLI_DEV=1`, both write `node <repo>/packages/pix3-cli/src/index.ts mcp --workspace`
instead, so the channel can be tried before that version is on npm. `PIX3_CLI_DEV=0` forces the
pinned form.
