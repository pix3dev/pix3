# Pix3 Nodes & Systems — Capabilities Guide for Agents

**Read this before writing custom game logic.** It is the inventory of what the
Pix3 engine and editor already do, and how to reach each capability correctly.
If a capability exists here, **use it instead of hand-rolling it in game code** —
that is the rule CLAUDE.md's *Engine vs Game feature decision* enforces.

- Node detail (every property, per node): [node-types-reference.md](node-types-reference.md)
- Product/architecture source of truth: [pix3-specification.md](pix3-specification.md)
- Deep-dive diagrams (operations flow, schema, rendering, state): [architecture.md](architecture.md)
- Property-schema authoring: [property-schema-reference.md](property-schema-reference.md)

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
- `SpineSkeleton2D` — a Spine skeleton (`.json`/`.skel` + `.atlas`). Skeletal rigs, mesh deformation and animation mixing, i.e. what a flipbook cannot do; see the recipe below.
- UI controls: `Button2D`, `Label2D`, `Slider2D`, `Joystick2D`, `Checkbox2D`, `Bar2D`, `ScrollContainer2D`, `InventorySlot2D`.
  `Label2D` is multiline: a fixed `width` word-wraps, `labelAlign`/`labelVAlign` align inside the box, and `typewriterSpeed` + `setText()`/`skipTypewriter()`/`'typewriter-complete'` give a per-character reveal.
- `Camera2D` — pan/zoom/limits/shake for the 2D pass. `CanvasLayer2D` — fixed HUD layer, unaffected by Camera2D.
- `AnimatedSprite2D` (and `AnimatedSprite3D`) play a flipbook from a **`.pix3anim`** resource — see the recipe below. A non-looping clip emits **`animation-finished`** (clip name as arg) when it stops on the last frame. For self-freeing one-shot VFX set **`freeOnFinish: true`** on the node (destroys itself when the clip ends — no component); use `core:FreeOnSignal` only when the trigger is some *other* signal.

