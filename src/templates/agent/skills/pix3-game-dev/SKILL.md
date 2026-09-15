---
name: pix3-game-dev
description: Guidance for building this game on the Pix3 engine — implementing gameplay/features, writing scenes (.pix3scene YAML) and script components, or answering "how do I do X with the engine". Use BEFORE writing custom game logic so you reach for an existing engine capability (nodes, core:* behaviors, juice, audio buses, camera brain, cutscene director, keyframe animation, shader effects, post-processing, ECS, input, signals) and use it correctly.
---

# Building a game on Pix3

The engine already ships most game-feel and structural capabilities. Your job is
to **reach for them** and wire them correctly, not to reimplement them.

## The loop

0. **Search the Asset Library before generating art or building UI/prefabs from
   scratch.** It holds reusable prefabs, images, fonts, audio and shaders (built-in
   starter pack + personal + team). Open the **Library** panel (tabbed with the Asset
   Browser), filter/search, and drag a card into the scene to insert (a snapshot copy
   under `res://assets/library/<slug>/`). Publish reusable nodes back with **Publish to
   Library** (Edit menu), and keep good generator results via **Save to Library**.

1. **Consult the catalog: [references/nodes-and-systems.md](references/nodes-and-systems.md).**
   It lists every node, `core:*` behavior, system, and scripts-facing runtime API,
   each with how to use it. Per-node property detail is in
   [references/node-types-reference.md](references/node-types-reference.md).

2. **Prefer an existing capability.** Common asks and what they already are:
   - Screen-shake / squash / pop / flash / hitstop / slow-mo → `scene.juice` /
     `scene.time` or the `core:Shake` / `core:PunchScale` / `core:PopIn` presets.
   - Timeline animation, camera moves, scripted beats → `core:AnimationPlayer`
     clips (property + event tracks).
   - Camera follow / cut / blend → `Camera3D` + `core:CameraBrain` +
     `VirtualCamera3D` (priority-driven).
   - Cinematic (letterbox + input-lock + skip) → `scene.cutscene.playCinematic`.
   - Sound, music, mixing → `scene.audio` (buses: master/music/sfx) / `AudioPlayer` / `core:PlaySound`.
   - Store CTA / game end (playables) → `playable.openStore(url)` / `playable.gameEnd()` from `@pix3/runtime`.
   - Switch scenes (menu → game → results) → `await scene.changeScene('res://scenes/main.pix3scene', { transition: 'fade' })`.
   - Cross-node events → `node.connect('signal', target, handler)` / `node.emit('signal')`.
     Buttons emit `pressed` / `released` / `click`.
   - Fixed-step logic (physics/AI/spawning) → an ECS system.

2½. **Physics: 2D is built in — never hand-write a 2D solver.** The engine ships a
   real 2D rigid-body solver, and it is the right answer for every top-down or
   side-on game that needs collision *response*: carrom, pool, air hockey,
   pinball, breakout, a platformer.

   | You need | Use |
   | --- | --- |
   | "Is anything here?" — overlaps, raycasts, line of sight, **no response** | `scene.collision2d` + `core:Hitbox2D` |
   | Movement and collision **response** in 2D — bouncing, pushing, sensors | `scene.physics2d` + `core:PhysicsBody2D` / `core:Collider2D` |
   | 3D rigid bodies | Rapier: `import RAPIER from '@dimforge/rapier3d-compat'` |

   Reaching for the hitbox tier when you need response is the same mistake as
   writing the solver yourself — it answers queries and applies no impulses, so
   you end up resolving contacts by hand. Author it Unity-style: `core:PhysicsBody2D`
   **and** `core:Collider2D` on the same node. A `core:Collider2D` with no body on
   it or any ancestor is static world geometry — that is the whole "wall" case,
   one component and no script. Units are design pixels with **y up**, so a
   **top-down game sets gravity to (0, 0)** (`core:PhysicsWorld2D` on the scene
   root, or `scene.physics2d.setGravity(0, 0)`). From a script:
   `scene.physics2d.getBody(node)` → `applyImpulse` / `setVelocity` / `teleport`,
   plus `raycast`, `overlapCircle`, `moveAndSlide`. Full detail:
   [references/nodes-and-systems.md](references/nodes-and-systems.md).

2¾. **Give the game a debug surface as you build it, not afterwards.** Two
   engine APIs turn "play it and look" into assertions, and they are load-bearing
   rather than optional polish:

   - `scene.commands.register('shoot', handler, { description })` — name every
     intent the game has (start, restart, shoot, spawn, advance-level, cheat).
     Anything registered can be triggered by name, with no simulated input and no
     timing luck, from a test, from the editor, or from a preview session.
   - `registerGameDebug({ name, snapshot, actions, inspect, action, reset })` from
     `@pix3/runtime` — publish the game's own state as JSON. `actions()` must be
     answered **from the registry** (`scene.commands.list().map(c => c.name)`), not
     a hand-kept list that drifts.

   Wire every UI button to a command and have the button call
   `scene.commands.dispatch(...)`, so the button and the test take the same path.
   With both in place, "did the rule fire" is a state assertion instead of a
   screenshot; without them, the only way to check anything is to ask a human to
   play. The project templates scaffold both — keep them fed as you add features.

