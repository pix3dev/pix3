# Recipe: recipe-bouncer-2d

## What this is

A ball under gravity bounces off walls, bumpers and a paddle you steer; hits
score, the bottom drain costs a life. Playable before any edit.

The physics lives in the project, not the engine: the engine has no rigidbody
solver and `core:Hitbox2D` is axis-aligned (rotation ignored). `ball-collision.ts`
does swept circle-vs-segment / circle-vs-circle with fixed substeps, and
`BallBody` rebuilds colliders each frame from the marker nodes' **live world
transforms** — so a rotated paddle or a flipper works for free. Never import
rapier.

## Node map

| id | what |
| --- | --- |
| `game-root` | root; hosts `GameRules` + `TouchRules`; all HUD signals emitted here |
| `game-background` | full-screen `ColorRect2D` (palette background) |
| `board` | the playfield (`Group2D`); clamps the paddle |
| `board-floor` | the playfield's visible plate |
| `walls` → `wall-left` / `wall-right` / `wall-top` | oriented-box colliders, kind `wall` |
| `bumpers` → `bumper-a` / `bumper-b` / `bumper-c` | circle colliders, kind `bumper` |
| `paddles` → `paddle` | oriented-box collider, kind `paddle`; hosts `PaddleController` |
| `drain` | trigger box at the bottom, kind `drain` — entering it loses a ball |
| `ball` | hosts `BallBody` |
| `hud` | `CanvasLayer2D` overlay, hosts `ScoreHud` |
| `score-label` / `time-label` / `lives-bar` / `menu-button` | HUD |
| `result-overlay` / `result-label` / `retry-button` | end screen, hidden until the run ends |

Anything parented under `walls` / `paddles` becomes an oriented box collider and
anything under `bumpers` becomes a circle — that is how you add geometry.

Signals: `BallBody` emits `ball-hit` (kind, nodeId, speed, x, y) and
`ball-drained` on `ball`; `TouchRules` turns those into `touch-scored` /
`touch-damaged` on `game-root`; `GameRules` answers `score-changed`,
`lives-changed`, `time-changed`, `game-won` / `game-lost`.

## Placeholders

Near-white PNGs carrying a `core:tint` effect: set `effects[0].params.color` and
the multiply gives you that palette colour.

| role | file | node |
| --- | --- | --- |
| avatar | `sprites/ph-ball.png` | `ball` (the ball is what the run is about) |
| player | `sprites/ph-paddle.png` | `paddle` |
| collectible | `sprites/ph-bumper.png` | `bumper-a` / `bumper-b` / `bumper-c` |

## Tunables

```yaml
tunables:
  gravity: { node: ball, component: "user:BallBody", property: gravity, min: -12000, max: 12000, default: -1600 }
  maxSpeed: { node: ball, component: "user:BallBody", property: maxSpeed, min: 100, max: 12000, default: 1900 }
  minSpeed: { node: ball, component: "user:BallBody", property: minSpeed, min: 0, max: 4000, default: 380 }
  ballRadius: { node: ball, component: "user:BallBody", property: radius, min: 2, max: 400, default: 30 }
  launchSpeed: { node: ball, component: "user:BallBody", property: launchSpeed, min: 0, max: 6000, default: 900 }
  launchAngleDeg: { node: ball, component: "user:BallBody", property: launchAngleDeg, min: 5, max: 175, default: 72 }
  wallBounce: { node: ball, component: "user:BallBody", property: wallRestitution, min: 0, max: 2, default: 1 }
  paddleBounce: { node: ball, component: "user:BallBody", property: paddleRestitution, min: 0, max: 2, default: 1.05 }
  bumperBounce: { node: ball, component: "user:BallBody", property: bumperRestitution, min: 0, max: 3, default: 1.3 }
  substeps: { node: ball, component: "user:BallBody", property: substeps, min: 1, max: 16, default: 4 }
  paddleMode: { node: paddle, component: "user:PaddleController", property: mode, default: pointer }
  paddleSpeed: { node: paddle, component: "user:PaddleController", property: speed, min: 100, max: 6000, default: 1800 }
  paddleHalfWidth: { node: paddle, component: "user:PaddleController", property: halfWidth, min: 10, max: 800, default: 150 }
  touchRules: { node: game-root, component: "user:TouchRules", property: rules, default: "bumper:score:100;paddle:score:10;drain:damage:1" }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 1500 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor: { node: game-background, property: color, default: "#141a2e" }
  boardColor: { node: board-floor, property: color, default: "#1d2743" }
```

`component` present → `set_component_property`; absent → `set_property`. The
schema clamps out-of-range values rather than rejecting them.

## Extension points

- **Pinball flippers.** Add two nodes under `paddles` (`flipper-left`,
  `flipper-right`), each an oriented box pivoted at its inner end, and replace
  `PaddleController` with a flipper script: hold `Key_ArrowLeft` /
  `Key_ArrowRight` → lerp `rotation.z` from a rest angle (say −25°) to a flick
  angle (+35°) in ~0.06 s, release → lerp back. Nothing else changes: `BallBody`
  re-reads their world transforms every frame, so the swept solver bounces off
  the rotated box, and the impact normal is the flipper's real face.
- **More bumpers.** Duplicate a `bumpers` child. Circle radius = its width/2 ×
  world scale. `bumperBounce > 1` adds energy on contact; the punch-scale and the
  score already fire through the existing `ball-hit` signal, so a new bumper needs
  no code at all.
- **A plunger.** One tunable: raise `launchSpeed` (and `launchAngleDeg` toward 90)
  and call `BallBody.launch()` from your own button handler instead of on start.
- **Brick field (arkanoid).** Put brick nodes under `walls`, give each a distinct
  id, and in `TouchRules` `queueFree` the hit node when `kind === 'wall'` and the
  id starts with `brick-`.
- **Ball trails / juice.** `scene.juice.punchScale` is already called on whatever
  is hit; add `scene.time.hitstop(60)` next to it for weight.

Replacing a whole script the list above names is expected: use `fs_write` with
`overwrite: true` and a short `reason` (the size guard only blocks *silent*
wholesale rewrites).

## Do not touch

- The node ids above (rename `name`, never `id`), and the signal names.
- The collider grouping: `walls` / `paddles` children are boxes, `bumpers`
  children are circles, `drain` is a trigger. Moving a node between them changes
  its physics.
- Do not add `core:Hitbox2D` to the ball or the walls — it is an axis-aligned
  overlap test and would disagree with the swept solver.
- Do not import rapier.

## Verify

1. `play_start` on `scenes/main.pix3scene`.
2. `game_observe` twice ~0.5 s apart: `ball`'s position changes and stays inside
   the board (|x| < 470, y > −800 in board space).
3. `game_input` a pointer move along the bottom — `paddle` x follows it, and the
   ball bounces off it instead of passing through.
4. Let the ball drain: `lives-bar` drops by one and the ball relaunches after
   `resetDelaySec`. Three drains → `result-overlay` with `GAME OVER`.
