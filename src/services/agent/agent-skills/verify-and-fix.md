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
1. **Compile scripts** after editing anything under `scripts/`: `compile_scripts` — it builds,
   registers, *and* type-checks in one call. `ok: false` means either the bundle broke or
   `errorCount` type errors came back in `diagnostics` (read-only `position`/`rotation`/`scale`,
   wrong argument types, bad imports). Fix those files and compile again. **Do not call
   `check_scripts` after a compile** — the same diagnostics are already in the compile result.
2. **Run it**: `play_start`, then `play_status`. Give it a moment, then `read_errors` (runtime
   errors: thrown exceptions, rejections) and `read_logs` (log output). A clean run has no
   captured errors.
2b. **Prove the behaviour** — a clean compile is NOT proof the change works. Drive it with
   `game_input` (or `game_observe` + `sampleMs` for self-movers), then **read `verdict` first** —
   it fuses every signal into one line. `moved:false` does NOT mean the game is dead: a spawner,
   projectile pool, or HUD reacts without its container ever moving. Anything that plays out over
   time — a wave clearing, a death, a score climbing — is judged by `game_run` with an explicit
   success condition, not by watching a window and deciding (see "Time and frames").
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

## Input channels: what proves what

Three ways to reach a control, and they form a ladder — each rung skips exactly what the rung
below it proves:

| Channel | How you address it | Proves | Skips |
| --- | --- | --- | --- |
| **physical** | pixels, a real pointer: `game_input` `tap`/`hover`/`drag`/`key` | the control is reachable — on screen, right size — and the gesture itself | — |
| **semantic** | the control by name: a `game_input` `{type:'invoke',…}` step, names from `game_controls` | everything AFTER "the point is inside the control": `enabled`, the ancestor-scroll gate, the skin state machine, signal order, the game logic listening on them | whether a finger could land on it — the pointer is synthesized from the control's own transform |
| **command** | the intent: the command a handler dispatches (`start-game`, `restart`, `settings.toggle-music`) | the game logic behind the intent | whether the control is wired to that command |

**Rule: make the FIRST contact with a control a physical `tap` — that is what flips its `reach` to
`reachable` — then drive it with `invoke` for everything after.** One physical proof per control
instead of a round of coordinate guesses every iteration; skipping it is how a button nobody can
hit passes every test.

Three things that bite:

- **Overlap is invisible.** `game_controls` has no "covered by another control" status and cannot
  grow one: the engine runs no global picking pass, every control polls the pointer itself, so a
  tap where two controls overlap fires BOTH. The missing status is not evidence there is no
  overlap — if two controls share screen space, that is a bug only you will find.
- **Reach proof is session memory, not truth.** It survives the control moving, being re-laid-out,
  or the viewport changing, so a `reachable` earned before a layout change can be a lie. Re-tap
  physically after you move a control or rebuild the screen it lives on.
- **Match the predicate to the widget** once `game_run`'s `command`/`signal` predicates land: a
  **button's** binding is proven by `command(…)` — its handler dispatches one — while a **state
  control's** (checkbox, inventory slot) is proven by `signal('toggled')`, because there the
  command flips the control and the effect hangs off the control's own signal.

## Time and frames

- **Count in `frames`, not `ms`, whenever what matters is a number of ticks** — input holds and the
  `game_observe` window both take either. `ms:800` is 800 ms of wall clock and however many polls
  the frame rate happened to deliver; `frames:8` is the same test on a slow machine and a fast one.
  Keep `ms` only for things genuinely about wall time.
- **`game_run` judges, `game_observe` samples.** `game_observe` watches a window and hands you what
  it saw; `game_run` checks your condition on EVERY frame and stops on the first one that decides —
  an event lasting one frame is caught instead of straddled, and a win in the second second costs
  two seconds, not fifteen. Use `game_run` whenever you can state the success condition.
