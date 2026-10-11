<!-- Pix3 agent kit 1.6.2 — generated from docs/nodes-and-systems.md, src/services/agent/agent-skills/engine-api-map.md and the runtime's component registry. Do not edit: pix3 kit --update regenerates it. -->
# Script API reference

Generated from the engine's own documentation and code. Grep a heading instead of reading it
whole. Tool names the in-editor agent uses appear in places: `add_component` /
`set_component_property` = edit the scene YAML's `components:`; `list_component_types` = the
"`core:` components" section at the end of this file; `engine_search` / `engine_read` do not
exist for you — the runtime's declarations are in `.pix3/types/@pix3/runtime/` (or in
`node_modules/@pix3/runtime` when the project has its own `tsconfig.json`). Source paths quoted here (`src/…`, `packages/…`) are files of the Pix3 engine repository, not of this project.

## The surface a `Script` sees

Inside any `Script` subclass:

- `this.node` — the owning `NodeBase` (transform, `visible`, `getComponent`, `addComponent`, `connect`/`emit`, `findById`/`findByName`/`findByPath`, `children`, `parentNode`). `getComponent<T>(type: new (...args) => T): T | null` takes the component **class**, not a string ID — `node.getComponent(CarController)`, importing the class by relative path (`./CarController`). There is no string-based lookup (`getComponent('user:CarController')` fails); `user:*` IDs are for `add_component`/scene YAML only. To fetch by hand: `node.components.find(c => c instanceof CarController)`.
- `this.scene` — the `SceneService` (all of §4's `scene.*` APIs, plus `getActiveCamera()`, `getActiveCamera2D()`, `findNode(query)`, `getRootNodes()`, `getViewportInfo()`/`onViewportChanged()`/`isPortrait()`, `raycastViewport(nx,ny)`, `getAudioService`/`getAssetLoader`/`getResourceManager`/`getECSService`, plus `network` and `netNodes` for multiplayer, and `commands` for named game intents). May be `undefined` in some editor previews — guard it.
- `this.input` — the `InputService` (§4 Input).
- `this.findNode(query)` — resolve another node by id / name / slash-path, or `null` if absent (`get_node_or_null`).
- `this.getNode(query)` — same lookup but **throws** if the node is missing (`get_node`). In the in-editor code editor the argument autocompletes to the node names/paths of the open scenes and the return type is the exact node type (`this.getNode('Hero')` → `Sprite2D`), à la Godot's `$Node` / WPF `x:Name`. Any other string resolves to `NodeBase`, so a script reused in a scene that lacks the name still type-checks — the names are hints, never constraints. (Typed names come from the editor augmenting `SceneNodeNames`; it's empty in exported games, where only `getNode<T>(query)` applies.)

**Lifecycle:** `onAttach(node)` → `onStart()` (first frame) → `onUpdate(dt)` (every
frame, `dt` is scaled game time) → `onDetach()`. Define `static getPropertySchema()`
to expose inspector-editable params (see §6). `this.config` holds params.

