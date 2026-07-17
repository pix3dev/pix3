# Pix3 Node Types Reference

This document provides a comprehensive reference for all node types available in the Pix3 editor. Each node type is designed for specific use cases in 2D and 3D scene composition.

---

## Base Classes

### NodeBase

The foundation class for all nodes in Pix3. Every node inherits from `NodeBase`, which provides core functionality:

- **Unique ID**: Each node has a system-generated unique identifier
- **Name**: User-editable name for identification
- **Type**: The node type string (e.g., "Sprite2D", "Camera3D")
- **Properties**: Custom key-value data storage
- **Metadata**: Additional user-defined data
- **Components**: Script components attached to the node

**Common Properties (all nodes):**

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Display name |
| `type` | string | Node type |
| `visible` | boolean | Visibility toggle |
| `locked` | boolean | Lock for editing |
| `instancePath` | string | Path to source file |

---

## 2D Nodes

All 2D nodes operate in screen space and are rendered using an orthographic camera. They use a left-handed coordinate system where X increases to the right and Y increases upward.

### Node2D

The base class for all 2D scene nodes. Use this for simple grouping or as a container for other 2D elements.

**Type String:** `Node2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `position` | Vector2 | (0, 0) | X and Y coordinates |
| `rotation` | number | 0 | Rotation in degrees |
| `scale` | Vector2 | (1, 1) | X and Y scale factors |

**Usage Notes:**
- Cannot have children by default (set `isContainer = true` to enable)
- Transforms affect all children in local space
- Rotation is clockwise, in degrees

---

### Layout2D

The root container for 2D scenes. This is the top-level node that defines the canvas area for all 2D content. All other 2D nodes should be children of a Layout2D.

**Type String:** `Layout2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 1920 | Canvas width in pixels |
| `height` | number | 1080 | Canvas height in pixels |
| `resolutionPreset` | enum | FullHD | Resolution preset |
| `showViewportOutline` | boolean | true | Show viewport border |

**Resolution Presets:**

| Preset | Dimensions | Description |
|--------|------------|-------------|
| `FullHD` | 1920×1080 | Full HD (default) |
| `HD` | 1280×720 | HD Ready |
| `Tablet` | 1024×768 | Standard tablet |
| `MobilePortrait` | 1080×1920 | Mobile portrait |
| `Custom` | user-defined | Manual dimensions |

**Usage Notes:**
- Only one Layout2D should exist per scene
- All 2D content renders within these bounds
- Changing resolution automatically recalculates child layouts

---

### Sprite2D

A 2D image display node. Renders a textured quad that always faces the camera.

**Type String:** `Sprite2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `texturePath` | string | null | Path to texture (res://) |
| `width` | number | 64 | Display width in pixels |
| `height` | number | 64 | Display height in pixels |
| `color` | color | #ffffff | Tint color |

**Usage Notes:**
- Supports PNG, JPG, WebP textures
- Aspect ratio is controlled by width/height properties
- Use white color to display texture without tint
- Texture is scaled to fit the specified dimensions

---

### Button2D

An interactive button control for 2D user interfaces. Responds to pointer clicks and provides visual feedback.

**Type String:** `Button2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 100 | Button width in pixels |
| `height` | number | 40 | Button height in pixels |
| `backgroundColor` | color | #4a4a4a | Default background |
| `hoverColor` | color | #5a5a5a | Background on hover |
| `pressedColor` | color | #3a3a3a | Background when pressed |
| `buttonAction` | string | "Submit" | Action identifier |

**Usage Notes:**
- Emits button press events when clicked
- Visual states: default, hover, pressed
- Use `buttonAction` to identify button function in scripts

---

### Label2D

A multiline text label for 2D UI. Wraps text to a fixed box, aligns it in both axes, and can reveal it with a typewriter effect.

