# Skill: game-prototype

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> _process_ to the task if you have a better plan.

How to turn a game design document (GDD) into a **playable** prototype in this Pix3
project. Do the small, safe thing first; verify; then continue.

## 1. Understand the design (do this before touching anything)

- **First, `fs_read` `design/progress.md`.** If it exists, a previous session already planned
  (and partly built) this game — resume from the first unchecked `[ ]` item and skip the
  exploration you already did; the Notes section lists traps that were already hit. A missing
  file just means a fresh start.
- `fs_list` the `design/` folder, then `fs_read` every text/markdown file in it — that is
  the GDD. Note the game name, core loop, controls, win/lose, and screens.
- For each image in `design/` (references, mockups), call `analyze_image` with
  `question: "list the visual style tokens for an image-generation prompt: palette hex,
rendering style, lighting, camera angle, mood"`. Keep the answer — you will paste it into
  every `generate_asset` prompt so all art matches. (If your model can already see images,
  you may skip analyze_image, but doing it still gives you reusable style tokens.)
- `scene_tree` to see what the project template already gives you (screens, buttons,
  placeholder nodes). **Build on it — do not recreate what is already there.**
- **Budget your exploration.** Do not `fs_read` large reference docs (e.g.
  `nodes-and-systems.md`, `node-types-reference.md`) in full — everything you read is re-sent
  on every following step and starves the build phase. Use `read_skill` with its `section`
  parameter, or read only the doc section for the node types you actually plan to use.
  **Stop exploring at 8 calls — that is a cap, not a target.** One measured session spent 33
  (25 `engine_search` + 8 `engine_read`) before its first `play_start`, and still got the central
  question wrong. When the cap runs out with a question still open, do NOT read more: build the
  smallest runnable thing that would answer it and let the running game answer. A wrong guess
  costs one `play_start`; ten more searches cost the build phase.
- **`engine_search` indexes the runtime package only (`@pix3/runtime/src/**`).** An empty result
  means "not in that package", never "the engine cannot do this" — read §4¾ before you conclude a
  capability is missing and start writing it yourself.

## 2. Restate the plan (one short message to the user) and write it down

List, in 5 bullets or fewer: the game in one line, the screens, the core mechanic, the
win/lose condition, and the 2–3 increments you will build. Then start building — do not wait
for approval unless the user asked a question.

**Also `fs_write` the same plan to `design/progress.md`** as a short markdown checklist —
one `[ ]` line per increment plus a `## Notes` section. This file is your memory across
turns and sessions: a turn that hits the iteration cap (or gets cut off) resumes from it
instead of starting over. Keep it under ~40 lines; overwrite the whole file on each update.
**The filename is load-bearing** — the editor's Plan tab reads `design/progress.md` and nothing
else. A session that wrote its plan to `design/plan.md` left the user watching an empty Plan tab
for the entire build; the plan existed and no one could see it.

## 3. Build in increments — verify each before the next

Order increments so the game is runnable as early as possible:

1. **Screen flow** — wire the menu/game/over screens to switch on button presses.
2. **Core mechanic** — the one verb the GDD is about (move, shoot, match, dodge…).
3. **Win / lose** — a reachable end state.
4. **Feel & art** — juice, sound, then generated art (see the `asset-generation` skill).

**Never write the whole scene plus its scripts before the first `play_start`.** A measured session
authored the complete scene YAML and a 505-line script before running anything once; the first run
came up black and, with no smaller version that had ever worked, there was nothing to bisect
against — every line written that day was still a suspect. The point of an increment is not
tidiness, it is that when a run fails there is exactly one new thing in it.

After each increment: `play_start`, then `play_status` and `read_errors`. Fix errors before
moving on. Stop play mode (`play_stop`) before large edits — and once the increment is
verified and you're done running it, STOP it (`play_stop`) rather than leaving it running: a
live play session keeps ticking (spawners, physics, audio) and burns CPU/GPU in the
background. When an increment is verified,
mark it `[x]` in `design/progress.md` — and add a Notes line for anything you tried that did
NOT work (wrong property shape, a trap from §4½), so a resumed session does not repeat it.

**Prove gameplay with `game_input` — do not assume controls work, and read `verdict` FIRST.**
While the game is playing, send real input and let the tool tell you what reacted:
`game_input {steps:[{type:'key',code:'ArrowUp',ms:800}],observe:['Player']}`. The one-line
`verdict` fuses every signal — **`moved:false` does NOT mean nothing happened.** Match the
signal to the mechanic:

- **Movement** (player, car): `observed.Player.moved`/`delta`, and `alignForward` for direction.
- **Spawning / shooting / pools / HUD**: the container (e.g. `Cannonballs`) never moves — watch
  it and read `observed.Cannonballs.activity` (`spawned`/`visibleChildPeak`/`maxChildDistance`),
  or assert `expect:{Cannonballs:'activity'}`. A shot that spawns and dies inside the window is
  still caught. Do NOT decide "the tap did nothing" from the container's `moved:false`.