3. **Write scenes as YAML** (`.pix3scene`):
   ```yaml
   version: 1.0.0
   root:
     - id: my-node
       type: Sprite2D            # or instance: res://path/to/prefab.pix3scene
       name: My Node
       properties:
         texture: { type: 'texture', url: 'res://sprites/foo.png' }
         width: 128
         height: 128
         transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
         layout: { enabled: true, horizontalAlign: center, verticalAlign: center }
       components:
         - id: my-behavior
           type: user:MyScript    # or core:Rotate etc.
           enabled: true
           config: { speed: 2 }
       children: []
   ```
   2D coordinates: origin at canvas center, X right, Y **up**. `initiallyVisible: false`
   in properties hides a node when the game starts (editor still shows it).
   Node order in the tree = 2D paint order (later/deeper draws on top).

4. **Write scripts** in `scripts/` following this shape:
   ```ts
   import { Script, type PropertySchema } from '@pix3/runtime';

   export class MyScript extends Script {
     constructor(id: string, type: string) {
       super(id, type);
       this.config = { speed: 2 };
     }
     static getPropertySchema(): PropertySchema { /* expose config to the inspector */ }
     onStart(): void { /* scene is loaded */ }
     onUpdate(dt: number): void { /* dt is scaled game-time seconds */ }
   }
   ```
   Reference it in scenes as `type: user:MyScript`. Reach the engine via
   `this.scene` (guard for undefined in previews), `this.input`
   (`this.input?.pointerEvents.some(e => e.type === 'down')` = tap),
   `this.node`, and `this.findNode('node-id-or-name')`.

5. **Verify by running it** — use the `pix3-remote-preview` skill. Don't declare
   the game done without seeing it run (or explicitly asking the user to run it).

   A type-check, a lint and a scene-YAML validation all pass on a game that is
   100 % unplayable: they check the artefact, and only motion checks the
   behaviour. One real case — a placement helper with an inverted sign put each
   player's piece on the opponent's baseline, aimed off the board. It passed
   `tsc`, prettier, YAML validation and a headless scene *parse* (the authored
   coordinate was right; nothing at load time called the function). It took one
   behavioural run to see. **Never report "done" on the strength of static
   checks alone.**

   If this project has a Node toolchain (a `package.json` with vitest and
   `@pix3/runtime` installed), you can also run a scene headlessly — no browser,
   about a second — with `createHeadlessGame` from `@pix3/runtime/testing`:

   ```ts
   import { createHeadlessGame } from '@pix3/runtime/testing';

   const game = await createHeadlessGame({ files, scripts: { GameRules } });
   await game.start('scenes/main.pix3scene');
   game.dispatch('start-game');
   await game.run(5);                       // 5 s of game time
   expect(game.snapshot()).toMatchObject({ state: 'PLAYING' });
   expect(game.errors).toEqual([]);         // a throwing component is auto-disabled silently
   await game.disposeAsync();
   ```

   It runs logic, physics, scripts, signals and commands; it renders nothing, so
   "does it look right" still belongs in the preview. A project with no Node
   toolchain (the editor's own project folders) goes straight to remote preview.

## Gotchas

- Components tick before their children; `onUpdate(dt)` is scaled game time.
- **A component that throws in `onStart`/`onUpdate` is auto-disabled by the engine.**
  The game keeps running and looks fine while that one object is frozen — so an
  error-free-looking run is not an error-free run. Check the logs (or
  `game.errors` headlessly) right after starting.
- **`scene.time.hitstop(ms)` is edge-triggered.** Call it when a contact *begins*,
  never every frame while an overlap lasts: a freeze sets gameplay `dt` to 0, so
  the contact that drives the call cannot separate on its own.
- `position` / `rotation` / `scale` are read-only three.js references — never
  assign them. `node.position.set(x, y, 0)`, `node.rotation.z = radians`.
- `getComponent` takes the component **class**, never a string. Import the class
  with a relative path (`./CarController`); `user:CarController` is a registry id
  for scene YAML and tooling only.
- Audio is unlocked by the first user gesture automatically (engine handles it) —
  playables should still show a tap-to-start overlay so music starts after a tap.
- 2D textures must not use mipmaps — the engine handles this for `res://` loads.
- `main.pix3scene` is the editor's startup scene (opened by default; the one to
  iterate on and play directly). A build boots the project's entry scene
  (Project Settings → Default Export Scene Path) — which may be a separate menu
  scene that `scene.changeScene`s into `main`. Iterate in `main`, keep the entry
  scene wired.
