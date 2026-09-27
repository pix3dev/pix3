---
name: pix3-scene-format
description: The .pix3scene YAML format — file header, node shape (id/type/name/properties/children/components), component shape, 2D transform and layout blocks, res:// references, textures, prefab instances and overrides, scenes/ui overlays and the visible/initiallyVisible split, plus how to translate design/recipe.md tool names into file edits. Use BEFORE creating or editing any .pix3scene file (scene, prefab or overlay) in this project.
---

<!-- Pix3 agent kit {{version}} -->
# `.pix3scene` format

Scenes, prefabs and overlays are the same file type: YAML with a `.pix3scene` extension.
"Prefab" only means "a scene file that other scenes instance". There is no `.pix3prefab`.
The engine's own statement of the format (principles, skinned UI controls, Spine nodes) is in
`reference.md` beside this file; where the two differ, this page describes what the loader and
`pix3 validate` actually do.

## Before you write

- Re-read the file you are about to change — the human may have edited it in the editor.
- Change only the lines you mean to change. A whole-file rewrite from memory drops what the
  human (or the editor) wrote since you last read it.
- If your tools support it, write to a temporary file and rename it over the target. Not
  required for correctness — the editor waits for the file to stop changing — but cleaner.
- Then `pix3 check` (see `pix3-verify`).

## File

```yaml
version: 1.0.0                 # the only format version; copy it
metadata:                      # optional, free-form
  author: Pix3 Recipe
  description: Tapper gameplay — falling objects
root:                          # list of root nodes; at least one
  - id: game-root
    type: Group2D
    ...
```

`#` lines are comments and may appear anywhere. Top-level keys are exactly `version`,
`description`, `metadata`, `root`.

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
  rotation: 0           # DEGREES in YAML; positive = counter-clockwise (Y is up)
```

2D space: origin at the centre of the screen/parent, **X right, Y up**. The recipes use a
1080 x 1920 portrait design (top edge y = 960, bottom y = -960); other projects read
`viewportBaseSize` / `projectType` in `pix3project.yaml` — a `3d` project may have loose
top-level 2D nodes (a HUD) and no 2D root at all, so position new HUD relative to the HUD
nodes that are already there. Scripts see the rotation in
radians (`node.rotation.z`). `{ x: 0, y: 690 }` is also accepted for a vector, and so is a flat
`position:` beside `transform` (read-compat), but write the `transform:` block the editor saves.

3D nodes (`Node3D`, meshes, cameras, lights) use
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

**A new HUD node must not overlap the HUD that is already there.** Before you place it, read
the `position`, `width`/`height` and anchoring of its siblings and pick a free spot (a combo
label placed "top-right" once landed under the game's Shop button). With the live channel,
confirm it with a `viewport_screenshot` while the game runs; without it, ask the human to look.

Flow (stack children in a row/column) is a separate block:
`flow: { enabled: true, direction: vertical, gap: 16, paddingX: 0, paddingY: 0, align: start, autoSize: false }`.

The flat names `layoutEnabled`, `horizontalAlign`, `flowEnabled`, `flowGap` … are the
inspector's names for the same values: on a plain node they belong in these blocks (flat they
are ignored — `pix3 validate` says so); on an **instance** node they are the only form (below).

### Values

- **Colour**: a quoted hex string, `color: "#141a2e"`. Always quote — an unquoted `#` starts
  a YAML comment and the value becomes empty.
- **Asset path**: `res://` + path from the project root (the folder with `pix3project.yaml`),
  whatever the layout: `res://sprites/ph-target.png` in a recipe, `res://src/assets/textures/x.png`
  in a project that keeps assets under `src/`. Follow the folders the project already has; a
  new project from `pix3 new` uses one folder per type at the root (`sprites/`, `audio/`,
  `fonts/`, `models/`, `spine/`, `scripts/`, `scenes/`).
