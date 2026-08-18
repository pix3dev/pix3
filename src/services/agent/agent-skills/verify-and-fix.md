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
- **Match the predicate to the widget** with `game_run`'s `command`/`signal` predicates: a
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

## design/tests/ — what the harness keeps in the project

Everything here survives context compaction and is reviewed like code. That is the point: a
scenario you got right once should never be re-derived.

- `routines/<name>.json` — one replayable scenario, run with `game_run {routine:'<name>', args}`:
  `name`, `description` (a single line — it is the ONLY part that reaches your context), `scope`
  (scene or tag), optional `params`, `uses` (the nodes it touches), `steps`, `expect`. Steps are the
  `game_input` vocabulary plus `{type:'command', name}`; `expect` is the same predicate objects as
  `until`, ANDed and judged once after the last step. **A routine with no `expect` is a macro, not a
  test**, and the verdict says so. Keep `uses` honest: a renamed node answers `ROUTINE STALE` with
  the name before anything runs, which is a one-line diagnosis instead of a scenario that failed
  halfway through.
- `bots/<name>.ts` — a policy that plays the game; see below.
- `<name>.trace.json` — a recorded input trace (`game_trace`), replayed to compare outcomes between
  two increments of your own work.
- `reports/NNNN-*.json` — the full protocol of each run. Slice it with `fs_read {offset, limit}`;
  the reply is a summary of it.
- `reachability.json` — the journal of controls proven reachable by a real physical tap. Written by
  the harness; never hand-write entries, and expect a proof to burn when the control moves.

## Bot policies: when the decisions come faster than a tool call

A routine replays a fixed script. A **policy** decides every tick — which is what gameplay like
surviving a runner, dodging, or chasing needs, and what a tool call per decision cannot deliver.

Write `design/tests/bots/<name>.ts` and run it with
`game_run {bot: {name: '<name>'}, maxFrames: 1800}`:

```ts
export default {
  name: 'survive-30s',
  tick(bot) {
    const hero = bot.nodes('Hero')[0];
    if (!hero) return bot.done(false, 'the hero left the scene');
    const rock = bot.nearest('Rock2D', hero.worldPosition);
    bot.axis('Horizontal', rock && rock.node.worldPosition.x > hero.worldPosition.x ? -1 : 1);
    if (bot.frame >= 1800) bot.done(true, 'survived 30s at 60fps');
  },
};
```

The API is ~10 methods: sensors `nodes(query)` / `nearest(type, from)` / `raycast(from, dir)` /
`gameState()`, actuators `press(action, frames?)` / `release(action)` / `tap(target)` /
`axis(name, value)` / `moveTo(point)`, protocol `log(event)` / `done(pass, reason)`, plus
`bot.frame`. On the first successful compile the editor writes `pix3-test-bot.d.ts` next to your
policy, so `bot.` completes in the code view.

Five things decide whether a policy works:

- **Observe frame N, act for frame N+1.** `tick` runs after the game's tick and every actuator lands
  on the next one. A policy that expects its own press to be visible in the same tick reads as a game
  that ignores input.
- **`channel` defaults to `physical-input`** — real pointer and key events, the whole player path,
  and the only setting under which the run proves an input binding. `axis()` there deflects the live
  on-screen joystick that writes the axis, and **refuses by name** when no control does (the runtime
  has no keyboard-to-axis binding: a key raises `Key_<code>` as a *button*). `direct-action` sets
  axes and calls interactions directly: use it to test logic when the binding is already proven, and
  never to close an input check — the report and the verdict both say it proves nothing.
- **Read `verdict` first.** `BOT PASS` / `BOT FAIL` carry your own `reason`, the frame and the
  channel. `BOT ERROR` means the *policy* threw — the fault is in your file, nothing is claimed about
  the game, and it is deliberately **not** counted in `newErrors`, so a `fail: [{kind:'newErrors'}]`
  crash net cannot mistake your typo for a game crash (it is logged as a warning instead).
  `BOT NOTHING DRIVEN` means no actuator was ever delivered, so the run is not a pass even if the
  policy claimed one; the refusals in `bot.log` say what could not be reached. A `done(false)` still
  reads as `BOT FAIL` even when nothing was driven — "I could not play" is a finding.
- **`done(pass, reason)` is the finding.** Write the reason for a reader who has not seen the run:
  "hero died: lives 0 at the third gap", not "failed". Call it from `tick`, never from `end` — by
  then the run is over and the verdict decided nothing.
- **`until`/`fail` still apply** as the budget and the crash net. Omit `until` and it becomes
  `maxFrames`; add `fail: [{kind:'newErrors'}]` and a script throwing beats any verdict the policy
  reaches on that frame.

Three canonical policies to copy instead of inventing:

```ts
// chase — close the distance to the nearest target.
export default {
  name: 'chase',
  tick(bot) {
    const me = bot.nodes('Hero')[0];
    const target = me && bot.nearest('Coin2D', me.worldPosition);
    if (!me || !target) return;
    bot.axis('Horizontal', Math.sign(target.node.worldPosition.x - me.worldPosition.x));
    bot.axis('Vertical', Math.sign(target.node.worldPosition.y - me.worldPosition.y));
    if (target.distance < 8) bot.log(`reached ${target.node.name} at frame ${bot.frame}`);
  },
};
```

```ts
// avoid — steer away from whatever is closest, and report a hit as the finding.
export default {
  name: 'avoid',
  tick(bot) {
    const me = bot.nodes('Hero')[0];
    if (!me) return bot.done(false, `the hero is gone at frame ${bot.frame}`);
    const threat = bot.nearest('Rock2D', me.worldPosition);
    if (!threat) return bot.axis('Horizontal', 0);
    if (threat.distance < 6) return bot.done(false, `hit ${threat.node.name} at frame ${bot.frame}`);
    bot.axis('Horizontal', -Math.sign(threat.node.worldPosition.x - me.worldPosition.x));
  },
};
```

```ts
// pressWhen — hold an action while a condition holds. The shape for "jump over the gap".
export default {
  name: 'press-when',
  tick(bot) {
    const state = bot.gameState();
    const shouldHold = Boolean(state && state.onGround === false ? false : state?.gapAhead);
    if (shouldHold) bot.press('Key_Space', 6);
    else bot.release('Key_Space');
  },
};
```

Sensor cost is worth knowing: `nodes`/`nearest` walk the live tree, `raycast` builds a world-space
bounding box per node and is the most expensive call available — reach for it when you need "is
something in the way", not every tick. And `raycast` tests bounding boxes, not geometry and not
colliders, which is what makes it mean the same thing in 2D and 3D.

One gap to know about: **a bot's physical tap does not flip a control's `reach` to `reachable`** the
way a `game_input` tap does, even though it dispatches the same real pointer. So a bot run does not
accrue the "one physical proof per control" the ladder above is built on — tap the control once with
`game_input` if you need that proof recorded.

## Common runtime problems and fixes

- **A black or empty 3D scene** — read `sceneIssues` in the `scene_tree` / `game_observe` result
  before anything else. `lit-material-no-light` means the meshes have no light and draw black;
  `no-camera-3d` means nothing 3D is drawn at all; `inert-nodes` means a node's `type` is not a
  real node type (it loaded as a placeholder that does nothing — the message names the correct
  spelling). Never settle this with a viewport screenshot: the editor lights the scene with
  fallback lights the running game does not have, and says so via `editorFallbackLighting`.
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