**Type String:** `Label2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `label` | string | "" | Text to display; `\n` breaks lines |
| `labelFontFamily` | string | Arial | Font family |
| `labelFontSize` | number | 16 | Font size in pixels |
| `labelColor` | color | #ffffff | Text color |
| `labelAlign` | enum | center | Horizontal alignment: `left`, `center`, `right` |
| `labelVAlign` | enum | middle | Vertical alignment: `top`, `middle`, `bottom` |
| `width` | number | 0 | Fixed box width; text word-wraps to it. 0 = auto-size (no wrap) |
| `height` | number | 0 | Fixed box height for vertical alignment. 0 = auto-size to the lines |
| `typewriterSpeed` | number | 0 | Characters per second for the typewriter reveal; 0 = off |

**Usage Notes:**
- The box is centered on the node position (like other UI controls); alignment places the text inside that box.
- Set `width` manually to get word wrap — there is no auto-grow layout yet.
- Scripts: `setText(text)` replaces the text and restarts the typewriter; `skipTypewriter()` completes it instantly; `restartTypewriter()` replays it; `isTyping` reports progress; the node emits `'typewriter-complete'` when the reveal finishes.
- The typewriter runs in play mode only (it advances in `tick`); the editor viewport always shows the full text.

---

### Slider2D

A horizontal slider control for selecting numeric values. Useful for volume controls, brightness settings, or any continuous value input.

**Type String:** `Slider2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 200 | Slider width in pixels |
| `height` | number | 20 | Slider height in pixels |
| `handleSize` | number | 20 | Handle knob size |
| `trackBackgroundColor` | color | #333333 | Empty track color |
| `trackFilledColor` | color | #4a9eff | Filled track color |
| `handleColor` | color | #ffffff | Handle color |
| `minValue` | number | 0 | Minimum value |
| `maxValue` | number | 100 | Maximum value |
| `value` | number | 50 | Current value |
| `axisName` | string | "Slider" | Identifier for axis |

**Usage Notes:**
- Drag the handle to change values
- Value is clamped between min and max
- Emits value change events during interaction

---

### Joystick2D

A virtual analog stick control for touch or mouse input. Commonly used for character movement or camera control in games.

**Type String:** `Joystick2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 120 | Base diameter in pixels |
| `height` | number | 120 | Base diameter in pixels |
| `knobSize` | number | 50 | Knob diameter in pixels |
| `baseColor` | color | #333333 | Base circle color |
| `knobColor` | color | #666666 | Knob color |
| `maxDistance` | number | 40 | Maximum knob travel |

**Usage Notes:**
- Returns normalized X/Y values (-1 to 1)
- Center position returns (0, 0)
- Ideal for mobile/touch interfaces

---

### Checkbox2D

A toggle checkbox control for boolean settings.

**Type String:** `Checkbox2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 24 | Checkbox size |
| `height` | number | 24 | Checkbox size |
| `checked` | boolean | false | Checked state |
| `uncheckedColor` | color | #333333 | Unchecked border |
| `checkedColor` | color | #4a9eff | Checked fill color |

**Usage Notes:**
- Toggle between checked/unchecked states
- Emits state change events

---

### Bar2D

A progress bar or health bar display.

**Type String:** `Bar2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 200 | Bar width in pixels |
| `height` | number | 20 | Bar height in pixels |
| `value` | number | 50 | Current fill value |
| `maxValue` | number | 100 | Maximum fill value |
| `backgroundColor` | color | #333333 | Background color |
| `fillColor` | color | #4a9eff | Fill bar color |

**Usage Notes:**
- Fill percentage = value / maxValue
- Useful for health bars, mana bars, loading progress
- Can be oriented horizontally

---

### InventorySlot2D

A specialized slot control for inventory systems. Supports drag-and-drop for item management.

**Type String:** `InventorySlot2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | number | 64 | Slot size |
| `height` | number | 64 | Slot size |
| `backgroundColor` | color | #2a2a2a | Empty slot color |
| `borderColor` | color | #444444 | Border color |
| `highlightColor` | color | #4a9eff | Selection highlight |
| `itemCount` | number | 0 | Number of items in slot |

**Usage Notes:**
- Can hold one item at a time
- Visual indicator for item count
- Supports drag operations

---

### Camera2D

A 2D game camera (Godot-style). Like `VirtualCamera3D` it does **not** render — it *describes* how the shared 2D orthographic pass is framed. Each frame the runtime picks the highest-priority visible `Camera2D` and applies its pan (`position` + `offset`), `zoom`, clamped `limits`, and shake to the 2D camera. With no `Camera2D` in the scene the 2D pass keeps its default identity framing, so existing 2D scenes / playable ads are unaffected. Every knob is a flat schema property, so the keyframe timeline animates `position`, `offset`, `zoom`, `priority`, etc. with no animation code.

