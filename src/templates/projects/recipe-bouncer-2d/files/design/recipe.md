# Recipe: recipe-bouncer-2d

## What this is

A ball under gravity bounces off walls, bumpers and a paddle you steer; hits score, the
bottom drain costs a life. Playable, neon-lit and audible before any edit.

Physics lives in the project: `BallBody` runs the swept solver (`ball-collision.ts`)
over colliders rebuilt each frame from the marker nodes' **live world transforms**, so
a rotated flipper works for free. No rigidbody engine, no `core:Hitbox2D`, no rapier.

The look: `PostProcess` (bloom + vignette) over bright accents, a tinted gradient
sprite behind the board, `Label2D` glow on the HUD (drawn after post — it glows on
canvas, never blooms).

## Node map

| id | what |
| --- | --- |
| `post-fx` | `PostProcess` (`affect2D`): bloom + vignette |
| `game-root` | root; hosts `GameRules` + `TouchRules`; emits the HUD signals |
| `game-background` | full-screen `ColorRect2D`, the darkest colour |
| `bg-glow` | full-screen `Sprite2D`, the tinted gradient over it |
| `board` | playfield `Group2D`; clamps the paddle |
| `board-floor` | the plate, translucent so the glow shows through |
| `board-trim` | `trim-left`/`-right`/`-top` + `trim-drain`: DECOR, not colliders |
| `walls` → `wall-left`/`-right`/`-top` | box colliders, kind `wall` |
| `bumpers` → `bumper-a`/`-b`/`-c` | circle colliders, kind `bumper`; each a `Group2D` of `*-halo` + `*-core` rings |
| `paddles` → `paddle` | box collider, kind `paddle`; `PaddleController` |
| `drain` | trigger box, kind `drain` — entering it loses a ball |
| `ball` | hosts `BallBody` |
| `hud` | `CanvasLayer2D` + `ScoreHud`: `score-label`, `time-label`, `lives-bar`, `menu-button` |
| `result-overlay` / `result-label` / `retry-button` | end screen, hidden until a run ends |

`menu.pix3scene`: `menu-post-fx`, `menu-root`, `menu-background`, `menu-bg-glow`,
`title-label` (title patched in), `title-rule`, `subtitle-label`, `play-button`.

Parenting adds geometry: under `walls`/`paddles` a node is an oriented box, under
`bumpers` a circle.

Signals: `ball` emits `ball-hit` (kind, nodeId, speed, x, y — world) and `ball-drained`;
`TouchRules` re-emits `touch-scored` / `touch-damaged` on `game-root`, where `GameRules`
answers `score-changed`, `lives-changed`, `time-changed`, `game-won` / `game-lost`.

## Placeholders

Near-white PNGs carrying a `core:tint`: set `effects[0].params.color`.

| role | file | node |
| --- | --- | --- |
| background | `sprites/ph-bg.png` | `bg-glow`, `menu-bg-glow` (radial gradient) |
| avatar | `sprites/ph-ball.png` | `ball` |
| player | `sprites/ph-paddle.png` | `paddle` |
| collectible | `sprites/ph-bumper.png` | `bumper-*-core` / `*-halo` (a ring) |

## Tunables