- **Assert the change, not the value.** A predicate already true at frame 0 ends the run with
  `PRECONDITION ALREADY MET` and proves nothing — assert `gameStateChanged` on `score`, not
  `gameState score gte 0`. A `fail` beats an `until` on the same frame, deliberately.
- **`game_run` sends no input.** Send it with `game_input` (realtime), then call `game_run` with
  only `until`/`fail` to judge what follows. It leaves the game paused on the outcome frame for
  `game_observe` and restores the time mode itself.
- **A `game_time` mode you forgot to set back looks exactly like a hung game** — `manual` most of
  all. Return to `realtime` when done; the config is replaced whole, so `mode` goes in every call.

## Design the game intent-first

Every UI reaction gets a named intent method; the handler only calls it.

```ts
onStart(): void {
  this.connectButton(String(this.config.playButton ?? ''), () => this.startGame());
}

private startGame(): void {
  /* the whole reaction lives here */
}
```

Name the method after what the player means — `startGame()`, `openMenu()`, `closeWindow()`,
`restart()`, `ctaClick()`, `toggleMusic()` — never after the widget. The templates already do this
and register each intent as a command (`start-game`, `open-settings`, `restart`, `cta-click`,
`settings.toggle-music`); copy that shape instead of inlining logic into a handler. An intent with
a name is addressable by all three channels — a handler with logic inlined is reachable only by
pixels.

## GameDebugProvider is the cheapest check

Register one per game: `registerGameDebug({ name, snapshot })`, where `snapshot()` returns the
fields that actually decide a run — score, lives, ammo, wave, phase. Every `game_input` /
`game_observe` result then carries `game.changed`, so "does shooting work" is a state diff instead
of a picture (step 2b).

The templates register it in `GameFlow` / `GameRules`. **When you add a mechanic, add its field to
the snapshot** — state the provider doesn't mention is state nothing can verify, and the check
falls back to screenshots that prove nothing.

## design/tests/ — routines and the reachability journal

- `routines/<name>.json` — one replayable scenario: `name`, `description` (a single line, it goes
  into the agent's index), `scope` (scene or tag), optional `params`, `uses` (the node ids it
  touches), `steps`, `expect`. A routine with no `expect` is a macro, not a test.
- `reachability.json` — the on-disk journal of proven controls. Nothing writes it yet (today's
  reach proof lives in the session, reported by `game_controls`), so never hand-write entries.

The format and the location are fixed; the harness that executes routines is still being built.
Until it lands, drive the game with `game_input` as in "The loop", and keep `uses` honest — a
routine naming a node that no longer exists is stale, and that is a regression report, not a
harness glitch.

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
  hide this with `as any` — that's what the type-check inside `compile_scripts` exists to catch.
- **Moves, but in the WRONG direction (sideways / backwards / turns the wrong way)** — this is a
  math bug, not a "does it move" bug, and blind sign-flipping never converges. Verify with
  `game_input`/`game_observe` and read `alignForward`/`alignRight`, don't guess. `rotation.z`
  rotates the node's local +Y ("nose") to world `(-sin θ, cos θ)` and local +X to `(cos θ, sin θ)`,
  counter-clockwise (with world +Y up). So a car whose nose is +Y moves forward with
  `vx = -Math.sin(rot.z)*speed`, `vy = Math.cos(rot.z)*speed`; an AI aiming its nose along a
  velocity `(dx, dy)` sets `rotation.z = Math.atan2(-dx, dy)`. Using `+sin` (or `atan2(dx, dy)`)
  mirrors X → the body slides sideways the moment it turns.
- **A button does nothing** — split the two failures with `game_controls` first: a `reach` other
  than `reachable`/`in-frame-unproven` or `enabled:false` means no tap can land, and the script is
  innocent. If it lists clean, `invoke` it — the signals now definitely fired, so a still-dead game
  is a binding bug: buttons emit `pressed`/`released`/`click`, something must
  `node.connect('pressed', target, handler)`, and the flow script must be attached to a node that
  exists and name the right node ids.
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