**Type String:** `Camera2D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `priority` | number | 10 | Highest-priority visible Camera2D drives the 2D view (animatable) |
| `zoom` | number | 1 | >1 magnifies (zooms in), <1 zooms out |
| `offset` | vector2 | 0,0 | Framing offset added to position (never written by follow / shake) |
| `followTargetId` | node | — | Node whose position this camera follows (empty = authored position) |
| `followOffset` | vector2 | 0,0 | Offset from the follow target |
| `followDamping` | number | 8 | Higher = snappier follow (0 = instant) |
| `deadzone` | vector2 | 0,0 | World half-extents the target may move within before the camera follows |
| `limitsEnabled` | boolean | false | Clamp the visible view inside an axis-aligned world box |
| `limitsCenter` | vector2 | 0,0 | Limits box center |
| `limitsSize` | vector2 | 1000,1000 | Limits box size |
| `shakeAmplitude` | number | 8 | Peak shake displacement in world units |
| `shakeFrequency` | number | 24 | Shake oscillation speed |
| `shakeDuration` | number | 0.35 | Shake duration in seconds |
| `shakeDecay` | number | 1.5 | Falloff power (0 = steady, 1 = linear, >1 = punchy tail) |

**Usage Notes:**
- `position` is the camera center (follow damps it toward the target); `offset` is a separate framing bias that follow and shake never touch.
- Limits clamp the view **center** zoom-aware, so the view edge never crosses the box; a box smaller than the view pins the center to `limitsCenter`.
- Shake is additive at apply time (never mutates `position`) and, being tick-driven, respects `Time.scale` — a hitstop freezes it, slow-mo stretches it. Trigger it from a script with `scene.juice.shake('camera2d')` (or `scene.juice.shake('camera')` in a pure-2D scene).
- v1: screen-anchored HUD shares this camera and pans / zooms with the world. Use a `CanvasLayer2D` to pin a HUD.

---

### CanvasLayer2D

A Godot-style `CanvasLayer` — a clean UI overlay band. Its subtree renders on a separate layer through an always-identity camera **after** the post-processing composer, so it is (a) a **fixed HUD** that ignores any `Camera2D` pan/zoom, and (b) **never post-processed** — bloom/vignette/chromatic-aberration leave it crisp (e.g. a restart dialog over a blurred game-over scene). Extends `Group2D` (width/height container); no extra authored properties in v1.

**Type String:** `CanvasLayer2D`

**Properties:** inherits `Group2D` (`width`, `height`) + `Node2D` transform/anchor/opacity.

**Usage Notes:**
- Content under a CanvasLayer2D is pinned in design-space coordinates regardless of the active Camera2D, and its pointer hit-tests stay correct while the world camera pans.
- Multiple CanvasLayer2D nodes stack by scene-tree order (like ordinary 2D draw order).
- Unlike Godot, inheritance is **not** broken: an ancestor's transform, opacity, and visibility still flow into the overlay subtree — only the render camera differs. Author at the scene root for a fully independent layer.
- Runtime overlay behavior is play-mode only; in the editor it renders as a normal Group2D container.

---

## 3D Nodes

All 3D nodes operate in world space using a perspective camera by default. They use a right-handed coordinate system where X is right, Y is up, and Z is toward the viewer.

### Node3D

The base class for all 3D scene nodes. Use this for simple grouping or as a container for other 3D elements.

**Type String:** `Node3D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `position` | Vector3 | (0, 0, 0) | X, Y, Z coordinates |
| `rotation` | Euler | (0, 0, 0) | Pitch, Yaw, Roll in degrees |
| `scale` | Vector3 | (1, 1, 1) | X, Y, Z scale factors |

**Rotation Order:** XYZ (Pitch → Yaw → Roll)

**Usage Notes:**
- Rotation values are in degrees, stored as radians internally
- Default scale (1, 1, 1) means no scaling
- Children inherit all transforms

---

### Camera3D

A camera node that defines the viewpoint for rendering. The scene can have multiple cameras, but only one is active at a time.