> **Ordering gotcha:** a node's components tick _before_ its children. Don't arm
> cross-node state in `onStart` that a child component's `onStart` will reset the
> same frame (e.g. a child camera's `CameraBrain`). Trigger such calls from a
> gameplay event or after a frame.

> **Real vs scaled time:** `onUpdate(dt)` and keyframe clips run on _scaled_
> `dt` (frozen by hitstop). Anything that must ignore hitstop/slow-mo (screen
> chrome, timers) uses `performance.now()` — mirror how `flash()`/letterbox work.

**Editor preview (draw the node your way without play mode):** implement
`tickEditorPreview(dt, ctx)` — the editor calls it on every non-play frame it
paints, for each enabled component. The viewport still renders on demand:
implementing the hook does not keep it painting — only `ctx.requestRender()`
called _during_ the tick asks for the next frame (called later, e.g. when an
asset finishes loading, it is a one-off repaint). The status bar shows **Live**
and names the script while one keeps the loop hot. Use `ctx.setAppearanceOverride({ textureRegion?, tint?,
visible? })` to change how _this component's node_ draws in the editor viewport;
it is immediate-mode (stop pushing → the proxy reverts) and never mutates or
serializes the node. `ctx.assetLoader` / `ctx.requestRender()` are also provided;
call `requestRender()` for continuous animation. For UV cropping specifically,
`Sprite2D.setTextureRegion({ x, y, width, height } | null)` shows a normalized
sub-rect of the texture (e.g. one digit of an odometer strip) — a transient,
non-serialized crop. It is per-sprite even when several sprites reuse the same
cached texture (the runtime crops a private clone that shares the GPU image), so
you never clone textures yourself. Author the region once and drive it from
**both** `onUpdate` (play) and `tickEditorPreview` (edit) so the two modes match. A
throwing `tickEditorPreview` disables the component and surfaces the error like a
play-mode hook, so the editor keeps running.

## Engine API map

### A `Script`

- Lifecycle: `onAttach(node)` → `onStart()` (first frame) → `onUpdate(dt)` (scaled seconds;
  frozen by hitstop) → `onDetach()`. Defaults in the constructor's `this.config = {…}`;
  `static getPropertySchema()` exposes them to the inspector / `set_component_property`.
- `this.node` (owner `NodeBase`), `this.scene` (`SceneService`, guard for `undefined` in
  editor previews), `this.input` (`InputService`), `this.findNode(q)` (id / name / path →
  node or null), `this.getNode(q)` (throws when missing).
- Reach another script: `import { Other } from './Other'; this.node.getComponent(Other)` —
  the class, never the `user:Other` string.

### Nodes

- Transform is three.js and **read-only by reference**: `node.position.set(x, y, 0)`,
  `node.position.x += dx`, `node.rotation.z = radians`, `node.scale.set(s, s, 1)`. Never
  assign `node.position = …`.
- `visible`, `name`, `id`, `children`, `parentNode`, `findById(id)`, `findByName(name)`,
  `adoptChild(child)` (runtime parenting), `queueFree()` (safe inside `onUpdate`; use
  `dispose()` only outside the tick), `getComponent(Class)`, `addComponent(c)`,
  `removeComponent(c)`.
- Signals: `node.emit(name, ...args)`, `node.connect(name, target, fn)`,
  `node.disconnect(name, target, fn)`. A script's handlers (`target === this`) are
  auto-disconnected on detach — on its own node and on any other node it connected to.
  Window listeners, store subscriptions and timers are still yours to clean up.
  **UI controls emit:** every `UIControl2D` (`Button2D`, `Slider2D`, `Checkbox2D`, `Joystick2D`,
  `InventorySlot2D`, `ScrollContainer2D`) → `'pressed'`, `'released'`, `'click'` (a completed
  tap — wire buttons to THIS), `'pointerdown'`, `'pointerup'`; `Checkbox2D` / `InventorySlot2D`
  also `'toggled'`; `Label2D` → `'typewriter-complete'`. Read a control's value from its
  properties (`Slider2D.value`, `Checkbox2D.checked`) inside the handler.
- **Node2D** adds design-pixel space (origin centre, X right, **Y up**): `width`, `height`,
  `opacity` (0..1), `zIndex` (higher draws on top; ties = tree order, later sibling on top),
  `blendMode` (`normal | additive | multiply | subtract` — `additive` for glow/VFX), anchored
  `layout`. Construct at runtime with the same props the scene YAML uses:
  `new ColorRect2D({ id, width, height, color })`, `new Sprite2D({ id, texturePath:
  'res://sprites/ph-circle.png', width, height })`, `new Label2D({ id, label, labelFontSize,
  labelColor })`, `new Group2D({ id, width, height })`, then `parent.adoptChild(node)`.
- 2D node types: `ColorRect2D`, `Sprite2D`, `TiledSprite2D`, `AnimatedSprite2D`, `Group2D`,
  `Label2D` (`label`, `labelFontSize`, `labelColor`, `glowColor`/`glowStrength`,
  `outlineColor`/`outlineWidth`), `Button2D`, `Slider2D`, `Checkbox2D`, `Bar2D`, `Joystick2D`,
  `InventorySlot2D`, `ScrollContainer2D`, `Camera2D`, `CanvasLayer2D` (HUD layer, drawn after
  post-fx, never blooms), `SpineSkeleton2D`, `Layout2D`.
- 3D node types: `Node3D`, `Camera3D`, `VirtualCamera3D`, `GeometryMesh`, `MeshInstance`,
  `InstancedMesh3D`, `Sprite3D`, `AnimatedSprite3D`, `Particles3D`, lights (`Ambient`,
  `Hemisphere`, `Directional`, `Point`, `Spot`), `PostProcess` (bloom / vignette /
  chromatic aberration; `affect2D: true` for 2D scenes), `AudioPlayer`.
- Shader effects on a 2D node: `effects: [{ type: 'core:tint', params: { color, amount } }]`
  (also `core:adjust`, `core:grayscale`) — the way a near-white placeholder takes a colour.

### `this.scene`

- Lookup: `findNode(q)`, `findNodeById`, `findNodeByName`, `findNodeByPath`, `getRootNodes()`,
  `getActiveCamera()`, `getActiveCamera2D()`, `getViewportInfo()`, `isPortrait()`.
- **Pointer in 2D world space:** `scene.getPointer2DWorldPosition()` → `Vector2 | null`
  (design pixels, Y up; the primary finger), `getPointer2DWorldPosition(pointerId)` for one
  finger (null once it is up). Godot's `get_global_mouse_position()`.
- Spawning: `await scene.instantiate('res://prefabs/x.pix3scene', { parent: 'container' })`
  → the new node (prefab = a `.pix3scene` with one root). Despawn with `node.queueFree()`.
- Scenes & transitions: `await scene.changeScene('res://scenes/menu.pix3scene', {
  transition: 'fade' | 'none', durationSec: 0.3 })`; `scene.fadeToBlack(sec, onDone?)`,
  `scene.fadeFromBlack(sec, onDone?)`, `scene.switchCameraWithFade(cameraId, outSec, inSec,
  onDone?)`; `scene.flash({ color, intensity, durationSec })`. Real-time overlays — they
  survive hitstop.
- Time: `scene.time.hitstop(ms)` (edge-triggered — on a contact START, never per frame),
  `scene.time.slowMotion(scale, { durationMs, blendMs })`, `setScale`, `reset`, `scale`,
  `isFrozen`.
- **Juice (`scene.juice`)** — one-liners, call them WITH the mechanic: `shake(target, {
  amplitude: 8, frequency: 24, duration: 0.35, decay: 1.5 })`, `punchScale(target, { amount: 0.3,
  duration: 0.35, vibrato: 3 })`, `popIn(target, { from: 0, duration: 0.4, easing: 'backOut' })`
  (these three take `duration`, not `durationSec`), `flash({ color: '#ffffff', intensity: 1,
  durationSec: 0.2 })`, `burst(anchor, { count: 14,
  speed: 260, spread: 2π, direction, lifeSec: 0.5, color | colors: [], sizePx: 10, gravityY:
  -600, fadeOut: true, additive: true, zIndex })`, `floatText('+25', { at, color,
  fontSizePx: 28, driftPx: 60, durationSec: 0.8, glow })`. `target` = node | node query |
  `'camera'` / `'camera2d'`; `anchor` = node | query | `{ x, y }` 2D world point. Presets as
  components: `core:BurstOnSignal`, `core:SfxOnSignal`, `core:Shake`, `core:PunchScale`,
  `core:PopIn`, `core:Fade`.
- **Tweens (`scene.tween`)** — Godot-style, on scaled time: `scene.tween.to(target, props, {
  durationSec: 0.3, ease: 'cubicOut', delaySec, yoyo, repeat (-1 = forever), onUpdate,
  onComplete })` → `{ cancel(), finished: Promise<'completed' | 'cancelled'>, isRunning }`.
  `props` for a node: `x`, `y`, `position: {x, y}`, `scale` (number = uniform, or `{x, y}`),
  `rotation` (radians), `opacity`, `width`, `height`, or any numeric dotted path; for a plain
  object every key is a dotted path. `fadeIn(node, sec)`, `fadeOut(node, sec, { hide: true })`,
  `crossFade(from, to, sec)` (state/panel switches — the in-scene counterpart of
  `changeScene`'s fade), `killAll(target?)`. Use these instead of hand-lerping in `onUpdate`.
- **Trail (`scene.juice.trail`)**: `scene.juice.trail(node, { lifeSec: 0.35, widthPx: 14,
  color | colors: [], additive: true, zIndex, maxPoints: 48 })` → a fading ribbon that follows
  the node (a ball, a projectile); `trail.stop()` lets it fade out; freeing the node frees it.
- **Audio (`scene.audio`)**: `sfx(preset, { volume, pitch })` — procedural, no asset; presets
  `tap | score | bounce | explosion | powerup | win | lose | laser | tick`;
  `await play('res://sfx/hit.ogg', { bus: 'sfx', pitchVariation: 0.1, volumeVariation: 0.1 })`
  for an authored clip; `setBusVolume(bus, v, fadeSec)`, `applySnapshot(name)`, `stopAll()`.
- **2D physics (`scene.physics2d`)** — the built-in rigid-body solver; never hand-write one,
  never import rapier for 2D. Author Unity-style: `core:PhysicsBody2D` (`static | kinematic |
  dynamic`, `mass`, `restitution`, `friction`, `linearDamping`, `fixedRotation`, `bullet`,
  `emitContacts`) **and** `core:Collider2D` (`rect | circle | polygon | capsule`, `isSensor`,
  `group`) on the same node; a `core:Collider2D` alone is static geometry. Gravity is
  negative Y (`core:PhysicsWorld2D` on the root or `scene.physics2d.setGravity(0, -1800)`;
  top-down = `(0, 0)`). From a script: `const body = scene.physics2d.getBody(node)` →
  `setVelocity(vx, vy)`, `applyImpulse(ix, iy)`, `applyForce`, `teleport(x, y, rot?)`, `wake()`,
  `velocityX/Y`, `isSleeping`; queries `raycast(...)`, `overlapCircle(...)`,
  `overlapRect(...)`, `moveAndSlide(...)`; signals on the node: `body-entered` /
  `body-exited` (sensors), `contact-started` / `contact-ended` (with `emitContacts`).
  Joints: `core:RevoluteJoint2D`.
- 2D overlap-only queries (no response): `scene.collision2d.overlapPoint(x, y, group?)`,
  `overlapCircle(x, y, r, group?)`, `overlapRect(cx, cy, w, h, group?)`, `raycast(x1, y1, x2,
  y2, group?)` over nodes carrying `core:Hitbox2D`.
- Game intents: `scene.commands.register(name, handler, { description })`,
  `dispatch(name, args)`, `list()`, `log` — how tests and the menu drive the game without
  clicking.
- Debug surface for `game_observe` / `game_run`: `import { registerGameDebug } from
  '@pix3/runtime'`; in `onStart`: `this.disposeDebug = registerGameDebug({ name, version: 1,
  snapshot: () => ({ …JSON-safe state… }), inspect: (query, args) => …, action: (name, args)
  => … })`, call the returned disposer in `onDetach`. Global and last-wins — only the running
  scene's flow/rules script registers one; recipes already do (extend theirs, do not add a
  second).
- Cutscenes: `scene.cutscene.playCinematic(id, {…})`; camera blends via `core:CameraBrain`
  + `VirtualCamera3D`.
- Multiplayer: `scene.network`, `scene.netNodes`, `core:NetworkedNode`,
  `core:ReplicatedTransform` (only when the brief says multiplayer).

### `this.input`

- Per frame: `input.pointerEvents` → `{ type: 'down' | 'move' | 'up' | 'cancel', pointerId,
  x, y }[]` (`cancel` is never a completed tap); `input.keyEvents`; `input.wheelDelta` (plain
  scroll wheel only); `input.wheelZoomDelta` (Ctrl/⌘ + wheel and trackpad pinch — use it for
  camera zoom, it is excluded from `wheelDelta`); `input.wheelModifiers` (`{ ctrl, meta, shift,
  alt }`). The canvas already `preventDefault()`s every wheel event, so ctrl-wheel never zooms the page.
- Polled: `input.isPointerDown` (any finger), `input.pointerPosition` (primary finger,
  canvas space — convert with `scene.getPointer2DWorldPosition()`), `input.getActivePointers()`,
  `input.getPointer(id)`, `input.pointerDownCount`, `input.isPointerOverUI(pointerId)` (gate
  gestures on THIS, not on `isHoveringUI`), `input.getButton(name)` / `getAxis(name)`
  (`Action_Primary`, arrows / WASD axes), `lock()` / `unlock()`.
- Keyboard: compare `event.code` (`'KeyW'`, `'ArrowUp'`), case-sensitive.
- A tap-to-place mechanic is: on a `'down'` event, `scene.getPointer2DWorldPosition(ev.pointerId)`,
  convert to the board's local space (`board.worldToLocal` or subtract the board's world
  position), place the node, `scene.juice.burst({ x, y })`, `scene.audio.sfx('tap')`.

