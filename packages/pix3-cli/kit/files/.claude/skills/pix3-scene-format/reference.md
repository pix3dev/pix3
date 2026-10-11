<!-- Pix3 agent kit 1.6.2 — generated from docs/pix3-specification.md ("Scene File Format"). Do not edit: pix3 kit --update regenerates it. -->
# `.pix3scene` — the engine specification

Excerpts of the engine's specification, as shipped with this CLI. `SKILL.md` beside this file
is the practical version and wins where they differ — in particular node ids may be readable
kebab-case, and there are no scene-format migrations today (`version: 1.0.0` is the only one).
The "Flat Asset Layout" principle is what `pix3 new` creates; an existing project keeps its own
layout (`res://` is always relative to the project root). Source paths quoted here (`src/…`, `packages/…`) are files of the Pix3 engine repository, not of this project.

## Key principles

- Declarative: The file describes the composition and structure of the scene, not the process of its creation.
- Asset Referencing: Assets (models, textures) are not embedded in the file but are referenced via relative paths with a res:// prefix (path from the project root).
- Flat Asset Layout: a game project keeps one folder per asset type **at its root** — `scenes/`, `sprites/` (images/textures), `models/`, `audio/`, `fonts/`, `spine/` (skeleton + atlas + pages together), `scripts/`, `locales/` — with free subdivision inside (`sprites/ui/…`). There is no `assets/` wrapper folder; the project templates ship this layout and `defaultAssetFolder()` (`src/core/asset-categories.ts`) is the canonical mapping used when the editor creates an asset from a bare file name.
- SVG textures: an `.svg` works as a `Sprite2D` / `Button2D` texture only when its root `<svg>` carries `xmlns="http://www.w3.org/2000/svg"` and px `width`/`height` (a viewBox alone has no intrinsic size), it is self-contained, and the Blob it is decoded from is typed `image/svg+xml` — every read path therefore types image/audio blobs by extension when the stored type is generic (`CloudProjectCacheService.readBlob`, `PlayableHtmlBuildService.resolveMimeType`). `pix3 validate` checks referenced SVGs (`E_SVG_INVALID`, `E_SVG_NO_SIZE`, `W_SVG_VIEWBOX_ONLY`, `W_SVG_EXTERNAL_REF`).
- Composition: Complex scenes are assembled from simpler ones by instantiating other scene files.
- Unambiguous Structure: An explicit children key is used to denote the list of child nodes, which separates the hierarchy from the properties of the node itself.
- Unique Identification: Every node must have an id field. The value is a short, cryptographically secure unique identifier (similar to Nano ID) to provide a balance between file readability and the absolute reliability of references.
- Versioned Schema: Each file includes a `version` field; migrations are maintained in the SceneManager and run automatically on load.
- Conflict Resolution: Instance overrides always win over parent definitions. Duplicate IDs trigger validation errors during import.
- Forgiving Vocabulary: a `type:` the loader does not know does **not** fail the load — the node is built as a bare `NodeBase` placeholder that does nothing, so a scene written by a newer version (or with a typo) stays openable and editable. Because such a node is otherwise indistinguishable from a working one, it is reported on three surfaces: the renderability lint (`inert-nodes` in `scene_tree` / `game_observe` / play start), the loader diagnostic (`describeUnknownNodeType`, which suggests the nearest known name), and the Scene Tree row, which carries a warn badge and states the reason in its tooltip. `isInertNode` (`packages/pix3-runtime/src/core/renderability-lint.ts`) is the one predicate behind all three.

## Skinned 2D UI controls

`Button2D`, `Checkbox2D`, `Slider2D` and `Bar2D` are colour-driven by default and
skinned by pointing their texture slots at `res://` sprites. A slot that is set
replaces the corresponding flat colour (the material tint goes white); a slot that
is unset keeps the colour, so an existing scene is unchanged and **every one of
these keys is omitted from a saved scene at its default**.

Slots per node: `Button2D` — `textureNormal` / `textureHover` / `texturePressed` /
`textureDisabled` (a missing state falls back to normal); `Checkbox2D` —
`textureBox`, `textureBoxChecked` (optional; falls back to `textureBox`),
`textureMark` (drawn over the box only while checked); `Slider2D` —
`textureTrack`, `textureFill`, `textureThumb`; `Bar2D` — `textureTrough`,
`textureFill`.