**Type String:** `Camera3D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `projection` | enum | perspective | Projection type |
| `fov` | number | 60 | Field of view (degrees) |
| `near` | number | 0.1 | Near clipping plane |
| `far` | number | 1000 | Far clipping plane |

**Projection Types:**

| Type | Description |
|------|-------------|
| `perspective` | Perspective projection (default) |
| `orthographic` | Orthographic projection |

**Usage Notes:**
- Perspective: Objects get smaller with distance
- Orthographic: No perspective distortion
- Default looks down the negative Z axis
- Use `setTargetPosition()` to point camera at a target

---

### VirtualCamera3D

A lightweight "virtual camera" (Cinemachine-lite). It does **not** render — it only describes a desired framing. Attach a **Camera Brain** (`core:CameraBrain`) component to a real `Camera3D`; each frame the brain picks the highest-priority visible virtual camera and blends the render camera toward it. Because every knob is a schema property, the keyframe timeline can animate `priority`, `fov`, `position`, etc. — switching cameras is "raise this one's priority above that one" — with no animation code.

**Type String:** `VirtualCamera3D`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `priority` | number | 10 | Highest-priority live virtual camera wins (animatable) |
| `fov` | number | 60 | Field of view applied to a perspective render camera |
| `orthographicSize` | number | 5 | Size applied to an orthographic render camera |
| `followTargetId` | node | — | Node whose position this camera follows (empty = authored position) |
| `followOffset` | vector3 | 0,0,0 | World-space offset from the follow target |
| `followDamping` | number | 8 | Higher = snappier follow (0 = instant) |
| `deadzone` | vector3 | 0,0,0 | World half-extents the target may move within before the camera follows |
| `lookAtTargetId` | node | — | Node this camera orients toward (empty = authored rotation) |
| `lookAtWeight` | number | 1 | 0 = keep authored rotation, 1 = fully track the target |
| `rotationDamping` | number | 8 | Higher = snappier aim (0 = instant) |
| `confinerEnabled` | boolean | false | Clamp the camera position inside an axis-aligned box |
| `confinerCenter` | vector3 | 0,0,0 | Confiner box center |
| `confinerSize` | vector3 | 10,10,10 | Confiner box size |
| `blendDuration` | number | 1 | Seconds to blend the render camera toward this one when it becomes active |
| `blendEasing` | enum | cubicInOut | Easing curve used for the blend |

**Usage Notes:**
- Requires a `Camera3D` carrying the `core:CameraBrain` component — that camera is the only one that renders.
- Standby cameras are still solved every frame, so a camera is already framed when it is cut to.
- With no follow target, position is left to authored / keyframed values (dolly by keyframes). Same for rotation with no look-at target.
- Setting a Camera Brain's **Blend On Switch** off makes cuts instantaneous.
- Scripts can force the *next* activation blend with `CameraBrainBehavior.overrideNextBlend(durationSec, easing?)` — a one-shot override that wins even when Blend On Switch is off. The Cutscene Director (`scene.cutscene.playCinematic`) uses it to smooth the cut into and out of a cinematic virtual camera. See the runtime spec §6.13.

---

### GeometryMesh

A 3D mesh node with a built-in primitive geometry and a PBR material. The shape
is inspector-switchable and animatable via the `geometry`/`size` schema
properties.

**Type String:** `GeometryMesh`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `geometry` | enum | "box" | Primitive shape (see below) |
| `size` | Vector3 | (1, 1, 1) | Interpreted per shape (see below) |
| `material.color` | color | #4e8df5 | Surface color |
| `material.roughness` | number | 0.35 | Surface roughness (0-1) |
| `material.metalness` | number | 0.25 | Metallic appearance (0-1) |
| `material.map` | texture | — | Albedo (diffuse) texture (res://); required for UV Scroll to be visible |
| `material.aoMap` | texture | — | Baked ambient-occlusion map (set by the AO baker) |
| `material.aoMapIntensity` | number | 1 | Strength of the baked AO map (0 = off) |

**Shader Effects (attached list):**

Shader effects are **added from a picker** (Inspector → **Effects** → **Add**),
Unity/Godot-style — not fixed checkboxes. Each attached effect shows an **enable
toggle**, its params, and a **Remove** control; the built-in effects come from a
registry (`core:*`) and can be extended with `user:*` effects later. One instance
of each type per mesh (v1). Effects are injected into the standard PBR material
via `onBeforeCompile` and `#ifdef`-gated on `material.defines`, so a disabled
effect costs zero GPU and lighting/shadows/albedo/AO maps still apply.

