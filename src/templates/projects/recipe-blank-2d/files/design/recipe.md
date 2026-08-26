# Recipe: recipe-blank-2d

## What this is

**Nothing plays yet, on purpose.** A bounded field, a HUD, and score / lives /
timer / win-lose bookkeeping that already works — and no mechanic of any kind,
including controls.

Pick this recipe when the idea's core loop is not what another recipe ships:
grid or turn-based movement (snake, sokoban, match-3), word / card / board games,
builders, physics contraptions, idle games. **Your first increment is the core
mechanic itself, controls included** — that is the trade being made here, and it
beats spending the first increment deleting somebody else's mechanic.

Everything *around* the mechanic is done: you never hand-roll a score counter, a
lives bar, a timer, an end screen or a retry.

## Node map

| id | what |
| --- | --- |
| `game-root` | root; hosts `GameRules`; every HUD signal is emitted here |
| `game-background` | full-screen `ColorRect2D` (palette background) |
| `board` | the play field (`Group2D`) — **build your mechanic inside this** |
| `board-floor` | the field's visible plate; its rect is the field's extent |
| `hud` | `CanvasLayer2D` overlay, hosts `ScoreHud` |
| `score-label` / `time-label` / `lives-bar` | HUD widgets, signal-driven only |
| `result-overlay` / `result-dim` / `result-label` / `retry-button` | end screen, hidden until the run ends |

Signals on `game-root`: your mechanic emits `score-added` (amount) and
`life-lost` (amount); `GameRules` answers `score-changed`, `lives-changed`,
`time-changed`, and `game-won` / `game-lost`.

There is **one scene** (`scenes/main.pix3scene`) and no menu — see Extension
points if the game eventually needs one.

## Placeholders

**None.** This recipe ships no placeholder art, because it ships no entities to
put it on. Generate a sprite per entity as you introduce it (`generate_asset`),
or start with `ColorRect2D` blocks and replace them later — a mechanic is provable
with rectangles.

| role | file | node/prefab |
| --- | --- | --- |

## Tunables

```yaml
tunables:
  winMode: { node: game-root, component: "user:GameRules", property: winMode, default: score }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 10 }
  timeLimitSec: { node: game-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 0 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor: { node: game-background, property: color, default: "#12141c" }
  boardColor: { node: board-floor, property: color, default: "#1d212e" }
```

`component` present → `set_component_property`; absent → `set_property`. The
schema clamps out-of-range values rather than rejecting them.

`timeLimitSec: 0` means **no clock**: the run ends on the target score or on
running out of lives, and `time-label` counts elapsed seconds up. Set a limit and
it counts down and becomes a deadline (see `winMode`).

## Extension points

- **The mechanic.** Write a script under `scripts/`, attach it to a node inside
  `board`, and let it own input and movement. It scores through `GameRules` —
  either `node.emit('score-added', 1)` on `game-root`, or a direct
  `addScore(1)` / `loseLife()` / `finish(true)` on the component. Nothing else in
  the project needs to change for the HUD and the end screen to work.
- **Collision, when the mechanic needs it.** `core:Hitbox2D` gives overlap tests
  by group (axis-aligned — rotation is ignored). There is **no** rigidbody solver
  and **do not import rapier**: it is a ~2 MB wasm the export budget cannot carry.
  Grid games usually need no collision at all — compare cell coordinates.
- **Spawning.** `scene.instantiate` a prefab into a container node, `queueFree`
  it when it leaves the field, and add that container to `GameRules.freezeNodes`
  so it stops on game over. Give your spawner a `clear()` method and `resetRun()`
  will empty the field for you.
- **Juice.** `scene.juice.punchScale/shake/flash` and `scene.time.hitstop` are
  available from any script — call them on the frames where something lands.
- **A menu, later.** Create `scenes/menu.pix3scene` with a root carrying a script
  that calls `scene.changeScene('res://scenes/main.pix3scene', {transition: 'fade'})`
  on PLAY, then set Project Settings → Default Export Scene Path to it. Do this
  **after** the game is fun, never before: while iterating, the menu is a screen
  between you and the thing you are working on.

## Ending a run belongs to GameRules

The result overlay and RETRY are **owned by `GameRules`**: it hides the overlay on
start and keeps `retry-button` **disabled**, then `finish(won)` shows the overlay,
writes the result text, enables RETRY and freezes the `freezeNodes` nodes. For a
custom win/lose condition call `finish(true|false)` — do NOT show the overlay
yourself. A hand-rolled ending leaves RETRY on screen with its handler bound and
`enabled: false`, i.e. a button that can never be pressed (`game_observe` reports
`control: { enabled: false }`; that is the tell).

## Do not touch

- The node ids above (rename `name`, never `id`), and the signal names.
- `GameRules`' ownership of `result-overlay` and `retry-button`.
- Do not import rapier, and do not add a menu scene as part of an early increment.

## Verify

1. `play_start` on `scenes/main.pix3scene` — `game_observe` reports the snapshot
   with `phase: playing`, `score: 0`, `lives: 3`. That is the baseline, before any
   mechanic exists.
2. After the first mechanic increment, prove it by **state delta**, not by a
   screenshot: `game_input` the real input with `observe:` on the node that should
   react, and read `moved` / `activity` / the `game.changed` diff.
3. Scoring is proven the same way: one real input, then `score` up in the snapshot
   (and `score-label` reading `SCORE 1`).
4. `targetScore: 1`, replay, score once → `result-overlay` visible with `YOU WIN!`;
   `retry-button` (or the `restart` intent) starts a fresh run.