### Traps

- Assigning `position` / `rotation` / `scale` throws — mutate them.
- A component that throws in `onStart` / `onUpdate` is auto-disabled and the game keeps
  running — `read_errors` after `play_start` is the only way to see it.
- `this.node as any` disables exactly the check that would have caught the above.
- Hitstop every frame while an overlap lasts freezes the contact forever — edge-trigger it.
- A hidden `UIControl2D` takes no input; `tick` still runs on hidden nodes.

## Capability catalog — nodes

Add via the editor **Create** menu / `Create*Command`, or author in `.pix3scene`
YAML, or (from a script) construct + `parent.adoptChild(child)`. Full property
tables: node-types-reference.md.

**Structure / base**

- `Node2D`, `Node3D` — transform containers (2D uses anchors/layout; 3D is a
  Three.js `Object3D`). `Group2D` groups 2D content.

**2D content & UI** (orthographic overlay pass; draw order = tree order)

- `Sprite2D`, `AnimatedSprite2D`, `TiledSprite2D`, `ColorRect2D` — images / frames / 9-slice-ish tiling / solid rects.
- `SpineSkeleton2D` — a Spine skeleton (`.json`/`.skel` + `.atlas`). Skeletal rigs, mesh deformation and animation mixing, i.e. what a flipbook cannot do; see the recipe below.
- UI controls: `Button2D`, `Label2D`, `Slider2D`, `Joystick2D`, `Checkbox2D`, `Bar2D`, `ScrollContainer2D`, `InventorySlot2D`.
  **Skins:** these controls are colour-driven by default and take sprites through texture slots — `Button2D` `textureNormal/Hover/Pressed/Disabled`, `Checkbox2D` `textureBox` / `textureBoxChecked` / `textureMark`, `Slider2D` `textureTrack` / `textureFill` / `textureThumb`, `Bar2D` `textureTrough` / `textureFill`, plus `ScrollContainer2D`'s thumb/track. A set slot replaces that flat colour; an unset one keeps it. `Button2D`, `Slider2D` (track+fill) and `Bar2D` (trough+fill) also take the four `sliceBorder*` nine-slice insets `TiledSprite2D` uses, so one 64x64 skin fits any size instead of smearing — and a fill that shrinks with `value` is re-cut, not squashed. A sliced skin opts out of the 2D quad batcher.
  `Label2D` is multiline: a fixed `width` word-wraps, `labelAlign`/`labelVAlign` align inside the box, and `typewriterSpeed` + `setText()`/`skipTypewriter()`/`'typewriter-complete'` give a per-character reveal.
