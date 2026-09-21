# Recipe: recipe-blank-2d

## What this is

**Nothing plays yet, on purpose.** A bounded field, a HUD, and score / lives /
timer / win-lose bookkeeping that already works — and no mechanic of any kind,
including controls.

Pick this recipe when the idea's core loop is not what another recipe ships:
grid or turn-based movement (snake, sokoban, match-3), word / card / board games,
builders, idle games without a ball. **Your first increment is the core
mechanic itself, controls included** — that is the trade being made here, and it
beats spending the first increment deleting somebody else's mechanic. (A ball
that falls and bounces off things — pinball, plinko, peggle, idle-pinball — is
the bouncer recipe's job, even when the paddle goes.)

Everything *around* the mechanic is done: you never hand-roll a score counter, a
lives bar, a timer, an end screen or a retry. The look is done too: `post-fx`
blooms anything bright and `bg-glow` lights the field, so a sprite tinted with a
palette accent already glows on the first frame.

## Node map

| id | what |
| --- | --- |
| `post-fx` | `PostProcess` (`affect2D`): bloom + vignette — tune, never delete |
| `game-root` | root; hosts `GameRules`; every HUD signal is emitted here |
| `game-background` | full-screen `ColorRect2D` (palette background) |
| `bg-glow` | full-screen `Sprite2D`, the tinted radial gradient over it |
| `board` | the play field (`Group2D`) — **build your mechanic inside this** |
| `board-floor` | the field's visible plate; its rect is the field's extent |
| `hud` | `CanvasLayer2D` overlay, hosts `ScoreHud` |
| `score-label` / `time-label` / `lives-bar` | HUD widgets, signal-driven only |
| `result-overlay` / `result-dim` / `result-label` / `retry-button` | end screen, own file `scenes/ui/result.pix3scene`; instanced into main with `visible: false` (editor-only hide — `GameRules` shows it) |

Signals on `game-root`: your mechanic emits `score-added` (amount) and
`life-lost` (amount); `GameRules` answers `score-changed`, `lives-changed`,
`time-changed`, and `game-won` / `game-lost`.

There is **one gameplay scene** (`scenes/main.pix3scene`) and no menu — see
Extension points if the game eventually needs one.

## Placeholders

A **shape library**, not entities: near-white PNGs already tinted with the
palette at T0 (the role column decides the colour). Put them on a `Sprite2D`
sized to the thing they stand for, and recolour with `effects: [{type: core:tint,
params: {color}}]` when you need another accent. **A round thing is
`ph-circle`/`ph-orb`, a coin or bumper is `ph-ring`, a bar or paddle is
`ph-capsule`, a spark or star is `ph-star`.** A `ColorRect2D` is for panels,
floors and bars — never for a ball, a coin, an enemy or anything the player
looks at: a square ball on the first frame is what the user remembers. Real art
replaces these through `generate_asset` in the art pass.

| role | file | node/prefab |
| --- | --- | --- |
| background | `sprites/ph-bg.png` | `bg-glow` (radial gradient) |
| player | `sprites/ph-circle.png` | (library — a solid disc with a soft edge) |
| avatar | `sprites/ph-orb.png` | (library — a disc with a bright rim) |
| collectible | `sprites/ph-ring.png` | (library — a ring; bumpers, coins, targets) |
| hazard | `sprites/ph-star.png` | (library — a four-point spark) |
| ui | `sprites/ph-capsule.png` | (library — a rounded bar; paddles, platforms, pills) |

## Tunables

```yaml
tunables:
  winMode: { node: game-root, component: "user:GameRules", property: winMode, default: score }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 10 }
  timeLimitSec: { node: game-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 0 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor: { node: game-background, property: color, default: "#12141c" }
  boardColor: { node: board-floor, property: color, default: "#1d212e" }
  bloomIntensity: { node: post-fx, property: bloomIntensity, min: 0, max: 3, default: 0.8 }
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
- **Collision, when the mechanic needs it.** Three tiers, cheapest first. Overlap
  queries with no response: `scene.collision2d` + `core:Hitbox2D` (axis-aligned).
  Bouncing, pushing, gravity, sensors: the engine's own 2D rigid-body solver —
  `core:PhysicsBody2D` + `core:Collider2D` on the same node (a `core:Collider2D`
  alone is static world geometry), `scene.physics2d.getBody(node)` for
  `applyImpulse` / `setVelocity` / `teleport`, `setGravity(0, 0)` for top-down.
  **Never hand-write a 2D solver, and do not import rapier** (3D only, ~2 MB wasm).
  Grid games usually need no collision at all — compare cell coordinates.
- **Spawning.** `scene.instantiate` a prefab into a container node, `queueFree`
  it when it leaves the field, and add that container to `GameRules.freezeNodes`
  so it stops on game over. Give your spawner a `clear()` method and `resetRun()`
  will empty the field for you.
- **Juice is one-liners — add it WITH the mechanic, never as a later pass.**
  `scene.juice.burst({x, y})`, `floatText('+5', {at: node})`, `punchScale` /
  `shake` / `flash`, `scene.audio.sfx('score')`, `scene.time.hitstop(50)` on a
  contact START; `scene.juice.trail(ball)` for a light streak; `scene.tween.to(node,
  {scale: 1.2}, {durationSec: 0.15, yoyo: true, repeat: 1})` / `crossFade(a, b)` for any
  motion or panel switch instead of hand-lerping. Bright sprites bloom through `post-fx`
  by themselves.
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
- `post-fx`: keep the id and `affect2D: true` — without it a 2D scene gets no
  bloom. Tune the values, don't delete the node.
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
