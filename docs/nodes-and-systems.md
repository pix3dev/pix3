# Pix3 Nodes & Systems — Capabilities Guide for Agents

**Read this before writing custom game logic.** It is the inventory of what the
Pix3 engine and editor already do, and how to reach each capability correctly.
If a capability exists here, **use it instead of hand-rolling it in game code** —
that is the rule CLAUDE.md's *Engine vs Game feature decision* enforces.

- Node detail (every property, per node): [node-types-reference.md](node-types-reference.md)
- Product/architecture source of truth: [pix3-specification.md](pix3-specification.md)
- Deep-dive diagrams (operations flow, schema, rendering, state): [architecture.md](architecture.md)
- Property-schema authoring: [property-schema-quick-reference.md](property-schema-quick-reference.md)

---

## 0. The engine-vs-game decision (do this first)

When asked to implement a game feature:

1. **Search this doc + [node-types-reference.md](node-types-reference.md).** If a
   node, behavior, system, or runtime API already covers it, use that.
2. Ask: *"Would Godot / Unity ship this as a built-in?"*
   - **Yes → engine-level.** Implement in the runtime + editor (schema,
     `Create*Command`, registry, YAML serialization, inspector), then
     `yalc:publish` and update the consumer. **State the plan and confirm first.**
   - **No** (game-specific rules, content, balancing) → **game-level script**.
3. Engine nodes/systems must **not** reference game domain concepts (shop, coins,
   enemies). Keep the runtime editor-agnostic and game-agnostic.
4. After adding an engine capability, **update this file**.

---

## 1. Two ways to build on Pix3

**A. In-editor user scripts** (the common path). A `Script` subclass in the
project's `scripts/` folder, attached to a node as a component and referenced in
the scene as `type: user:<ClassName>`. The editor compiles it (esbuild-wasm) and
hot-reloads it. Scripts reach the engine through `this.scene` / `this.input` /
`this.node`. Example: [../samples/HelloWorld/scripts/CutsceneTrigger.ts](../samples/HelloWorld/scripts/CutsceneTrigger.ts).

**B. Consumer game project** (e.g. DeepCore) that imports `@pix3/runtime` via
yalc. It drives the engine itself with `SceneManager` + `SceneRunner` +
`RuntimeRenderer` (no editor). The **same runtime APIs** below are available; the
difference is you own the loop and there is no inspector/command layer. It may
register a debug provider via `registerGameDebug(...)` (see §6).

> The runtime package (`packages/pix3-runtime`) is the contract shared by both.
> After changing it: `cd packages/pix3-runtime && npm run yalc:publish`, then
> `yalc update` in the consumer.

---

## 2. Nodes (scene building blocks)

Add via the editor **Create** menu / `Create*Command`, or author in `.pix3scene`
YAML, or (from a script) construct + `parent.adoptChild(child)`. Full property
tables: [node-types-reference.md](node-types-reference.md).

**Structure / base**
- `Node2D`, `Node3D` — transform containers (2D uses anchors/layout; 3D is a
  Three.js `Object3D`). `Group2D` groups 2D content.

**2D content & UI** (orthographic overlay pass; draw order = tree order)
- `Sprite2D`, `AnimatedSprite2D`, `TiledSprite2D`, `ColorRect2D` — images / frames / 9-slice-ish tiling / solid rects.
- UI controls: `Button2D`, `Label2D`, `Slider2D`, `Joystick2D`, `Checkbox2D`, `Bar2D`, `ScrollContainer2D`, `InventorySlot2D`.
- `Camera2D` — pan/zoom/limits/shake for the 2D pass. `CanvasLayer2D` — fixed HUD layer, unaffected by Camera2D.

**3D content**
- `GeometryMesh` — primitive/standard-material mesh; supports **shader effects** (§4) and baked/realtime AO.
- `MeshInstance` — a loaded model (glTF). `InstancedMesh3D` — GPU-instanced copies for crowds.
- `Sprite3D`, `AnimatedSprite3D` — billboarded sprites in 3D.
- `Particles3D` — GPU-ish particle system with trails + sub-emitters + world/local sim.