- **Texture slot**: `texture: { type: 'texture', url: 'res://sprites/x.png' }` (same shape for
  `textureNormal`, `textureFill`, …). The saver always writes this form; a bare
  `texturePath: 'res://…'` string is only read for compatibility.
- **Strings** with `:` `#` `{` or leading spaces: quote them (`label: "SCORE 0"`).

### Shader effects (`Sprite2D`, `AnimatedSprite2D`, `Button2D` only)

```yaml
effects:
  - type: core:tint
    params: { color: "#7ee787", amount: 1 }
```

`core:tint` multiplies a near-white placeholder PNG to the colour — this is how recipe
placeholders get their palette. Also `core:adjust`, `core:grayscale`, `core:flash`,
`core:uv-scroll`, `core:dissolve`. Other 2D nodes do not read `effects` (a `ColorRect2D` takes
its colour from `color`). On a `GeometryMesh` the stack lives at `material.effects`.

## Component

```yaml
- id: combo                    # readable id; keep it unique in the scene
  type: user:Combo             # user:<ExportedClassName> (scripts/*.ts) or core:<Name>
  enabled: true
  config:                      # keys = names in the component's getPropertySchema()
    windowSec: 1.2
```

- `config` is **merged over** the defaults the script's constructor sets, so write only the
  keys you want to differ.
- A `user:X` whose class does not exist (or has no `static getPropertySchema()`) is kept as
  "pending" with a console warning and never runs.
- Built-ins (`core:*`) and every config key they take, with defaults, are listed in
  `.claude/skills/pix3-scripts/reference.md` ("`core:` components").

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
- The instance node's `name` **replaces the prefab root's name** in the loaded scene (its `id`
  stays the instance's own id). `findByName('Result Overlay')` finds the instance above, not
  the name written in `result.pix3scene`; omit `name` to keep the prefab's.
- Instance `properties` are applied to the prefab's root through its **schema names**:
  `visible`, `opacity`, `width`, `layoutEnabled`, `horizontalAlign`, … plus a `transform` block
  (`position`, `rotation`, `scale`). The `layout:` / `flow:` blocks of a plain node are not read
  here — write `layoutEnabled: true` + `horizontalAlign: right` instead.
- Do **not** add `components` or `children` to an instance node — they are ignored (the
  content comes from the prefab). To change what is inside, edit the prefab file itself, or
  override one inner node's properties:

  ```yaml
  overrides:
    byLocalId:
      retry-button:            # an id below the prefab root; nested: parent-id/child-id
        properties: { label: "AGAIN" }   # schema names, as on the instance itself
  ```

- Nodes inside an instance keep their authored ids when those are unique, so scripts can find
  them by id (`retry-button` inside `scenes/ui/result.pix3scene` is found as `retry-button`).
- A prefab carries fixed defaults only (e.g. its `core:Hitbox2D` group). Tunables live on
  plain nodes in the host scene.
- Where prefabs live: `scenes/prefabs/` (the recipes) or a top-level `prefabs/` — the export
  treats both (and `scenes/ui/`) as prefabs, never as a boot scene.
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
| tunable without `component` | edit `properties.<property>` on the node with that `id` (in the `transform` / `layout` / `flow` block where it belongs) |
| `set_property` | edit `properties` in the YAML |
| `set_component_property` | edit the component's `config` |
| `create_node` / `add_component` | add the node / component entry to the YAML |
| `fs_write` (+ `overwrite: true`) | write the file |
| `play_start`, `game_input`, `game_observe`, `game_run` | the same tools over the live channel when it is connected (`pix3-verify`); otherwise `pix3 check`, then `pix3 smoke <the scene you changed>`, then ask the human to press Play and tell them what to look for |

Values out of a tunable's `min`/`max` load as written (`pix3 validate` warns); the script's
schema `setValue` may clamp them.

## Known gaps

- `metadata.description` is free text; nothing reads it but humans.
- Instance overrides of **components** inside a prefab are not supported from the host scene.
