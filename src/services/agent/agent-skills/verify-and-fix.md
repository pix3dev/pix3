# Skill: verify-and-fix

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> *process* to the task if you have a better plan.

How to check that what you built actually runs, and how to fix it when it doesn't. Never
declare a feature done without running it.

## The loop

1. **Compile scripts** after any `fs_write` to `scripts/`: `compile_scripts` (fast syntax
   check). If it reports an error, fix that file and repeat. Then `check_scripts` for
   TypeScript type errors (things esbuild misses — e.g. assigning to the read-only
   `position`/`rotation`/`scale`, wrong argument types, bad imports).
2. **Run it**: `play_start`, then `play_status`. Give it a moment, then `read_errors` (runtime
   errors: thrown exceptions, rejections) and `read_logs` (log output). A clean run has no
   captured errors.
3. **Look at it** (optional but valuable): `viewport_screenshot` to see edit-mode layout, or
   `analyze_image` with `source:"viewport"` if your model can't see images — ask e.g. "are the
   menu buttons visible and inside the screen?".
4. **Fix** the first error, then repeat. Stop play mode (`play_stop`) before editing.

## Common runtime problems and fixes

- **"Cannot read properties of undefined (reading 'scene'/'input')"** — a script used
  `this.scene` / `this.input` before the scene was ready, or in an editor preview. Guard with
  `if (!this.scene) return;` at the top of `onUpdate`.
- **A component threw and got auto-disabled** — the engine disables a component that throws in
  `onStart`/`onUpdate` and logs it. `read_errors` shows the throw; fix the script, re-enable
  via `set_component_property` `enabled: true` (or re-add), and replay.
- **Nothing moves / input dead** — check the script is actually attached (`node_inspect` the
  node → look at `components`) and `enabled`. For taps use
  `this.input?.pointerEvents.some(e => e.type === 'down')`.
- **A button does nothing** — buttons emit `pressed`/`released`/`click` signals; something must
  `node.connect('pressed', target, handler)`. Check the flow script is attached to a node that
  exists and references the right node ids/names.
- **Sprite looks wrong** (semi-transparent, box background, huge) — an art problem, not code.
  Reprocess the texture with `process_asset` (preset `sprite`). See the `asset-generation` skill.
- **Scene didn't update after editing a `.pix3scene` file** — run `run_command scene.reload`.

## When you're stuck

- Re-read the failing script with `fs_read` — don't guess its contents.
- `read_logs` shows your own `console.log` output from scripts; add logging to narrow it down.
- Report the exact error text to the user with the file/line if you can't resolve it in two
  attempts, and say what you tried.
