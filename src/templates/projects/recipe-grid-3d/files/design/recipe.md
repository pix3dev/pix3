# Recipe: recipe-grid-3d

## What this is

The 3D carving shape: a solid block of cubes, a perspective camera looking at
it, and a tap that removes one cube. Some cubes are **core** — hitting one costs
a life. Clear every non-core cube and the run is won.

Voxel carving, 3D minesweeper, layer puzzles, tap-to-mine, "chip away to reveal
the shape". If the idea is a 3D thing you touch, start here; if it is a flat
board of tiles, `recipe-tapper-2d` is the cheaper shape.

**The cubes are generated, not authored.** `GridBoard` builds them under
`board-anchor` on start, so the board size is a config number
(`sizeX`/`sizeY`/`sizeZ`), not a scene edit. Do not hand-place cubes in the
scene — they would not be in the board's map and taps would ignore them.

**Picking is a 3D raycast.** `GridBoard` converts the pointer to normalized
device coordinates and calls `scene.raycastViewport(nx, ny)`. There are no
`Hitbox2D` groups on a mesh, so the 2D collision helpers do nothing here.

**Lighting is load-bearing.** `key-light` + `fill-light` are why the block is
visible; lit materials with no light render pure black, and the editor viewport
hides that by adding fallback lights the running game does not have. If
something comes out black, read `sceneIssues` in `scene_tree` / `game_observe`.

**Mobile is the default target.** Every cube is `material.type: lambert` — a
4×4×4 board is 64 meshes, and PBR at that count is a phone's whole frame budget.
Past ~8³ move to an `InstancedMesh3D` before you reach for prettier materials.

## Node map

| id | what |
| --- | --- |
| `game-root` | 3D scene root; hosts **both** `GridBoard` and `GridRules` |
| `main-camera` | `Camera3D`, perspective, framed on the block from `[6, 6, 8]` |
| `key-light` | `DirectionalLightNode` — the shading light |
| `fill-light` | `HemisphereLightNode` — keeps unlit faces readable |
| `board-anchor` | empty `Node3D` the generated cubes are parented to; the board centres itself on it |
| `hud-root` | 2D UI layer; hosts `ScoreHud` |
| `score-label` | cleared-cube counter |
| `lives-bar` | `Bar2D` driven by `lives-changed` |
| `result-overlay` → `result-dim`, `result-label`, `retry-button`, `menu-button` | end screen, hidden at start |

Signals, all emitted on `game-root` by `GridBoard` and consumed by `GridRules`:
`board-built` (clearable, cores) · `cell-cleared` (remaining) · `core-hit`
(remaining) · `board-cleared`.

## Placeholders

| role | file | node |
| --- | --- | --- |
| cube | (none — generated `GeometryMesh`, coloured by `cellColor`) | `board-anchor` children |

## Tunables

```yaml
tunables:
  sizeX: { node: game-root, component: "user:GridBoard", property: sizeX, min: 1, max: 10, default: 4 }
  sizeY: { node: game-root, component: "user:GridBoard", property: sizeY, min: 1, max: 10, default: 4 }
  sizeZ: { node: game-root, component: "user:GridBoard", property: sizeZ, min: 1, max: 10, default: 4 }
  coreCount: { node: game-root, component: "user:GridBoard", property: coreCount, min: 0, max: 40, default: 6 }
  cellSize: { node: game-root, component: "user:GridBoard", property: cellSize, min: 0.1, max: 3, default: 0.9 }
  spacing: { node: game-root, component: "user:GridBoard", property: spacing, min: 0.1, max: 4, default: 1 }
  cellColor: { node: game-root, component: "user:GridBoard", property: cellColor, default: "#3ee6c1" }
  coreColor: { node: game-root, component: "user:GridBoard", property: coreColor, default: "#ff6b6b" }
  revealCores: { node: game-root, component: "user:GridBoard", property: revealCores, default: false }
  startingLives: { node: game-root, component: "user:GridRules", property: startingLives, min: 1, max: 9, default: 3 }
  timeLimitSec: { node: game-root, component: "user:GridRules", property: timeLimitSec, min: 0, max: 600, default: 0 }
```

`component` present → `set_component_property`; absent → `set_property`.

## Extension points

- **A shape inside the block.** `pickCoreKeys` chooses cores at random from the
  interior; replace it with a lookup into your own voxel shape and the game
  becomes "carve until the statue appears".
- **Layer rules.** `GridBoard.removeCell` is the one place a removal happens —
  add a cascade (remove neighbours), a combo counter, or a rule that only
  exposed cubes may be tapped, all from there.
- **Camera moves.** Animate `main-camera`'s transform, or add a
  `VirtualCamera3D` rig, to let the player orbit the block between taps.
- **Feel.** `clearSound` / `coreSound` take a `res://` audio path; the punch and
  the red flash are already wired through `scene.juice`.

## Do not touch

- **`key-light` / `fill-light`.** Remove them and every cube renders black.
- **`main-camera`.** No enabled `Camera3D` means nothing 3D is drawn at all, and
  the raycast has no camera to shoot through — taps stop working too.
- **`board-anchor`'s id.** `GridBoard.boardAnchor` addresses it by name; renaming
  one without the other leaves the board unbuilt (it logs a warning and stops).
- **The `game-root` id.** Portable tests and routines address the run through it.

## Verify

- `play_start`, then `game_observe` — `sceneIssues` must be **absent**, and
  `game.snapshot()` carries `remaining` (cubes still to clear).
- Tap the block: `game_input {type:'tap', x:0, y:0}` and assert `remaining` went
  **down** in `game.changed`. That is the proof a tap reached the board — not a
  screenshot, which the editor's fallback lighting can flatter. Note the units:
  tap coordinates are 2D world space, which is **centred on the origin**, so the
  middle of the screen is `(0, 0)` and not `(540, 960)`.
- Win: set `sizeX/sizeY/sizeZ: 1` and `coreCount: 0`, then one tap clears the
  board. Read the *transition*, not the end state: the win overlay appears on the
  pointer-DOWN that clears the last cube, so the matching pointer-UP can land on
  the RETRY button underneath the finger and start a fresh run before you look.
  Assert on `board-cleared` / `game-won`, or tap a last cube that is not under
  the end screen's buttons.