Attached effects contribute their params to the node's schema **per instance**
(as `fx.<effect>.<param>`), so each param — and each effect's `enabled` flag — is
individually **keyframe-animatable** from the timeline. Animate the numeric
params rather than the enable toggles (a toggle flip recompiles the shader; cheap
after the first compile, which three caches per variant).

| Effect (`type`) | Params | What it does |
|--------|--------|--------------|
| Dissolve (`core:dissolve`) | `amount` (0-1), `scale`, `edgeWidth`, `edgeColor` | Noise-thresholded `discard` with an emissive glowing edge; drive `amount` 0→1 to dissolve away |
| Rim Light (`core:rim`) | `color`, `intensity` (0-5), `power` | Fresnel-based emissive rim, brightest at grazing angles |
| UV Scroll (`core:uv-scroll`) | `speed` (uv/s) | Scrolls the albedo map. **Play-mode only** (accumulated per tick); static in the edit viewport. Needs `material.map` |
| Flash Tint (`core:flash`) | `color`, `amount` (0-1) | Blends the final lit color toward a flat color; a hit/damage flash |

Serialized under `material.effects` as an ordered array of `{ type, enabled,
params }` (only non-default params are written).

**Geometry Types & `size` semantics:**

`size` is a single `[x, y, z]` vector reinterpreted per shape, so one editable
field works for every primitive:

| Type | `size` meaning |
|------|----------------|
| `box` | Full extents: width `x`, height `y`, depth `z` |
| `sphere` | Diameter `x` (y, z ignored) |
| `plane` | A horizontal floor `x` by `z` (lies in the XZ plane) |
| `cylinder` | Diameter `x`, height `y` |
| `cone` | Base diameter `x`, height `y` |
| `torus` | Outer diameter `x`; tube thickness scales with `y` |

**Usage Notes:**
- Changing `geometry` or `size` in the inspector rebuilds the mesh live.
- Material uses PBR (Physically Based Rendering).
- Roughness: 0 = glossy, 1 = matte. Metalness: 0 = non-metal, 1 = metal.
- Material color/roughness/metalness edits persist through save and play mode
  (the live material is serialized, not a stale authored snapshot).
- Node opacity does **not** currently fade a GeometryMesh (its material isn't
  registered for opacity blending).
- Effects are attached from a registry-backed picker (see above), not fixed
  checkboxes; their params surface per-instance as `fx.<effect>.<param>` schema
  props so they remain keyframe-animatable.
- A dissolving mesh still casts an intact shadow (the depth/shadow pass has no
  `discard`); accepted for now.

---

### MeshInstance

A node that loads and displays external 3D models in GLB or GLTF format.