**Cameras & lights**
- `Camera3D` — the single render camera (attach `core:CameraBrain` for blending).
- `VirtualCamera3D` — non-rendering "virtual camera" rigs selected by priority (§4 Camera system).
- `DirectionalLightNode`, `PointLightNode`, `SpotLightNode`, `AmbientLightNode`, `HemisphereLightNode`.

**Other**
- `AudioPlayer` — a scene-graph audio source (§4 Audio).
- `PostProcess` — enables the post-processing pipeline (§4 Post-processing).

---

## 3. Script components you can attach (`core:*` behaviors)

Attach in the inspector or in YAML `components:`. These are the pre-built,
designer-facing behaviors — prefer them over writing a script for the same
effect. Registered in
[packages/pix3-runtime/src/behaviors/register-behaviors.ts](../packages/pix3-runtime/src/behaviors/register-behaviors.ts).

| Component id | Does |
|---|---|
| `core:Rotate` | Continuous rotation of a 3D node |
| `core:SimpleMove` | Simple test movement |
| `core:Sine` | Oscillate a node along an axis |
| `core:Follow` | Smoothly follow a target node's position/rotation |
| `core:PinToNode` | Pin a 2D UI node to a 3D target (screen projection) |
| `core:Fade` | Fade a 2D node's opacity in/out (optional auto-destroy) |
| `core:RadialProgress` | Circular progress mask on a Sprite2D |
| `core:AnimationPlayer` | Play keyframe clips on this node + descendants (§4) |
| `core:PlaySound` | Play a sound when a node signal fires |
| `core:Shake` | Additive positional shake (juice) |
| `core:PunchScale` | Squash-and-stretch scale punch (juice) |
| `core:PopIn` | Spawn pop-in scale with overshoot (juice) |
| `core:CameraBrain` | Blend the render camera between virtual cameras (§4) |

Most juice behaviors have a `triggerEvent` (a signal name) and/or `playOnStart`,
so a keyframe **event track** or a script `emit()` can fire them.

**GeometryMesh shader effects** (added via the inspector "Add Effect" picker or
`mesh.attachEffect(id)`): `core:dissolve`, `core:rim`, `core:uv-scroll`,
`core:flash`. Params are keyframe-animatable. See
[packages/pix3-runtime/src/shader-effects/](../packages/pix3-runtime/src/shader-effects/).

---

## 4. Systems (engine-level capabilities)

Each entry: **what it is → how to use it → where it lives**.

### Keyframe animation
Timeline-authored clips (position/rotation/scale/color tracks + audio + event
tracks) on `core:AnimationPlayer`. **Use:** attach `core:AnimationPlayer`, author
in the Animation panel, `player.play('clip')` or `autoplay`. Event tracks emit
signals (the "cutscene glue"); `finish()` fast-forwards. Signals:
`animation_started` / `animation_finished`.
See node-types-reference "AnimationPlayer" + [../samples/HelloWorld/demo-03-animation-timeline.pix3scene](../samples/HelloWorld/demo-03-animation-timeline.pix3scene).

### 3D camera system (Cinemachine-lite)
One `Camera3D` renders; attach `core:CameraBrain` to it. Add `VirtualCamera3D`
rigs (follow/look-at/damping/priority). The brain blends the render camera to the
**highest-priority visible** vcam. **Use:** raise a vcam's `priority` (animatable)
to "cut" to it; scripts can force a one-shot blend with
`brain.overrideNextBlend(sec, easing?)`. Demo: [../samples/HelloWorld/demo-02-cinematic-camera.pix3scene](../samples/HelloWorld/demo-02-cinematic-camera.pix3scene).

