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
2b. **Prove the behaviour** — a clean compile is NOT proof the change works. For anything that
   moves or responds to input, drive it: `game_input` with `expect` (e.g.
   `{steps:[{type:'key',code:'KeyW',ms:800}],expect:{PlayerCar:'forward'}}` → read
   `observed.PlayerCar.directionOk`), or `game_observe` with `sampleMs` for self-movers (AI).
   Do NOT trust `moved:true` alone — a car driving sideways or backwards is still `moved:true`;
   check `alignForward` (≈1 forward, ≈0 sideways, ≈−1 backward) / `directionOk`.
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
- **Nothing moves / input dead** — first `read_errors`: a component that threw was
  auto-disabled and will not tick again until fixed and re-enabled. Then check the script is
  actually attached (`node_inspect` the node → look at `components`) and `enabled`. For taps
  use `this.input?.pointerEvents.some(e => e.type === 'down')`. For keyboard, match on
  `event.code` (`'KeyW'`, `'ArrowUp'`) — `event.key` is case-sensitive (`'ArrowUp'`, never
  `'arrowup'`).
- **`Cannot assign to read only property 'position'/'rotation'`** — three.js transforms are
  read-only references; use `node.position.set(x, y, z)` / `node.rotation.z = radians`. Never
  hide this with `as any` — that's what `check_scripts` exists to catch.
- **Moves, but in the WRONG direction (sideways / backwards / turns the wrong way)** — this is a
  math bug, not a "does it move" bug, and blind sign-flipping never converges. Verify with
  `game_input`/`game_observe` and read `alignForward`/`alignRight`, don't guess. `rotation.z`
  rotates the node's local +Y ("nose") to world `(-sin θ, cos θ)` and local +X to `(cos θ, sin θ)`,
  counter-clockwise (with world +Y up). So a car whose nose is +Y moves forward with
  `vx = -Math.sin(rot.z)*speed`, `vy = Math.cos(rot.z)*speed`; an AI aiming its nose along a
  velocity `(dx, dy)` sets `rotation.z = Math.atan2(-dx, dy)`. Using `+sin` (or `atan2(dx, dy)`)
  mirrors X → the body slides sideways the moment it turns.
- **A button does nothing** — buttons emit `pressed`/`released`/`click` signals; something must
  `node.connect('pressed', target, handler)`. Check the flow script is attached to a node that
  exists and references the right node ids/names.
- **Sprite looks wrong** (semi-transparent, box background, huge) — an art problem, not code.
  Reprocess the texture with `process_asset` (preset `sprite`). See the `asset-generation` skill.
- **Scene didn't update after editing a `.pix3scene` file** — the editor watches the active
  scene file and reloads automatically (there is no `scene.reload` command); confirm with
  `scene_tree`. Remember a scene `fs_write` replaces the scene wholesale — components added
  earlier via `add_component` are lost unless they are in the YAML.

## When you're stuck

- Re-read the failing script with `fs_read` — don't guess its contents.
- `read_logs` shows your own `console.log` output from scripts; add logging to narrow it down.
- After two failed fix attempts, consult the advisor (if `ask_advisor` is available): put the
  exact error text, the failing script's source, and what you already tried into `context`.
  Apply its fix, then re-run this loop.
- Report the exact error text to the user with the file/line if you can't resolve it (advisor
  included) — and say what you tried.