The four `sliceBorderLeft/Right/Top/Bottom` scalars are the same nine-slice insets
`TiledSprite2D` uses — source-texture pixels, Godot's `patch_margin_*` — so one
64x64 skin fits a control of any size instead of being smeared. They apply to
`Button2D`'s state skins, `Slider2D`'s track and fill, and `Bar2D`'s trough and
fill; the slider thumb is drawn at its authored size and is never sliced. A fill
that shrinks with `value` is **re-cut** at the new width, so its end caps keep
their pixel size. All-zero (the default) is the plain stretch. A sliced skin opts
out of the 2D quad batcher, because the batcher extracts four *unit* corners, and
is excluded from the pre-launch texture atlas for the same reason.

Sprites for every one of these slots — and the matching insets — can be generated
and applied without leaving the editor; the files and their manifest are specified
in **§6.23 UI Kit Assets**.

```yaml
- id: 'q7Bd-1mZ_kTn0-Vx4pA'
  type: 'Button2D'
  name: 'PlayButton'
  properties:
    transform:
      position: { x: 0, y: -80 }
    width: 240
    height: 72
    label: 'Play'
    buttonAction: 'Submit'
    textureNormal: { type: 'texture', url: 'res://sprites/ui/btn_normal.png' }
    textureHover: { type: 'texture', url: 'res://sprites/ui/btn_hover.png' }
    texturePressed: { type: 'texture', url: 'res://sprites/ui/btn_pressed.png' }
    # 64x64 skin with 16 px corners -> fits 240x72 without smearing
    sliceBorderLeft: 16
    sliceBorderRight: 16
    sliceBorderTop: 16
    sliceBorderBottom: 16

- id: 'w3Kf-8sQ_2rLm-Yc6tB'
  type: 'Bar2D'
  name: 'HealthBar'
  properties:
    width: 200
    height: 24
    value: 100
    maxValue: 100
    textureTrough: { type: 'texture', url: 'res://sprites/ui/bar_trough.png' }
    textureFill: { type: 'texture', url: 'res://sprites/ui/bar_fill.png' }
    sliceBorderLeft: 12
    sliceBorderRight: 12

- id: 'e5Nh-4tW_9pJk-Zd1uC'
  type: 'Checkbox2D'
  name: 'MusicToggle'
  properties:
    size: 32
    checked: true
    label: 'Music'
    textureBox: { type: 'texture', url: 'res://sprites/ui/check_off.png' }
    textureBoxChecked: { type: 'texture', url: 'res://sprites/ui/check_on.png' }
    textureMark: { type: 'texture', url: 'res://sprites/ui/check_tick.png' }
```

## Spine skeleton nodes

A `SpineSkeleton2D` references its Spine export by two `res://` paths — the
skeleton (`.json` or `.skel`) and the atlas (`.atlas`). The atlas' page images are
NOT listed: they are named inside the atlas text and resolved relative to it (the
export asset collector parses `.atlas` files for the same reason). `texture` is an
optional single-page override.

```yaml
- id: 'ZP2h-9kQ_1sVb0Ac-7mnE'
  type: 'SpineSkeleton2D'
  name: 'Hero'
  properties:
    transform:
      position: { x: 0, y: -120 }
      scale: { x: 1, y: 1 }
    skeletonPath: 'res://spine/hero.json'
    atlasPath: 'res://spine/hero.atlas'
    animation: 'idle'
    loop: true
    isPlaying: true
    skin: ''
    timeScale: 1
    defaultMix: 0.15
    color: '#ffffff'
    # Omitted unless enabled: twoColorTint, freeOnFinish, previewInEditor
```

Rendering requires the optional `@esotericsoftware/spine-threejs` (`~4.3`) module,
registered by the host through `setSpineModuleLoader`. A scene with a Spine node
still loads without it — the node keeps its authored properties and warns.

## Groups

Groups provide runtime categorization for nodes (for example, `enemies`, `ui`, `interactables`).

#### 6.19.1 Node API

- `addToGroup(group)`
- `removeFromGroup(group)`
- `isInGroup(group)`

#### 6.19.2 Scene API

`SceneManager` provides group-based queries and invocation:

- `getNodesInGroup(group)` - returns matching nodes in the active scene.
- `callGroup(group, method, ...args)` - calls matching component methods across grouped nodes.

`callGroup` performs runtime method checks and warns if no callable method is found.

#### 6.19.3 Serialization

Groups are serialized in `.pix3scene` nodes via `groups: []`.

```yaml
root:
  - id: player_001
    type: Node3D
    name: Player
    groups: [actors, player]
```

## Prefabs — instance creation

Creating a prefab instance uses the `instance:` YAML key:

```yaml
root:
  - id: scene_root
    type: Node3D
    children:
      - id: player_instance_1
        instance: res://prefabs/player.pix3scene
        name: Player1
        properties:
          position: { x: 0, y: 0, z: 0 }
```

The `properties` block allows overriding base prefab values. Overrides are tracked separately from the base values.
