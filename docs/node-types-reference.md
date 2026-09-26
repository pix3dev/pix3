# Pix3 Node Types Reference

Per-node property tables for every node type. **Reading economically:** grep the
`### <NodeName>` heading for one node instead of loading the file; the
one-line-per-node summary is at "Node Properties Quick Reference" (bottom). For
_what a node is for_ / engine-vs-game, use [nodes-and-systems.md](nodes-and-systems.md);
for schema authoring, [property-schema-reference.md](property-schema-reference.md).

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

| Property       | Type    | Description         |
| -------------- | ------- | ------------------- |
| `id`           | string  | Unique identifier   |
| `name`         | string  | Display name        |
| `type`         | string  | Node type           |
| `visible`      | boolean | Visibility toggle   |
| `locked`       | boolean | Lock for editing    |
| `instancePath` | string  | Path to source file |

**`visible` is an accessor, and it has a second input.** Reading it answers "would this draw right
now" — `authoredVisible && !hiddenByEditor`, where `hiddenByEditor` is the editor's per-user Peek
view mask (never serialized, never exported; see
[pix3-specification.md](pix3-specification.md) → "Editor Peek (View Mask)"). Writing it sets the
authored flag and mirrors `properties.visible`, so a script's `node.visible = false` persists exactly
as it always has.

| Member                 | Meaning                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `node.visible`         | Effective: authored AND not Peek-masked. What the renderer, picking and `isVisibleInTree()` use.                    |
| `node.authoredVisible` | The author's own flag — the value that belongs in a scene file, a state snapshot, or a report of what was authored. |
| `node.hiddenByEditor`  | The Peek mask. Editor-owned; a play clone is told it via `SceneRunner.setEditorPeekMask(ids)`.                      |

Reach for `authoredVisible` wherever the AUTHORED value is meant; `Object3D.clone()`/`copy()` copy
the effective value, so a clone of a masked node needs `hiddenByEditor` cleared.

---

## Containers

### Group

A plain container with no transform semantics of its own — a `NodeBase` whose `type` is `Group`.
Use it to fold a branch of the tree into something foldable and nameable when neither 2D nor 3D
placement is wanted.

**Type String:** `Group`

**Properties:** the common `NodeBase` set only (`id`, `name`, `type`, `visible`, `locked`, …).

**Usage Notes:**

