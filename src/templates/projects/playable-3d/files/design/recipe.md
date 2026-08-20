# Recipe: recipe-scene-3d

## What this is

The only **3D** recipe: a portrait scene with a real 3D stage — perspective
`Camera3D`, a key light and an ambient fill, a ground slab and one hero solid —
under a 2D UI layer with a tap-to-start gate and an end screen with a CTA.

Reach for it whenever the idea is genuinely three-dimensional: a cube you rotate
and carve, a stack you topple, a solid you inspect from all sides. The other
recipes are 2D, and a 3D idea faked with isometric sprites is not the same game —
if the brief says 3D, it starts here.

The gameplay is a placeholder (`hero-box` spinning on a `core:Rotate`) plus an
auto-win timer. Replace both; keep the camera, the lights and the gate.

**Lighting is load-bearing.** Lit materials with no light render pure black, and
the editor viewport hides this by adding fallback lights of its own — the running
game has none. `key-light` and `ambient-light` are why this scene is visible: do
not delete them, and if you add a mesh that comes out black, the scene lint
(`sceneIssues` in `scene_tree` / `game_observe`) will say so.

**Mobile is the default target.** Both meshes use `material.type: lambert`
(diffuse-only) rather than PBR — the shapes still read, at a fraction of the
per-pixel cost. New geometry created in this project inherits that default. Only
a project whose `targetPlatform` is `desktop` gets `standard` (PBR); switch a
single mesh with `set_property <node> materialType standard`, or the whole
project in Project Settings, when the user asks for a high-end look. `basic`
(unlit) is cheaper still and is the one family that cannot render black for want
of a light.

## Node map

| id | what |
| --- | --- |
| `game-root` | 3D scene root (`Node3D`) |
| `main-camera` | `Camera3D`, perspective, looking down at the stage from `[0, 3, 8]` |
| `key-light` | `DirectionalLightNode` — the shading light; angle it, don't remove it |
| `ambient-light` | `AmbientLightNode` — the fill that keeps unlit faces readable |
| `ground` | `GeometryMesh` box, 12×0.2×12, the floor slab |
| `hero-box` | `GeometryMesh` box placeholder, spinning on `core:Rotate` |
| `hud-root` | 2D UI layer (`Group2D`, stretched); hosts `GameFlow` (intro → playing → ended) |
| `hud-label` | in-game text line |
| `intro-overlay` → `intro-dim`, `intro-label` | the tap gate; the first tap hides it, starts the game, unlocks browser audio |
| `end-screen` → `end-dim`, `end-label`, `cta-button` | end screen, hidden at start |
| `cta-button` | hosts `CtaButton` — `playable.gameEnd()` + a `[CtaButton] CTA clicked` log; the store call belongs to the ad network SDK, not to the template |

`GameFlow.finish()` reveals the end screen; call it from your gameplay code for a
real win/lose instead of the placeholder timer.

## Placeholders

| role | file | node |
| --- | --- | --- |
| hero | (none — `hero-box` is untextured geometry) | `hero-box` |

## Tunables

```yaml
tunables:
  autoWinAfterSec: { node: hud-root, component: "user:GameFlow", property: autoWinAfterSec, min: 0, max: 120, default: 15 }
  introNode: { node: hud-root, component: "user:GameFlow", property: introNode, default: intro-overlay }
  endNode: { node: hud-root, component: "user:GameFlow", property: endNode, default: end-screen }
  keyLightIntensity: { node: key-light, property: intensity, min: 0, max: 4, default: 1.2 }
  ambientIntensity: { node: ambient-light, property: intensity, min: 0, max: 2, default: 0.5 }
```

`component` present → `set_component_property`; absent → `set_property`.

Mesh colour is not a declared tunable: it lives under `material.color` in the
scene file and is edited live with `set_property <node> color "#rrggbb"`.

## Extension points

- **Real geometry.** `create_node` more `GeometryMesh` nodes (`box`, `sphere`,
  `cylinder`, …) with `position3`, or convert `hero-box` into a `MeshInstance3D`
  pointing at a `.glb`. A grid/stack of solids is a loop over `create_node`.
- **Picking.** 3D taps come from the raycast API, not from 2D hit-testing: read
  the pointer in a script and ray-test against the meshes to know which solid was
  hit. That is the backbone of every "tap the block" mechanic.
- **Camera moves.** Orbit or pull back by animating `main-camera`'s transform, or
  add a `VirtualCamera3D` rig if the game needs blends between framings.
- **Real gameplay.** Set `autoWinAfterSec: 0` and call `finish()` on the
  `GameFlow` component when the player actually wins or loses.

## Do not touch

- **`key-light` / `ambient-light`.** Deleting or disabling them makes every lit
  mesh black. Re-colour and re-angle freely; keep at least one enabled light.
- **`main-camera`.** A 3D scene with no enabled `Camera3D` draws nothing at all.
- **The `hud-root` layout.** It is stretched to the safe area on purpose; nest new
  UI inside it rather than adding a second full-screen root.
- **`GameFlow`'s `introNode` / `endNode` ids.** They address nodes by id; renaming
  a node without updating them breaks the phase machine silently.

## Verify

- `play_start`, then `game_observe` — check `sceneIssues` is **absent**. A
  `lit-material-no-light` or `no-camera-3d` entry means the scene cannot draw.
- Tap the gate: `game_input {type:'tap', target:'intro-overlay'}` and confirm
  `intro-overlay` goes invisible and the game phase advances.
- Judge the win with `game_run` and an `until` that names what success is (e.g.
  `end-screen` visible), not with a screenshot — the editor viewport adds
  fallback lights, so a picture cannot prove the running game is lit.
