---
name: pix3-scene-format
description: The .pix3scene YAML format — file header, node shape (id/type/name/properties/children/components), component shape, 2D transform and layout blocks, res:// references, textures, prefab instances, scenes/ui overlays and the visible/initiallyVisible split, plus how to translate design/recipe.md tool names into file edits. Use BEFORE creating or editing any .pix3scene file (scene, prefab or overlay) in this project.
---

# `.pix3scene` format

Scenes, prefabs and overlays are the same file type: YAML with a `.pix3scene` extension.
"Prefab" only means "a scene file that other scenes instance". There is no `.pix3prefab`.

## Before you write

- Re-read the file you are about to change — the human may have edited it in the editor.
- Change only the lines you mean to change. A whole-file rewrite from memory drops what the
  human (or the editor) wrote since you last read it.
- If your tools support it, write to a temporary file and rename it over the target. Not
  required for correctness — the editor waits for the file to stop changing — but cleaner.

## File

```yaml
version: 1.0.0                 # copy what the file already has
metadata:                      # optional, free-form
  author: Pix3 Recipe
  description: Tapper gameplay — falling objects
root:                          # list of root nodes; at least one
  - id: game-root
    type: Group2D
    ...
```

`#` lines are comments and may appear anywhere.

## Node

```yaml
- id: spawner-targets          # REQUIRED. Unique across the scene incl. instanced prefabs.
  type: Group2D                # REQUIRED for a plain node. Exact class name (see pix3-nodes).
  name: Spawner Targets        # display name; free to change
  groups: [spawners]           # optional runtime groups
  properties:                  # node properties — names from pix3-nodes
    width: 900
    height: 60
    transform:
      position: [0, 690]
      scale: [1, 1]
      rotation: 0
  components:                  # optional; script components
    - id: target-spawner
      type: user:Spawner
      enabled: true
      config:
        prefab: res://scenes/prefabs/target.pix3scene
        intervalSec: 0.85
  children: []                 # optional; child nodes, same shape, recursive
```

Rules:

- **`id`**: short, readable, kebab-case, unique (`combo-label`, `spawner-bonus`). Two nodes
  with the same id fail the load. Never rename an id the recipe lists as stable — scripts
  find nodes by id; rename `name` instead.
- **`type`**: must be a real node type. An unknown or misspelled type does **not** fail the
  load — the node becomes an inert placeholder that draws and does nothing.
- **`properties`**: unknown keys are kept silently and do nothing; a value of the wrong type
  (a string where a number belongs) is silently replaced by the default. Check names and
  types against `pix3-nodes`.
- **`children`**: tree order is 2D paint order — a later sibling, or a deeper node, draws on
  top. `zIndex` overrides it.

### 2D transform

```yaml
transform:
  position: [x, y]      # design pixels; the node's CENTRE, relative to its parent
  scale: [1, 1]
  rotation: 0           # DEGREES in YAML (scripts see radians in node.rotation.z)
```

2D space: origin at the centre of the screen/parent, **X right, Y up**. The recipes use a
1080 x 1920 portrait design (top edge y = 960, bottom y = -960). `{ x: 0, y: 690 }` is also
accepted for a vector, and so is a flat `position:` beside `transform`, but write the
`transform:` block the recipes use.

3D nodes (`Node3D`, meshes, cameras) use
`transform: { position: [x, y, z], rotationEuler: [dx, dy, dz], scale: [1, 1, 1] }`,
rotation in degrees.

### Anchor layout (2D)

```yaml
layout:
  enabled: true
  horizontalAlign: left      # left | center | right | stretch
  verticalAlign: top         # top | center | bottom | stretch
```

The node keeps its authored distance to that edge of its parent when the parent resizes
(a different screen aspect). `stretch` keeps both margins and resizes the node. Position is
still authored in `transform.position`. HUD widgets anchor to screen edges; full-screen
backgrounds and roots use `stretch` on both axes.

Flow (stack children in a row/column) is a separate block:
`flow: { enabled: true, direction: vertical, gap: 16, paddingX: 0, paddingY: 0, align: start, autoSize: false }`.

### Values

- **Colour**: a quoted hex string, `color: "#141a2e"`. Always quote — an unquoted `#` starts
  a YAML comment and the value becomes empty.
- **Asset path**: `res://` + path from the project root: `res://sprites/ph-target.png`,
  `res://scenes/prefabs/hazard.pix3scene`. Assets live in one folder per type at the root
  (`sprites/`, `audio/`, `fonts/`, `models/`, `spine/`, `scripts/`, `scenes/`). Never an
  `assets/` wrapper folder.