### Cutscene Director (`scene.cutscene`)
Play an AnimationPlayer clip as a cinematic: letterbox, input-lock, skip gesture,
CameraBrain blend in/out. **Use:**
`const {done} = this.scene.cutscene.playCinematic(nodeId, { skippableAfter, blendDuration }); await done;`
(`'finished' | 'skipped' | 'stopped'`). Camera moves/VFX/beats are authored as
clip tracks. Spec §6.13; demo: [../samples/HelloWorld/demo-07-cutscene.pix3scene](../samples/HelloWorld/demo-07-cutscene.pix3scene) + [../samples/HelloWorld/scripts/CutsceneTrigger.ts](../samples/HelloWorld/scripts/CutsceneTrigger.ts).

### 2D camera & layers
`Camera2D` drives the 2D pass (pan/zoom/limits, built-in additive `shake`).
`CanvasLayer2D` is a fixed HUD unaffected by the camera. Draw order follows the
scene tree (Godot-like). **Use:** add a `Camera2D`; put HUD under a `CanvasLayer2D`.

### Juice & time-scale
Fire-and-forget game feel from scripts (or the matching `core:*` presets):
- `scene.time.hitstop(ms)`, `scene.time.slowMotion(scale, {durationMs, blendMs})`, `setScale` / `reset` / `scale` / `isFrozen`. Scales gameplay `dt`; render + real-time chrome are unscaled.
- `scene.juice.shake(target, opts)`, `punchScale(target, opts)`, `popIn(target, opts)`, `flash({color,intensity,durationSec})`. `target` is a node, a node query, or `'camera'` / `'camera2d'`.
Spec §6.12; demo: [../samples/HelloWorld/demo-05-juice.pix3scene](../samples/HelloWorld/demo-05-juice.pix3scene).

### Audio (buses, snapshots, one-shots)
3-bus mixer (`master`/`music`/`sfx`) with named snapshots + auto-muffle under
slow-mo. **Use from scripts:** `scene.audio.play('res://sfx/hit.ogg', { bus:'sfx', pitchVariation:0.1, volumeVariation:0.1 })`, `setBusVolume`, `applySnapshot`/`resetSnapshot`, `registerSnapshot`. **In the scene:** `AudioPlayer` node or `core:PlaySound` behavior (both take `bus`/`pitchVariation`/`volumeVariation`). node-types-reference "Buses, snapshots & scene.audio".

### GeometryMesh shader effects
Registry-backed material effects (dissolve/rim/uv-scroll/flash) with zero GPU cost
while disabled. Params keyframe-animatable. **Use:** inspector "Add Effect", or
`mesh.attachEffect('core:dissolve')` + set `fx.<key>.<param>`.

### Post-processing
Add a `PostProcess` node to enable an EffectComposer pass (bloom / vignette /
chromatic aberration / AO modes). **Use:** drop one `PostProcess` node; configure
its properties. Pure-2D scenes can opt 2D in via `affect2D`.

### Particles
`Particles3D` — emission, trails, sub-emitters, world/local simulation space, and
`emitBurstAt(...)` for scripted bursts.

### ECS (fixed-step logic)
`ECSService` runs a deterministic fixed-step update alongside per-frame node
ticks. Games register systems/components for physics, AI, spawning, etc. **Use
(consumer):** `sceneService.getECSService()` → register systems; the runner calls
`fixedUpdate`. See [ecs-instancing.md](ecs-instancing.md) + `architecture.md`.

### Physics
No built-in rigidbody node yet. Rapier is available (lazy-loaded) and the
fixed-step ECS loop is the integration point; **games implement their own physics
systems** on top (DeepCore does this). If asked for physics, prefer a game-level
ECS system unless building a reusable engine node (confirm first).

### Input (`this.input`, `InputService`)
Polled + per-frame input, unified across pointer/keyboard: `getAxis(name)`,
`getButton(name)`, `pointerEvents` / `keyEvents` (this frame), `pointerPosition`,
`wheelDelta`, `isPointerDown`, `isHoveringUI`. Depth-counted `lock()`/`unlock()`
(used by the Cutscene Director) silences the whole polled surface at once.