**Flipbook animation (`.pix3anim`)** — hand-author it; the file is plain JSON and `SceneLoader` auto-loads the resource + every frame texture (also when the node arrives via `scene.instantiate` of a prefab). Every omitted field is defaulted on load (fps 12, loop true, `playbackMode` normal, anchor 0.5/0.5, `durationMultiplier` 1). Save it next to the frames, point the node at it. **Sequence mode** (one image per frame — the common case, e.g. an impact flash):
```json
{ "version": "1.0.0", "texturePath": "",
  "clips": [{ "name": "burst", "fps": 30, "loop": false, "frames": [
    { "texturePath": "res://.../fireb0001.png" },
    { "texturePath": "res://.../fireb0002.png" }
    /* … one entry per frame … */
  ]}]}
```
**Spritesheet mode** instead: set top-level `texturePath` and give each frame a UV rect `offset:{x,y}` + `repeat:{x,y}` (these default to 0 → sample nothing, so they're required here). Frames may carry `durationMultiplier` and `events:[{signal,args}]` (fired on play-driven frame entry). Node wiring: `type: AnimatedSprite2D`, properties `animationResourcePath`, `currentClip`, `isPlaying`, `freeOnFinish` (one-shot self-destruct), `width`/`height`, `anchor`, `sizeMode`. First spawn of a runtime-instantiated clip warms its texture cache; if the first play must be pixel-perfect, spawn one invisible warm-up at level start. Authoring GUI: the editor's **Sprite Editor** produces the same file — one shell (canvas + clips rail + frame timeline) that edits both a bare image and a `.pix3anim`; selecting a frame binds the canvas to that frame's texture, and crop / rotate / flip / background-removal / generation write straight back into the frame.

**Frame presentation — `sizeMode`, per-frame `anchor`, `sourceSize`.** Two anchors are in play and they mean different things. The **node** `anchor` is a global pivot in the node's `width × height` box (y up, same as `Sprite2D.anchor`). Each **frame's** `anchor` is that frame's own origin inside its — possibly tightly cropped — raster, normalized with **y measured from the top** (image convention, like `boundingBox`). They compose: the quad is placed so the frame anchor lands on the node's position, then shifted by the node pivot. That is what makes cropping pay off — crop a frame tighter, move its anchor to the old visual centre, and the animation is pixel-identical while the PNG (and the atlas) shrinks. `sizeMode` decides how a frame fills the box: `'stretch'` (default, and what every pre-existing scene assumes) scales every frame to exactly `width × height`; `'native'` renders each frame at its own `sourceSize` scaled by one per-clip factor derived from the clip's FIRST frame, so mixed-size frames keep their relative proportions and resizing the node scales the whole animation uniformly (the editor sets `'native'` on newly created nodes). `sourceSize` is an optional per-frame `{width,height}` the editor stamps whenever a frame is added, imported or sliced, so native layout never waits on a texture load; a frame with no known size falls back to stretch, so legacy files keep working. The math lives in one shared module (`core/animated-sprite-layout.ts`) because the editor viewport draws SEPARATE proxy meshes — both apply the same resolver.

**Named frame points (sockets).** `AnimationFrame.points?: [{name, x, y, angle?}]` — points that live in frame space (normalized, y from the top; `angle` in degrees, 0 = right) and move *and rotate* across frames: a muzzle on a barrel, a hand socket an item follows through a walk cycle. Read them from scripts — `sprite.getFramePoint('muzzle')` returns node-local `{x, y, angle}` usable directly as a child position, `getFramePointWorld('muzzle')` adds the node's world transform and accumulated Z rotation, `getClipPointNames()` lists the active clip's points; all return `null`/`[]` when the current frame doesn't define the point. Frame `events` compose naturally: an emitting frame fires `muzzle-flash`, the handler reads `getFramePoint('muzzle')`. For the "item in hand" case attach **`core:PointAttachment`** to the child (`point`, `applyRotation`, `offsetX`/`offsetY`, optional `spriteNodeId`); it parks the node on the named point every tick and leaves it alone on frames that don't define it. Authoring: the Sprite Editor's **points** canvas tool (drag the dot, drag the direction handle for the angle; the previous frame's points ghost behind as a mini onion-skin).

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
| `core:PointAttachment` | Keep this node on a named frame point of a parent `AnimatedSprite2D` (hand socket, muzzle) every tick, optionally copying the point's angle |
| `core:PlaySound` | Play a sound when a node signal fires |
| `core:SfxOnSignal` | Play a **procedural** (asset-free) sound preset when a node signal fires — see §4 "Procedural SFX" |
| `core:BurstOnSignal` | Spawn a one-shot 2D particle burst at this node when a signal fires (juice) |
| `core:FreeOnSignal` | `queueFree` this node when a signal fires on it (e.g. `animation-finished`), after an optional delay — one-shot VFX lifecycle |
| `core:Shake` | Additive positional shake (juice) |
| `core:PunchScale` | Squash-and-stretch scale punch (juice) |
| `core:PopIn` | Spawn pop-in scale with overshoot (juice) |
| `core:CameraBrain` | Blend the render camera between virtual cameras (§4) |
| `core:Hitbox2D` | Queryable 2D collision shape (rect/circle, group tag) — see §4 "2D collision" |
| `core:NetworkedNode` | Bind this node to a replicated entity — spawn one for the local player, adopt a peer's — see §4 "Multiplayer replication" |
| `core:ReplicatedTransform` | Replicate position/rotation: owner publishes quantized, peers interpolate on a timed buffer |

Most juice behaviors have a `triggerEvent` (a signal name) and/or `playOnStart`,
so a keyframe **event track** or a script `emit()` can fire them.

**Shader effects** (added via the inspector "Add Effect" picker or
`node.attachEffect(id)`) attach to `GeometryMesh` (3D) and to `Sprite2D` /
`AnimatedSprite2D` / `Button2D` skin (2D): `core:dissolve`, `core:rim`
(3D-only), `core:uv-scroll`, `core:flash`, `core:adjust`
(brightness/contrast/saturation), `core:grayscale`, `core:tint`. Params are
keyframe-animatable. See
[packages/pix3-runtime/src/shader-effects/](../packages/pix3-runtime/src/shader-effects/).

---

## 4. Systems (engine-level capabilities)

Each entry: **what it is → how to use it → where it lives**.