**Type String:** `MeshInstance`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `src` | string | null | Path to model file (res://) |

**Usage Notes:**
- Supports GLB (binary) and GLTF formats
- Path uses `res://` protocol for project resources
- Can contain multiple meshes, materials, and animations
- Animations can be played via script components

---

### DirectionalLightNode

A light source that emits parallel rays in a single direction, like the sun. Illuminates all objects from the same angle.

**Type String:** `DirectionalLight`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `color` | color | #ffffff | Light color |
| `intensity` | number | 1.0 | Light brightness |
| `castShadow` | boolean | true | Enable shadow casting |

**Usage Notes:**
- Light direction is determined by node rotation
- Good for outdoor lighting and sun simulation
- Constant illumination regardless of distance
- Shadow map size is auto-calculated

---

### PointLightNode

A light source that emits rays in all directions from a single point. Like a light bulb.

**Type String:** `PointLight`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `color` | color | #ffffff | Light color |
| `intensity` | number | 1.0 | Light brightness |
| `distance` | number | 0 | Maximum range (0 = infinite) |
| `decay` | number | 2 | Falloff rate |
| `castShadow` | boolean | true | Enable shadow casting |

**Usage Notes:**
- Intensity decreases with distance (inverse square law)
- Use `distance` to limit effective range
- Decay of 2 is physically accurate
- Good for lamps, candles, torches

---

### SpotLightNode

A light source that emits a cone of light in a specific direction. Like a flashlight or spotlight.

**Type String:** `SpotLight`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `color` | color | #ffffff | Light color |
| `intensity` | number | 1.0 | Light brightness |
| `distance` | number | 0 | Maximum range (0 = infinite) |
| `angle` | number | 60 | Cone angle (degrees) |
| `penumbra` | number | 0 | Edge softness (0-1) |
| `decay` | number | 2 | Falloff rate |
| `castShadow` | boolean | true | Enable shadow casting |

**Usage Notes:**
- Penumbra creates soft edge transitions
- Angle controls the cone width
- Good for stage lights, flashlights, focused lighting
- Target direction is determined by node rotation

---

### Particles3D

A CPU-simulated particle emitter rendered as a single `InstancedMesh`. Supports
billboarded planes, spheres or cubes, per-particle color/alpha/size ramps, an
emitter shape (point/sphere/box), optional ribbon **trails**, and **sub-emitters**
that burst a second emitter on particle death.

**Type String:** `Particles3D`

**Key Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `emissionRate` | number | 24 | Particles spawned per second |
| `maxParticles` | number | 512 | Simulation pool size (also the instance cap) |
| `lifetime` | number | 2 | Base particle lifetime (s), jittered ±15% |
| `speed` / `speedSpread` | number | 2 / 0.5 | Initial speed and its random spread |
| `gravity` | vector3 | (0,0,0) | Constant acceleration (sim-space vector) |
| `startColor`/`endColor` | color | white/amber | Color ramp over life |
| `startAlpha`/`endAlpha` | number | 1 / 0 | Alpha ramp over life |
| `simulationSpace` | enum | `local` | `local` = particles follow the emitter; `world` = particles are emitted into world space and stay put |
| `trailEnabled` | boolean | false | Draw a camera-facing ribbon behind each particle |
| `trailLifetime` | number | 0.3 | How long (s) a trail sample survives |
| `trailWidth` | number | 0.05 | Ribbon width at the head |
| `trailSegments` | number | 16 | Ribbon resolution (clamped 2–64) |
| `trailFade` | number | 1 | Alpha falloff along the ribbon (0 = solid, 1 = fade to transparent) |
| `subEmitterId` | node | — | Another `Particles3D` fired as a burst at each particle death |
| `subEmitterBurstCount` | number | 8 | Particles spawned per death (0–128) |
| `subEmitterInheritVelocity` | number | 0 | Fraction of the dead particle's velocity passed to the burst (0–1) |

**Simulation space (behavior change):** `simulationSpace` was persisted since it
shipped but was previously **ignored** — every emitter simulated in `local` space
regardless of the value. It now works: in `world` mode already-spawned particles
keep their world position when the emitter moves (trails, exhaust, muzzle smoke),
implemented by neutralizing the emitter's ancestor transform each frame
(`renderRoot.matrix = matrixWorld⁻¹`). Any externally-authored scene that set
`simulationSpace: world` will change from the old (buggy) local-follow to true
world-space; there is no migration — the field finally does what its label says.

**Usage Notes:**
- Trails are best with `simulationSpace: world`; in `local` mode on a moving
  emitter the whole ribbon rides with the node.
- Trails allocate `maxParticles × trailSegments` samples — keep `maxParticles`
  moderate when trails are enabled (buffers exist only while `trailEnabled`).
- The sub-emitter target is a normal `Particles3D`, typically authored with
  `emissionRate: 0` so it only fires from bursts. Bursts are deferred to after the
  simulation loop, so self-reference and any tick order are safe (≤1 frame latency).
- Trail material is additive and untextured in v1.
- All new fields are flat scalars, so they are keyframe-animatable from the timeline.

---

## Audio

### AudioPlayer

A node that plays an audio clip through the runtime mixer. Attach it anywhere in
the scene; drive it via `autoplay`, from a script (`node.play()`), or from an
`AnimationPlayer` audio track.

**Type String:** `AudioPlayer`

**Key Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `audioTrack` | string | — | Asset URL (`res://…`, `data:audio/…`, or absolute URL) |
| `autoplay` | boolean | false | Play automatically on the first tick |
| `loop` | boolean | false | Loop the clip |
| `volume` | number | 1 | Per-clip volume (0–1), before the bus gain |
| `bus` | enum | `sfx` | Mixer bus: `master`, `music`, or `sfx` |
| `pitchVariation` | number | 0 | Random ± playback-rate spread per play (0–1) |
| `volumeVariation` | number | 0 | Random ± volume spread per play (0–1) |

`bus`, `pitchVariation` and `volumeVariation` are also available on the
`core:PlaySound` behavior (`PlaySoundBehavior`), with identical semantics.

### Buses, snapshots & `scene.audio`

The runtime mixer routes every playback through three fixed buses:

```
sound → sfx  ┐
       music ┼→ master → output
```

Each bus has a volume and a permanently-wired (transparent) lowpass filter, so
mixing and snapshot transitions are click-free `AudioParam` ramps. Scripts reach
the mixer through `this.scene.audio`:

```ts
// One-shot playback (loads + caches via the AssetLoader)
this.scene.audio.play('res://sfx/hit.ogg', { bus: 'sfx', pitchVariation: 0.1 });

// Mixer volume (e.g. from a settings menu)
this.scene.audio.setBusVolume('music', 0.5);

// Snapshots — named per-bus lowpass + volume-scale states
this.scene.audio.registerSnapshot({ name: 'underwater', lowpassHz: { master: 500 } });
this.scene.audio.applySnapshot('underwater');
this.scene.audio.resetSnapshot();               // back to 'default'
```

**Built-in snapshots:** `'default'` (fully open) and `'muffled'`
(`master` lowpass 700 Hz, volume ×0.85). A snapshot's volume scale composes *on
top of* the user's bus volume, so entering/leaving a snapshot never forgets the
authored mix.

**Slow-motion auto-muffle:** while `scene.time` is in slow motion the mixer
automatically blends to `'muffled'` and back on return to normal speed. This is
driven by the slow-mo base scale, **not** the frozen scale — a `hitstop(…)`
freeze does **not** muffle audio (otherwise every micro-freeze would pump the
filter).

---

## Choosing the Right Node

### For 2D Projects:

1. **Start with Layout2D** as your scene root
2. Add **Sprite2D** for images and graphics
3. Use **Button2D**, **Slider2D**, **Joystick2D** for UI controls
4. Use **Node2D** as containers to group related elements

### For 3D Projects:

1. Add a **Camera3D** to define your viewpoint
2. Use **GeometryMesh** for simple shapes
3. Use **MeshInstance** for imported 3D models
4. Add **DirectionalLightNode** for overall lighting
5. Add **PointLightNode** or **SpotLightNode** for localized lighting
6. For cinematics / dynamic framing, add **VirtualCamera3D** nodes and a **Camera Brain** (`core:CameraBrain`) on the Camera3D to blend between them by priority

---

## Node Properties Quick Reference

| Node Type | Key Properties |
|-----------|----------------|
| NodeBase | id, name, type, visible, locked |
| Node2D | position (Vector2), rotation, scale (Vector2) |
| Node3D | position (Vector3), rotation (Euler), scale (Vector3) |
| Layout2D | width, height, resolutionPreset |
| Sprite2D | texturePath, width, height, color |
| Camera2D | priority, zoom, offset, followTargetId, limitsEnabled, shakeAmplitude |
| CanvasLayer2D | width, height (fixed HUD overlay; renders after post) |
| Camera3D | projection, fov, near, far |
| VirtualCamera3D | priority, followTargetId, lookAtTargetId, blendDuration, fov |
| GeometryMesh | geometry, size, material |
| MeshInstance | src |
| DirectionalLightNode | color, intensity, castShadow |
| PointLightNode | color, intensity, distance, decay |
| SpotLightNode | color, intensity, distance, angle, penumbra |
| Button2D | width, height, backgroundColor, buttonAction |
| Slider2D | width, minValue, maxValue, value |
| Joystick2D | width, height, maxDistance |
| Checkbox2D | width, checked |
| Bar2D | width, value, maxValue |
| InventorySlot2D | width, itemCount |
| AudioPlayer | audioTrack, autoplay, loop, volume, bus, pitchVariation, volumeVariation |
