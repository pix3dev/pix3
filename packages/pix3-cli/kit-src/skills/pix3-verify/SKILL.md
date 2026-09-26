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

- `files` — every scene validated and every script type-checked, with the **sha256 of its raw
  bytes**. These are the hashes `expect` and `pix3 ack --sha256` take.
- `diagnostics` — one list: `{ severity, code, file, line?, nodeId?, path?, message, fix? }`.
- `typecheck` — `{ ok, errors, tsconfig, mode, files, typescript }`; tsc errors are `E_TYPE`
  diagnostics in the list above.
- `mergeLog` — the newest `.pix3/merge-log.jsonl` entries (section 2).
- `kit` — `{ version, cliVersion, upToDate }`: `pix3 kit --update` when it is stale.

The first `check` on a machine may install TypeScript once into `~/.pix3/typescript/` (it
prints the `npm install` it runs; `--offline` refuses and prints the command instead).

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
you write the same number the human chose. (`pix3 ack <file> --sha256 <hash>` confirms a
version whose hash you took from `pix3 check --json` without printing it again.)

## 3. Live channel — run the game yourself

Available when the human runs `pix3 serve` in the project and connects the editor to it
(File → Connect to Workspace…); your MCP client starts `pix3 mcp --workspace` from `.mcp.json`
(`pix3 setup claude|codex` prints the registration for a client without it). Without a server
every tool answers `no_workspace_server`; without a connected window, `no_editor`.

The 14 tools:

{{generated:mcp-tools}}

The loop after a batch of edits:

1. `pix3 check --json` → take the `sha256` of every file you wrote from `files`.
2. `game_run` (or `play_restart`) with `expect: { "<path>": "<sha256>", … }` — the run starts
   only if the disk holds exactly those versions and the editor loaded them.
3. Green = no error, `matchesAgent: true`, `matchesDisk: true`, empty `changedDuringRun`. Then
   `read_errors`, `game_observe` / `viewport_screenshot` to see what happened.
4. `disk_differs_from_agent` with `mergeLog: true` → the editor merged your file with a human
   edit: `pix3 read` it (section 2). With `recovery` → someone overwrote it; the named file under
   `.pix3/recovery/` holds your version. Otherwise write the file again.

The contract, as the CLI documents it:

{{include:packages/pix3-cli/README.md#`pix3 mcp --workspace` — the live channel}}

### MCP configuration

{{include:packages/pix3-cli/README.md#MCP configuration and `pix3 setup`|only}}

## 4. Report honestly

A file that passes `check` loads and compiles. It is not a game that works. End the turn
with:

- what you changed (files), and whether `pix3 check` was green;
- whether you ran it (`game_run` result) — or **what the human should do to see it**: "press
  Play in `scenes/main.pix3scene`, tap the gold stars — the combo label top-right should count
  x2, x3";
- what you could not verify (behaviour, feel, anything timing-dependent);
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
