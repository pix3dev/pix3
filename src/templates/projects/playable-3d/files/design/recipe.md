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

**The bookkeeping is already built.** `GameRules` keeps score, lives and the clock and
decides win/lose; `ScoreHud` displays them. Your first increment is the *mechanic*: call
`addScore(1)` / `loseLife()` / `finish(true)`, or emit `score-added` / `life-lost` on
`hud-root`. Never write a second score counter, HUD label or result screen.

**Lighting is load-bearing.** Lit materials with no light render pure black, and
the editor viewport hides this by adding fallback lights of its own — the running
game has none. `key-light` and `ambient-light` are why this scene is visible: do
not delete them, and if you add a mesh that comes out black, the scene lint
(`sceneIssues` in `scene_tree` / `game_observe`) will say so.

**Mobile is the default target.** Both meshes use `material.type: lambert`
(diffuse-only) rather than PBR — the shapes still read, at a fraction of the
per-pixel cost, and new geometry inherits that default. Only a `desktop`
`targetPlatform` gets `standard` (PBR); switch one mesh with
`set_property <node> materialType standard`, or the project in Project Settings,
when the user asks for a high-end look. `basic` (unlit) is cheaper still and is
the one family that cannot render black for want of a light.

## Node map

| id | what |
| --- | --- |
| `game-root` | 3D scene root (`Node3D`) |
| `main-camera` | `Camera3D`, perspective, looking down at the stage from `[0, 3, 8]` |
| `key-light` | `DirectionalLightNode` — the shading light; angle it, don't remove it |
| `ambient-light` | `AmbientLightNode` — the fill that keeps unlit faces readable |
| `ground` | `GeometryMesh` box, 12×0.2×12, the floor slab |
| `hero-box` | `GeometryMesh` box placeholder, spinning on `core:Rotate` |
| `hud-root` | 2D UI layer (`Group2D`, stretched); hosts `GameFlow` (intro → playing → ended), `GameRules` (score/lives/win-lose) and `ScoreHud` (display only) |
| `hud-label` | in-game text line |
| `score-label` | `SCORE n`, driven by the `score-changed` signal |
| `time-label` | seconds — counts up with no time limit, down with one |
| `lives-bar` | `Bar2D` fed by `lives-changed` |
| `intro-overlay` → `intro-dim`, `intro-label` | the tap gate; the first tap hides it, starts the game, unlocks browser audio |
| `end-screen` → `end-dim`, `end-label`, `cta-button` | end screen, hidden at start |
| `cta-button` | hosts `CtaButton` — `playable.gameEnd()` + a `[CtaButton] CTA clicked` log; the store call belongs to the ad network SDK, not to the template |

End a run with `GameRules.finish(won)`: it writes the outcome text and dispatches
`GameFlow`'s `finish`. One end screen, one phase machine, one debug snapshot (the rules'
numbers ride inside GameFlow's). Either script survives the other being deleted.

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
  skipIntro: { node: hud-root, component: "user:GameFlow", property: skipIntro, default: false }
  winMode: { node: hud-root, component: "user:GameRules", property: winMode, default: score }
  targetScore: { node: hud-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 10 }
  timeLimitSec: { node: hud-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 0 }
  startingLives: { node: hud-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  keyLightIntensity: { node: key-light, property: intensity, min: 0, max: 4, default: 1.2 }
  ambientIntensity: { node: ambient-light, property: intensity, min: 0, max: 2, default: 0.5 }
```

`component` present → `set_component_property`; absent → `set_property`.

`skipIntro: true` starts already playing, gate hidden — a prototyping vent. Turn it off
before shipping: that first tap is what unlocks browser audio.

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
- **Real gameplay.** Set `autoWinAfterSec: 0` and let `GameRules` end the run: score
  with `addScore`/`score-added`, cost a life with `loseLife`/`life-lost`, and pick the win
  condition with `winMode` + `targetScore` + `timeLimitSec` instead of writing one.

## Do not touch

- **`key-light` / `ambient-light`.** Deleting or disabling them makes every lit
  mesh black. Re-colour and re-angle freely; keep at least one enabled light.
- **`main-camera`.** A 3D scene with no enabled `Camera3D` draws nothing at all.
- **The `hud-root` layout.** It is stretched to the safe area on purpose; nest new
  UI inside it rather than adding a second full-screen root.
- **`GameFlow`'s `introNode` / `endNode` ids.** They address nodes by id; renaming
  a node without updating them breaks the phase machine silently. The same goes for
  `ScoreHud`'s `sourceNode` / label ids.
- **A second `registerGameDebug`.** `GameFlow` publishes the only one, rules' numbers
  merged in; a second silently replaces it. Add fields to that snapshot instead.

## Verify

- `play_start`, then `game_observe` — check `sceneIssues` is **absent**. A
  `lit-material-no-light` or `no-camera-3d` entry means the scene cannot draw.
- Tap the gate: `game_input {type:'tap', target:'intro-overlay'}` and confirm
  `intro-overlay` goes invisible and the game phase advances.
- Read scoring back as data: the snapshot carries `score`, `lives`, `timeLeftSec` and
  `outcome` next to `phase` — never judge a counter from a screenshot.
- Judge the win with `game_run` and an `until` that names what success is (e.g.
  `end-screen` visible), not with a screenshot — the editor viewport adds
  fallback lights, so a picture cannot prove the running game is lit.