- **Game state**: register a `GameDebugProvider` (`registerGameDebug({name, snapshot})` exposing
  ammo/score/wave/health) — then every `game_input`/`game_observe` result carries `game.changed`,
  the clearest proof of all and the way to verify by state instead of screenshots.
- **Transient visual effects** (hover, `core:PunchScale`, `core:PopIn`, fades): use a `hover` step
  and read scale/opacity peaks (`scaleDelta`/`activity.maxScaleDelta`/`activity.opacityRange`) — a
  separate screenshot always shows the resting state.
  Tap UI buttons by name: `{type:'tap',target:'PlayButton'}` (a Button2D needs the default long
  press — don't shorten `holdMs`); after that first physical tap, drive the control with an
  `invoke` step (see the verify-and-fix skill). Keys use `KeyboardEvent.code` (`'KeyW'`, `'ArrowLeft'`, `'Space'`).
  For self-movers/spawners use `game_observe {nodes:['AICar'],sampleMs:1500}` to read baseline
  `activity` before attributing anything to your input.
  **Anything that plays out over time — a wave clearing, a death, the score climbing — is decided by
  `game_run` with an explicit success condition (`until:[{kind:'gameStateChanged',path:'score',by:1}]`),
  not by watching and judging.** It sends no input: `game_input` first, in realtime, then `game_run`
  to judge what follows. A gameplay increment is DONE only when a run confirms it, not when the code
  compiles.

## 4. How to make changes (use tools, not hand-edited files)

- **Give a node behaviour** → `list_component_types`, then `add_component` (a built-in
  `core:*` behaviour or a project `user:*` script), then `set_component_property` to
  configure it. Never hand-edit a scene file just to add a component.
- **Tweak a property** on an existing node → `set_property` (undoable).
- **Custom logic** → `fs_write` a `Script` subclass under `scripts/`, run `compile_scripts`
  (it type-checks too — no separate `check_scripts`), then `add_component` with its `user:<ExportName>`
  type. See the `pix3-game-dev` skill / the project `AGENTS.md` for the Script shape and the
  engine API (`this.scene`, `this.input`, `this.node`, `this.findNode(...)`).
- **New scene structure** (nodes that don't exist yet) → edit the `.pix3scene` YAML with
  `fs_write`; the editor watches the active scene file and reloads it automatically (there is
  **no** `scene.reload` command). Prefer this only when you truly need new nodes; editing
  existing nodes via set_property/components is safer (it keeps undo history).
  **Warning:** writing the scene YAML replaces the scene wholesale. Components you previously
  attached with `add_component` exist only in the loaded scene — include them in the YAML you
  write (a `components:` block on the node), or they are silently lost. After a scene
  `fs_write`, `node_inspect` your key nodes to confirm their components survived.
- **Level/config data lives in the scene or component config, not hardcoded in a script.**
  Waypoint positions, spawn points, speeds, lap counts — put them on nodes (positions in the
  scene) or as component `config` (via `add_component` config / `set_component_property`) so the
  editor and the designer can see and tweak them. Hardcoding an array of coordinates inside a
  `Script` hides the data from the editor and is a last resort. If a `set_property` looks
  ignored, check the value _shape_ first — a vector wants `{ x, y }` (an `[x, y]` array is also
  accepted), a rotation wants a number — rather than hardcoding a workaround.

## 4½. Engine API traps (these compile clean and then break at runtime)

Every one of these passes `compile_scripts` clean — including its type-check, if you cast to
`any` — then throws or silently does nothing on the first frame:

- **`position` / `rotation` / `scale` are read-only references** (three.js). Never assign
  them: `node.position = {x, y}` and `node.rotation = angle` throw
  `Cannot assign to read only property`. Mutate instead: `node.position.set(x, y, 0)`,
  `node.rotation.z = radians` (or the 2D helpers if the node exposes them).
- **A component that throws in `onStart`/`onUpdate` is auto-disabled by the engine** — the
  game keeps running errorless-looking while your car/enemy is frozen. `read_errors` right
  after `play_start` is the only way to catch it.
- **Keyboard events are case-sensitive**: `event.key` is `'ArrowUp'`, `'w'` — checking
  `keys['arrowup']` never matches. Prefer `event.code` (`'KeyW'`, `'ArrowUp'`, layout-independent).
- **`getComponent` takes the component _class_, never a string.** `node.getComponent('user:CarController')`
  does not type-check and returns garbage/`null` at runtime (it does `components.find(c => c instanceof type)`).
  To reach another script, import its class with a relative path — all `scripts/` files bundle together, so
  `import { CarController } from './CarController'; const car = this.node.getComponent(CarController);` works.
  The `user:CarController` string is the registry ID for `add_component`/scene YAML only — there is no
  `user:`-style code import and no string-based `getComponent`.
- **Never cast `this.node as any`** — it disables exactly the type-checking that would have
  caught the read-only assignment above. If a property seems missing from the type, look up
  the real API (`read_skill`, `node_inspect`) instead of casting.
- **Write each script once.** Think the design through, then write the file and immediately
  `compile_scripts`. Rewriting the same file 3–4 times burns your iteration budget.

## 4¾. 3D rigid-body physics: Rapier is here, and `engine_search` cannot see it

`engine_search` searches `@pix3/runtime/src/**` and Rapier does not live there — the editor wires
it and exposes it to project scripts through the runtime import map. So searching `rigidbody`,
then `physics`, then `rapier`, and getting back only comment mentions is **not** evidence the
engine has no physics: one session read it that way and hand-wrote a 505-line box solver. A
project script imports it like `@pix3/runtime` or `three`:

```ts
import RAPIER from '@dimforge/rapier3d-compat';
// ...
await RAPIER.init(); // resolved stub in the editor; real init in an export
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
```

It is lazy-loaded — the editor fetches the wasm only once a compiled bundle mentions the module,
so the import costs nothing until you write it — and the single-file playable export vendors it,
so a game built on it still exports. Use it for **3D rigid-body work only**: 2D games stay on the
engine's own collision (`Collision2DService`, the hitbox behaviours), which the editor and the
verification tools already understand. Physics state is opaque to the editor by design; a game that
wants collider wireframes registers them through the runtime's physics-debug hook
(`registerPhysicsDebugSource`, alongside `registerGameDebug`).

## 5. Art comes last, and placeholders come first

Do not block gameplay on art. Use `ColorRect2D` (2D) or a `GeometryMesh` with a material
colour (3D) as placeholders until the mechanic works, then replace them with generated
sprites via the `asset-generation` skill. List every placeholder you leave in your summary.

**A 3D scene needs a light and a camera or it renders black.** Before any lit mesh
(`GeometryMesh`, `MeshInstance3D`) means anything on screen, `create_node` a
`HemisphereLightNode` (add a `DirectionalLightNode` for shading) and a `Camera3D`. The editor
viewport adds its own fallback lights, so the black screen only shows up in play mode — check
`sceneIssues` in `scene_tree`/`game_observe` instead of a screenshot. Mobile is the default
target: keep materials cheap and leave PBR-style shine for when the user asks for a
high-end desktop look.

**For the first pass of art, use `generate_asset` with `providerId: 'svg-llm'`.** It draws
with your own model as SVG and bakes it locally, which buys three things a raster model
cannot: the exact `width`/`height` you ask for (a 96×32 health bar is 96×32, no crop pass),
real transparency with no background-removal step, and the cost of a text completion. That
makes it the right tool for icons, buttons, bars, arrows, flat props and blockout art — most
of what a prototype needs. Upgrade the pieces that want painterly or textured art (hero
sprites, backgrounds, key illustrations) to a raster model afterwards, when the game plays.

**For UI chrome — buttons, panels, bars, sliders, checkboxes — use `skin_ui`, not
`generate_asset`.** It renders a whole coherent kit from ONE theme (no model, no key, seconds),
so the button and the panel behind it actually agree; drawn separately they never do. The loop is
`skin_ui { action: 'bake', preset: … }` → `skin_ui { action: 'apply', targets: 'scene' }`, and
later `skin_ui { action: 'restyle', theme: { … } }` to re-theme everything at once. Colour
convention: green = the single primary action, blue = secondary, red = destructive. (A project
built from an idea already arrives with a kit baked and applied — restyle it rather than starting
over.)

**Sound has the same three-rung ladder, and the first rung costs nothing.** Start with the
built-in synth presets — `scene.audio.sfx('tap' | 'score' | 'bounce' | 'explosion' | 'powerup'
| 'win' | 'lose' | 'laser' | 'tick')` plays on the first frame with no file, no asset and no
waiting, so every mechanic gets its sound in the same increment as the mechanic. Reach for `generate_sfx` only when a sound needs its _own
character_ — this game's weapon, this game's pickup, a UI voice the presets do not have. It
writes a procedural recipe with your own model and renders it locally (one text completion, no
metered audio API), saving `res://sfx/<name>.wav`; `scene.audio.play('res://sfx/pop.wav')`,
`AudioPlayer` and `core:PlaySound` all take it untouched. **What it saves is a placeholder**,
exactly like SVG art: a sound designer's final file later overwrites the same path and nothing
else changes, so list generated sounds as placeholders in your summary. Keep the `soundline`
the tool returns — passing it back with `feedback` ("duller, 100 ms shorter") edits that sound
deterministically instead of rolling a different one. Never ask it for music, an ambience bed
or a voice: procedural synthesis cannot do them and the tool will decline, which is an answer,
not a failure to retry.

## 6. Finish

Update `design/progress.md` one last time (checkboxes + remaining work), then summarize:
what plays now, how to test it (which button, which key), what art is still a placeholder,
and the single most useful next step.