```yaml
tunables:
  gravity: { node: ball, component: "user:BallBody", property: gravity }
  maxSpeed: { node: ball, component: "user:BallBody", property: maxSpeed }
  minSpeed: { node: ball, component: "user:BallBody", property: minSpeed }
  ballRadius: { node: ball, component: "user:BallBody", property: radius }
  launchSpeed: { node: ball, component: "user:BallBody", property: launchSpeed }
  launchAngleDeg: { node: ball, component: "user:BallBody", property: launchAngleDeg }
  wallBounce: { node: ball, component: "user:BallBody", property: wallRestitution }
  paddleBounce: { node: ball, component: "user:BallBody", property: paddleRestitution }
  bumperBounce: { node: ball, component: "user:BallBody", property: bumperRestitution }
  paddleMode: { node: paddle, component: "user:PaddleController", property: mode, default: pointer }
  paddleSpeed: { node: paddle, component: "user:PaddleController", property: speed }
  paddleHalfWidth: { node: paddle, component: "user:PaddleController", property: halfWidth }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives }
  touchRules: { node: game-root, component: "user:TouchRules", property: rules, default: "bumper:score:100;paddle:score:10;drain:damage:1" }
  punchAmount: { node: game-root, component: "user:TouchRules", property: punchAmount }
  hitstopMs: { node: game-root, component: "user:TouchRules", property: hitstopMs }
  burstCount: { node: game-root, component: "user:TouchRules", property: burstCount }
  sfxEnabled: { node: game-root, component: "user:TouchRules", property: sfxEnabled }
  bgColor: { node: game-background, property: color, default: "#05030f" }
  boardColor: { node: board-floor, property: color, default: "#120a33" }
  bloomIntensity: { node: post-fx, property: bloomIntensity, min: 0, max: 3, default: 0.9 }
  menuBloomIntensity: { node: menu-post-fx, property: bloomIntensity, min: 0, max: 3, default: 0.7 }
```

`component` present → `set_component_property`, absent → `set_property`. Current values
live in the scene; each script's schema clamps on write. Bloom lifts only what is
*already* bright — brighten the colour or lower `bloomThreshold` (0.58), don't raise
intensity.

## Extension points

- **Pinball flippers.** Two oriented boxes under `paddles` (`flipper-left`,
  `flipper-right`) pivoted at their inner ends; swap `PaddleController` for a flipper
  script: holding `Key_ArrowLeft`/`Key_ArrowRight` lerps `rotation.z` −25° → +35° in
  ~0.06 s, release lerps back.
- **Juice is one-liners — add it WITH the mechanic, never as a later pass.**
  `scene.audio.sfx('score')`, `scene.juice.burst({x, y})`,
  `floatText('+100', { at: node })`, `punchScale`/`shake`/`flash`,
  `scene.time.hitstop(50)` (on contact START, not every frame),
  `core:BurstOnSignal`/`core:SfxOnSignal`. `TouchRules` already calls them on
  contact — copy the line next to your mechanic, in board space.
- **More bumpers.** Duplicate a `bumpers` child (radius = width/2 × world scale) —
  punch, particles and score already ride `ball-hit`.
- **Brick field (arkanoid).** Bricks under `walls` with ids `brick-*`; in `TouchRules`
  `queueFree` the hit node when `kind === 'wall'` and the id matches.

Replacing a script named above is expected — `fs_write` with `overwrite: true` + `reason`.

## Do not touch

- **Ending a run is `GameRules`' job**: `finish(won)` shows `result-overlay`, plays the
  jingle, enables the initially-disabled `retry-button` and freezes gameplay. Call it
  for custom endings — showing the overlay yourself leaves RETRY unpressable.
- The node ids above (rename `name`, never `id`), and the signal names.
- The collider grouping: `walls`/`paddles` children are boxes, `bumpers` children
  circles, `drain` a trigger. Moving a node between them changes its physics, and a
  decoration dropped into one becomes a collider.
- `post-fx` / `menu-post-fx`: keep the ids and `affect2D: true` — without it a 2D-only
  scene gets no effects. Tune the values, don't delete the nodes.
- No `core:Hitbox2D` on the ball or walls (axis-aligned overlap would disagree with the
  swept solver), and no rapier.

## Verify

1. `play_start` on `scenes/main.pix3scene`.
2. `game_observe` twice ~0.5 s apart: `ball` moves and stays inside the board
   (|x| < 470, y > −800 board space).
3. **The core promise: the defender keeps the ball in play.** Whatever guards the
   drain (paddle, flippers, …) must cover or funnel every downward path, never let the
   ball round its open sides. Prove a save with `game_input`: a driven run outlives an
   unattended one, and an unattended one survives several seconds (the stage idles
   between turns, so a board that loses itself instantly reads as broken).
4. Let the ball drain: `lives-bar` drops one and it relaunches after `resetDelaySec`;
   three drains → `result-overlay` with `GAME OVER`.
