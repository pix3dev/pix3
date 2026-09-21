# Engine API map — what a game script can call

This is the index. Everything below exists and is exported from `@pix3/runtime`; use it
directly and **do not `engine_search` / `engine_read` for anything listed here** — a live run
spent 34 hops re-discovering `pointerEvents` and `position.set`. Search the engine only for
what this map does not name, and say in one line what you were missing.

## A `Script` (`export class X extends Script` in `scripts/`, attached as `user:X`)

- Lifecycle: `onAttach(node)` → `onStart()` (first frame) → `onUpdate(dt)` (scaled seconds;
  frozen by hitstop) → `onDetach()`. Defaults in the constructor's `this.config = {…}`;
  `static getPropertySchema()` exposes them to the inspector / `set_component_property`.
- `this.node` (owner `NodeBase`), `this.scene` (`SceneService`, guard for `undefined` in
  editor previews), `this.input` (`InputService`), `this.findNode(q)` (id / name / path →
  node or null), `this.getNode(q)` (throws when missing).
- Reach another script: `import { Other } from './Other'; this.node.getComponent(Other)` —
  the class, never the `user:Other` string.

## Nodes (`NodeBase`)

- Transform is three.js and **read-only by reference**: `node.position.set(x, y, 0)`,
  `node.position.x += dx`, `node.rotation.z = radians`, `node.scale.set(s, s, 1)`. Never
  assign `node.position = …`.
- `visible`, `name`, `id`, `children`, `parentNode`, `findById(id)`, `findByName(name)`,
  `adoptChild(child)` (runtime parenting), `queueFree()` (safe inside `onUpdate`; use
  `dispose()` only outside the tick), `getComponent(Class)`, `addComponent(c)`,
  `removeComponent(c)`.
- Signals: `node.emit(name, ...args)`, `node.connect(name, target, fn)`,
  `node.disconnect(name, target, fn)` (the `Script` base auto-disconnects on detach).
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

## `this.scene` (`SceneService`)

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
- **Juice (`scene.juice`)** — one-liners, call them WITH the mechanic: `shake(target, {…})`,
  `punchScale(target, {…})`, `popIn(target, {…})`, `flash({…})`, `burst(anchor, { count: 14,
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

## `this.input` (`InputService`) — pointer and touch are already unified

- Per frame: `input.pointerEvents` → `{ type: 'down' | 'move' | 'up' | 'cancel', pointerId,
  x, y }[]` (`cancel` is never a completed tap); `input.keyEvents`; `input.wheelDelta`.
- Polled: `input.isPointerDown` (any finger), `input.pointerPosition` (primary finger,
  canvas space — convert with `scene.getPointer2DWorldPosition()`), `input.getActivePointers()`,
  `input.getPointer(id)`, `input.pointerDownCount`, `input.isPointerOverUI(pointerId)` (gate
  gestures on THIS, not on `isHoveringUI`), `input.getButton(name)` / `getAxis(name)`
  (`Action_Primary`, arrows / WASD axes), `lock()` / `unlock()`.
- Keyboard: compare `event.code` (`'KeyW'`, `'ArrowUp'`), case-sensitive.
- A tap-to-place mechanic is: on a `'down'` event, `scene.getPointer2DWorldPosition(ev.pointerId)`,
  convert to the board's local space (`board.worldToLocal` or subtract the board's world
  position), place the node, `scene.juice.burst({ x, y })`, `scene.audio.sfx('tap')`.

## Built-in behaviours (`add_component` with these ids, configure with `set_component_property`)

`core:AnimationPlayer`, `core:BurstOnSignal`, `core:CameraBrain`, `core:Collider2D`,
`core:Fade`, `core:Follow`, `core:FreeOnSignal`, `core:Hitbox2D`, `core:PhysicsBody2D`,
`core:PhysicsWorld2D`, `core:PinToNode`, `core:PlaySound`, `core:PointAttachment`,
`core:PopIn`, `core:PunchScale`, `core:RadialProgress`, `core:RevoluteJoint2D`, `core:Rotate`,
`core:SfxOnSignal`, `core:Shake`, `core:SimpleMove`, `core:Sine`, `core:NetworkedNode`,
`core:ReplicatedTransform`. `list_component_types` gives each one's properties.

## Traps (compile clean, break at runtime)

- Assigning `position` / `rotation` / `scale` throws — mutate them.
- A component that throws in `onStart` / `onUpdate` is auto-disabled and the game keeps
  running — `read_errors` after `play_start` is the only way to see it.
- `this.node as any` disables exactly the check that would have caught the above.
- Hitstop every frame while an overlap lasts freezes the contact forever — edge-trigger it.
- A hidden `UIControl2D` takes no input; `tick` still runs on hidden nodes.
