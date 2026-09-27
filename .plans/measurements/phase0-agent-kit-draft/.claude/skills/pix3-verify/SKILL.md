---
name: pix3-verify
description: How to check a Pix3 change without running the game — `pix3 check` / `pix3 validate` / `pix3 read`, reading merge-log entries (the editor kept a human's value over yours), the manual pass to do when the pix3 CLI is not installed, and how to report what was and was not verified. Use after every batch of edits to .pix3scene or scripts/*.ts, and before telling the user a change is done.
---

# Verify a change

You cannot run the game. The human can. Your job is: leave files that load and compile,
then tell the human exactly what to press and what they should see.

## 1. `pix3 check` after every batch

```bash
pix3 check            # tsc over scripts/ + everything validate does + new merge-log entries
pix3 check --json     # same, machine-readable; also prints the hash of each file checked
pix3 validate [paths] [--json]   # scenes/prefabs only, no tsc
```

Exit code 1 = at least one **error**. Fix every error before reporting; warnings (off-screen
nodes, zero size, unused assets, old schema version) are for judgement.

Errors it reports, and what they usually mean:

| Error | Usual cause / fix |
| --- | --- |
| YAML does not parse | Bad indentation, unquoted `#colour`, a `:` inside an unquoted string |
| unknown `type:` (with nearest name) | Typo in the node type — use the suggested name |
| unknown component | `user:X` with no exported `class X extends Script` that has `static getPropertySchema()` in `scripts/`; or a `core:` name that does not exist |
| unknown property | Key not in that node's / script's schema — check `pix3-nodes` or the script |
| wrong type / out of range | `"10"` for a number, a colour without quotes, an enum value not in the list |
| missing `res://` file | Path typo, or the asset was never written |
| missing / cyclic prefab, duplicate id | Fix the `instance:` path; a prefab file needs exactly one root; ids are unique |
| emoji-as-art | A `label`/`text` that is only emoji — use a sprite or `ColorRect2D` |
| tsc errors in `scripts/` | Read-only transform assignment, wrong import, wrong argument types |

Level-1 validation does not check the **properties** of `user:` components (only that the
script exists); say so if your change depends on them.

## 2. Merge-log: the editor kept the human's value

The human edits the same files in the editor. When you write a value over one the human set
after your last read, the editor keeps the human's value and logs it to
`.pix3/merge-log.jsonl`; `pix3 check` prints those entries.

When you see one:

1. `pix3 read <file>` — prints the current file and records that you have read this version.
2. Decide: is your value still intended given what the human did? If yes, write it again —
   it now sticks. If unsure, ask the human (that is your one question this turn).

Without step 1 the editor keeps restoring the human's value on every write you make, even
if you write the same number the human chose.

## 3. If `pix3` is not installed — the manual pass

This draft kit ships before the CLI. If `pix3` is "command not found", do NOT skip the check:
re-read every file you wrote this turn and go through this list.

Scenes (`.pix3scene`):

- [ ] It parses as YAML in your head: consistent 2-space indentation, list items under
      `root:` / `children:` / `components:` start with `- `.
- [ ] Every colour is a **quoted** hex string (`"#ff4d6d"`).
- [ ] Every new node has `id`, `type` (or `instance`), `name`; the id is unique in the file
      and not a renamed stable id from `design/recipe.md`.
- [ ] Every `type:` is spelled exactly as in `pix3-nodes` (case-sensitive: `ColorRect2D`,
      `Label2D`, `Group2D`).
- [ ] Every property key is one listed for that node type in `pix3-nodes`, or copied from
      an existing node of the same type in the project.
- [ ] 2D placement is `transform: { position: [x, y], scale: [1, 1], rotation: deg }`, inside
      the 1080 x 1920 design (|x| ≤ 540, |y| ≤ 960) unless meant off-screen.
- [ ] Every `res://` path points at a file that exists (list the folder to confirm).
- [ ] An `instance:` node has no `type`, no `components`, no `children`; the prefab file has
      exactly one root node. Overlay instances keep `visible: false`.
- [ ] Components: `type: user:<ExportedClassName>` matching a class in `scripts/`; `config`
      keys match that script's `getPropertySchema()` names.
- [ ] No `label:` / `text:` that is only emoji.

Scripts (`scripts/*.ts`):

- [ ] `export class X extends Script`, constructor `(id: string, type: string)` calling
      `super(id, type)`, and a `static getPropertySchema()` returning
      `{ nodeType, properties: [...], groups: {...} }` — every property with `setValue`.
- [ ] Imports only from `@pix3/runtime`, `three`, or `./Sibling`.
- [ ] No assignment to `position` / `rotation` / `scale`; no `as any`.
- [ ] Every `findNode(...)` result is null-checked; `this.scene` is guarded.
- [ ] No unused locals/parameters (prefix intentionally unused ones with `_`).
- [ ] Signal names match what the emitter emits (grep them).

## 4. Report honestly

A file that passes `check` loads and compiles. It is not a game that works. End the turn
with:

- what you changed (files), and whether `pix3 check` was green or you did the manual pass;
- **what the human should do to see it**: "press Play in `scenes/main.pix3scene`, tap the
  gold stars — the combo label top-right should count x2, x3";
- what you could not verify (behaviour, feel, anything timing-dependent);
- placeholders you left.

If the human reports an error from the editor, ask for the exact text (the editor's console
or the load error shown on the scene), fix the first one, and check again.
