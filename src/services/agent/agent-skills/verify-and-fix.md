# Skill: verify-and-fix

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> *process* to the task if you have a better plan.

How to check that what you built actually runs, and how to fix it when it doesn't. Never
declare a feature done without running it.

## The loop

0. **Edit with `str_replace`, not a full `fs_write`.** To change existing code, replace the exact
   lines you mean to change with `str_replace` (fails loudly if the anchor isn't unique). A full
   `fs_write` rewrite risks silently dropping or reverting the rest of the file — reserve it for
   creating a file. Never re-emit a whole script to flip one sign or constant.
1. **Compile scripts** after editing anything under `scripts/`: `compile_scripts` (fast syntax
   check). If it reports an error, fix that file and repeat. Then `check_scripts` for
   TypeScript type errors (things esbuild misses — e.g. assigning to the read-only
   `position`/`rotation`/`scale`, wrong argument types, bad imports).
2. **Run it**: `play_start`, then `play_status`. Give it a moment, then `read_errors` (runtime
   errors: thrown exceptions, rejections) and `read_logs` (log output). A clean run has no
   captured errors.
2b. **Prove the behaviour** — a clean compile is NOT proof the change works. Drive it with
   `game_input` (or `game_observe` + `sampleMs` for self-movers), then **read `verdict` first** —
   it fuses every signal into one line. `moved:false` does NOT mean the game is dead: a spawner,
   projectile pool, or HUD reacts without its container ever moving.
   - **Movers** (car, player): `{steps:[{type:'key',code:'KeyW',ms:800}],expect:{PlayerCar:'forward'}}`
     → read `observed.PlayerCar.directionOk`. Do NOT trust `moved:true` alone — a car driving
     sideways/backwards is still `moved:true`; check `alignForward` (≈1 forward, ≈0 sideways, ≈−1 back).
   - **Spawners / shooters / pools / HUD** (a container that fires or holds a score, e.g.
     `Cannonballs`): its position never changes, so `moved:false` is normal and meaningless.
     Watch it and assert `expect:{Cannonballs:'activity'}`, then read `observed.Cannonballs.activity`:
     `spawned`/`removed` children, `visibleChildPeak` (pools recycle ammo by toggling visibility —
     count of shots in flight, not position), `maxChildDistance` (a projectile flew while the
     spawner sat at 0,0). Transients that spawn AND die inside the window are caught by the window
     recorder — endpoints alone would miss them.
   - **Transient / interaction-gated visual effects** (hover states, hover-scale, press
     effects, `core:PunchScale`, `core:PopIn`, fades, flashes, shakes): verify by STATE, never
     by a separate screenshot. A `viewport_screenshot` taken after `game_input` returns ALWAYS
     shows the resting state — the gesture ended and the effect lerped back before the
     screenshot call even started. Reshooting will not fix this; it is structural.
     Instead, trigger and measure in ONE `game_input` call:
     `{steps:[{type:'hover',target:'Play Button',ms:900}],expect:{'Play Button':'activity'}}`
     → read `observed['Play Button'].scaleDelta.ratio` (endpoint, e.g. ≈1.08 for a hover-scale)
     and `activity.maxScaleDelta` / `activity.opacityRange` (window peaks — these catch a
     PunchScale/PopIn/flash that fired AND settled back inside the window). For press effects
     use a `tap` with a generous `holdMs` and read the same fields. Hover persists after the
     call (the synthetic pointer stays put), so to prove the return-to-rest half, hover away —
     `{type:'hover',x:<empty area>,y:<empty area>}` — and check scale returns to base.
     Screenshots are for STATIC properties only: layout, colors, placement.
   - **Game state**: when a GameDebugProvider is registered the result carries `game.changed`
     (ammo/score/wave diff) — often the clearest proof of all. If your game has none, register one
     (see the game-prototype skill) so gameplay is legible to state, not screenshots.
3. **Look at it** (optional but valuable): `viewport_screenshot` — while the game is running it
   captures the RUNNING GAME, otherwise the edit-mode viewport (check `view` in the result;
   `source:"game"|"editor"` forces one). In edit mode the user's camera may be zoomed/scrolled
   anywhere, so pass `frame:"all"` to fit the whole scene, `frame:"selection"`, or `nodeId` to
   zoom onto one node (add `isolate:true` when other content covers it); framing is temporary and
   never moves the user's camera. If your model can't see images, use `analyze_image` with
   `source:"viewport"` (same auto-routing) — ask e.g. "are the menu buttons visible and inside
   the screen?".
   Do NOT use screenshots to verify transient/hover/press effects — see 2b: by the time a
   separate screenshot runs, the effect is back at rest, and reshooting in a loop proves
   nothing. (Exception: a hover state deliberately left active by the last `hover` step is
   still on screen and MAY be screenshotted for a visual once the state delta already passed.)
4. **Fix** the first error, then repeat. Stop play mode (`play_stop`) before editing.
5. **When you're done, STOP play mode (`play_stop`).** Once you've gathered the
   verification you need (or finished iterating), never leave the game running —
   a live play session keeps ticking in the background (spawners, physics,
   audio, rAF) and burns CPU/GPU indefinitely. Confirm `play_status` reports it
   stopped before you report back to the user.

## Common runtime problems and fixes

- **"Cannot read properties of undefined (reading 'scene'/'input')"** — a script used
  `this.scene` / `this.input` before the scene was ready, or in an editor preview. Guard with
  `if (!this.scene) return;` at the top of `onUpdate`.
- **A component threw and got auto-disabled** — the engine disables a component that throws in
  `onStart`/`onUpdate` and logs it. `read_errors` shows the throw; fix the script, re-enable
  via `set_component_property` `enabled: true` (or re-add), and replay.
- **"Nothing happened" after input** — before concluding the input was dead, re-read the
  `verdict` and `activity`/`game.changed` in the result. The classic false negative: you tapped
  fire, watched the shot *container* (which never moves), saw `moved:false`, and assumed the tap
  missed — but `activity.visibleChildPeak`/`spawned` or `game.changed` shows the shots really
  fired. Only if `verdict` says NO ACTIVITY is the input actually not reaching gameplay.
- **Genuinely dead input** — `read_errors` first: a component that threw was auto-disabled and
  will not tick again until fixed and re-enabled. Then check the script is actually attached
  (`node_inspect` the node → look at `components`) and `enabled`. For taps use
  `this.input?.pointerEvents.some(e => e.type === 'down')`. For keyboard, match on `event.code`
  (`'KeyW'`, `'ArrowUp'`) — `event.key` is case-sensitive (`'ArrowUp'`, never `'arrowup'`).
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
- **A hover/press/juice effect "doesn't work" but screenshots look normal** — screenshots taken
  after `game_input` always show the resting state (transient effects reset when the gesture
  ends). Verify with a state delta instead: `hover` (or `tap` with `holdMs`) the node and read
  `scaleDelta`/`scaled`/`opacityDelta` + `activity.maxScaleDelta`/`activity.opacityRange` in the
  result. If those are flat, the effect really didn't fire — check the script is attached and
  reads `isHovering`/signals, and `read_errors` for an auto-disabled component.
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