### Signals (node events)
`node.connect(name, target, method)` / `disconnect` / `emit(name, ...args)`. The
decoupled event bus between nodes, scripts, animation event tracks, and juice
`triggerEvent`s. Always `disconnect` in `onDetach` (the `Script` base auto-drops
connections where the script is the target).

### Screen transitions
`scene.fadeToBlack(sec)` / `fadeFromBlack(sec)` / `switchCameraWithFade(id, out, in)`
/ `flash(opts)`. Real-time overlays (survive hitstop).

### Playable SDK (store CTA / game end / viewport)
`import { playable } from '@pix3/runtime'` — `playable.openStore(url?)` opens the
app-store page (delivery order: installed adapter → `dapi.openStoreUrl()`
(ironSource/Unity, network-configured URL) → `mraid.open` → `window.open`;
default URL via `setDefaultStoreUrl`), `playable.gameEnd()` marks the session
over (idempotent; `onGameEnd(cb)` to observe, auto-`reset()` on every
`SceneRunner.startScene`). Viewport helpers: `playable.getViewport()` /
`getOrientation()` return size + `'portrait' | 'landscape'`, and
`playable.onResize(cb)` fires on window resize/orientation change plus MRAID
`sizeChange` and DAPI `adResized`. Ad-network adapters plug in via
`setPlayableAdapter`. Use for playable-ad CTA buttons, end screens and
orientation-aware layouts; the `playable-2d/3d` project templates ship a
`user:CtaButton` script wired to it.

### Asset Library (reuse before you build)
**Before generating graphics or writing UI/prefabs from scratch, search the Asset
Library** — it holds reusable prefabs, images, fonts, audio and shaders across three
scopes (built-in starter pack, your personal library, and the team library). In the
editor: the **Library** panel (tabbed with the Asset Browser) — filter by scope/type,
search, then drag a card into the viewport (or double-click) to insert. Inserting
copies the bundle into `res://assets/library/<slug>/` and remaps its paths; it is a
snapshot, so later edits to the library item do not change the project. Publish a
reusable node with **Publish to Library** (Edit menu, or `library.publish-node`),
which packs the subtree and its asset dependencies into a personal item. Good results
from the Asset Generator can be kept with its **Save to Library** action. Programmatic
scope (agent HTTP/preview commands) arrives in Phase 2 — see `.plans/asset-library.md`.

---

## 5. Scripts-facing runtime API (the surface a `Script` sees)

Inside any `Script` subclass:

- `this.node` — the owning `NodeBase` (transform, `visible`, `getComponent`, `addComponent`, `connect`/`emit`, `findById`/`findByName`/`findByPath`, `children`, `parentNode`). `getComponent<T>(type: new (...args) => T): T | null` takes the component **class**, not a string ID — `node.getComponent(CarController)`, importing the class by relative path (`./CarController`). There is no string-based lookup (`getComponent('user:CarController')` fails); `user:*` IDs are for `add_component`/scene YAML only. To fetch by hand: `node.components.find(c => c instanceof CarController)`.
- `this.scene` — the `SceneService` (all of §4's `scene.*` APIs, plus `getActiveCamera()`, `getActiveCamera2D()`, `findNode(query)`, `getRootNodes()`, `getViewportInfo()`/`onViewportChanged()`/`isPortrait()`, `raycastViewport(nx,ny)`, `getAudioService`/`getAssetLoader`/`getResourceManager`/`getECSService`). May be `undefined` in some editor previews — guard it.
- `this.input` — the `InputService` (§4 Input).
- `this.findNode(query)` — resolve another node by id / name / slash-path, or `null` if absent (`get_node_or_null`).
- `this.getNode(query)` — same lookup but **throws** if the node is missing (`get_node`). In the in-editor code editor the argument autocompletes to the node names/paths of the open scenes and the return type is the exact node type (`this.getNode('Hero')` → `Sprite2D`), à la Godot's `$Node` / WPF `x:Name`. Any other string resolves to `NodeBase`, so a script reused in a scene that lacks the name still type-checks — the names are hints, never constraints. (Typed names come from the editor augmenting `SceneNodeNames`; it's empty in exported games, where only `getNode<T>(query)` applies.)