- `Camera2D` — pan/zoom/limits/shake for the 2D pass. `CanvasLayer2D` — fixed HUD layer, unaffected by Camera2D.
- `AnimatedSprite2D` (and `AnimatedSprite3D`) play a flipbook from a **`.pix3anim`** resource — see the recipe below. Switch clips from a script with **`sprite.play('attack', { restart: true })`** (returns `false` for an unknown clip; `restart` replays the current clip from frame 0, which is how a finished one-shot is fired again — writing `currentClip` alone never restarts). A non-looping clip emits **`animation-finished`** (clip name as arg) when it stops on the last frame. For self-freeing one-shot VFX set **`freeOnFinish: true`** on the node (destroys itself when the clip ends — no component); use `core:FreeOnSignal` only when the trigger is some _other_ signal.

**Flipbook animation (`.pix3anim`)** — hand-author it; the file is plain JSON and `SceneLoader` auto-loads the resource + every frame texture (also when the node arrives via `scene.instantiate` of a prefab). Every omitted field is defaulted on load (fps 12, loop true, `playbackMode` normal, anchor 0.5/0.5, `durationMultiplier` 1). Save it next to the frames, point the node at it. **Sequence mode** (one image per frame — the common case, e.g. an impact flash):

```json
{
  "version": "1.0.0",
  "texturePath": "",
  "clips": [
    {
      "name": "burst",
      "fps": 30,
      "loop": false,
      "frames": [
        { "texturePath": "res://.../fireb0001.png" },
        { "texturePath": "res://.../fireb0002.png" }
        /* … one entry per frame … */
      ]
    }
  ]
}
```

