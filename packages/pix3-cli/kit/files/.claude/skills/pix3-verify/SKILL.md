---
name: pix3-verify
description: How to check and run a Pix3 change — `pix3 check` / `pix3 validate` / `pix3 read`, the diagnostic codes, reading merge-log entries (the editor kept a human's value over yours), the live channel (`pix3 serve` + `pix3 mcp --workspace`, `game_run` with `expect` hashes, the barrier's answer fields and error codes), and how to report what was and was not verified. Use after every batch of edits to .pix3scene or scripts/*.ts, and before telling the user a change is done.
---

<!-- Pix3 agent kit 1.6.2 -->
# Verify a change

Leave files that load and type-check, run the game when the live channel is there, and tell
the human exactly what to press and what they should see.

## 1. `pix3 check` after every batch

```bash
pix3 check            # validate (both levels) + tsc over the scripts + merge-log + versions
pix3 check --json     # the same, machine-readable
pix3 validate [paths] [--json]   # scenes/prefabs only, no type-check
pix3 smoke scenes/main.pix3scene # then: run the game headless for 120 frames, report what threw
pix3 tree [scene]                # outline of a scene (or of the project) instead of reading it
```

If `pix3` is not on your PATH, run the pinned one from `.mcp.json`: `npx -y @pix3/cli@1.6.2 check`.

Exit code 1 = at least one **error**. Fix every error before reporting; warnings (off-screen
nodes, zero size, unused assets, out-of-range values) are for judgement.

`--json` answers `{ ok, errorCount, warningCount, files, diagnostics, notes, typecheck,
mergeLog, kit, … }`:

- `files` — every scene validated and every script type-checked, as
  `[{ "file": "scenes/main.pix3scene", "sha256": "…" }]` (the key is `file`, not `path`) — the
  **sha256 of its raw bytes**. These are the hashes `expect` and `pix3 ack --sha256` take.
- `diagnostics` — one list: `{ severity, code, file, line?, nodeId?, path?, message, fix? }`.
- `typecheck` — `{ ok, errors, tsconfig, mode, files, typescript, skipped }`; tsc errors are
  `E_TYPE` diagnostics in the list above; `skipped` says why tsc did not run at all.
- `mergeLog` — the newest `.pix3/merge-log.jsonl` entries (section 2).
- `kit` — `{ version, cliVersion, upToDate }`: `pix3 kit --update` when it is stale.

The first `check` on a machine may install TypeScript once into `~/.pix3/typescript/` (it
prints the `npm install` it runs; `--offline` refuses and prints the command instead).

**A project with its own `package.json` needs `npm install` before `pix3 check` can
type-check.** Such a project has its own `tsconfig.json` and type-checks against its own
`node_modules`; without them `check` reports one `E_DEPENDENCIES_MISSING` (fix: `npm install`)
and skips tsc — the scenes are still validated. Run `npm install` once, then `check` again.

Codes and what they usually mean:

| Code | Usual cause / fix |
| --- | --- |
| `E_YAML` | Bad indentation, unquoted `#colour`, a `:` inside an unquoted string |
| `E_UNKNOWN_NODE_TYPE` | Typo in the node type — use the suggested name |
| `E_UNKNOWN_COMPONENT` | `user:X` with no exported `class X extends Script` that has `static getPropertySchema()` in `scripts/`; or a `core:` name that does not exist |
| `E_UNKNOWN_PROPERTY` | Key not read for that node / component — check `pix3-nodes`; a flat `horizontalAlign` belongs in `layout:` |
| `E_PROPERTY_TYPE` | `"10"` for a number, a colour without quotes, an enum value not in the list |
| `E_MISSING_RESOURCE` | `res://` path typo, or the asset was never written |
| `E_MISSING_PREFAB`, `E_PREFAB_*`, `E_DUPLICATE_ID` | Fix the `instance:` path; a prefab file needs exactly one root; ids are unique |
| `E_EMOJI_AS_ART` | A `label`/`text` that is only emoji — use a sprite or `ColorRect2D` |
| `E_SVG_INVALID`, `E_SVG_NO_SIZE`, `W_SVG_VIEWBOX_ONLY` | An `.svg` sprite without `xmlns` or without `width`/`height` in px — see the SVG template in `pix3-nodes` |
| `W_SVG_EXTERNAL_REF` | An `.svg` that links a file, URL or font — it will draw without it; inline it |
| `E_TYPE` | A TypeScript error in a script (`TS2339: Property … does not exist …`) |
| `E_TYPECHECK_UNAVAILABLE` | TypeScript could not be installed — run the printed command |
| `E_DEPENDENCIES_MISSING` | A project with its own `tsconfig.json` and no `node_modules` — `npm install`; tsc was skipped |
| `W_RUNTIME_VERSION_MISMATCH` / `W_RUNTIME_NOT_INSTALLED` | A project with its own `tsconfig.json` type-checks against its own `node_modules/@pix3/runtime` — `npm install` it at the CLI's version |
| `W_KIT_OUTDATED` | This kit is older than the CLI — `pix3 kit --update` |

`pix3 validate --help` and `pix3 check --help` list every code. Level 2 of validate compiles
and loads your scripts to check the properties of `user:` components; with `--no-hydrate` (or
when scripts cannot be loaded) those are **not** checked — say so if your change depends on them.

### `pix3 smoke` — when no editor is connected

`pix3 smoke <scene>` (after a green `check`) runs that scene in Node: your scripts compiled, the
scene loaded by the real loader, `--frames N` steps of 1/60 s (default 120). **Name the scene you
changed** — the game is `pix3 smoke scenes/main.pix3scene`. Input is empty, so a menu never
presses PLAY: smoking the menu (the build's entry scene) proves nothing about the game. With no
scene, smoke runs several, one line each and exit 1 if any fails: the top-level scenes your
uncommitted changes reach (git: the scene, a prefab or overlay it instances, a `user:` script it
attaches), else — no git, nothing changed, or a change it cannot trace — every top-level scene,
`scenes/main.pix3scene` first (`--changed` / `--all` force either; `--json` then answers
`{ ok, selection, reason, runs: [one report per scene] }`). Exit 1 lists every
`E_SMOKE_SCRIPT` (a hook threw: script, node, frame — 0 = `onAttach`/`onStart` — and a stack
pointing at your `.ts` line), `E_SMOKE_CONSOLE_ERROR`, `E_SMOKE_UNHANDLED` (a rejected promise
nobody awaited), `E_SMOKE_DOM` (a browser API the headless run lacks — `domAccess` names it; a
browser-only feature, not necessarily a bug: say so). `W_SMOKE_MISSING_RESOURCE` is a `res://`
typo. Exit 2 = it could not run (`E_SMOKE_NO_SCENE`: pass the scene; `E_SMOKE_TIMEOUT`: a loop
that never ends). Nothing is drawn, heard or tapped: a green smoke run proves the game starts and
runs without throwing, not that it plays — report it as exactly that, and tell the human what to
press and what they should see (section 4). With the live channel, `game_run` (section 3) is the
stronger check.

**No live channel: the fallback, in this order** — `pix3 check` (green), then
`pix3 smoke <the scene you changed>` (green), then ask the human to press Play in that scene,
naming what to press and what they should see.

## 2. Merge-log: the editor kept the human's value

The human edits the same files in the editor. When you write a value over one the human set
after your last read, the editor keeps the human's value and logs it to
`.pix3/merge-log.jsonl`; `pix3 check` prints the newest entries, e.g.
`scenes/main.pix3scene  merged: the editor KEPT 1 human value(s) over yours`.

When you see one:

1. `pix3 read <file>` — prints the current file and records that you have read this version
   (`.pix3/ack.json`).
2. Decide: is your value still intended given what the human did? If yes, write it again —
   it now sticks. If unsure, ask the human (that is your one question this turn).

Without step 1 the editor keeps restoring the human's value on every write you make, even if
you write the same number the human chose.

`check` prints `note: … read confirmation for a version the editor has not recorded — ignored
(harmless …)` as a note, not a merge-log line: your `pix3 read` named bytes the editor has no
record of having loaded or written (e.g. a version that was on disk only between two of its
polls). Nothing was lost and nothing is protected by it; no action unless a KEPT line follows,
and it stops printing once the file changes. (`pix3 ack <file> --sha256 <hash>` confirms a
version whose hash you took from `pix3 check --json` without printing it again.)

**A compile error hides level 2.** With `E_SCRIPT_COMPILE` in the list, every scene with `user:`
components is skipped at level 2 — `check` says `SKIPPED: N scene(s) …` and the summary line
reads `level 2 hydrated 0 file(s), N SKIPPED`. Their config/property errors are *missing*, not
passed: fix the compile error, run `check` again, and only then read the rest.

## 3. Live channel — run the game yourself

Available when the human runs `pix3 serve` in the project and connects the editor to it
(File → Connect to Workspace…); your MCP client starts `pix3 mcp --workspace` from `.mcp.json`
(`pix3 setup claude|codex` prints the registration for a client without it). Without a server
every tool answers `no_workspace_server`; without a connected window, `no_editor`.

The 14 tools:

- `project_status` — Whether a Pix3 editor window is connected to this project, what it has open, external versions it has not applied yet, unreadable files, merge conflicts and the latest merge-log entries (why a write of yours did not land as written).
- `play_start` — Enter play mode.
- `play_stop` — Exit play mode.
- `play_restart` — Restart play mode.
- `play_status` — Whether the game is playing, and what the last frame drew (draw calls, visible meshes).
- `game_run` — Run the game frame by frame until a predicate holds (`until`, OR), fails (`fail`) or a budget runs out, or run a stored routine from design/tests/routines (`routine`, `args`).
- `game_input` — Send real input to the running game (steps: tap / key / keys / drag / hover / invoke / wait) and report the reaction; `observe` watches nodes over the window.
- `game_observe` — Read live node state of the running game (by name or id) without sending input.
- `read_errors` — Recent runtime errors captured in the editor (console.error, window errors, rejections), each with an epoch-ms `at`; `since` (epoch ms) returns only newer ones.
- `read_logs` — Recent editor log entries; `since` (epoch ms) returns only newer ones.
- `viewport_screenshot` — A screenshot as an image: the running game while playing, else the editor viewport.
- `generate_asset` — Generate an image with the editor's configured image provider (the user's keys — the editor asks the user to allow this for the session), post-process it and save it into the project.
- `generate_sfx` — Generate a prototype sound effect (WAV under res://sfx/) with the editor's LLM (asks the user to allow this for the session).
- `get_selection` — What the human has selected in the editor right now (node ids, primary, hovered).

The loop after a batch of edits:

1. `pix3 check --json` → take the `sha256` of every file you wrote from `files`
   (`{ file, sha256 }` entries).
2. A barrier tool — `game_run`, `play_start` or `play_restart` — with
   `expect: { "<path>": "<sha256>", … }`: the run starts only if the disk holds exactly those
   versions and the editor loaded them.
3. Green = no error, `matchesAgent: true`, `matchesDisk: true`, empty `changedDuringRun`. Then
   `read_errors`, `game_observe` / `viewport_screenshot` to see what happened.
4. `disk_differs_from_agent` with `mergeLog: true` → the editor merged your file with a human
   edit: `pix3 read` it (section 2). With `recovery` → someone overwrote it; the named file under
   `.pix3/recovery/` holds your version. Otherwise write the file again.
5. `expectation_stale` → the disk held your version when the call started, then moved on
   (the editor merged your write, a human saved, another agent wrote) and the editor already
   holds the new bytes. Not editor lag, and nothing started: `pix3 read` the file, re-run
   `pix3 check --json`, pass the new hashes. `sync_timeout` is the other case — the editor is
   still catching up with a write; call again when the writes are done.

### Two ways to prove behaviour

**Every barrier call stops the game and starts it again from the files on disk.** `game_run`
included: it is always a run from a fresh start, so it can never judge state that an earlier
`game_input` produced — that state is gone before its first frame. Pick the pattern by what
causes the behaviour:

- **(a) Autonomous behaviour** (spawns, timers, physics, a HUD that counts on its own):
  one `game_run` with `expect`, predicates in `until` (any one ends the run as a pass) and
  `fail` (any one ends it as a failure), e.g. `until:
  [{ kind: "nodeProperty", name: "ScoreLabel", path: "text", op: "contains", value: "10" }]`,
  `fail: [{ kind: "newErrors" }]` (a script threw). Read `verdict`, then the result's
  `newErrors` count, then `read_errors` when it is not 0 (pass `since`, the epoch ms you noted
  before the run, or old errors come back too).
  **`game_run` outruns real time**: it steps hundreds of frames in a fraction of a second, so a
  game whose `onStart` awaits something real (a physics WASM module, assets, a fetch) is still
  initialising when the run ends — an empty screenshot or `ready: false` there is not a bug yet.
  Give it real time with `settleMs` (e.g. `2000`) and assert readiness first
  (`until: [{ kind: "gameState", path: "ready", op: "eq", value: true }]`); the report's
  `notes`/`verdict` say `OUTRAN REAL TIME` when a run stepped far faster than real time and the
  game's state never changed.
- **(b) Input-driven behaviour** (taps, keys, combos): `play_start` or `play_restart` with
  `expect` (the barrier, once) → one or more `game_input` calls → `game_observe` / `read_logs`.
  `game_input` and `game_observe` are observing tools: they neither stop nor resync, so the
  state builds up across calls. Do **not** end with `game_run` to "check the result" — it
  restarts the game.

### `game_input` — what the steps really do

- **Coordinates** (`x`, `y` on `tap` / `drag` / `hover`) are the 2D design space the scene
  file uses: origin at the **centre**, **Y up**, the same numbers as a node's `position`. With
  the 2D camera at rest, `{ x: 0, y: 0 }` is the centre of the viewport and the top edge of a
  1080 x 1920 design is `y: 960` — not `(540, 960)` or `(960, 540)`. Coordinates follow the 2D
  camera; a node under a `CanvasLayer2D` (a HUD) is pinned to the screen instead, so for HUD and
  buttons prefer `target: "<node name or id>"`, which projects the node's live position the
  right way for either.
- **`tap` holds the pointer down 80 ms by default** — a tap (a `Button2D` sees the press on one
  tick and the release on a later one). A game that tells a tap from a **hold** (mine while the
  finger is down, charge a shot) needs `holdMs` set to what it expects — the old 700 ms default
  read as a hold and produced "no activity"; a NO ACTIVITY verdict now names the hold it used.
  `frames` instead of `ms` / `holdMs` counts game ticks.
- **One call is capped at 15 s** of requested time (holds + drags + waits); longer answers
  `Input script too long` — split it into several `game_input` calls.
- **Input goes through the engine's `InputService`**: `PointerEvent`s on the game canvas and
  `KeyboardEvent`s on `window`. Scripts that read `this.input` see it. A game that listens for
  DOM `mouse*` / `click` / `touch*` events, keys on `document`, or on a canvas of its own does
  **not** — verify such input by hand.

### Reading the answers

- **Barrier answers** carry `revision`, `startupMs` (how long the game took to start),
  `matchesAgent` / `agentExpectations`, `matchesDisk`, `changedDuringRun`,
  `editorWroteDuringRun`, `editorChangedSinceAgentWrite` and `result` (the editor tool's own
  answer). **Observing answers** are `{ revision, stale, result }`.
- `revision` describes the running game's verified files (every open scene, every script the
  build read, `pix3project.yaml`) **compactly**: `{ files, digest, changed }` — the count, a
  digest of the whole map, and only the entries that changed since the previous answer of your
  `pix3 mcp` process (all of them on the first answer). `fullRevision: true` on any barrier or
  observing call returns the whole `{ path: sha256 }` map; `project_status` →
  `editor.playRevision` has it too while the game plays. Check `stale` and the match flags;
  never paste `revision` into a report.
- `game_observe` nodes carry `size` (`{ width, height }`) and `bounds` (axis-aligned world
  rectangle, rotation ignored) for 2D nodes that have a width/height — enough to tell "on
  screen / overlapping" without a screenshot.
- **Labels and HUD text.** An observed node reports its rendered `text` only at the window's
  **start and end** — `observed.<node>.before.text` / `.after.text` in `game_input`,
  `nodes.<node>.text` (and `movement.<node>.before` / `.after` with `sampleMs` or `frames`) in
  `game_observe`;
  there is no per-frame text timeline. The one-line `verdict` does not count a text change:
  it can say `NO ACTIVITY` while the label went from `x1` to `x3`. For HUD text, read the text
  fields, never the verdict alone.
- **Timing proofs** ("the combo resets after 1 s", "x3 appears on the third hit"): add
  temporary `console.info('[combo] x3')` markers in the script, note the current epoch ms
  before the input, run it, then `read_logs` with `since` set to that value — every console line
  the game prints arrives with its own epoch-ms `timestamp`, so the gaps between markers are the
  timing. **Remove the markers afterwards** and run `pix3 check` again.
- **Movement below ~0.5 units reads as `moved: false`**, and a shake that returns to rest
  inside the window has no endpoint delta at all — a small camera shake is not provable from
  `moved`. Take a `viewport_screenshot` mid-shake or log the offset with a marker.
- **Sound**: synthetic input is not a user gesture, so the browser may keep Web Audio
  suspended; nothing in the answers says whether a sound was heard. Report it as "code path
  verified, audibility not".
- **Latency** (measured in trials): observing calls take about 1 s; a barrier call takes the
  game's startup plus 1–2 s — a small 2D game a few seconds, a heavy 3D game 13–14 s
  (`startupMs` says which). Batch several input steps into one `game_input` rather than many
  calls.

The contract, as the CLI documents it:

A stdio MCP server the agent starts from its config (`.mcp.json`, `pix3 setup`). It has no port
of its own: it finds the running `pix3 serve` of the project (`--project`, else the nearest
ancestor of the cwd with `pix3project.yaml`) through `.pix3/workspace.json` and confirms it with
`GET /ws/agent/status` + the control secret. When none runs, every tool answers
`no_workspace_server` and stderr says ``Workspace server is not running. Run `pix3 serve` in
<root>``; the next call looks again, so the agent never restarts its MCP server.

**Presence.** While it runs, the process announces itself to that server
(`POST /ws/agent/presence`, every 10 s and on start/stop; failures are silent and the next beat
rediscovers a restarted server). That is what tells the editor an agent is attached, so it keeps
the game, the viewport, file polling and reconnects running in a hidden or unfocused tab instead
of pausing them for battery (`AgentKeepaliveService`; the user can switch this off in Settings →
General). `PIX3_PRESENCE_HEARTBEAT_MS` overrides the cadence (tests).

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
   `pending_external`; hashes that never agree → `sync_timeout` with the differing paths — except
   when every difference is an `expect` path whose disk version moved on *after* step 1 while the
   editor already holds what the disk holds (`loadedHash === diskHash !== agentHash`): that is the
   agent's expectation being stale (the editor merged the write with a human edit, a human saved,
   another agent wrote), retrying cannot bring the old bytes back, and it answers
   `expectation_stale` at once. The
   window then starts the game (`game_run` starts play itself; `play_restart` of a stopped game is
   a start) and answers only once the game is actually running: up to 30 s, as soon as it runs,
   failing fast (`load_failed` with the play-mode error) when play mode stops instead; `startupMs`
   says how long the start took (always present in the answer: `null` means no start happened —
   `game_run` found the game already running — never "0 ms"). The MCP process gives the tool call 120 s (the server's cap). The
   hold is released (`sync_release`) after the run.
3. **After the run** (for `game_run` when it finished; for `play_start` / `play_restart` right
   after the start was acknowledged) the verified files are hashed again and
   `/ws/agent/changes?since=<seq of the verification>` is read: `changedDuringRun` and
   `editorWroteDuringRun`.

The answer of a barrier tool:

```json
{
  "revision": { "files": 91, "digest": "<sha256 of the whole map>",
                "changed": { "<path>": "<sha256 of the verified version>" }, "removed?": ["<path>"] },
  "startupMs": 8123,
  "matchesAgent": true,
  "matchesDisk": true,
  "changedDuringRun": [],
  "editorWroteDuringRun": [],
  "editorChangedSinceAgentWrite": [],
  "result": { "…": "the editor tool's own result" }
}
```

`revision` is **compact by default**: the verified map (every open scene, every source the build
read, the manifest — ~90 entries on a real game) used to open every answer in full. Now `files` is
its size, `digest` a sha256 over its sorted `path\0hash` lines (equal digests = equal maps), and
`changed` holds only the entries that are new or different since the **previous answer of this
`pix3 mcp` process** (the whole map on the first answer; `removed` names paths that dropped out).
Pass `fullRevision: true` to any barrier or observing tool for the plain `{ "<path>": "<sha256>" }`
map, or read `editor.playRevision` from `project_status` while the game plays. `startupMs` is
always present: the milliseconds from the start request until the game was running, or `null`
when no start happened (the game was already running, so there was nothing to measure). `matchesAgent` is `null` (with `agentExpectations: "none"`) without `expect`; `matchesDisk` is
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
what the running game was verified against (compact, as above; `null` when play was not started
through the barrier) and `stale: true` when the editor saw an external change during play or a
`revision` path's disk hash moved since. `read_errors` takes `since` (epoch ms) like `read_logs`;
every entry carries its `at`. Other tools (`project_status`, `play_stop`, `get_selection`, `generate_*`) answer
with the editor's result as is. `project_status` without a window answers
`{ connected: false, server, editor: null, message }` (not an error).

**Error codes** (every error is `isError: true` with `{ "error": "<code>", "message", … }`):

| Code | When |
| --- | --- |
| `disk_differs_from_agent` | Step 1: the disk does not hold the `expect` versions (`differing[]` with `recovery`, `mergeLog`, `hint`). |
| `expectation_stale` | Step 2, at once: the disk moved past an `expect` version after step 1 and the editor already matches the disk (`differing[]` with `diskHash` / `agentHash` / `loadedHash`, plus `mergeLog` / `recovery` / `hint` as in step 1). Somebody wrote a newer version — re-read it, re-run `pix3 check --json`, pass the new hashes. Not editor lag. |
| `sync_timeout` | Step 2: the editor's loaded hashes did not match the disk within ~5 s (`differing[]` with `loadedHash` / `agentHash` / `diskHash`) — the editor is still catching up with a write. |
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

### MCP configuration

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

## 4. Report honestly

A file that passes `check` loads and compiles. It is not a game that works. End the turn
with:

- what you changed (files), and whether `pix3 check` was green;
- whether you ran it (the barrier answer, and which pattern: `game_run` predicates or
  `game_input` + observed text / log markers) — or **what the human should do to see it**:
  "press Play in `scenes/main.pix3scene`, tap the gold stars — the combo label top-right should
  count x2, x3";
- what you could not verify (feel, audibility, small shakes, anything the channel cannot see);
- placeholders you left — art (`ColorRect2D`, tinted PNGs, hand-written SVGs) and sound. A sound
  you made with `pix3 sfx` is a real `.wav`, not a placeholder in the file sense, but say it is a
  synthesised stand-in and that you could not listen to it.

If the human reports an error from the editor, ask for the exact text (the editor's console
or the load error shown on the scene), fix the first one, and check again.

## Known gaps

- `pix3 check` shows the newest merge-log entries, not only the ones since your last write —
  compare their age with when you wrote.
- The barrier verifies the open scenes and the built scripts; prefabs and assets the game loads
  lazily are only caught afterwards, in `changedDuringRun`.
- `.pix3/kit-manifest.json` (how `pix3 kit --update` knows which files are still the kit's) is
  in the gitignored `.pix3/`: on a fresh clone every kit file counts as edited and is skipped.
