---
name: pix3-verify
description: How to check and run a Pix3 change — `pix3 check` / `pix3 validate` / `pix3 read`, the diagnostic codes, reading merge-log entries (the editor kept a human's value over yours), the live channel (`pix3 serve` + `pix3 mcp --workspace`, `game_run` with `expect` hashes, the barrier's answer fields and error codes), and how to report what was and was not verified. Use after every batch of edits to .pix3scene or scripts/*.ts, and before telling the user a change is done.
---

<!-- Pix3 agent kit {{version}} -->
# Verify a change

Leave files that load and type-check, run the game when the live channel is there, and tell
the human exactly what to press and what they should see.

## 1. `pix3 check` after every batch

```bash
pix3 check            # validate (both levels) + tsc over the scripts + merge-log + versions
pix3 check --json     # the same, machine-readable
pix3 validate [paths] [--json]   # scenes/prefabs only, no type-check
```

If `pix3` is not on your PATH, run the pinned one from `.mcp.json`: `npx -y @pix3/cli@{{version}} check`.

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
| `E_TYPE` | A TypeScript error in a script (`TS2339: Property … does not exist …`) |
| `E_TYPECHECK_UNAVAILABLE` | TypeScript could not be installed — run the printed command |
| `E_DEPENDENCIES_MISSING` | A project with its own `tsconfig.json` and no `node_modules` — `npm install`; tsc was skipped |
| `W_RUNTIME_VERSION_MISMATCH` / `W_RUNTIME_NOT_INSTALLED` | A project with its own `tsconfig.json` type-checks against its own `node_modules/@pix3/runtime` — `npm install` it at the CLI's version |
| `W_KIT_OUTDATED` | This kit is older than the CLI — `pix3 kit --update` |

`pix3 validate --help` and `pix3 check --help` list every code. Level 2 of validate compiles
and loads your scripts to check the properties of `user:` components; with `--no-hydrate` (or
when scripts cannot be loaded) those are **not** checked — say so if your change depends on them.

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

`check` prints `note: … read confirmation for a version the editor has not recorded — ignored`
as a note, not a merge-log line: your `pix3 read` named bytes the editor has no record of
having loaded or written (e.g. a version that was on disk only between two of its polls).
Nothing was lost and nothing is protected by it; no action unless a KEPT line follows. (`pix3 ack <file> --sha256 <hash>` confirms a
version whose hash you took from `pix3 check --json` without printing it again.)

## 3. Live channel — run the game yourself

Available when the human runs `pix3 serve` in the project and connects the editor to it
(File → Connect to Workspace…); your MCP client starts `pix3 mcp --workspace` from `.mcp.json`
(`pix3 setup claude|codex` prints the registration for a client without it). Without a server
every tool answers `no_workspace_server`; without a connected window, `no_editor`.

The 14 tools:

{{generated:mcp-tools}}

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
  `newErrors` count, then `read_errors` when it is not 0.
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
- **`tap` holds the pointer down 700 ms by default** (so a `Button2D` sees a real press). For
  fast repeated hits — a combo window, a rhythm check — pass `holdMs` (e.g. `holdMs: 50`) and a
  short `wait` between taps; `frames` instead of `ms` / `holdMs` counts game ticks.
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
- `revision` is the running game's file → hash map: every open scene, every script the build
  read, `pix3project.yaml` — it can run to hundreds of lines. Check `stale` and the match
  flags; never paste `revision` into a report.
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

{{include:packages/pix3-cli/README.md#`pix3 mcp --workspace` — the live channel}}

### MCP configuration

{{include:packages/pix3-cli/README.md#MCP configuration and `pix3 setup`|only}}

## 4. Report honestly

A file that passes `check` loads and compiles. It is not a game that works. End the turn
with:

- what you changed (files), and whether `pix3 check` was green;
- whether you ran it (the barrier answer, and which pattern: `game_run` predicates or
  `game_input` + observed text / log markers) — or **what the human should do to see it**:
  "press Play in `scenes/main.pix3scene`, tap the gold stars — the combo label top-right should
  count x2, x3";
- what you could not verify (feel, audibility, small shakes, anything the channel cannot see);
- placeholders you left.

If the human reports an error from the editor, ask for the exact text (the editor's console
or the load error shown on the scene), fix the first one, and check again.

## Known gaps

- `pix3 check` shows the newest merge-log entries, not only the ones since your last write —
  compare their age with when you wrote.
- The barrier verifies the open scenes and the built scripts; prefabs and assets the game loads
  lazily are only caught afterwards, in `changedDuringRun`.
- `.pix3/kit-manifest.json` (how `pix3 kit --update` knows which files are still the kit's) is
  in the gitignored `.pix3/`: on a fresh clone every kit file counts as edited and is skipped.