### Keyframe animation
Timeline-authored clips (position/rotation/scale/color tracks + audio + event
tracks) on `core:AnimationPlayer`. **Use:** attach `core:AnimationPlayer`, author
in the **Animation** timeline panel (keyframes — not the Sprite Editor, which owns
flipbook frames), `player.play('clip')` or `autoplay`. Event tracks emit
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
- `scene.juice.burst(target, opts)` — one-shot 2D particle burst. `target` is a node, a node query, or a `{x,y}` 2D world point. Options (all defaulted, all clamped): `count` (14, max 512), `speed` (260 px/s), `spread` (radians, default `2π`), `direction` (radians, default up), `lifeSec` (0.5), `color` / `colors` (palette), `sizePx` (10), `gravityY` (-600), `fadeOut` (true), `additive` (true — the neon look), `zIndex`. Preset form: `core:BurstOnSignal`.
- `scene.juice.floatText(text, opts)` — floating score/text popup (pops in, rises, fades, frees itself; never pickable). Options: `at` (node / query / `{x,y}`), `color`, `fontSizePx` (28), `fontFamily`, `driftPx` (60 up), `durationSec` (0.8), `glow` (`true` = glow in the text colour, or a colour string), `glowStrength` (1.5), `zIndex`.
Both spawn a runtime-only 2D node into the anchor's 2D root — no authoring, no
YAML, nothing to clean up — and tick through `node.tick`, so a hitstop freezes
them like every other juice effect. Call them **together with the mechanic** they
punctuate; they are one-liners, not a later polish pass.
Spec §6.12; demo: [../samples/HelloWorld/demo-05-juice.pix3scene](../samples/HelloWorld/demo-05-juice.pix3scene).

### Audio (buses, snapshots, one-shots)
3-bus mixer (`master`/`music`/`sfx`) with named snapshots + auto-muffle under
slow-mo. **Use from scripts:** `scene.audio.play('res://sfx/hit.ogg', { bus:'sfx', pitchVariation:0.1, volumeVariation:0.1 })`, `setBusVolume`, `applySnapshot`/`resetSnapshot`, `registerSnapshot`. **In the scene:** `AudioPlayer` node or `core:PlaySound` behavior (both take `bus`/`pitchVariation`/`volumeVariation`). node-types-reference "Buses, snapshots & scene.audio".

### Procedural SFX (no assets)
`scene.audio.sfx(preset, { volume?, pitch? })` synthesizes a one-shot on the `sfx`
bus — no audio file to find, import, or ship. Presets: `tap`, `score`, `bounce`,
`explosion`, `powerup`, `win`, `lose`, `laser`, `tick`. `pitch` is a frequency
multiplier (0.25–4; 2 = an octave up) baked into the render, not a playback-rate
stretch, so duration is unchanged. Each preset+pitch is rendered into an
`AudioBuffer` once and cached; with no Web Audio context (headless / tests) every
call is a silent no-op that never throws. **In the scene:** `core:SfxOnSignal`
(`{signal, preset, volume, pitch}`). An authored asset always beats the synth —
use `scene.audio.play()` when the project has the clip; reach for `sfx()` when it
doesn't (prototypes, jam builds, generated recipes).
Source: [packages/pix3-runtime/src/core/SfxSynth.ts](../packages/pix3-runtime/src/core/SfxSynth.ts).

### Shader effects (Construct 3-style, per-node)
Registry-backed material effects with an `enabled` toggle (zero GPU cost while
disabled — attached-but-disabled keeps its params) and typed params
(number/color/vector2/boolean) exposed as `fx.<key>.<param>` — inspectable,
keyframe-animatable, undoable. Hosts: `GeometryMesh` (standard material) and
`Sprite2D`/`AnimatedSprite2D`/`Button2D` skin (basic material; an effected 2D
mesh opts out of the quad batcher automatically). Built-ins: `core:dissolve`,
`core:rim` (3D-only), `core:uv-scroll`, `core:flash`, `core:adjust`
(brightness/contrast/saturation — e.g. dim a menu button, restore on hover),
`core:grayscale`, `core:tint`. **Use:** inspector "Add Effect", or from scripts
`node.attachEffect('core:adjust')` + `node.setEffectParam('adjust', 'brightness', 0.65)`
(short key or full id) / `node.setEffectEnabled('core:adjust', false)`. Effects
serialize with the node and render in the editor viewport too. Custom effects:
`registerShaderEffect(info)` with GLSL chunks + `targets: ['basic'|'standard']`.

### Post-processing
Add a `PostProcess` node to enable an EffectComposer pass (bloom / vignette /
chromatic aberration / AO modes). **Use:** drop one `PostProcess` node; configure
its properties. Pure-2D scenes can opt 2D in via `affect2D`.