- **Texture slot**: `texture: { type: 'texture', url: 'res://sprites/x.png' }` (same shape for
  `textureNormal`, `textureFill`, …).
- **Strings** with `:` `#` `{` or leading spaces: quote them (`label: "SCORE 0"`).

### Shader effects on 2D nodes

```yaml
effects:
  - type: core:tint
    params: { color: "#7ee787", amount: 1 }
```

`core:tint` multiplies a near-white placeholder PNG to the colour — this is how recipe
placeholders get their palette. Also `core:adjust`, `core:grayscale`.

## Component

```yaml
- id: combo                    # readable id; keep it unique in the scene
  type: user:Combo             # user:<ExportedClassName> (scripts/*.ts) or core:<Name>
  enabled: true
  config:                      # keys = names in the script's getPropertySchema()
    windowSec: 1.2
```

- `config` is **merged over** the defaults the script's constructor sets, so write only the
  keys you want to differ.
- A `user:X` whose class does not exist (or has no `static getPropertySchema()`) is kept as
  "pending" with a console warning and never runs.
- Built-ins you can attach (configure via `config`): `core:AnimationPlayer`,
  `core:BurstOnSignal`, `core:CameraBrain`, `core:Collider2D`, `core:Fade`, `core:Follow`,
  `core:FreeOnSignal`, `core:Hitbox2D`, `core:PhysicsBody2D`, `core:PhysicsWorld2D`,
  `core:PinToNode`, `core:PlaySound`, `core:PointAttachment`, `core:PopIn`, `core:PunchScale`,
  `core:RadialProgress`, `core:RevoluteJoint2D`, `core:Rotate`, `core:SfxOnSignal`,
  `core:Shake`, `core:SimpleMove`, `core:Sine`. Their config keys are not listed here — copy
  them from an existing use in the project (e.g. `core:Hitbox2D` in a prefab:
  `shape: circle, radius: 74, group: target, debugDraw: false`; `core:PopIn`:
  `from: 0.2, duration: 0.22, easing: backOut, playOnStart: true, triggerEvent: ""`).

## Prefab instance

```yaml
- id: result-overlay
  name: Result Overlay
  instance: res://scenes/ui/result.pix3scene
  properties:
    visible: false
    transform: { position: [0, 0] }
```

- `instance:` **replaces** `type:`. The instanced file must contain **exactly one** root node.
- On the instance write only placement / simple overrides in `properties` (`transform`,
  `visible`). Do **not** add `components` or `children` to an instance node — the editor
  locks component config on instances and structural edits inside an instance cannot be
  saved. To change what is inside, edit the prefab file itself.
- Nodes inside an instance keep their authored ids when those are unique, so scripts can find
  them by id (`retry-button` inside
  `scenes/ui/result.pix3scene` is found as `retry-button`).
- A prefab carries fixed defaults only (e.g. its `core:Hitbox2D` group). Tunables live on
  plain nodes in the host scene.
- Spawned at runtime with `await this.scene.instantiate('res://scenes/prefabs/x.pix3scene', { parent })`.

## Full-screen UI lives in `scenes/ui/`

A result card, pause menu or modal is its own file in `scenes/ui/`, instanced into the host
scene with `properties: { visible: false }`. Two different flags, both needed:

- `visible: false` on the **instance** — hides it in the **editor**, so `main.pix3scene`
  opens on the game, not on a GAME OVER card. Never remove it.
- `initiallyVisible: false|true` on the **overlay file's root node** — what **play mode**
  applies at start. A script reveals the overlay by setting `node.visible = true`.

Never put a full-screen dimmer/panel inline in `main.pix3scene`.

## Recipe tool names → file edits

`design/recipe.md` was written for the in-editor agent. Without its tools:

| recipe.md says | you do |
| --- | --- |
| tunable with `component: "user:X"` | edit `config.<property>` of the component with `type: user:X` on the node with that `id` |
| tunable without `component` | edit `properties.<property>` on the node with that `id` |
| `set_property` | edit `properties` in the YAML |
| `set_component_property` | edit the component's `config` |
| `create_node` / `add_component` | add the node / component entry to the YAML |
| `fs_write` (+ `overwrite: true`) | write the file |
| `play_start`, `game_input`, `game_observe`, `game_run` | not available — `pix3 check`, then ask the human to press Play and tell them what to look for |

Values out of a tunable's `min`/`max` are clamped by the script's schema, not rejected.