**Lifecycle:** `onAttach(node)` → `onStart()` (first frame) → `onUpdate(dt)` (every
frame, `dt` is scaled game time) → `onDetach()`. Define `static getPropertySchema()`
to expose inspector-editable params (see §6). `this.config` holds params.

> **Ordering gotcha:** a node's components tick *before* its children. Don't arm
> cross-node state in `onStart` that a child component's `onStart` will reset the
> same frame (e.g. a child camera's `CameraBrain`). Trigger such calls from a
> gameplay event or after a frame.

> **Real vs scaled time:** `onUpdate(dt)` and keyframe clips run on *scaled*
> `dt` (frozen by hitstop). Anything that must ignore hitstop/slow-mo (screen
> chrome, timers) uses `performance.now()` — mirror how `flash()`/letterbox work.

---

## 6. Editor-side rules (when an agent edits scenes/state)

- **Mutation gateway:** every state change flows UI → `CommandDispatcher.execute(CommandClass, args)` → Command → Operation → history. **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `src/features/<area>/`. (See CLAUDE.md + AGENTS.md — binding.)
- **Property schema:** nodes and `Script`s expose `static getPropertySchema()` returning typed `PropertyDefinition`s (`getValue`/`setValue`); the Inspector renders editors from it and all edits go through `UpdateObjectPropertyOperation`. See [property-schema-quick-reference.md](property-schema-quick-reference.md).
- **Serialization:** scenes are `.pix3scene` YAML (`root:` tree of nodes with `properties`, `components`, `children`). Copy a known-good demo in `samples/HelloWorld/` as a template.
- **Debug bridge (dev):** `window.__PIX3_DEBUG__` exposes scene/liveScene/play/setProperty/errors for driving the running editor (see the `debug-running-game` skill). Consumer games can register `registerGameDebug({name, snapshot, inspect, action})` from `@pix3/runtime` for a game-specific surface.

---

## 7. Correct-usage checklist for a new user script

1. Create `scripts/<Name>.ts`: `export class <Name> extends Script { … }` importing from `@pix3/runtime`.
2. Set defaults in the constructor's `this.config = { … }`; expose them via `static getPropertySchema()`.
3. Read the engine through `this.scene` / `this.input` / `this.node` — guard `this.scene` for previews.
4. Reference it in a scene as `type: user:<Name>`.
5. **Don't reimplement** juice/audio/animation/camera/cutscene — call the systems in §4.
6. Verify by running it: use the `debug-running-game` skill (attach to the editor, `play.start()`, read `errors()`, screenshot). For sprites/UI art use `generate-sprites-in-editor`.

---

## 8. Where things live

- Runtime (nodes, systems, script APIs): `packages/pix3-runtime/src/` — public surface re-exported from its `index.ts`.
- Built-in behaviors: `packages/pix3-runtime/src/behaviors/`; shader effects: `.../shader-effects/`; animation: `.../animation/`.
- Editor features (commands/operations): `src/features/<area>/`; services: `src/services/`.
- Asset Library: services `src/services/AssetLibraryService.ts`, `LibraryInsertService.ts`, `PublishToLibraryService.ts`, providers + model in `src/services/library/`; panel `src/ui/asset-library/`; builtin pack `public/library/`.
- Demo scenes + example scripts: `samples/HelloWorld/`; `docs/example-scripts/`.
- Deeper docs: [node-types-reference.md](node-types-reference.md), [pix3-specification.md](pix3-specification.md), [architecture.md](architecture.md), [ecs-instancing.md](ecs-instancing.md), the `property-schema-*.md` set.
