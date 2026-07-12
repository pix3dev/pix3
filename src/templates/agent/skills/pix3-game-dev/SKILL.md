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
   - Cross-node events → `node.connect('signal', target, handler)` / `node.emit('signal')`.
     Buttons emit `pressed` / `released` / `click`.
   - Fixed-step logic (physics/AI/spawning) → an ECS system.

3. **Write scenes as YAML** (`.pix3scene`):
   ```yaml
   version: 1.0.0
   root:
     - id: my-node
       type: Sprite2D            # or instance: res://path/to/prefab.pix3scene
       name: My Node
       properties:
         texture: { type: 'texture', url: 'res://src/assets/textures/foo.png' }
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

## Gotchas

- Components tick before their children; `onUpdate(dt)` is scaled game time.
- Audio is unlocked by the first user gesture automatically (engine handles it) —
  playables should still show a tap-to-start overlay so music starts after a tap.
- 2D textures must not use mipmaps — the engine handles this for `res://` loads.
- Keep `main.pix3scene` as the startup scene; the editor opens it by default.
