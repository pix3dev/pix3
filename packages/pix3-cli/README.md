# @pix3/cli

Command line for Pix3:

```text
pix3 new [<recipe> [dir]] [--name <n>]        create a project from a recipe/template
pix3 mcp [--project <dir>] [--agent <name>]   stdio MCP server for your agent (+ FSA link server)
pix3 serve [--project <dir>] [--port <n>] [--new-token]
                                              serve a project folder to a Pix3 editor
pix3 validate [paths…] [--json]               strict scene check
pix3 read <path>                              print a file and ack its bytes' sha256
pix3 ack <path> --sha256 <hash>               ack a version you read (hash of raw bytes)
```

`read` / `ack` append `{ path, sha256, at }` to `.pix3/ack.json`. The editor, merging the next
version of that file you write, lifts the protection of the manual edits that version contained
and removes the ack (one-shot); see `docs/pix3-specification.md` → "Co-authoring mode".

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
- The whole `.pix3/` directory is unreachable through the API (`403 reserved_path`) and never
  part of the manifest or events.

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
  segments (leading/trailing/double `/`), `.` or `..` segments. `.pix3/…` → `403 reserved_path`.
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
describes; the control secret grants nothing else).

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
| `{ "type": "call-result", "id": "<call id>", "result": { "content": [{ "type": "text", "text": "…" }], "isError"?: true } }` | Answer a `call` (lease holder only). |

**Server → client**

| Frame | When |
| --- | --- |
| `{ "type": "hello", "workspaceId", "serverSession", "protocol": 1, "cliVersion", "revision", "seq", "root", "projectId": string \| null, "projectName", "lease": "held" \| "free" }` | Right after a valid `auth`. `root` is the server's absolute path, `projectName` is `metadata.projectName` (else the folder name), `projectId` is `metadata.projectId`. |
| `{ "type": "change", "seq", "revision", "events": [ChangeEvent, …] }` | External changes, debounced ~100 ms (at most ~1 s under a steady stream). `revision` is the revision after the batch. |
| `{ "type": "ping" }` | Every 10 s. A socket silent (no frame at all) for 30 s is terminated. |
| `{ "type": "lease", "state": "granted", "leaseId", "resumed": boolean }` | Lease granted (`resumed: true` = same lease after a reconnect). |
| `{ "type": "lease", "state": "busy", "inGrace": boolean }` | Someone else holds it (`inGrace`: its holder is disconnected but may come back). |
| `{ "type": "lease", "state": "lost", "reason": "taken_over" \| "expired" \| "revoked", "leaseId" }` | Sent to the holder that lost it. |
| `{ "type": "lease", "state": "released" }` | Answer to `release`. |
| `{ "type": "call", "id", "name", "input" }` | An MCP tool call for the lease holder. |
| `{ "type": "error", "error": "<code>", "message", "id"? }` | `unauthorized`, `auth_timeout`, `rate_limited`, `revoked` (then the socket closes), or `bad_frame`, `unknown_frame`, `not_lease_holder`, `bad_result`, `unknown_call`. |

`ChangeEvent`:

```json
{ "op": "create" | "modify" | "delete" | "rename", "path": "<p>", "kind": "file" | "dir", "sha256"?: "<hex>", "from"?: "<p>" }
```

`sha256` on file `create`/`modify`/`rename`; `from` only on `rename` (a delete + create of the same
content in one batch, when unambiguous). Events are sorted by `path`. A file touched without a
content change produces no event. Changes made **through this API** never appear as events.
Events are hints, not a guarantee of seeing every write — the barrier re-checks with
`/ws/manifest` or `/ws/hash`.

**Close codes**: `4401` unauthorized / auth timeout / revoked, `4429` rate limited, `1003` binary
frame, `1001` server shutting down.

**Lease.** One holder at a time; it is the window that edits and answers MCP calls. When the
holder's socket closes, the lease is kept for a **10 s grace**: the same window reconnecting
sends `acquire` with its `leaseId` and gets `resumed: true` (calls it had been handed are sent
again); anyone else gets `busy` with `inGrace: true`. After the grace, the lease is free and
pending calls fail. On `takeover`, the old holder gets `lost/taken_over` and calls it had not
answered go to the new holder. On `release`, pending calls fail. The HTTP routes do not check the
lease (v1): a window without it is expected to stay read-only.

**Calls.** In-process API for a later `pix3 mcp --workspace`: `WorkspaceServer.enqueueCall(name,
input, timeoutMs = 60 000) → Promise<ToolCallResult>`. With no lease holder it resolves at once
with an error result (`isError: true`); otherwise the call is delivered to the holder and the
promise settles with its `call-result`, or an error result on timeout.