### 3D model generation (Model Lab — editor authoring)
Editor-side tool that reconstructs a hard-surface 3D model **procedurally by
code** from a reference image (NOT neural image-to-mesh): vision assess → sculpt
spec → locked passes (blockout → structure → form → material → lighting →
optimization) where each pass is rendered offscreen, composited against the
reference into a comparison sheet, vision-scored, and self-corrected. The output
is a self-contained `.glb` (+ optional `.sculpt.json` / `.factory.ts` siblings
for re-editing) that becomes a scene node via `MeshInstance`. The generated code
contract is a pure `createModel(THREE): THREE.Group` factory — Mesh*Standard*/
*Physical* materials only (no `ShaderMaterial`, it wouldn't survive GLB export).
**Use (editor):** Tools → Model Lab; drop a reference image, Generate, Save GLB,
Add to scene; the Settings tab picks the codegen + vision models and a
pause-per-pass manual review (Accept / Retry / Stop). **Use (agent):** the
`generate_model_3d` tool — args `reference` (project asset path) + `name` (GLB
target); returns the saved path, per-pass scores, and a preview. **Headless /
debug:** `window.__PIX3_DEBUG__.model3d` (`generate` / `generateFromSpec` /
`rebuild` / `history` / `openHistory`). Objects only — characters/organics are
not supported yet. Lives in `src/services/model-gen/` + `src/ui/model-lab/`.

Model Lab has a second **Scene lane** (a lane switch in the panel) that generates
whole `.pix3scene` **levels** from a text brief, using the project's existing
assets as a palette: scan inventory → `LevelSpec` (zones / lighting / camera
intent + flagged palette gaps) → locked passes (layout → placement → dressing →
lighting → polish) emitting declarative `.pix3scene` YAML, gated by the runtime
`SceneManager.parseScene` PLUS an allow-list/asset-ref check (parseScene alone
tolerates unknown types and missing refs), previewed as a live runtime scene from
multiple viewpoints, and vision-reviewed against the brief. It can also EDIT an
existing scene (dress/light passes over a loaded `.pix3scene`), expands a
`type: Scatter` authoring-sugar node into deterministic seeded node clusters
before the gate (never persisted), and flags "palette gaps" that hand off to the
model lane. Output saves via `writeTextFile` and opens as a normal scene tab
(`EditorTabService.focusOrOpenScene`). **Agent:** `generate_scene_3d` (`brief` +
`name`, optional `references` / `baseScene`). **Debug:** `__PIX3_DEBUG__.scene3d`.
Scene lane lives in `src/services/model-gen/scene/`.

### Localization (i18n)
Per-locale JSON tables in the project's `locales/` directory
(`locales/en.json`, `locales/ru.json`): a `strings` section (translation key →
text, `{param}` interpolation) and a `sprites` section (sprite key → `res://`
texture path, for skins with baked text). Resolution never throws: current
locale → fallback locale → the key itself (strings) / the authored texture
(sprites). **Use — text:** set `labelKey` on any `UIControl2D` (inspector has
an autocomplete widget with an "extract from literal" button); the literal
`label` stays as designer fallback, key wins when both are set. **Use — sprites:**
set `textureKey` on a `Sprite2D`, or the per-state `textureNormalKey`/
`textureHoverKey`/`texturePressedKey`/`textureDisabledKey` on a `Button2D`;
authored texture refs stay as fallback. **Use — scripts:**
`this.scene.localization.tr('mission.name.2', {n: 2})`,
`trPlural('game.wave-failed', lives)` (suffix keys `.one/.few/.many/.other` via
`Intl.PluralRules`, `{count}` auto-interpolated),
`await this.scene.localization.setLocale('ru')` (every keyed label/sprite
re-renders live), `onChange(cb)`, `trSprite(key)`; `label.setTextKey(key, params?)`
keeps dynamic labels re-resolvable on locale switch (`setText` clears the key).
Reference migration: `samples/SkyDefender` (mission names/briefings/goals as
keys in `SdBalance`, `locales/en.json`+`ru.json`, keyed HUD/shop/map labels).
**Authoring:** View → Localization panel (Strings/Sprites tabs, per-locale
columns, missing-translation filter, preview-locale switch that live-updates the
viewport). The panel's **Scan** button extracts keys project-wide: it lists
unlocalized `label:` literals (per-item Extract creates the default-locale key
and binds `labelKey`) and script `tr()`-literal keys missing from the default
table, then seeds missing keys into other locales as `""` placeholders (empty
entries count as untranslated and fall through to the fallback locale). Rows
rename in place (pencil / double-click) — the key moves in every locale table
and `labelKey`/`textureKey` references in open scenes are rewritten, one undo.
Locale list/default live in `pix3project.yaml` (`localization:` block)
or are auto-discovered from `locales/`; locale tables get their own **Locales**
category in the asset browser's by-type view. Exports bake the config and embed
the tables + localized sprites automatically. Lives in
`packages/pix3-runtime/src/core/localization/`.

### Particles
`Particles3D` — emission, trails, sub-emitters, world/local simulation space, and
`emitBurstAt(...)` for scripted bursts.

### ECS (fixed-step logic)
`ECSService` runs a deterministic fixed-step update alongside per-frame node
ticks. Games register systems/components for physics, AI, spawning, etc. **Use
(consumer):** `sceneService.getECSService()` → register systems; the runner calls
`fixedUpdate`. For bulk instanced rendering see `InstancedMesh3D` in [node-types-reference.md](node-types-reference.md).

### Physics
No built-in rigidbody node yet. Rapier is available (lazy-loaded) and the
fixed-step ECS loop is the integration point; **games implement their own physics
systems** on top (DeepCore does this). If asked for physics, prefer a game-level
ECS system unless building a reusable engine node (confirm first).

### 2D collision (`scene.collision2d`, `core:Hitbox2D`)
Lightweight query-based 2D hit-testing (Godot Area2D groups × Unity `Physics2D.Overlap*`
— no solver, no rigidbodies). Attach `core:Hitbox2D` to any 2D node: shape
(`rect`/`circle`), size, offset, `group` tag, `debugDraw` outline (Godot's
"Visible Collision Shapes"). Shapes are **axis-aligned** (rotation ignored, scale
honored). **Use from scripts:**
`scene.collision2d.overlapPoint(x, y, group?)` / `overlapCircle(x, y, r, group?)` /
`overlapRect(cx, cy, w, h, group?)` → `Hit2D[]`, and
`raycast(x1, y1, x2, y2, group?)` → closest hit with entry point + distance (the
sniper-laser / line-of-sight query). Coordinates are 2D world/design px (origin
center, Y up). Broadphase is a linear scan — fine for hundreds of hitboxes.
Lives in [../packages/pix3-runtime/src/core/Collision2DService.ts](../packages/pix3-runtime/src/core/Collision2DService.ts) +
[../packages/pix3-runtime/src/behaviors/Hitbox2DBehavior.ts](../packages/pix3-runtime/src/behaviors/Hitbox2DBehavior.ts).

### Input (`this.input`, `InputService`)
Polled + per-frame input, unified across pointer/keyboard: `getAxis(name)`,
`getButton(name)`, `pointerEvents` / `keyEvents` (this frame), `pointerPosition`,
`wheelDelta`, `isPointerDown`, `isHoveringUI`. Depth-counted `lock()`/`unlock()`
(used by the Cutscene Director) silences the whole polled surface at once.
Pointer events come from the DOM Pointer Events API, so **mouse and touch are
already unified** — design every interaction for both (tap = click; don't rely
on hover). `scene.getPointer2DWorldPosition()` converts the current pointer to
2D world/design coordinates through the live 2D camera (Godot's
`get_global_mouse_position()`).

**Multi-touch is addressed, not shared.** Every finger that is down lives in a
map: `getActivePointers()` (press order, index 0 is the primary one),
`getPointer(id)`, `pointerDownCount`, `isPointerOverUI(id)`, and a `pointerId` on
every entry of `pointerEvents` (`'down' | 'move' | 'up' | 'cancel'` — a `'cancel'`
is a press *taken away*, e.g. a finger dragged off the screen edge, and must never
count as a completed tap). Anything that follows one contact — a stick, a drag, a
tap resolver — names its finger and reads only that one; UI controls do this for
you (each control owns at most one pointer). The shared values are summaries:
`isPointerDown` means "**any** finger is down", `pointerPosition` and
`activePointerId` (`@deprecated`) describe the **primary** finger only, and
`isHoveringUI` is the aggregate over all of them — gating a gesture on it is what
makes "hold a button with one thumb, drag the stick with the other" impossible, so
ask `isPointerOverUI(myPointerId)` instead. `Action_Primary` stays one shared
button raised on the first finger down and dropped by the last one up.
`scene.getPointer2DWorldPosition(pointerId)` is the addressed form of the world
conversion (null when that pointer is not down — a tap that went down and up in
one frame is already gone, so fall back to the no-argument call).

### Signals (node events)
`node.connect(name, target, method)` / `disconnect` / `emit(name, ...args)`. The
decoupled event bus between nodes, scripts, animation event tracks, and juice
`triggerEvent`s. Always `disconnect` in `onDetach` (the `Script` base auto-drops
connections where the script is the target).

### Game commands (`scene.commands`) — named intents
`register(name, handler, meta?)` / `dispatch(name, args?)` / `list()` / `log` /
`undo()`. The registry of a game's **discrete intents** — "start the game", "open
the settings", "make a move", "buy an item" — so tooling and tests can drive the
game without clicking, and every raised intent is journalled with the frame it
happened on. Names are `kebab-case`, optionally namespaced with dots
(`settings.toggle-music`); `args` must be JSON-serialisable (anything else is
refused with the offending path named); a handler that returns `{ undo() }` makes
the intent reversible through `commands.undo()`. A throwing handler is contained
the same way a script hook is (journalled, reported, loop unaffected), and
recursive dispatch is depth-capped.

**Wire a control's signal to `dispatch`, not to the method** —
`button.connect('pressed', this, () => this.scene?.commands.dispatch('start-game'))`.
That is what makes one real tap enough to prove the binding, after which every
scenario raises the intent directly. The registry **lives with the scene**: the
runner clears it on stop, so the next scene never inherits a dead intent. A
`GameDebugProvider` publishes it as `actions: () => scene.commands.list().map(c => c.name)`
rather than keeping a second, hand-maintained list.

**Boundary:** commands express intent, not continuous control. Movement, gestures
and aiming stay on input axes/controls — "drive left" as a command loses both the
analog magnitude and the per-frame cadence. Every project template registers its
flow intents this way (`start-game`, `open-settings`, `restart`, `cta-click`, …).

### Screen transitions
`scene.fadeToBlack(sec)` / `fadeFromBlack(sec)` / `switchCameraWithFade(id, out, in)`
/ `flash(opts)`. Real-time overlays (survive hitstop).

### Runtime spawning (`scene.instantiate`, `node.queueFree`)
Godot's `instantiate()` + `add_child()` / `queue_free()` pair for gameplay
spawning (enemies, projectile prefabs, VFX):
`const node = await scene.instantiate('res://…/prefab.pix3scene', { parent: 'enemies' })`
— the prefab (a `.pix3scene` with exactly one root node) is cloned with unique
runtime ids, adopted under `parent` (node or node-query; default = first scene
root), inherits `input`/`scene`, honors `initiallyVisible`, and its components
`onStart` on the next tick. In 2D the parent decides draw order. Despawn with
`node.queueFree()` — safe inside the node's own `onUpdate` (deferred to end of
frame, components get a proper `onDetach`); immediate `node.dispose()` is for
teardown outside the tick.