- For a 2D container that children can lay out against, use [Group2D](#group2d); for a 3D pivot you
  can move and rotate, use [Node3D](#node3d). `Group` is neither — it is organisational.
- Hiding it hides the branch, so it doubles as a cheap on/off switch for a set of nodes.

### Layout2D

**Removed.** The loader rejects it: a scene still carrying `type: Layout2D` fails to load with
"Layout2D nodes are no longer supported." It is listed here, and still known to the type registry,
so that an old scene produces that message instead of a silent inert node.

**Migration:** replace it with a root [Group2D](#group2d) plus anchor layout (`layoutEnabled`,
`horizontalAlign`, `verticalAlign`) on the children, and set the design resolution in project
viewport settings rather than on a node.

---

## 2D Nodes

All 2D nodes operate in screen space and are rendered using an orthographic camera. They use a left-handed coordinate system where X increases to the right and Y increases upward.

### Node2D

The base class for all 2D scene nodes. Use this for simple grouping or as a container for other 2D elements.

**Type String:** `Node2D`

**Properties:**

| Property                          | Type    | Default  | Description                                                                                                                   |
| --------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `position`                        | Vector2 | (0, 0)   | X and Y coordinates                                                                                                           |
| `rotation`                        | number  | 0        | Rotation in degrees                                                                                                           |
| `scale`                           | Vector2 | (1, 1)   | X and Y scale factors                                                                                                         |
| `opacity`                         | number  | 1        | Local opacity multiplier, inherited by child 2D nodes                                                                         |
| `blendMode`                       | enum    | normal   | How the node's own visuals combine with the backdrop: `normal`, `additive`, `multiply`, `subtract`. NOT inherited by children |
| `zIndex`                          | number  | 0        | Draw-order override, `-4096..4096` (integer). Higher draws on top                                                             |
| `zAsRelative`                     | boolean | true     | Add `zIndex` to the parent's effective z instead of treating it as absolute                                                   |
| `flow.enabled`                    | boolean | false    | Stack this container's children in tree order instead of leaving them where they were authored                                |
| `flow.direction`                  | enum    | vertical | `vertical` (a column) or `horizontal` (a row)                                                                                 |
| `flow.gap`                        | number  | 0        | Space between two children, px                                                                                                |
| `flow.paddingX` / `flow.paddingY` | number  | 0        | Inset from the container's edges                                                                                              |
| `flow.align`                      | enum    | start    | Cross-axis placement of each child: `start`, `center`, `end`. Inspector label: **Cross Axis**                                  |
| `flow.autoSize`                   | boolean | false    | Grow the container along the flow axis so the last child fits                                                                 |

**Usage Notes:**

- **Flow vs. anchors.** An anchor (`layout`) pins ONE node to its parent's edges; a
  flow is the container deciding where each child begins. With `flow.enabled` the
  container owns the main axis and each child's own anchor still owns the cross
  one — a settings row can pin its toggle to the right edge while the column
  decides how far down the row sits. This is why no `Layout2D` node exists.
- **Vocabulary and how the inspector shows it.** Three different things used to be
  called "align", so the words are now fixed: **Anchors** is the persistent rule
  placing this node in its parent (`layout*` properties), **Flow** is the
  persistent rule placing this node's children, **Cross Axis** is the flow's
  perpendicular placement (`flow.align`), and **Align** / **Distribute** are the
  one-shot operations on a selection (the viewport strip and `Node ▸ Align ▸`).
  Because Anchors and Flow are orthogonal — a panel can stretch to its parent
  *and* stack its children — the inspector shows them as two sub-blocks of one
  **Layout** section, each with its own switch, rather than as one mode selector.
  A child of a flow container sees only its *driven* Position axis disabled:
  the main axis always, the cross axis only when its own Anchors are off.
- Cannot have children by default (set `isContainer = true` to enable)
- Transforms affect all children in local space
- Rotation is clockwise, in degrees
- **Draw order:** by default the 2D pass paints in scene-tree DFS order (a later/deeper node draws
  on top — Godot-like). `zIndex` lifts a node out of that order without moving it in the tree:
  nodes are bucketed by _effective_ z first, and tree order only breaks ties inside a bucket. With
  `zAsRelative` (the default) a subtree keeps its internal layering wherever it is reparented; set
  it to `false` for an "always on top" overlay that must not inherit an ancestor's offset. Both
  fields serialize only when non-default, so scenes that never touch z-order are unchanged.
- **Blend mode:** `blendMode` applies to the materials the node itself owns (a sprite's quad, a
  control's skin + label) and is _not_ inherited the way `opacity` is — set it on each node that
  should glow, not on a wrapping `Group2D`. `additive` is the glow/VFX mode; `multiply` and
  `subtract` darken, and because a transparent PNG's cutout pixels are usually black they will
  darken through the cutout too. A non-normal mode forces `material.transparent` on (three.js
  disables blending for opaque materials) and opts the node's meshes out of the 2D quad batcher,
  so use it for the handful of nodes that need it rather than across a whole scene. `screen` is
  intentionally not offered: it needs `CustomBlending`, and no factor pair reproduces it without
  either ignoring `opacity` or darkening the backdrop as the node fades. Spine skeletons are
  unaffected — their blend modes come per-slot from the spine runtime.

---

### ColorRect2D

A solid-colour rectangle — the engine's **only** untextured 2D fill primitive, and the placeholder
both agent skills tell you to reach for when art does not exist yet. Blocking gameplay on art is the
mistake it exists to prevent: build the whole game out of coloured rects, then swap them for
`Sprite2D`/`TiledSprite2D` once the art lands.

**Type String:** `ColorRect2D`

**Properties** (plus everything on [Node2D](#node2d)):

| Property | Type   | Default | Description                     |
| -------- | ------ | ------- | ------------------------------- |
| `width`  | number | 100     | Width in design pixels          |
| `height` | number | 100     | Height in design pixels         |
| `color`  | color  | #ffffff | Fill colour (authored sRGB hex) |

**Usage Notes:**

- Centred on its own origin, like every 2D node — `position` is the rect's centre, not a corner.
- `opacity` comes from `Node2D` and multiplies the fill; there is no separate alpha property.
- No texture, no nine-slice: for a panel with a border use `TiledSprite2D` in `nine-slice` mode.

---

### Sprite2D

A 2D image display node. Renders a textured quad that always faces the camera.

**Type String:** `Sprite2D`

**Properties:**

| Property            | Type    | Default        | Description                                                                                                            |
| ------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `texture`           | texture | null           | Texture resource (`{ type: texture, url: res://… }`); a legacy `texturePath` string is still accepted on load          |
| `textureKey`        | string  | ""             | Localization sprite key; when it resolves, the localized path wins over `texture`                                      |
| `anchor`            | vector2 | [0.5, 0.5]     | Normalized pivot the image is positioned around                                                                        |
| `width`             | number  | texture width  | Display width in pixels; when unset it takes the texture's natural width on load (64 placeholder until then)           |
| `height`            | number  | texture height | Display height in pixels; when unset it takes the texture's natural height on load (64 placeholder until then)         |
| `aspectRatioLocked` | boolean | false          | Keep width/height at the texture's aspect ratio while resizing                                                         |
| `color`             | color   | #ffffff        | Constructor-only placeholder colour shown before the texture loads; reset to white on load, not in the schema or saved |

**Usage Notes:**

- Supports PNG, JPG, WebP textures
- Aspect ratio is controlled by width/height properties
- Texture is scaled to fit the specified dimensions

---

### TiledSprite2D

A texture mapped onto a rectangle of arbitrary size by one of five fill algorithms — the node for
**UI panels, windows, bars and repeating backgrounds**, where `Sprite2D`'s plain stretch would smear
the corners. This is the engine's nine-slice; UI Kit Forge emits its slice borders directly.

**Type String:** `TiledSprite2D`

**Properties** (plus everything on [Node2D](#node2d)):

| Property                           | Type    | Default    | Description                                                                     |
| ---------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------- |
| `texture`                          | texture | null       | `{ type: 'texture', url: 'res://…' }` (a bare `texturePath` string is read too) |
| `width`                            | number  | 128        | Rect width in design pixels (0 is valid — a collapsed rect)                     |
| `height`                           | number  | 128        | Rect height in design pixels                                                    |
| `patchMode`                        | enum    | `stretch`  | `stretch` \| `tile` \| `nine-slice` \| `three-slice-h` \| `three-slice-v`       |
| `sliceBorderLeft/Right/Top/Bottom` | number  | 0          | Border insets in **source-texture pixels** (Godot's `patch_margin_*`)           |
| `drawCenter`                       | boolean | true       | Draw the middle patch; false leaves a hollow frame                              |
| `axisStretchHorizontal`            | enum    | `stretch`  | `stretch` \| `tile` — how the stretchable regions fill horizontally             |
| `axisStretchVertical`              | enum    | `stretch`  | Same, vertically                                                                |
| `tileScale`                        | vector2 | (1, 1)     | Repeat scale in `tile` mode                                                     |
| `tileOffset`                       | vector2 | (0, 0)     | Repeat phase shift                                                              |
| `anchor`                           | vector2 | (0.5, 0.5) | Normalized pivot: (0,0) bottom-left, (1,1) top-right                            |

**Usage Notes:**

- The four `sliceBorder*` scalars are separate schema properties, not a nested object — set them
  individually from a script or a tool call.
- A 64×64 frame with a 16 px border covers a window of any size: corners stay crisp, edges scale.
- `three-slice-h` is the right mode for a horizontal bar (left cap · middle · right cap); only the
  left/right borders matter.

---

### AnimatedSprite2D

Flipbook sprite animation driven by a `.pix3anim` resource — a set of named clips over a
spritesheet or a list of frame images. Authored in the editor's Sprite Editor. For **skeletal**
animation use [SpineSkeleton2D](#spineskeleton2d) instead; for a property/timeline animation over any
node, use the `core:AnimationPlayer` behaviour.

**Type String:** `AnimatedSprite2D`

**Properties** (plus everything on [Node2D](#node2d)):

| Property                | Type    | Default    | Description                                                                |
| ----------------------- | ------- | ---------- | -------------------------------------------------------------------------- |
| `animationResourcePath` | string  | ""         | `res://…/foo.pix3anim`                                                     |
| `currentClip`           | string  | ""         | Clip name from that resource (empty = first clip)                          |
| `isPlaying`             | boolean | true       | Play on start                                                              |
| `currentFrame`          | number  | 0          | Frame index within the active clip                                         |
| `freeOnFinish`          | boolean | false      | Remove the node when a non-looping clip ends (one-shot VFX)                |
| `width`                 | number  | 64         | Display width in pixels                                                    |
| `height`                | number  | 64         | Display height in pixels                                                   |
| `sizeMode`              | enum    | `stretch`  | `stretch` (fit width/height) \| `native` (use each frame's own pixel size) |
| `anchor`                | vector2 | (0.5, 0.5) | Normalized pivot                                                           |
| `color`                 | color   | #ffffff    | Tint                                                                       |

**Usage Notes:**

- Frame timing lives in the clip (per-frame duration multipliers), not on the node — there is no
  `fps` property here, unlike [AnimatedSprite3D](#animatedsprite3d).
- `freeOnFinish` + a one-shot clip is the whole "spawn an explosion" pattern: no script needed.
- `sizeMode: native` is what you want for a trimmed spritesheet whose frames differ in size.

---

### Group2D

A sized 2D container. Unlike `Node2D` (a bare transform), it has a `width`/`height` rectangle, which
is what anchor layout and flow layout resolve their children against — so this is the node to use as
a **scene root** and as any panel that lays out its children.

**Type String:** `Group2D`

**Properties** (plus everything on [Node2D](#node2d), including the full `flow*` and anchor-layout set):

| Property | Type   | Default | Description                       |
| -------- | ------ | ------- | --------------------------------- |
| `width`  | number | 100     | Container width in design pixels  |
| `height` | number | 100     | Container height in design pixels |

**Usage Notes:**

- It draws nothing. The editor outlines it as an adornment; a build shows only its children.
- With `flowEnabled` it becomes a row/column stack (`flowDirection`, `flowGap`, `flowPaddingX/Y`,
  `flowAlign`, `flowAutoSize`) — the engine's layout container, no script required.
- Node order inside it is paint order, as everywhere in 2D.

---

### SpineSkeleton2D

A Spine skeletal-animation node. Renders a skeleton exported from the
[Spine editor](https://esotericsoftware.com/) in the 2D layer, with animations
selectable in the Inspector and drivable from scripts.

**Type String:** `SpineSkeleton2D`

**Requires the optional Spine runtime.** `@esotericsoftware/spine-threejs` (`~4.3`)
is an _optional_ peer dependency: pix3 declares the module contract and the host
registers a loader for it (`setSpineModuleLoader`), so projects that never use
Spine neither install nor download it. The editor and the exported player register
it automatically; a consumer project that places a `SpineSkeleton2D` adds:

```ts
import { setSpineModuleLoader } from '@pix3/runtime';

setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'));
```

Using the official Spine Runtimes requires a Spine Editor license (Spine Runtimes
License). The skeleton export must come from a Spine version matching the installed
runtime's minor (4.3 export ⇄ 4.3 runtime); a mismatch surfaces as a load error
naming both files.

**Properties:**

| Property          | Type            | Default | Description                                                                                                                               |
| ----------------- | --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `skeletonPath`    | string          | null    | Skeleton export, `.json` or `.skel` (res://)                                                                                              |
| `atlasPath`       | string          | null    | Atlas export, `.atlas` (res://)                                                                                                           |
| `texture`         | texture ref     | null    | Optional page-image override; single-page atlases only                                                                                    |
| `animation`       | string / select | ''      | Animation to play; a dropdown of real names once loaded                                                                                   |
| `loop`            | boolean         | true    | Loop the authored animation                                                                                                               |
| `isPlaying`       | boolean         | true    | Advance time in play mode                                                                                                                 |
| `skin`            | string / select | ''      | Skin to apply; empty = the skeleton's default                                                                                             |
| `timeScale`       | number          | 1       | Playback speed multiplier                                                                                                                 |
| `defaultMix`      | number          | 0       | Crossfade duration between animations, seconds                                                                                            |
| `color`           | color           | #ffffff | Tint (applied through spine's skeleton color)                                                                                             |
| `twoColorTint`    | boolean         | false   | Enable tint-black rendering (dark-tint exports)                                                                                           |
| `freeOnFinish`    | boolean         | false   | `queueFree()` when a non-looping animation ends                                                                                           |
| `previewInEditor` | boolean         | false   | Animate in the editor viewport. **Off by default** — a placed skeleton holds its first frame; the Inspector's Play/Reset buttons drive it |

**Script API:**

```ts
const hero = scene.getNode<SpineSkeleton2D>('Hero');

hero.play('run', { loop: true, mixDuration: 0.2 });
hero.queue('idle', { loop: true, delay: 0.5 }); // after the current entry
hero.stop({ mixDuration: 0.25 }); // mix back to the setup pose
hero.pause();
hero.resume();
hero.setSkin('blue');
hero.setMix('run', 'idle', 0.3); // per-pair crossfade
hero.setTimeScale(1.5);

hero.getAnimationNames(); // ['idle', 'run', …]
hero.getSkinNames();
hero.getCurrentAnimation(); // animation on track 0, or null
hero.getSetupBounds(); // setup-pose AABB, or null before load
hero.isLoaded;

hero.resetToFirstFrame(); // rewind the current animation (pose only)
```

In the Inspector the **Animation** group shows the animation and skin as dropdowns
of the loaded skeleton's real names, plus an **Editor Preview** row: `Play`/`Pause`
toggles `previewInEditor` (an ordinary undoable edit) and `Reset` rewinds to the
first frame. Reset is transient pose-only state — it never enters undo history and
never dirties the scene, matching how the animation timeline's scrub preview
behaves.

**Signals:**

| Signal               | Arguments                                    | When                                                       |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `animation-started`  | `(name, trackIndex)`                         | A track entry became current                               |
| `animation-finished` | `(name, trackIndex)`                         | A non-looping animation ended (also flips `isPlaying` off) |
| `animation-looped`   | `(name, trackIndex)`                         | A looping animation completed a loop                       |
| `spine-event`        | `(name, { int, float, string }, trackIndex)` | A keyed animation event fired                              |

**Export:** the HTML / zip playable export bundles the Spine runtime _statically_
into `index.html`, but only when a scene actually places a `SpineSkeleton2D` — a
dynamic import would become a chunk that a single-file export can never fetch.
Skeleton, atlas and the atlas' page images ship with it; projects without a
skeleton are unaffected in size. The generated npm project gets the dependency
added to its `package.json` on the same condition.

**Usage Notes:**

- Sizing comes from the node transform (`scale`), not a width/height pair — the
  skeleton is authored in its own pixel units. The parse-time skeleton scale stays
  at 1 so all instances share one cached `SkeletonData`.
- The skeleton data and atlas page textures are shared across every node (and the
  editor viewport proxy) that references the same files; each node owns only its
  own `Skeleton`/`AnimationState`.
- Atlas pages are loaded as standalone textures and are excluded from the
  pre-launch texture atlas — their UVs come from the `.atlas` file. For the same
  reason a Spine skeleton does not join the 2D quad batcher.
- Shader effects (`core:adjust`, …) are not supported: spine creates its batch
  materials dynamically. Use `color` / `twoColorTint` for tinting.
- CPU cost is per skeleton per frame (geometry is rebuilt on the CPU). Budget for
  units-to-dozens of visible skeletons, not hundreds.

---

### Button2D

An interactive button control for 2D user interfaces. Responds to pointer clicks and provides visual feedback.

**Type String:** `Button2D`

**Properties:**

| Property            | Type    | Default  | Description                                                      |
| ------------------- | ------- | -------- | ---------------------------------------------------------------- |
| `width`             | number  | 100      | Button width in pixels                                           |
| `height`            | number  | 40       | Button height in pixels                                          |
| `backgroundColor`   | color   | #4a4a4a  | Default background                                               |
| `hoverColor`        | color   | #5a5a5a  | Background on hover                                              |
| `pressedColor`      | color   | #3a3a3a  | Background when pressed                                          |
| `buttonAction`      | string  | "Submit" | Action identifier                                                |
| `textureNormal`     | texture | null     | Skin sprite for the idle state                                   |
| `textureHover`      | texture | null     | Skin sprite on hover; falls back to `textureNormal`              |
| `texturePressed`    | texture | null     | Skin sprite while pressed; falls back to `textureNormal`         |
| `textureDisabled`   | texture | null     | Skin sprite while disabled; falls back to `textureNormal`        |
| `sliceBorderLeft`   | number  | 0        | Left 9-slice inset of the state skins, in source px; 0 = stretch |
| `sliceBorderRight`  | number  | 0        | Right 9-slice inset, in source px                                |
| `sliceBorderTop`    | number  | 0        | Top 9-slice inset, in source px                                  |
| `sliceBorderBottom` | number  | 0        | Bottom 9-slice inset, in source px                               |

**Usage Notes:**

- Emits button press events when clicked
- Visual states: default, hover, pressed
- Use `buttonAction` to identify button function in scripts
- A state sprite replaces the flat colour for that state (the material tint goes white); with no
  sprites at all the button keeps its colour behaviour
- **Nine-slice**: set the four `sliceBorder*` insets (source-texture pixels, Godot's `patch_margin_*`) to stop the skin being smeared. The corners keep their pixel size while the edges and centre stretch, so one 64x64 sprite fits any size. All-zero (the default) is the plain stretch, unchanged.
- The four insets apply to **every** state sprite, and each state's patch is cut against _its own_
  natural size — a hover skin authored at 2x still gets the same physical corners
- A sliced skin opts out of the 2D quad batcher (the batcher extracts four _unit_ corners, which a
  baked patch is not); an unsliced button still batches

---

### Label2D

A multiline text label for 2D UI. Wraps text to a fixed box, aligns it in both axes, and can reveal it with a typewriter effect.

**Type String:** `Label2D`

**Properties:**

| Property                                    | Type             | Default | Description                                                                                                                                       |
| ------------------------------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                                     | string           | ""      | Text to display; `\n` breaks lines                                                                                                                |
| `labelFontFamily`                           | string           | Arial   | Font family. A family the project ships (`ProjectManifest.fonts`) is registered before the first frame; anything else falls back to a system face |
| `labelFontSize`                             | number           | 16      | Font size in pixels                                                                                                                               |
| `labelFontWeight`                           | number \| string | normal  | CSS weight (400/700/900…) — a display face and its Cyrillic supplier usually differ                                                               |
| `labelColor`                                | color            | #ffffff | Text color                                                                                                                                        |
| `labelOutlineWidth`                         | number           | 0       | Alias of `outlineWidth` below (the shared `UIControl2D` caption outline); one outline, two spellings                                              |
| `labelOutlineColor`                         | color            | #000000 | Alias of `outlineColor` below                                                                                                                     |
| `labelShadowColor`                          | color \| null    | null    | Drop-shadow colour; empty = no shadow                                                                                                             |
| `labelShadowOffsetX` / `labelShadowOffsetY` | number           | 0       | Drop-shadow offset in px                                                                                                                          |
| `labelLetterSpacing`                        | number           | 0       | Extra px between glyphs                                                                                                                           |
| `labelAlign`                                | enum             | center  | Horizontal alignment: `left`, `center`, `right`                                                                                                   |
| `labelVAlign`                               | enum             | middle  | Vertical alignment: `top`, `middle`, `bottom`                                                                                                     |
| `width`                                     | number           | 0       | Fixed box width; text word-wraps to it. 0 = auto-size (no wrap)                                                                                   |
| `height`                                    | number           | 0       | Fixed box height for vertical alignment. 0 = auto-size to the lines                                                                               |
| `typewriterSpeed`                           | number           | 0       | Characters per second for the typewriter reveal; 0 = off                                                                                          |
| `glowColor`                                 | color            | #ffffff | Glow colour; inert while `glowStrength` is 0                                                                                                      |
| `glowStrength`                              | number           | 0       | Neon glow around the glyphs (0–4); 0 = off                                                                                                        |
| `outlineColor`                              | color            | #000000 | Outline colour; inert while `outlineWidth` is 0                                                                                                   |
| `outlineWidth`                              | number           | 0       | Contrast outline half-width in px; 0 = off                                                                                                        |

**Usage Notes:**

- The box is centered on the node position (like other UI controls); alignment places the text inside that box.
- Set `width` manually to get word wrap — there is no auto-grow layout yet.
- **Glow/outline are canvas-drawn** (`ctx.shadowBlur` passes + a `strokeText` underlay), not post-processing — which is exactly why HUD text can glow: a `CanvasLayer2D` subtree is drawn _after_ the post-processing composer and can never bloom. Both are off by default, so existing scenes are unchanged.
- Turning either on grows the label's canvas (and the mesh showing it) by a bleed on each side so the blur/stroke isn't clipped; the tap target stays the authored box.
- `glowStrength` 1 is a subtle halo, 2–3 reads as neon (each whole step adds an additive shadow pass, capped at 3); the blur scales with `labelFontSize`, so a HUD label and a title glow proportionally.
- Scripts: `setText(text)` replaces the text and restarts the typewriter; `skipTypewriter()` completes it instantly; `restartTypewriter()` replays it; `isTyping` reports progress; the node emits `'typewriter-complete'` when the reveal finishes.
- The typewriter runs in play mode only (it advances in `tick`); the editor viewport always shows the full text.

---

### Slider2D

A horizontal slider control for selecting numeric values. Useful for volume controls, brightness settings, or any continuous value input.

**Type String:** `Slider2D`

**Properties:**

| Property               | Type    | Default  | Description                                                |
| ---------------------- | ------- | -------- | ---------------------------------------------------------- |
| `width`                | number  | 200      | Slider width in pixels                                     |
| `height`               | number  | 20       | Slider height in pixels                                    |
| `handleSize`           | number  | 20       | Handle knob size                                           |
| `trackBackgroundColor` | color   | #333333  | Empty track color                                          |
| `trackFilledColor`     | color   | #4a9eff  | Filled track color                                         |
| `handleColor`          | color   | #ffffff  | Handle color                                               |
| `minValue`             | number  | 0        | Minimum value                                              |
| `maxValue`             | number  | 100      | Maximum value                                              |
| `value`                | number  | 50       | Current value                                              |
| `axisName`             | string  | "Slider" | Identifier for axis                                        |
| `textureTrack`         | texture | null     | Sprite for the track background                            |
| `textureFill`          | texture | null     | Sprite for the filled portion left of the handle           |
| `textureThumb`         | texture | null     | Sprite for the handle; never nine-sliced                   |
| `sliceBorderLeft`      | number  | 0        | Left 9-slice inset of the track/fill sprites, in source px |
| `sliceBorderRight`     | number  | 0        | Right 9-slice inset, in source px                          |
| `sliceBorderTop`       | number  | 0        | Top 9-slice inset, in source px                            |
| `sliceBorderBottom`    | number  | 0        | Bottom 9-slice inset, in source px                         |

**Usage Notes:**

- Drag the handle to change values
- A slot's sprite replaces its flat colour (tint goes white); unset slots keep the colour
- **Nine-slice**: set the four `sliceBorder*` insets (source-texture pixels, Godot's `patch_margin_*`) to stop the skin being smeared. The corners keep their pixel size while the edges and centre stretch, so one 64x64 sprite fits any size. All-zero (the default) is the plain stretch, unchanged.
- The border applies to the track and the fill, never the thumb — a knob is drawn at its authored
  size, so there is nothing to slice. The fill is **re-cut** as the value moves, so its caps keep
  their pixel size instead of squashing
- Value is clamped between min and max
- Emits the pointer lifecycle signals (`pointerdown`/`pressed`/`pointerup`/`released`/`click`) but **no** state signal: the value is written during the drag, so by the time `released`/`click` fire, `value` is already the value the gesture produced. Read `slider.value` there, or track the live value through `input.getAxis(axisName)`.

---

### Joystick2D

A virtual analog stick control for touch or mouse input. Commonly used for character movement or camera control in games.

**Type String:** `Joystick2D`

**Properties:**

| Property         | Type    | Default    | Description                                                                 |
| ---------------- | ------- | ---------- | --------------------------------------------------------------------------- |
| `enabled`        | boolean | true       | When false the stick accepts no input and drops any drag in progress        |
| `radius`         | number  | 50         | Base radius; also the handle's travel limit                                 |
| `floating`       | boolean | false      | Hidden until a touch summons it under the finger, then fades out on release |
| `axisHorizontal` | string  | Horizontal | Virtual axis written with the X deflection (-1..1)                          |
| `axisVertical`   | string  | Vertical   | Virtual axis written with the Y deflection (-1..1)                          |

**Usage Notes:**

- Writes normalized X/Y values (-1 to 1) into the two named axes; centred is (0, 0)
- Captures the finger that started the drag and follows only that one, so a second thumb can press
  buttons (or drive a second stick) without disturbing it. A `pointercancel` — a finger dragged off
  the edge of the screen — returns the axes to zero, it never leaves them pushed
- A floating stick starts on a **new** touch that is not over UI, asked per finger: a button held by
  another thumb no longer blocks it
- Ideal for mobile/touch interfaces

---

### Checkbox2D

A toggle checkbox control for boolean settings.

**Type String:** `Checkbox2D`

**Properties:**

| Property            | Type    | Default  | Description                                         |
| ------------------- | ------- | -------- | --------------------------------------------------- |
| `size`              | number  | 30       | Side of the square box, in pixels                   |
| `checked`           | boolean | false    | Checked state                                       |
| `uncheckedColor`    | color   | #ffffff  | Box fill colour while unchecked                     |
| `checkedColor`      | color   | #4a9eff  | Box fill colour while checked                       |
| `checkmarkColor`    | color   | #ffffff  | Colour of the fallback tick (ignored with a sprite) |
| `checkmarkAction`   | string  | Checkbox | Virtual input action pulsed / latched on toggle     |
| `textureBox`        | texture | null     | Sprite for the box; also the checked fallback       |
| `textureBoxChecked` | texture | null     | Optional sprite for the box while checked           |
| `textureMark`       | texture | null     | Sprite drawn over the box while checked (the tick)  |

**Signals:**

| Signal                    | Arguments   | When                                                                                                       |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `pointerdown` / `pressed` | —           | A press landed inside the box                                                                              |
| `pointerup` / `released`  | —           | The press ended                                                                                            |
| `click`                   | —           | Released inside the box — a completed _gesture_, emitted **before** the box flips                          |
| `toggled`                 | `(checked)` | The checked state **changed**, emitted **after** the flip, the repaint and the virtual action are in place |

`click` and `toggled` are deliberately separate, as in Godot (`pressed` vs `toggled`):
`click` says "the user clicked me" and runs while `checked` still holds its
pre-click value, so a handler that applies `checked` from `click` applies the
_previous_ state (inverted behaviour). Connect anything that _acts on the state_
to `toggled` and read the payload or the node:

```ts
musicToggle.connect('toggled', this, checked => scene.audio.setBusVolume('music', checked ? 1 : 0));
```

`toggled` fires for every spelling of the change — a tap, the `toggle` /
`setChecked` interactions, `checkbox.checked = x` from a script, an Inspector
edit — and never fires when the assigned value equals the current one.

**Usage Notes:**

- Toggle between checked/unchecked states
- The hit area spans the box plus its label, so clicking the text toggles too
- `checkmarkAction` pulses a virtual button for one frame and latches an axis (1/0) with the state
- A sprite in a slot replaces the corresponding flat colour (the tint goes white). `textureBoxChecked`
  is optional: without it the checked box keeps drawing `textureBox`
- The mark exists **only while checked**, sprite or not. With `textureMark` it is a box-sized,
  unrotated quad; without one it stays the historical tilted colour bar

---

### Bar2D

A progress bar or health bar display.

**Type String:** `Bar2D`

**Properties:**

| Property              | Type    | Default | Description                                                                          |
| --------------------- | ------- | ------- | ------------------------------------------------------------------------------------ |
| `width`               | number  | 150     | Bar width in pixels                                                                  |
| `height`              | number  | 20      | Bar height in pixels                                                                 |
| `value`               | number  | 100     | Current fill value, clamped to `minValue`..`maxValue`                                |
| `minValue`            | number  | 0       | Value at which the bar is empty                                                      |
| `maxValue`            | number  | 100     | Value at which the bar is full                                                       |
| `backBackgroundColor` | color   | #333333 | Trough (background) colour                                                           |
| `barColor`            | color   | #ff4444 | Fill colour                                                                          |
| `showBorder`          | boolean | true    | Draw a frame around the bar                                                          |
| `borderColor`         | color   | #000000 | Frame colour                                                                         |
| `borderWidth`         | number  | 2       | Frame thickness in pixels (not in the Inspector schema; authored/saved in YAML only) |
| `textureTrough`       | texture | null    | Sprite for the empty trough behind the fill                                          |
| `textureFill`         | texture | null    | Sprite for the filled portion                                                        |
| `sliceBorderLeft`     | number  | 0       | Left 9-slice inset of the trough/fill sprites, in source px                          |
| `sliceBorderRight`    | number  | 0       | Right 9-slice inset, in source px                                                    |
| `sliceBorderTop`      | number  | 0       | Top 9-slice inset, in source px                                                      |
| `sliceBorderBottom`   | number  | 0       | Bottom 9-slice inset, in source px                                                   |

**Usage Notes:**

- Fill fraction = (value - minValue) / (maxValue - minValue)
- Useful for health bars, mana bars, loading progress
- Can be oriented horizontally
- A slot's sprite replaces its flat colour (tint goes white); unset slots keep the colour
- **Nine-slice**: set the four `sliceBorder*` insets (source-texture pixels, Godot's `patch_margin_*`) to stop the skin being smeared. The corners keep their pixel size while the edges and centre stretch, so one 64x64 sprite fits any size. All-zero (the default) is the plain stretch, unchanged.
- The fill is **re-cut** at the new width every time `value` changes, so a sliced fill keeps its
  end caps at full pixel size all the way down to an empty bar instead of squashing them

---

### InventorySlot2D

A specialized slot control for inventory systems. Supports drag-and-drop for item management.

**Type String:** `InventorySlot2D`

**Properties:**

| Property          | Type   | Default | Description             |
| ----------------- | ------ | ------- | ----------------------- |
| `width`           | number | 64      | Slot size               |
| `height`          | number | 64      | Slot size               |
| `backgroundColor` | color  | #2a2a2a | Empty slot color        |
| `borderColor`     | color  | #444444 | Border color            |
| `highlightColor`  | color  | #4a9eff | Selection highlight     |
| `itemCount`       | number | 0       | Number of items in slot |

**Signals:**

| Signal                                               | Arguments    | When                                                                                           |
| ---------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `pointerdown` / `pressed` / `pointerup` / `released` | —            | Pointer lifecycle, same as every UI control                                                    |
| `click`                                              | —            | Released inside the slot, emitted **before** the selection flips                               |
| `toggled`                                            | `(selected)` | The selection **changed**, emitted **after** the highlight and the virtual action are in place |

Same split as `Checkbox2D`: read `selected` from a `toggled` listener, not from a
`click` one (which still sees the pre-click value). A slot inside a
`ScrollContainer2D` refuses the click entirely while the list is being flicked,
so neither signal fires for a scroll drag.

**Usage Notes:**

- Can hold one item at a time
- Visual indicator for item count
- Supports drag operations

---

### ScrollContainer2D

A vertically scrolling viewport that clips its children, with drag, wheel and inertia, plus an
optional themeable scrollbar. Use it for inventories, leaderboards, long settings lists.

**Type String:** `ScrollContainer2D`

**Properties** (plus everything on [Node2D](#node2d)):

| Property                | Type    | Default | Description                                                                              |
| ----------------------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `width`                 | number  | 100     | Viewport width                                                                           |
| `height`                | number  | 100     | Viewport height (the clipped window)                                                     |
| `scrollY`               | number  | 0       | Current scroll offset, clamped to content                                                |
| `dragScrollEnabled`     | boolean | true    | Drag the content to scroll                                                               |
| `wheelScrollEnabled`    | boolean | true    | Mouse wheel / trackpad                                                                   |
| `inertiaEnabled`        | boolean | true    | Fling continues after release                                                            |
| `wheelSensitivity`      | number  | 1       | Wheel multiplier                                                                         |
| `dragThreshold`         | number  | 6       | Pixels of movement before a press becomes a drag (below it, the press goes to the child) |
| `inertiaDamping`        | number  | 14      | Higher stops the fling sooner                                                            |
| `showScrollbar`         | boolean | true    | Draw the scrollbar                                                                       |
| `scrollbarWidth`        | number  | 8       | Bar width (min 2)                                                                        |
| `scrollbarMinHeight`    | number  | 24      | Shortest the thumb may get (min 8)                                                       |
| `scrollbarInset`        | number  | 8       | Inset from the right edge                                                                |
| `scrollbarColor`        | color   | #f5f7ff | Thumb tint                                                                               |
| `scrollbarTrackColor`   | color   | #ffffff | Track tint                                                                               |
| `scrollbarThumbTexture` | texture | null    | Optional thumb skin                                                                      |
| `scrollbarTrackTexture` | texture | null    | Optional track skin                                                                      |

**Usage Notes:**

- Script API: `scrollBy(delta)`, `scrollTo(offset)`, `fling(velocity)`, and the `scrollY` accessor.
- The scrollbar meshes carry the 2D overlay flag, so they float above the container's _children_
  rather than being painted under them.
- Vertical only. A horizontal carousel is a `Group2D` with a flow row and your own drag script.

---

### Camera2D

A 2D game camera (Godot-style). Like `VirtualCamera3D` it does **not** render — it _describes_ how the shared 2D orthographic pass is framed. Each frame the runtime picks the highest-priority visible `Camera2D` and applies its pan (`position` + `offset`), `zoom`, clamped `limits`, and shake to the 2D camera. With no `Camera2D` in the scene the 2D pass keeps its default identity framing, so existing 2D scenes / playable ads are unaffected. Every knob is a flat schema property, so the keyframe timeline animates `position`, `offset`, `zoom`, `priority`, etc. with no animation code.

**Type String:** `Camera2D`

**Properties:**

| Property         | Type    | Default   | Description                                                             |
| ---------------- | ------- | --------- | ----------------------------------------------------------------------- |
| `priority`       | number  | 10        | Highest-priority visible Camera2D drives the 2D view (animatable)       |
| `zoom`           | number  | 1         | >1 magnifies (zooms in), <1 zooms out                                   |
| `offset`         | vector2 | 0,0       | Framing offset added to position (never written by follow / shake)      |
| `followTargetId` | node    | —         | Node whose position this camera follows (empty = authored position)     |
| `followOffset`   | vector2 | 0,0       | Offset from the follow target                                           |
| `followDamping`  | number  | 8         | Higher = snappier follow (0 = instant)                                  |
| `deadzone`       | vector2 | 0,0       | World half-extents the target may move within before the camera follows |
| `limitsEnabled`  | boolean | false     | Clamp the visible view inside an axis-aligned world box                 |
| `limitsCenter`   | vector2 | 0,0       | Limits box center                                                       |
| `limitsSize`     | vector2 | 1000,1000 | Limits box size                                                         |
| `shakeAmplitude` | number  | 8         | Peak shake displacement in world units                                  |
| `shakeFrequency` | number  | 24        | Shake oscillation speed                                                 |
| `shakeDuration`  | number  | 0.35      | Shake duration in seconds                                               |
| `shakeDecay`     | number  | 1.5       | Falloff power (0 = steady, 1 = linear, >1 = punchy tail)                |

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

| Property   | Type    | Default   | Description                 |
| ---------- | ------- | --------- | --------------------------- |
| `position` | Vector3 | (0, 0, 0) | X, Y, Z coordinates         |
| `rotation` | Euler   | (0, 0, 0) | Pitch, Yaw, Roll in degrees |
| `scale`    | Vector3 | (1, 1, 1) | X, Y, Z scale factors       |

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

| Property     | Type   | Default     | Description             |
| ------------ | ------ | ----------- | ----------------------- |
| `projection` | enum   | perspective | Projection type         |
| `fov`        | number | 60          | Field of view (degrees) |
| `near`       | number | 0.1         | Near clipping plane     |
| `far`        | number | 1000        | Far clipping plane      |

**Projection Types:**

| Type           | Description                      |
| -------------- | -------------------------------- |
| `perspective`  | Perspective projection (default) |
| `orthographic` | Orthographic projection          |

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

| Property           | Type    | Default    | Description                                                               |
| ------------------ | ------- | ---------- | ------------------------------------------------------------------------- |
| `priority`         | number  | 10         | Highest-priority live virtual camera wins (animatable)                    |
| `fov`              | number  | 60         | Field of view applied to a perspective render camera                      |
| `orthographicSize` | number  | 5          | Size applied to an orthographic render camera                             |
| `followTargetId`   | node    | —          | Node whose position this camera follows (empty = authored position)       |
| `followOffset`     | vector3 | 0,0,0      | World-space offset from the follow target                                 |
| `followDamping`    | number  | 8          | Higher = snappier follow (0 = instant)                                    |
| `deadzone`         | vector3 | 0,0,0      | World half-extents the target may move within before the camera follows   |
| `lookAtTargetId`   | node    | —          | Node this camera orients toward (empty = authored rotation)               |
| `lookAtWeight`     | number  | 1          | 0 = keep authored rotation, 1 = fully track the target                    |
| `rotationDamping`  | number  | 8          | Higher = snappier aim (0 = instant)                                       |
| `confinerEnabled`  | boolean | false      | Clamp the camera position inside an axis-aligned box                      |
| `confinerCenter`   | vector3 | 0,0,0      | Confiner box center                                                       |
| `confinerSize`     | vector3 | 10,10,10   | Confiner box size                                                         |
| `blendDuration`    | number  | 1          | Seconds to blend the render camera toward this one when it becomes active |
| `blendEasing`      | enum    | cubicInOut | Easing curve used for the blend                                           |

**Usage Notes:**

- Requires a `Camera3D` carrying the `core:CameraBrain` component — that camera is the only one that renders.
- Standby cameras are still solved every frame, so a camera is already framed when it is cut to.
- With no follow target, position is left to authored / keyframed values (dolly by keyframes). Same for rotation with no look-at target.
- Setting a Camera Brain's **Blend On Switch** off makes cuts instantaneous.
- Scripts can force the _next_ activation blend with `CameraBrainBehavior.overrideNextBlend(durationSec, easing?)` — a one-shot override that wins even when Blend On Switch is off. The Cutscene Director (`scene.cutscene.playCinematic`) uses it to smooth the cut into and out of a cinematic virtual camera. See the runtime spec §6.13.

---

### GeometryMesh

A 3D mesh node with a built-in primitive geometry and a PBR material. The shape
is inspector-switchable and animatable via the `geometry`/`size` schema
properties.

**Type String:** `GeometryMesh`

**Properties:**

| Property                  | Type    | Default   | Description                                                             |
| ------------------------- | ------- | --------- | ----------------------------------------------------------------------- |
| `geometry`                | enum    | "box"     | Primitive shape (see below)                                             |
| `size`                    | Vector3 | (1, 1, 1) | Interpreted per shape (see below)                                       |
| `material.color`          | color   | #4e8df5   | Surface color                                                           |
| `material.roughness`      | number  | 0.35      | Surface roughness (0-1)                                                 |
| `material.metalness`      | number  | 0.25      | Metallic appearance (0-1)                                               |
| `material.map`            | texture | —         | Albedo (diffuse) texture (res://); required for UV Scroll to be visible |
| `material.aoMap`          | texture | —         | Baked ambient-occlusion map (set by the AO baker)                       |
| `material.aoMapIntensity` | number  | 1         | Strength of the baked AO map (0 = off)                                  |
| `castShadow`              | boolean | true      | Whether the mesh casts shadows                                          |
| `receiveShadow`           | boolean | true      | Whether the mesh receives shadows cast by others                        |

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

| Effect (`type`)              | Params                                            | What it does                                                                                                         |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Dissolve (`core:dissolve`)   | `amount` (0-1), `scale`, `edgeWidth`, `edgeColor` | Noise-thresholded `discard` with an emissive glowing edge; drive `amount` 0→1 to dissolve away                       |
| Rim Light (`core:rim`)       | `color`, `intensity` (0-5), `power`               | Fresnel-based emissive rim, brightest at grazing angles                                                              |
| UV Scroll (`core:uv-scroll`) | `speed` (uv/s)                                    | Scrolls the albedo map. **Play-mode only** (accumulated per tick); static in the edit viewport. Needs `material.map` |
| Flash Tint (`core:flash`)    | `color`, `amount` (0-1)                           | Blends the final lit color toward a flat color; a hit/damage flash                                                   |

Serialized under `material.effects` as an ordered array of `{ type, enabled,
params }` (only non-default params are written).

**Geometry Types & `size` semantics:**

`size` is a single `[x, y, z]` vector reinterpreted per shape, so one editable
field works for every primitive:

| Type       | `size` meaning                                       |
| ---------- | ---------------------------------------------------- |
| `box`      | Full extents: width `x`, height `y`, depth `z`       |
| `sphere`   | Diameter `x` (y, z ignored)                          |
| `plane`    | A horizontal floor `x` by `z` (lies in the XZ plane) |
| `cylinder` | Diameter `x`, height `y`                             |
| `cone`     | Base diameter `x`, height `y`                        |
| `torus`    | Outer diameter `x`; tube thickness scales with `y`   |

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
- `castShadow`/`receiveShadow` (Inspector → **Rendering**) are authored on the
  node and mirrored onto the child render mesh; both default to **true**, which is
  what this node hardcoded before they were exposed, so existing scenes are
  unchanged. Turn `receiveShadow` off for a mesh that should stay evenly lit
  (unlit-looking floors, UI-ish props) without touching the light itself.

---

### MeshInstance

A node that loads and displays external 3D models in GLB or GLTF format.

**Type String:** `MeshInstance`

**Properties:**

| Property | Type   | Default | Description                 |
| -------- | ------ | ------- | --------------------------- |
| `src`    | string | null    | Path to model file (res://) |

**Usage Notes:**

- Supports GLB (binary) and GLTF formats
- Path uses `res://` protocol for project resources
- Can contain multiple meshes, materials, and animations
- Animations can be played via script components

---

### InstancedMesh3D

A `THREE.InstancedMesh` wrapper for rendering many copies of one geometry/material in a single draw call — for large ECS-driven simulations (crowds, particles, tiles). Populate it in bulk from a script/system, not the inspector.

**Type String:** `InstancedMesh3D`

**Node-level (serialized) properties:**

| Property                                    | Type    | Default     | Description                                                                                                     |
| ------------------------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `maxInstances`                              | number  | —           | Buffer capacity (instance count ceiling); read-only in inspector                                                |
| `enablePerInstanceColor`                    | boolean | false       | Allocate a per-instance color buffer                                                                            |
| `castShadow`                                | boolean | —           | Forwarded to the underlying mesh                                                                                |
| `receiveShadow`                             | boolean | —           | Forwarded to the underlying mesh                                                                                |
| `frustumCulled`                             | boolean | —           | Forwarded to the underlying mesh                                                                                |
| `visibleInstanceCount`                      | number  | —           | How many instances currently draw (read-only display)                                                           |
| `material.type`                             | enum    | `standard`  | Material family — `standard` (PBR) / `lambert` (mobile default) / `basic` (unlit); inspector: **Material Type** |
| `material.color`                            | color   | `#ffffff`   | Colour every instance shares; a per-instance colour multiplies it                                               |
| `material.roughness` / `material.metalness` | number  | 0.35 / 0.25 | `standard` only; dropped from the file for the other families                                                   |

**Bulk API (call from a script/system, then `flush()`):**

- `writeMatrices(data, options?)` — write raw N×16 `Float32Array` instance matrices.
- `writeTransforms(data, options?)` — write position/rotation/scale transforms (composed to matrices for you).
- `writeColors(data, options?)` — write per-instance colors (requires `enablePerInstanceColor`).
- `flush()` — upload dirty buffers to the GPU. `SceneRunner` calls `flush()` on every `InstancedMesh3D` before each frame; call it yourself if you mutate outside the runner loop.
- `setGeometry(geometry)` / `setMaterial(material)`; `getInstanceMatrixBuffer()` / `getInstanceColorBuffer()` for direct access.

**Usage Notes:**

- **Instance buffers are NOT serialized** — only the node-level config above is saved. Repopulate buffers at runtime.
- The `material` block IS serialized, and is what makes an instanced mesh authorable: before it existed the loader built no material at all, so a scene-authored instanced mesh always rendered with a shared white PBR default — unreachable from the inspector and past the project's mobile material policy. A `material` handed to the constructor in code still wins over the authored block.
- Raycasts against an instanced mesh return the hit `instanceId`.
- Backed by `ECSService` for project-managed ECS worlds; runtime lives in `packages/pix3-runtime/src/nodes/3D/InstancedMesh3D.ts` + `core/ECSService.ts`.

---

### AmbientLightNode

Uniform light from every direction with no falloff and no shadows — the cheapest possible fill.
Raises the floor of a scene so unlit faces are not pure black.

**Type String:** `AmbientLightNode`

**Properties** (plus everything on [Node3D](#node3d)):

| Property    | Type   | Default | Description  |
| ----------- | ------ | ------- | ------------ |
| `color`     | color  | #ffffff | Light colour |
| `intensity` | number | 0.5     | Brightness   |

**Usage Notes:**

- Position and rotation are inert: ambient light has no direction and no origin.
- Flattens everything it touches. Use it under a `DirectionalLightNode`, not instead of one; for a
  fill with some sense of sky and ground, prefer [HemisphereLightNode](#hemispherelightnode).
- Authored colours convert exactly once — never call `convertSRGBToLinear` on the hex you set.

---

### HemisphereLightNode

A two-colour gradient fill: sky colour from above, ground colour from below, interpolated by each
surface's normal. An outdoor scene's fill light, and a much better default than flat ambient.

**Type String:** `HemisphereLightNode`

**Properties** (plus everything on [Node3D](#node3d)):

| Property      | Type   | Default | Description                |
| ------------- | ------ | ------- | -------------------------- |
| `skyColor`    | color  | #ffffff | Colour arriving from above |
| `groundColor` | color  | #444444 | Colour bounced from below  |
| `intensity`   | number | 0.5     | Brightness                 |

**Usage Notes:**

- No shadows and no falloff, like ambient — it is a fill, not a key light.
- A warm `skyColor` with a cool `groundColor` (or the reverse) reads as outdoor bounce for free.

---

### DirectionalLightNode

A light source that emits parallel rays in a single direction, like the sun. Illuminates all objects from the same angle.

**Type String:** `DirectionalLight`

**Properties:**

| Property     | Type    | Default | Description           |
| ------------ | ------- | ------- | --------------------- |
| `color`      | color   | #ffffff | Light color           |
| `intensity`  | number  | 1.0     | Light brightness      |
| `castShadow` | boolean | true    | Enable shadow casting |

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

| Property     | Type    | Default | Description                  |
| ------------ | ------- | ------- | ---------------------------- |
| `color`      | color   | #ffffff | Light color                  |
| `intensity`  | number  | 1.0     | Light brightness             |
| `distance`   | number  | 0       | Maximum range (0 = infinite) |
| `decay`      | number  | 2       | Falloff rate                 |
| `castShadow` | boolean | true    | Enable shadow casting        |

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

| Property     | Type    | Default | Description                  |
| ------------ | ------- | ------- | ---------------------------- |
| `color`      | color   | #ffffff | Light color                  |
| `intensity`  | number  | 1.0     | Light brightness             |
| `distance`   | number  | 0       | Maximum range (0 = infinite) |
| `angle`      | number  | 60      | Cone angle (degrees)         |
| `penumbra`   | number  | 0       | Edge softness (0-1)          |
| `decay`      | number  | 2       | Falloff rate                 |
| `castShadow` | boolean | true    | Enable shadow casting        |

**Usage Notes:**

- Penumbra creates soft edge transitions
- Angle controls the cone width
- Good for stage lights, flashlights, focused lighting
- Target direction is determined by node rotation

---

### Sprite3D

A textured quad in the 3D world — optionally billboarded so it always faces the camera. For
impostors, floating markers, particles you place by hand, and 2.5D characters.

**Type String:** `Sprite3D`

**Properties** (plus everything on [Node3D](#node3d)):

| Property             | Type    | Default | Description                                                            |
| -------------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `texture`            | texture | null    | `{ type: 'texture', url: 'res://…' }` (`texturePath` string also read) |
| `width`              | number  | 1       | Quad width in **world units**, not pixels                              |
| `height`             | number  | 1       | Quad height in world units                                             |
| `billboard`          | boolean | false   | Face the camera every frame                                            |
| `billboardRoll`      | number  | 0       | Roll, in degrees, applied after billboarding                           |
| `opacity`            | number  | 1       | Alpha                                                                  |
| `textureAspectRatio` | number  | null    | Captured from the texture on load                                      |
| `aspectRatioLocked`  | boolean | false   | Keep width/height at the texture's aspect when either is edited        |

**Usage Notes:**

- Sizes are world units — a 1×1 sprite is one metre wide, not 1 px. This is the single most common
  surprise when porting a 2D idea into 3D.
- Unlike 2D nodes, this one keeps mipmaps: it is a 3D texture and is minified by distance.

---

### AnimatedSprite3D

A billboarded flipbook in the 3D world: same spritesheet idea as
[AnimatedSprite2D](#animatedsprite2d), placed in world space. Unlike the 2D node it carries its own
frame rate.

**Type String:** `AnimatedSprite3D`

**Properties** (plus everything on [Node3D](#node3d)):

| Property       | Type    | Default  | Description                                                  |
| -------------- | ------- | -------- | ------------------------------------------------------------ |
| `width`        | number  | 1        | Quad width in world units                                    |
| `height`       | number  | 1        | Quad height in world units                                   |
| `fps`          | number  | 10       | Frames per second                                            |
| `playing`      | boolean | true     | Play on start                                                |
| `loop`         | boolean | true     | Repeat when the clip ends                                    |
| `freeOnFinish` | boolean | false    | Remove the node when a non-looping clip ends                 |
| `currentFrame` | number  | 0        | Frame index                                                  |
| `billboard`    | boolean | **true** | Face the camera (note: the opposite default from `Sprite3D`) |
| `color`        | color   | #ffffff  | Tint                                                         |
| `opacity`      | number  | 1        | Alpha                                                        |

**Usage Notes:**

- `billboard` defaults to true here and false on `Sprite3D` — an explosion wants to face you, a
  poster on a wall does not.
- `loop: false` + `freeOnFinish: true` is the fire-and-forget 3D hit effect.

---

### Particles3D

A CPU-simulated particle emitter rendered as a single `InstancedMesh`. Supports
billboarded planes, spheres or cubes, per-particle color/alpha/size ramps, an
emitter shape (point/sphere/box), optional ribbon **trails**, and **sub-emitters**
that burst a second emitter on particle death.

**Type String:** `Particles3D`

**Key Properties:**

| Property                    | Type    | Default     | Description                                                                                           |
| --------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `emissionRate`              | number  | 24          | Particles spawned per second                                                                          |
| `maxParticles`              | number  | 512         | Simulation pool size (also the instance cap)                                                          |
| `lifetime`                  | number  | 2           | Base particle lifetime (s), jittered ±15%                                                             |
| `speed` / `speedSpread`     | number  | 2 / 0.5     | Initial speed and its random spread                                                                   |
| `gravity`                   | vector3 | (0,0,0)     | Constant acceleration (sim-space vector)                                                              |
| `startColor`/`endColor`     | color   | white/amber | Color ramp over life                                                                                  |
| `startAlpha`/`endAlpha`     | number  | 1 / 0       | Alpha ramp over life                                                                                  |
| `simulationSpace`           | enum    | `local`     | `local` = particles follow the emitter; `world` = particles are emitted into world space and stay put |
| `trailEnabled`              | boolean | false       | Draw a camera-facing ribbon behind each particle                                                      |
| `trailLifetime`             | number  | 0.3         | How long (s) a trail sample survives                                                                  |
| `trailWidth`                | number  | 0.05        | Ribbon width at the head                                                                              |
| `trailSegments`             | number  | 16          | Ribbon resolution (clamped 2–64)                                                                      |
| `trailFade`                 | number  | 1           | Alpha falloff along the ribbon (0 = solid, 1 = fade to transparent)                                   |
| `subEmitterId`              | node    | —           | Another `Particles3D` fired as a burst at each particle death                                         |
| `subEmitterBurstCount`      | number  | 8           | Particles spawned per death (0–128)                                                                   |
| `subEmitterInheritVelocity` | number  | 0           | Fraction of the dead particle's velocity passed to the burst (0–1)                                    |

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

## Post-processing

### PostProcess

The scene's post-processing stack: bloom, vignette, chromatic aberration, ambient occlusion and a
LUT colour grade, as one node. The runner picks the **first active** `PostProcess` node in the tree
and builds a composer from it; with no such node the plain two-pass path runs and costs nothing.

**Type String:** `PostProcess`

**Properties:**

| Property                     | Type    | Default   | Description                                                                  |
| ---------------------------- | ------- | --------- | ---------------------------------------------------------------------------- |
| `affect2D`                   | boolean | true      | Also run the effects over the 2D pass                                        |
| `bloomEnabled`               | boolean | true      | Bloom on                                                                     |
| `bloomIntensity`             | number  | 1         | Bloom strength                                                               |
| `bloomThreshold`             | number  | 0.9       | Luminance above which pixels bloom                                           |
| `bloomSmoothing`             | number  | 0.025     | Threshold knee                                                               |
| `bloomRadius`                | number  | 0.85      | Blur radius                                                                  |
| `vignetteEnabled`            | boolean | false     | Vignette on                                                                  |
| `vignetteOffset`             | number  | 0.35      | Where the darkening starts                                                   |
| `vignetteDarkness`           | number  | 0.5       | How dark the edges go                                                        |
| `chromaticAberrationEnabled` | boolean | false     | Chromatic aberration on                                                      |
| `chromaticAberrationOffset`  | number  | 0.002     | Channel separation                                                           |
| `aoMode`                     | enum    | `inherit` | Ambient occlusion: `inherit` (project setting) \| `off` \| `ssao` \| `baked` |
| `ssaoIntensity`              | number  | 2.5       | SSAO strength                                                                |
| `ssaoRadius`                 | number  | 0.25      | SSAO sample radius, world units                                              |
| `lutEnabled`                 | boolean | false     | Colour grading on                                                            |
| `lutSrc`                     | string  | ""        | `res://…` path to the LUT image                                              |
| `lutIntensity`               | number  | 1         | Grade blend amount                                                           |

**Usage Notes:**

- It has no transform: the properties sit flat in `properties`, and position/rotation/scale do not
  apply.
- The whole stack is one lazily-created composer. Every effect off = no composer at all.
- In a single-file playable export, `postprocessing` is pulled in through a generated
  `virtual:runtime-*` module — using this node is fine for an export, it just adds weight.

---

## Audio

### AudioPlayer

A node that plays an audio clip through the runtime mixer. Attach it anywhere in
the scene; drive it via `autoplay`, from a script (`node.play()`), or from an
`AnimationPlayer` audio track.

**Type String:** `AudioPlayer`

**Key Properties:**

| Property          | Type    | Default | Description                                            |
| ----------------- | ------- | ------- | ------------------------------------------------------ |
| `audioTrack`      | string  | —       | Asset URL (`res://…`, `data:audio/…`, or absolute URL) |
| `autoplay`        | boolean | false   | Play automatically on the first tick                   |
| `loop`            | boolean | false   | Loop the clip                                          |
| `volume`          | number  | 1       | Per-clip volume (0–1), before the bus gain             |
| `bus`             | enum    | `sfx`   | Mixer bus: `master`, `music`, or `sfx`                 |
| `pitchVariation`  | number  | 0       | Random ± playback-rate spread per play (0–1)           |
| `volumeVariation` | number  | 0       | Random ± volume spread per play (0–1)                  |

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
this.scene.audio.resetSnapshot(); // back to 'default'
```

**Built-in snapshots:** `'default'` (fully open) and `'muffled'`
(`master` lowpass 700 Hz, volume ×0.85). A snapshot's volume scale composes _on
top of_ the user's bus volume, so entering/leaving a snapshot never forgets the
authored mix.

**Slow-motion auto-muffle:** while `scene.time` is in slow motion the mixer
automatically blends to `'muffled'` and back on return to normal speed. This is
driven by the slow-mo base scale, **not** the frozen scale — a `hitstop(…)`
freeze does **not** muffle audio (otherwise every micro-freeze would pump the
filter).

---

## Choosing the Right Node

### For 2D Projects:

1. **Start with a Group2D** as your scene root (the game viewport size comes from project settings; use anchor layout for responsiveness)
2. Add **Sprite2D** for images and graphics
3. Before the art exists, build with **ColorRect2D** — it is the only solid-colour 2D primitive, and
   a game made of coloured rects is playable a day before a game waiting on sprites
4. Use **TiledSprite2D** in `nine-slice` mode for panels, windows and bars — stretching a bordered
   texture with Sprite2D smears its corners
5. Use **Button2D**, **Slider2D**, **Joystick2D** for UI controls, **ScrollContainer2D** for lists
6. Use **Node2D** as bare transforms and **Group2D** wherever children must lay out against a size

### For 3D Projects:

1. Add a **Camera3D** to define your viewpoint
2. Use **GeometryMesh** for simple shapes
3. Use **MeshInstance** for imported 3D models
4. Add **DirectionalLightNode** for overall lighting
5. Add **PointLightNode** or **SpotLightNode** for localized lighting
6. Add **AmbientLightNode** or **HemisphereLightNode** as fill so unlit faces are not black
7. For cinematics / dynamic framing, add **VirtualCamera3D** nodes and a **Camera Brain** (`core:CameraBrain`) on the Camera3D to blend between them by priority
8. For bloom / vignette / colour grading, add one **PostProcess** node anywhere in the tree

---

## Node Properties Quick Reference

| Node Type            | Key Properties                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| NodeBase             | id, name, type, visible, locked                                                                      |
| Node2D               | position (Vector2), rotation, scale (Vector2), opacity, blendMode, zIndex                            |
| Node3D               | position (Vector3), rotation (Euler), scale (Vector3)                                                |
| Sprite2D             | texture, width, height, anchor, aspectRatioLocked                                                    |
| ColorRect2D          | width, height, color (the only untextured 2D fill)                                                   |
| TiledSprite2D        | texture, width, height, patchMode, sliceBorderLeft/Right/Top/Bottom, drawCenter (nine-slice)         |
| AnimatedSprite2D     | animationResourcePath, currentClip, isPlaying, freeOnFinish, width, height, sizeMode                 |
| Group2D              | width, height (+ flow\* / anchor layout — the 2D container)                                          |
| ScrollContainer2D    | width, height, scrollY, dragScrollEnabled, inertiaDamping, showScrollbar                             |
| SpineSkeleton2D      | skeletonPath, atlasPath, animation, loop, skin, timeScale, defaultMix (optional Spine runtime)       |
| Camera2D             | priority, zoom, offset, followTargetId, limitsEnabled, shakeAmplitude                                |
| CanvasLayer2D        | width, height (fixed HUD overlay; renders after post)                                                |
| Camera3D             | projection, fov, near, far                                                                           |
| VirtualCamera3D      | priority, followTargetId, lookAtTargetId, blendDuration, fov                                         |
| GeometryMesh         | geometry, size, material, castShadow, receiveShadow                                                  |
| MeshInstance         | src                                                                                                  |
| Sprite3D             | texture, width, height (world units), billboard, billboardRoll, opacity                              |
| AnimatedSprite3D     | width, height, fps, playing, loop, freeOnFinish, billboard (default true)                            |
| InstancedMesh3D      | maxInstances, enablePerInstanceColor, visibleInstanceCount (bulk write\*/flush), material.type/color |
| DirectionalLightNode | color, intensity, castShadow                                                                         |
| AmbientLightNode     | color, intensity (flat fill, no shadows)                                                             |
| HemisphereLightNode  | skyColor, groundColor, intensity                                                                     |
| PointLightNode       | color, intensity, distance, decay                                                                    |
| SpotLightNode        | color, intensity, distance, angle, penumbra                                                          |
| Button2D             | width, height, backgroundColor, buttonAction, textureNormal/Hover/Pressed/Disabled, sliceBorder\*    |
| Slider2D             | width, minValue, maxValue, value, textureTrack/Fill/Thumb, sliceBorder\*                             |
| Joystick2D           | enabled, radius, floating, axisHorizontal, axisVertical                                              |
| Checkbox2D           | size, checked, textureBox, textureBoxChecked, textureMark                                            |
| Bar2D                | width, value, minValue, maxValue, barColor, backBackgroundColor, textureTrough/Fill, sliceBorder\*   |
| InventorySlot2D      | width, itemCount                                                                                     |
| AudioPlayer          | audioTrack, autoplay, loop, volume, bus, pitchVariation, volumeVariation                             |
| PostProcess          | affect2D, bloom*, vignette*, chromaticAberration*, aoMode, ssao*, lut\*                              |
| Group                | NodeBase only — an organisational container                                                          |