**Character with variants/states (weapon skins, outfits)** — one `.pix3anim` whose clips are named `<variant>.<state>` (`sword.idle`, `sword.attack`, `bow.idle`, …; a clip without the separator is a variant-less state such as `die`), an `AnimatedSprite2D` as the prefab root (`sizeMode: native` — every frame carries `sourceSize`; the frame `anchor` at the feet, so the node's position is where the character stands) and **`core:CharacterVisual2D`** on that same node (`variant`, `state`, `separator`, optional `spriteNodeId`; empty = the host itself, else its first `AnimatedSprite2D` child). Keep the sprite as the root: selecting the character then selects the drawn quad, and the viewport frames the visible art and marks the pivot at the node position — a `Group2D` wrapper frames a centred box that the frame anchor pushes off the art. Game code says `character.playState('attack', { restart: true })` and `character.setVariant('bow')` (keeps the state, restarts its clip) and never spells a clip name; both return `false` for a pair the resource lacks, no hidden fallback. A finished one-shot holds its last frame and the root emits **`state-finished`** `(state, variant)` — the component adds no movement, physics, AI or automatic transitions. `getVariants()` / `getStates(variant?)` read the vocabulary off the clip names. This is Unity's Sprite Library categories/labels + Sprite Resolver, not an AnimationTree. `compileCharacter` (`src/services/library/character-compiler.ts`) emits exactly this shape from grouped frame files — the Store's `character2d` asset kind — as a managed sprite folder (`sprites/<slug>/<slug>.pix3anim` + `<variant>_<state>_<nnnn>.png`) plus `prefabs/<Name>.pix3scene`; pass `anchor` (y from the top) at the feet row so the node's position is where the character stands — the default is the canvas centre.

**Spritesheet mode** instead: set top-level `texturePath` and give each frame a UV rect `offset:{x,y}` + `repeat:{x,y}` (these default to 0 → sample nothing, so they're required here). Frames may carry `durationMultiplier` and `events:[{signal,args}]` (fired on play-driven frame entry). Node wiring: `type: AnimatedSprite2D`, properties `animationResourcePath`, `currentClip`, `isPlaying`, `freeOnFinish` (one-shot self-destruct), `width`/`height`, `anchor`, `sizeMode`. First spawn of a runtime-instantiated clip warms its texture cache; if the first play must be pixel-perfect, spawn one invisible warm-up at level start. Authoring GUI: the editor's **Sprite Editor** produces the same file — one shell (canvas + clips rail + frame timeline) that edits both a bare image and a `.pix3anim`; selecting a frame binds the canvas to that frame's texture, and crop / rotate / flip / background-removal / generation write straight back into the frame.

**Frame presentation — `sizeMode`, per-frame `anchor`, `sourceSize`.** Two anchors are in play and they mean different things. The **node** `anchor` is a global pivot in the node's `width × height` box (y up, same as `Sprite2D.anchor`). Each **frame's** `anchor` is that frame's own origin inside its — possibly tightly cropped — raster, normalized with **y measured from the top** (image convention, like `boundingBox`). They compose: the quad is placed so the frame anchor lands on the node's position, then shifted by the node pivot. That is what makes cropping pay off — crop a frame tighter, move its anchor to the old visual centre, and the animation is pixel-identical while the PNG (and the atlas) shrinks. `sizeMode` decides how a frame fills the box: `'stretch'` (default, and what every pre-existing scene assumes) scales every frame to exactly `width × height`; `'native'` renders each frame at its own `sourceSize` scaled by one per-clip factor derived from the clip's FIRST frame, so mixed-size frames keep their relative proportions and resizing the node scales the whole animation uniformly (the editor sets `'native'` on newly created nodes). `sourceSize` is an optional per-frame `{width,height}` the editor stamps whenever a frame is added, imported or sliced, so native layout never waits on a texture load; a frame with no known size falls back to stretch, so legacy files keep working. The math lives in one shared module (`core/animated-sprite-layout.ts`) because the editor viewport draws SEPARATE proxy meshes — both apply the same resolver.

**Named frame points (sockets).** `AnimationFrame.points?: [{name, x, y, angle?}]` — points that live in frame space (normalized, y from the top; `angle` in degrees, 0 = right) and move _and rotate_ across frames: a muzzle on a barrel, a hand socket an item follows through a walk cycle. Read them from scripts — `sprite.getFramePoint('muzzle')` returns node-local `{x, y, angle}` usable directly as a child position, `getFramePointWorld('muzzle')` adds the node's world transform and accumulated Z rotation, `getClipPointNames()` lists the active clip's points; all return `null`/`[]` when the current frame doesn't define the point. Frame `events` compose naturally: an emitting frame fires `muzzle-flash`, the handler reads `getFramePoint('muzzle')`. For the "item in hand" case attach **`core:PointAttachment`** to the child (`point`, `applyRotation`, `offsetX`/`offsetY`, optional `spriteNodeId`); it parks the node on the named point every tick and leaves it alone on frames that don't define it. Authoring: the Sprite Editor's **points** canvas tool (drag the dot, drag the direction handle for the angle; the previous frame's points ghost behind as a mini onion-skin).

**Spine skeletal animation (`SpineSkeleton2D`)** — for rigs authored in the Spine
editor, when a flipbook (`.pix3anim`) is not enough: bone hierarchies, mesh
deformation, skins, and crossfaded animation mixing. Point the node at its
`skeletonPath` (`.json`/`.skel`) and `atlasPath` (`.atlas`); the page images come
from the atlas text and are resolved next to it. Once the asset loads, the
Inspector's `animation`/`skin` fields become dropdowns of the skeleton's real
names. From a script:

```ts
const hero = scene.getNode<SpineSkeleton2D>('Hero');
hero.play('run', { loop: true, mixDuration: 0.2 });
hero.queue('idle', { loop: true });
hero.setSkin('blue');
```

Editor playback is **opt-in**: a placed skeleton holds its first frame until you
press Play on the Inspector's Editor Preview row (`previewInEditor`), and Reset
rewinds to that frame without touching the authored state.

Signals: `animation-started`, `animation-finished` (non-looping end — pair with
`freeOnFinish: true` for one-shot VFX), `animation-looped`, and `spine-event` for
keyed animation events. Sizing is the node transform, not width/height. Spine is an
**optional** dependency (`@esotericsoftware/spine-threejs` `~4.3`, Spine Runtimes
License, lazily imported): the editor and the exported player register it
automatically, a consumer project calls
`setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'))` once.
Not batched/atlased and no shader-effect support (spine owns its materials); CPU
cost is per skeleton per frame, so budget dozens, not hundreds. Full property table:
`docs/node-types-reference.md` → `### SpineSkeleton2D`.

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

## Capability catalog — `core:*` behaviours

Attach in the inspector or in YAML `components:`. These are the pre-built,
designer-facing behaviors — prefer them over writing a script for the same
effect. Registered in
packages/pix3-runtime/src/behaviors/register-behaviors.ts.

| Component id               | Does                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:Rotate`              | Continuous rotation of a 3D node                                                                                                            |
| `core:SimpleMove`          | Simple test movement                                                                                                                        |
| `core:Sine`                | Oscillate a node along an axis                                                                                                              |
| `core:Follow`              | Smoothly follow a target node's position/rotation                                                                                           |
| `core:PinToNode`           | Pin a 2D UI node to a 3D target (screen projection)                                                                                         |
| `core:Fade`                | Fade a 2D node's opacity in/out (optional auto-destroy)                                                                                     |
| `core:RadialProgress`      | Circular progress mask on a Sprite2D                                                                                                        |
| `core:AnimationPlayer`     | Play keyframe clips on this node + descendants (§4)                                                                                         |
| `core:PointAttachment`     | Keep this node on a named frame point of a parent `AnimatedSprite2D` (hand socket, muzzle) every tick, optionally copying the point's angle |
| `core:CharacterVisual2D`   | `variant + state → clip` on an `AnimatedSprite2D` with clips named `<variant>.<state>`; `playState`/`setVariant`, `state-finished`          |
| `core:PlaySound`           | Play a sound when a node signal fires                                                                                                       |
| `core:SfxOnSignal`         | Play a **procedural** (asset-free) sound preset when a node signal fires — see §4 "Procedural SFX"                                          |
| `core:BurstOnSignal`       | Spawn a one-shot 2D particle burst at this node when a signal fires (juice)                                                                 |
| `core:FreeOnSignal`        | `queueFree` this node when a signal fires on it (e.g. `animation-finished`), after an optional delay — one-shot VFX lifecycle               |
| `core:Shake`               | Additive positional shake (juice)                                                                                                           |
| `core:PunchScale`          | Squash-and-stretch scale punch (juice)                                                                                                      |
| `core:PopIn`               | Spawn pop-in scale with overshoot (juice)                                                                                                   |
| `core:CameraBrain`         | Blend the render camera between virtual cameras (§4)                                                                                        |
| `core:Hitbox2D`            | Queryable 2D collision shape (rect/circle/polygon, group tag) — see §4 "2D collision"                                                       |
| `core:PhysicsBody2D`       | Rigid body simulated by `scene.physics2d` (static/kinematic/dynamic) — see §4 "2D physics"                                                  |
| `core:Collider2D`          | Physics shape (rect/circle/polygon, rotation-aware, may be concave); a sensor with no body is an Area2D                                     |
| `core:PhysicsWorld2D`      | Sets the 2D world gravity; attach to the scene root                                                                                         |
| `core:RevoluteJoint2D`     | Hinge with optional angle limits and a motor — flippers, swinging doors, ragdoll links                                                      |
| `core:NetworkedNode`       | Bind this node to a replicated entity — spawn one for the local player, adopt a peer's — see §4 "Multiplayer replication"                   |
| `core:ReplicatedTransform` | Replicate position/rotation: owner publishes quantized, peers interpolate on a timed buffer                                                 |

Most juice behaviors have a `triggerEvent` (a signal name) and/or `playOnStart`,
so a keyframe **event track** or a script `emit()` can fire them.

**Shader effects** (added via the inspector "Add Effect" picker or
`node.attachEffect(id)`) attach to `GeometryMesh` (3D) and to `Sprite2D` /
`AnimatedSprite2D` / `Button2D` skin (2D): `core:dissolve`, `core:rim`
(3D-only), `core:uv-scroll`, `core:flash`, `core:adjust`
(brightness/contrast/saturation), `core:grayscale`, `core:tint`. Params are
keyframe-animatable. See
packages/pix3-runtime/src/shader-effects/.

## `core:` components — every config key

Read from the runtime's component registry for this CLI's version: the keys a `config:` block
may carry, their type, the default a fresh component has, and the inspector's range/options.

### `core:AnimationPlayer`

Plays keyframe animation clips on this node and its descendants

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `autoplay` | string | `""` | Clip name to play automatically on start (empty = none) |
| `speed` | number | `1` | ≥ 0; Playback speed multiplier |

### `core:BurstOnSignal`

Spawn a one-shot 2D particle burst at this node when a signal fires (juice)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `signal` | string | `"hit"` | Node signal that fires the burst (e.g. hit, damaged, pointerdown) |
| `count` | number | `14` | 1..512; Particles per burst |
| `color` | color | `""` | Particle colour; empty = white |
| `speed` | number | `260` | ≥ 0; Initial particle speed |
| `sizePx` | number | `10` | ≥ 0.5 |
| `lifeSec` | number | `0.5` | ≥ 0.05 |
| `gravityY` | number | `-600` | Vertical acceleration; negative falls, 0 = weightless |

### `core:CameraBrain`

Blends the render camera between virtual cameras by priority (Cinemachine-lite)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `blendEnabled` | boolean | `true` | Ease between cameras on activation. Off = hard cut. |

### `core:CharacterVisual2D`

Plays variant + state as a clip of an AnimatedSprite2D whose clips are named <variant>.<state> (sword.idle); swap the variant, keep the state vocabulary

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | string | `""` | Clip-name prefix (sword, bow). Empty when clips are named by state alone |
| `state` | string | `""` | State played on start (idle) |
| `separator` | string | `"."` | Text between variant and state in clip names |
| `spriteNodeId` | string | `""` | AnimatedSprite2D to drive; empty = this node or its first sprite child |

### `core:Collider2D`

Physics shape (rect/circle/polygon, rotation-aware, may be concave). With no Physics Body above it this is static world geometry; as a sensor it reports body-entered / body-exited.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `shape` | select | `"rect"` | rect \| circle \| polygon \| capsule; All of them follow the node rotation and scale. A capsule is upright along local Y and sized by height + radius (Godot’s convention). A polygon may be concave; it is split into convex parts for you. |
| `width` | number | `64` | Rect width in design pixels. |
| `height` | number | `64` | Rect height, or a capsule’s TOTAL height including both caps. |
| `radius` | number | `32` | Circle radius, or a capsule’s cap radius (its half-width). |
| `offsetX` | number | `0` | Shape offset from the node origin. |
| `offsetY` | number | `0` | Shape offset from the node origin. |
| `polygonSource` | select | `"manual"` | manual \| frame; manual: the vertices below. frame: the collision polygon of the animation frame showing right now. |
| `points` | object | `[]` | Vertices in node-local pixels (y up). Edit them in the viewport. |
| `friction` | number | `0.4` | Coulomb friction. Combined between two colliders as the geometric mean. |
| `restitution` | number | `0.2` | Bounciness, 0 to 1. Combined as the maximum of the two. Slow contacts never bounce. |
| `density` | number | `1` | Mass per unit area, used when the body derives its own mass. |
| `sensor` | boolean | `false` | Detect overlaps and report body-entered / body-exited without pushing anything (Godot Area2D). |
| `group` | string | `"default"` | Tag used to filter physics queries (same convention as Hitbox2D). |

### `core:Fade`

Fades 2D node opacity in and out with optional auto-destroy

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `FadeInTime` | number | `0.5` | ≥ 0 |
| `FadeOutTime` | number | `0.5` | ≥ 0 |
| `FadeInDelay` | number | `0` | ≥ 0 |
| `FadeOutDelay` | number | `0` | ≥ 0 |
| `DestroyOnFadeOut` | boolean | `false` |  |
| `FadeOnStart` | boolean | `false` |  |

### `core:Follow`

Smoothly follows a target node position and/or rotation

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `targetNodeId` | node | `""` | Node to follow |
| `positionSmoothing` | number | `8` | ≥ 0; Higher values follow position faster |
| `followPositionX` | boolean | `true` |  |
| `followPositionY` | boolean | `true` |  |
| `followPositionZ` | boolean | `true` |  |
| `rotationSmoothing` | number | `8` | ≥ 0; Higher values follow rotation faster |
| `followRotationX` | boolean | `false` |  |
| `followRotationY` | boolean | `true` |  |
| `followRotationZ` | boolean | `false` |  |

### `core:FreeOnSignal`

Frees this node when a signal fires on it (e.g. animation-finished) — one-shot VFX lifecycle

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `signal` | string | `"animation-finished"` | Node signal that triggers the free (e.g. animation-finished) |
| `delay` | number | `0` | ≥ 0; Seconds to wait after the signal before freeing |

### `core:Hitbox2D`

Queryable 2D collision shape (rect/circle) with group filtering — hit-test via scene.collision2d

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `shape` | select | `"rect"` | rect \| circle \| polygon; Rect and circle are axis-aligned (rotation ignored, scale honored); polygon is rotation-aware and may be concave |
| `width` | number | `64` |  |
| `height` | number | `64` |  |
| `radius` | number | `32` |  |
| `offsetX` | number | `0` |  |
| `offsetY` | number | `0` |  |
| `polygonSource` | select | `"manual"` | manual \| frame; manual: the vertices below. frame: the collision polygon of the animation frame currently showing on this AnimatedSprite2D. |
| `points` | object | `[]` | Vertices in node-local pixels (y up). Edit them in the viewport. |
| `group` | string | `"default"` | Collision group tag used to filter queries (Godot-style group) |
| `debugDraw` | boolean | `false` | Render the shape outline in play mode |

### `core:NetworkedNode`

Binds this node to a replicated entity — spawns one for the local player, or adopts the entity a peer spawned

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `prefabPath` | string | `""` | This node's own prefab (res:// path). Indexes the build's netKindTable to the wire kind, and is what every other client instantiates for this entity. |
| `ownership` | select | `"owned"` | owned \| shared \| transferable; What happens when the owner leaves: owned = despawned, shared = reassigned to the new host, transferable = reassignable to anyone. |
| `spawnOnStart` | boolean | `true` | Request an entity as soon as this node starts. Turn it off for a node a script spawns explicitly, or for a prefab that only ever represents a peer. |
| `despawnOnDetach` | boolean | `true` | Despawn the entity when this node goes away (scene change, queueFree). Off leaves a ghost in the room until its owner disconnects. |
| `appFlags` | number | `0` | 0..31; Game-defined flag bits 3–7 (0–31), replicated verbatim. |

### `core:PhysicsBody2D`

Rigid body simulated by scene.physics2d — static, kinematic or dynamic. Shape comes from sibling or descendant Collider 2D components.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `bodyType` | select | `"dynamic"` | static \| kinematic \| dynamic; static: never moves. kinematic: moved by scripts/animation, pushes others, is not pushed. dynamic: simulated. |
| `gravityScale` | number | `1` | Multiplier on world gravity. 0 makes the body float; negative makes it rise. |
| `mass` | number | `0` | Explicit mass. 0 derives it from the collider area times its density. |
| `linearDamping` | number | `0` | Per-second velocity decay. |
| `angularDamping` | number | `0.05` | Per-second spin decay. |
| `fixedRotation` | boolean | `false` | Lock the rotation — the usual choice for a character or a UI prop. |
| `bullet` | boolean | `false` | Sweep this body against static geometry so a fast circle cannot tunnel through a wall. |
| `canSleep` | boolean | `true` | Let the body stop simulating once it has been at rest for half a second. |
| `emitContacts` | boolean | `false` | Fire contact-started / contact-ended on this node. Off by default: most games never read them. |

### `core:PhysicsWorld2D`

Sets the 2D world gravity. Attach to the scene root.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `gravityX` | number | `0` | Sideways gravity in px/s^2. 0 for most games. |
| `gravityY` | number | `-1960` | Vertical gravity in px/s^2. Y is up, so falling is NEGATIVE. |

### `core:PinToNode`

Pins a 2D UI node to a 3D target node

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `targetNodeId` | node | `""` |  |
| `yOffset` | number | `2` |  |

### `core:PlaySound`

Plays an audio track when a node signal is emitted

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `audioTrack` | string | `""` | Asset URL (res://..., data:audio/..., or absolute URL) |
| `triggerEvent` | string | `"pointerdown"` | Node signal or UI event (pointerdown, pointerup, click) |
| `volume` | number | `1` | 0..1 |
| `loop` | boolean | `false` |  |
| `bus` | enum | `"sfx"` | master \| music \| sfx |
| `pitchVariation` | number | `0` | 0..1; Random ± playback-rate spread per shot |
| `volumeVariation` | number | `0` | 0..1; Random ± volume spread per shot |

### `core:PointAttachment`

Keeps this node on a named frame point of a parent AnimatedSprite2D (hand socket, muzzle) every tick

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `point` | string | `""` | Named frame point to follow |
| `applyRotation` | boolean | `true` | Copy the point's angle into this node |
| `offsetX` | number | `0` |  |
| `offsetY` | number | `0` |  |
| `spriteNodeId` | node | `""` | AnimatedSprite2D to read points from (empty = nearest ancestor) |

### `core:PopIn`

Scales a node up from zero with an overshoot on spawn (juice)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `from` | number | `0` | ≥ 0; Starting fraction of the authored scale |
| `duration` | number | `0.4` | ≥ 0 |
| `easing` | select | `"backOut"` | backOut \| elasticOut \| bounceOut \| cubicOut \| quadOut \| linear |
| `triggerEvent` | string | `""` | Node signal that triggers the pop (empty = manual/API only) |
| `playOnStart` | boolean | `true` |  |

### `core:PunchScale`

Squash-and-stretch scale punch on a signal or on start (juice)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `amount` | number | `0.3` | ≥ 0; Peak scale delta (0.3 = +30%) |
| `duration` | number | `0.35` | ≥ 0 |
| `vibrato` | number | `3` | ≥ 0; Oscillations before settling |
| `triggerEvent` | string | `""` | Node signal that triggers the punch (empty = manual/API only) |
| `playOnStart` | boolean | `false` |  |

### `core:RadialProgress`

Masks a Sprite2D texture as a circular progress bar

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `value` | number | `1` | 0..1; Target progress from 0.0 (empty) to 1.0 (full) |
| `animationSpeed` | number | `3` | 0..20; How fast the progress bar animates (higher = faster) |
| `startAngle` | number | `0` | -360..360; Starting angle in degrees. 0 = top (12 o'clock), 90 = right |
| `clockwise` | boolean | `true` | Fill direction: clockwise or counter-clockwise |

### `core:ReplicatedTransform`

Replicates this node's position and rotation: the owner publishes quantized values, peers render them on a timed interpolation buffer

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `sendRateHz` | number | `20` | 1..60; How often the owner publishes. The session still only sends what actually changed (dirty detection compares quantized integers), so an idle entity costs nothing. |
| `replicateRotation` | boolean | `true` | Send rotation as well as position (256 steps per turn, 1.41°). |
| `plane` | select | `"xy"` | xy \| xz; Which axes the wire's X/Y drive: xy for 2D nodes, xz for a top-down 3D game. |
| `interpolationDelayMs` | number | `0` | 0..500; 0 = adaptive (two room ticks plus measured jitter). Raise it for a lossy link, lower it for a LAN — it is latency traded for smoothness. |

### `core:RevoluteJoint2D`

Hinge: pins this body to a pivot so it can only rotate about it. With no connected node the hinge is fixed to the world — the pinball flipper / swinging door case. Optional angle limits and a motor.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `anchorX` | number | `0` | Pivot point in this node’s local pixels. (0, 0) hinges on the node origin. |
| `anchorY` | number | `0` | Pivot point in this node’s local pixels. |
| `connectedNode` | string | `""` | Name, id or path of the body to hinge to. Empty pins the hinge to the world, which is what a flipper or a swinging door wants. |
| `limitEnabled` | boolean | `false` | Restrict the swing to an angle range. |
| `lowerAngle` | number | `-45` | Degrees, relative to the rest pose. |
| `upperAngle` | number | `45` | Degrees, relative to the rest pose. |
| `motorEnabled` | boolean | `false` | Drive the hinge towards a target spin. |
| `motorSpeed` | number | `0` | Target spin in degrees per second. Flip its sign to swing the other way. |
| `maxMotorTorque` | number | `100000` | Torque ceiling. Too low and the motor cannot lift the arm; too high and it ignores everything it hits. |
| `collideConnected` | boolean | `false` | Let the two hinged bodies collide. Off by default: they overlap at the pivot, and a contact there fights the joint. |

### `core:Rotate`

Rotates a 3D node continuously

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `rotationSpeed` | number | `1` | 0..10; Speed of rotation in radians per second |

### `core:SfxOnSignal`

Play a procedural (asset-free) sound preset when a node signal fires

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `signal` | string | `"pointerdown"` | Node signal that plays the sound (pointerdown, hit, damaged, …) |
| `preset` | enum | `"tap"` | tap \| score \| bounce \| explosion \| powerup \| win \| lose \| laser \| tick; Built-in synth patch played on the sfx bus |
| `volume` | number | `1` | 0..1 |
| `pitch` | number | `1` | 0.25..4; Frequency multiplier: 2 = an octave up, 0.5 = an octave down |

### `core:Shake`

Smooth positional shake, additive over other motion (juice)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `amplitude` | number | `8` | ≥ 0 |
| `frequency` | number | `24` | ≥ 0 |
| `duration` | number | `0.35` | ≥ 0 |
| `decay` | number | `1.5` | ≥ 0; Falloff power (0 = steady, 1 = linear, >1 = punchy tail) |
| `triggerEvent` | string | `""` | Node signal that starts the shake (empty = manual/API only) |
| `playOnStart` | boolean | `false` |  |

### `core:SimpleMove`

Moves a 3D node in a simple pattern (for testing)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `speed` | number | `5` | 0..50; Movement speed units per second |
| `axisHorizontal` | string | `"Horizontal"` | Input axis name for horizontal movement |
| `axisVertical` | string | `"Vertical"` | Input axis name for vertical movement |
| `movementPlane` | select | `"xz"` | xz \| xy; Select whether vertical input moves on XY or XZ plane |
| `invertVertical` | boolean | `true` | Invert sign for vertical input axis |

### `core:Sine`

Oscillates a node along a selected axis

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `amplitude` | number | `1` | ≥ 0; Maximum displacement from the center |
| `frequency` | number | `1` | ≥ 0; Oscillations per second |
| `axis` | select | `"y"` | x \| y \| z; The axis to oscillate along |