### Multiplayer replication (`scene.network`, `scene.netNodes`)
The session is `this.scene.network` — offline-safe, host-owned, and it survives
`changeScene` (it is installed at the three `SceneRunner` bootstraps, not by the
scene). `network.connect({url, token, roomId})` joins a pix3-rooms room; then
`isOnline`, `clientId`, `isHost`, `rtt`, `peers`, `vars`, `on/emit` (signals) and
`entities` are live.

**Everything networked is spawned** — an authored node has no network identity of
its own. Attach **`core:NetworkedNode`** to a *prefab* that is also listed in the
build's `netKindTable` (the exporter emits it from the project's prefabs, sorted;
`registerNetworkPrefab(path)` is the fallback for a session with no built
manifest). On start it sends a spawn request and binds the `netId` the fabric
mints; when a *peer's* entity arrives instead, `scene.netNodes`
(`NetworkNodeBinder`) instantiates that same prefab with instance id
`net:<netId>` — which is what makes every client derive identical child ids — and
the component adopts the binding rather than spawning a duplicate. `isMine`,
`ownerId` and `ownership` (`owned` / `shared` / `transferable`) come off the
replicated flags byte; `despawnOnDetach` (default on) means a `changeScene` or a
`queueFree` releases the entity.

Add **`core:ReplicatedTransform`** for movement. The owner publishes **quantized**
values and renders the node from the **dequantized** ones, so it sees exactly what
its peers do; remote copies render on a timed snapshot buffer at roughly two room
ticks of delay plus measured jitter, and the wire's `Teleport` bit snaps instead of
sliding. Two interactions worth knowing: it **turns anchored 2D layout off** on its
node (the per-frame anchor reflow and a replicated position cannot both own the
transform), and a camera following a *remote* node should use little or no
`followDamping` — the interpolation buffer is already the smoothing, and damping on
top of it is pure added latency.

