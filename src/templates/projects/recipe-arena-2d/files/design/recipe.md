# Recipe: recipe-arena-2d

## What this is

An avatar in a bounded field; two spawners drip things in; touching a thing
resolves through a group→outcome map into score or damage. Lives, timer,
win/lose screen with RETRY / MENU. Playable before any edit — start from what
runs. This is the **fallback recipe**: anything shaped like "steer something
around a space while stuff comes at you" starts here.

## Node map

| id | what |
| --- | --- |
| `game-root` | root; hosts `GameRules` + `TouchRules`; all HUD signals are emitted here |
| `game-background` | full-screen `ColorRect2D` (palette background) |
| `board` | the field (`Group2D`); its rect clamps the avatar |
| `board-floor` | the field's visible plate |
| `player` | avatar (`Sprite2D`), hosts `PlayerController` |
| `spawner-pickups` / `spawner-hazards` | spawn bands, one `Spawner` each |
| `hud` | `CanvasLayer2D` overlay, hosts `ScoreHud` |
| `score-label` / `time-label` / `lives-bar` | HUD widgets, signal-driven only |
| `menu-button` | back to the menu scene |
| `result-overlay` / `result-label` / `retry-button` | end screen, hidden until the run ends |

Signals: `TouchRules` emits `touch-scored` / `touch-damaged` on `game-root`;
`GameRules` answers `score-changed`, `lives-changed`, `time-changed`,
`game-won` / `game-lost`.

## Placeholders

Near-white PNGs carrying a `core:tint` effect: set `effects[0].params.color` and
the multiply gives you that palette colour.

| role | file | node/prefab |
| --- | --- | --- |
| avatar | `ph-avatar.png` | `player` |
| collectible | `ph-pickup.png` | `prefabs/pickup.pix3scene` |
| threat | `ph-hazard.png` | `prefabs/hazard.pix3scene` |

## Tunables

```yaml
tunables:
  playerMode: { node: player, component: "user:PlayerController", property: mode, default: pointer }
  playerSpeed: { node: player, component: "user:PlayerController", property: speed, min: 60, max: 2000, default: 620 }
  playerRadius: { node: player, component: "user:PlayerController", property: radius, min: 4, max: 400, default: 60 }
  pickupRate: { node: spawner-pickups, component: "user:Spawner", property: intervalSec, min: 0.05, max: 20, default: 1.0 }
  pickupMaxAlive: { node: spawner-pickups, component: "user:Spawner", property: maxAlive, min: 1, max: 200, default: 10 }
  pickupFallSpeed: { node: spawner-pickups, component: "user:Spawner", property: driftY, min: -3000, max: 3000, default: -300 }
  hazardRate: { node: spawner-hazards, component: "user:Spawner", property: intervalSec, min: 0.05, max: 20, default: 1.8 }
  hazardFallSpeed: { node: spawner-hazards, component: "user:Spawner", property: driftY, min: -3000, max: 3000, default: -380 }
  touchRadius: { node: game-root, component: "user:TouchRules", property: touchRadius, min: 4, max: 600, default: 62 }
  touchRules: { node: game-root, component: "user:TouchRules", property: rules, default: "pickup:score:1;hazard:damage:1" }
  winMode: { node: game-root, component: "user:GameRules", property: winMode, default: score }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 999, default: 12 }
  timeLimitSec: { node: game-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 45 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor: { node: game-background, property: color, default: "#141a2e" }
  boardColor: { node: board-floor, property: color, default: "#1d2743" }
```

`component` present → `set_component_property`; absent → `set_property`. The
schema clamps out-of-range values rather than rejecting them.

## Extension points

- **Different locomotion → replace `scripts/PlayerController.ts` wholesale.** It
  is the only file that reads input and writes `player.position`. A grid stepper,
  a jumper (velocity + gravity) or an auto-runner all drop in as long as the file
  still exports a `PlayerController` class and keeps the node inside `board`.
- **Trail / body behind the avatar.** Add a `segment` prefab (`Sprite2D` +
  `core:Hitbox2D` in a hazard group). In the locomotion script, on each completed
  step `scene.instantiate` a segment at the vacated position into a `segments`
  node and `queueFree` the tail once the trail exceeds its length. Self-collision
  then falls out of the existing rules — the segment's group is already in
  `touchRules`, so hitting your own trail costs a life with no new code. Grow the
  trail by skipping the tail free on a `touch-scored` frame.
- **A third kind of thing.** Copy a prefab, give its `core:Hitbox2D` a new group,
  `create_node` + `add_component` a third `Spawner`, append `<group>:score:5` to
  `touchRules`. Chasers: a script on the prefab that steers toward `player`'s
  world position — contact is already punished.
- **More juice.** `scene.juice.punchScale/shake/flash` + `scene.time.hitstop` are
  already called in `TouchRules`; raise the numbers there.

## Do not touch

- The node ids above (rename `name`, never `id`), and the signal names.
- Component config on a **prefab instance** — the editor locks it. Prefabs carry
  fixed defaults only (their hitbox group); tunables live on plain nodes in
  `main.pix3scene`.
- Do not import rapier: there is no rigidbody solver here and none is needed.

## Verify

1. `play_start` on `scenes/main.pix3scene`.
2. `game_input` a pointer drag across the lower board — `player`'s position
   changes between two `game_observe` calls.
3. After ~3 s: children exist under `spawner-pickups`, and `score-label` climbs
   above `SCORE 0` once the avatar meets one.
4. Set `targetScore: 1`, replay, collect one → `result-overlay` visible with
   `YOU WIN!`; `retry-button` restarts the scene.