Spawn/despawn from a script: `await network.spawn('res://prefabs/bomb.pix3scene',
{ position, ownership })` → the minted `netId`, or a typed `NetworkSpawnError`
whose `kind` separates `'quota'` (this owner's 64-entity budget),
`'entity-limit'` (the room's table) and `'kind-not-allowed'`;
`network.despawn(netId)`.

**Getting online in the editor: "Play Online"** (`game.start-online`, project menu
or the Game tab). It scans the project for spawnable prefabs, installs that
`netKindTable`, starts the preview relay, asks pix3-cloud for a room, joins it,
and only then enters play mode — so a script's `onStart` already sees
`net.isOnline` and nothing needs a "wait until connected" dance. A session card
floats over the running game with the QR/join link, the roster, ping and the
number of visible entities. The join link carries the **room id, never a token**:
the player page mints its own guest token, and the kind table reaches it through
the relay's session config, because every participant must resolve a wire `Kind`
through the same list. The membership survives a scene restart and a
tab⇄popout swap; it ends when play mode ends or you press Leave. Requires a
pix3-cloud with `ROOMS_ADMIN_URL` / `ROOMS_SERVICE_TOKEN` / `ROOMS_JWT_SECRET`
configured; without one the button reports `rooms_not_configured` and single-player
Play is unaffected.

`samples/MultiplayerArena` is the worked example of all of the above (8-player
tag arena, no binary assets, runs offline as a single-player sandbox).

### Scene transitions (change the running scene)
`await scene.changeScene('res://scenes/level2.pix3scene', { transition: 'fade', durationSec: 0.3 })`
— Godot's `change_scene_to_file`. Loads the *saved* target file, tears down the
current scene and starts the new one at full black, then fades in. Works
identically in play-mode and exports (all scenes ship in the build). The old
scene keeps running until the new one parses, so a missing/invalid target fades
back and rejects instead of stranding a black screen; overlapping calls are
ignored. Use it to wire menu → game → results flows across separate scene files
(each scene runs standalone in the editor). `transition: 'none'` swaps instantly.

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
from the Sprite Editor can be kept with its **Save to Library** action. Programmatic
scope (agent HTTP/preview commands) arrives in Phase 2 — see `.plans/asset-library.md`.

---

## 5. Scripts-facing runtime API (the surface a `Script` sees)

Inside any `Script` subclass:

- `this.node` — the owning `NodeBase` (transform, `visible`, `getComponent`, `addComponent`, `connect`/`emit`, `findById`/`findByName`/`findByPath`, `children`, `parentNode`). `getComponent<T>(type: new (...args) => T): T | null` takes the component **class**, not a string ID — `node.getComponent(CarController)`, importing the class by relative path (`./CarController`). There is no string-based lookup (`getComponent('user:CarController')` fails); `user:*` IDs are for `add_component`/scene YAML only. To fetch by hand: `node.components.find(c => c instanceof CarController)`.
- `this.scene` — the `SceneService` (all of §4's `scene.*` APIs, plus `getActiveCamera()`, `getActiveCamera2D()`, `findNode(query)`, `getRootNodes()`, `getViewportInfo()`/`onViewportChanged()`/`isPortrait()`, `raycastViewport(nx,ny)`, `getAudioService`/`getAssetLoader`/`getResourceManager`/`getECSService`, plus `network` and `netNodes` for multiplayer, and `commands` for named game intents). May be `undefined` in some editor previews — guard it.
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

**Editor preview (draw the node your way without play mode):** implement
`tickEditorPreview(dt, ctx)` — the editor calls it every non-play frame for each
enabled component. Use `ctx.setAppearanceOverride({ textureRegion?, tint?,
visible? })` to change how *this component's node* draws in the editor viewport;
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

---

## 6. Editor-side rules (when an agent edits scenes/state)

- **Mutation gateway:** every state change flows UI → `CommandDispatcher.execute(CommandClass, args)` → Command → Operation → history. **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `src/features/<area>/`. (See CLAUDE.md + AGENTS.md — binding.)
- **Property schema:** nodes and `Script`s expose `static getPropertySchema()` returning typed `PropertyDefinition`s (`getValue`/`setValue`); the Inspector renders editors from it and all edits go through `UpdateObjectPropertyOperation`. See [property-schema-reference.md](property-schema-reference.md).
- **A new node's constructor must end with `installReactiveSchemaProperties(this, TheNode.getPropertySchema)`.** Without it, a schema `setValue` that redraws (clamp, geometry rebuild, canvas repaint, material colour) runs for the Inspector but not for a script: `node.prop = x` changes the field, redraws nothing, and the getter still returns `x` — so even state-based verification reports a success that never reached the screen. `reactive-schema-coverage.spec.ts` fails if a `SceneLoader`-constructible node skips it.
- **Serialization:** scenes are `.pix3scene` YAML (`root:` tree of nodes with `properties`, `components`, `children`). Copy a known-good demo in `samples/HelloWorld/` as a template.
- **2D texture filtering (project setting):** Project Settings → *2D Texture Filtering* is `linear` (default, smoothed) or `nearest` (crisp pixel-art). It lives on the `ProjectManifest` and is pushed to the runtime global via `setProjectTextureFiltering`; `configure2DTexture` (runtime) and the editor's sprite-texture setup both read it, so 2D sprite/UI textures pick up the mode in edit mode, play mode, and export. 3D textures are unaffected (they keep mipmapped linear sampling).
- **2D draw-call optimization (play mode):** a pre-launch **texture atlas** + a paint-order **quad batcher** cut a 2D frame from ~one draw call per node to a handful. The editor packer (`TextureAtlasService`) packs eligible sprite textures (Sprite2D / Button2D / AnimatedSprite2D / Bar2D — plus dynamic paths reached via script `res://` directory prefixes) into a few sheets, cached in IndexedDB, and installs a resolver on the play-mode `AssetLoader` so every texture load returns a lightweight **view** onto a shared sheet (`configure2DTexture` keeps sheets mipmap-free). The runtime `Batch2DSystem` then merges maximal contiguous same-source runs (in stamped `renderOrder`) into single draws, preserving paint order by construction (per-node opacity/tint ride vertex colors). Editor viewport rendering is unaffected (it draws its own proxy meshes). Toggles (`'auto'` default; `'off'` = byte-identical): project manifest `rendering2D.textureAtlas` / `.batching`, or `?pix3Atlas2D=off` / `?pix3Batch2D=off`, or `window.__PIX3_RENDER2D__`. `Label2D`/canvas text and `TiledSprite2D` are intentionally not atlased/batched. Exported games consume a shipped `assets/.atlas/atlas-manifest.json` via `installAtlasFromManifest` (emission from `ProjectBuildService` is a pending follow-up).
- **Debug bridge (dev):** `window.__PIX3_DEBUG__` exposes scene/liveScene/play/setProperty/errors for driving the running editor (see the `debug-running-game` skill). Consumer games can register `registerGameDebug({name, snapshot, inspect, action})` from `@pix3/runtime` for a game-specific surface.

---

## 7. Correct-usage checklist for a new user script

0. **The script gate (do this first).** Name the node / `core:*` behavior / system above that covers the ask. If one exists, wire it — don't write a script. If none does, put the reason as the first doc-comment line: `/** engine-check: no built-in covers <X> because <reason> */`. A script duplicating a catalog capability without that line is a defect. Smells that mean "stop, a built-in exists": `setTexture()` on a timer → `AnimatedSprite2D` + `.pix3anim`; hand-lerped opacity/scale/position → `core:Fade`/`core:PopIn`/`core:PunchScale`/`core:AnimationPlayer`; a timer that only ends in `queueFree()` → `core:FreeOnSignal`; manual camera chase / `new Audio()` → `core:CameraBrain` / `scene.audio`.
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
- Asset Library: services `src/services/library/AssetLibraryService.ts`, `LibraryInsertService.ts`, `PublishToLibraryService.ts`, providers + model in `src/services/library/`; panel `src/ui/asset-library/`; builtin pack `public/library/`.
- Model Lab (3D generation): orchestrator + pipeline in `src/services/model-gen/` (`Model3DGenService`, `SculptSpec`, `ModelPreviewRenderer`, `ComparisonSheet`, `Model3DGenHistoryService`, `prompts/`); scene lane in `src/services/model-gen/scene/` (`Scene3DGenService`, `LevelSpec`, `scene-validate`, `SceneInventoryService`, `ScenePreviewRenderer`, `scene-scatter`, `prompts`); panel `src/ui/model-lab/`; agent tools `generate_model_3d` / `generate_scene_3d` (`src/services/agent/AgentToolRegistry.ts`); debug lanes `__PIX3_DEBUG__.model3d` / `.scene3d` (`src/core/debug-bridge.ts`).
- Demo scenes + example scripts: `samples/HelloWorld/`; `docs/example-scripts/`.
- Deeper docs: [node-types-reference.md](node-types-reference.md), [pix3-specification.md](pix3-specification.md), [architecture.md](architecture.md), [property-schema-reference.md](property-schema-reference.md).
