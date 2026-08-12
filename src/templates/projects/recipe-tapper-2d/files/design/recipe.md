# Recipe: recipe-tapper-2d

## What this is

Objects fall into a field; tapping them is the whole game. One "bad" type
punishes instead of scoring. A countdown ends the run and a target score decides
win or lose. Playable before any edit.

Same script names and roles as the other recipes — `Spawner`, `TouchRules`,
`ScoreHud`, `GameRules` — so what you learn here transfers.

## Node map

| id | what |
| --- | --- |
| `game-root` | root; hosts `GameRules` + `TouchRules`; all HUD signals emitted here |
| `game-background` | full-screen `ColorRect2D` (palette background) |
| `board` | the field (`Group2D`) |
| `board-floor` | the field's visible plate |
| `spawner-targets` | spawn band for tappable things; hosts `Spawner` |
| `spawner-hazards` | spawn band for the bad type; hosts `Spawner` |
| `hud` | `CanvasLayer2D` overlay, hosts `ScoreHud` |
| `score-label` / `time-label` / `lives-bar` / `menu-button` | HUD |
| `result-overlay` / `result-label` / `retry-button` | end screen, hidden until the run ends |

Signals: `TouchRules` emits `touch-scored` / `touch-damaged` on `game-root`;
`GameRules` answers `score-changed`, `lives-changed`, `time-changed`,
`game-won` / `game-lost`.

## Placeholders

Near-white PNGs carrying a `core:tint` effect: set `effects[0].params.color` and
the multiply gives you that palette colour.

| role | file | node/prefab |
| --- | --- | --- |
| collectible | `sprites/ph-target.png` | `prefabs/target.pix3scene` |
| threat | `sprites/ph-hazard.png` | `prefabs/hazard.pix3scene` |

## Tunables

```yaml
tunables:
  targetRate: { node: spawner-targets, component: "user:Spawner", property: intervalSec, min: 0.05, max: 20, default: 0.85 }
  targetMaxAlive: { node: spawner-targets, component: "user:Spawner", property: maxAlive, min: 1, max: 200, default: 8 }
  targetFallSpeed: { node: spawner-targets, component: "user:Spawner", property: driftY, min: -3000, max: 3000, default: -230 }
  targetLifetime: { node: spawner-targets, component: "user:Spawner", property: lifetimeSec, min: 0, max: 120, default: 8 }
  hazardRate: { node: spawner-hazards, component: "user:Spawner", property: intervalSec, min: 0.05, max: 20, default: 2.2 }
  hazardFallSpeed: { node: spawner-hazards, component: "user:Spawner", property: driftY, min: -3000, max: 3000, default: -260 }
  tapRadius: { node: game-root, component: "user:TouchRules", property: tapRadius, min: 0, max: 400, default: 40 }
  missPenalty: { node: game-root, component: "user:TouchRules", property: missPenalty, min: 0, max: 10, default: 0 }
  touchRules: { node: game-root, component: "user:TouchRules", property: rules, default: "target:score:1;hazard:damage:1" }
  winMode: { node: game-root, component: "user:GameRules", property: winMode, default: time }
  targetScore: { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 18 }
  timeLimitSec: { node: game-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 30 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor: { node: game-background, property: color, default: "#141a2e" }
  boardColor: { node: board-floor, property: color, default: "#1d2743" }
```

`component` present → `set_component_property`; absent → `set_property`. The
schema clamps out-of-range values rather than rejecting them.

## Extension points

- **Popping instead of falling (whack-a-mole).** Set `targetFallSpeed: 0` and
  `targetLifetime` to ~1.2 s: things appear in place and vanish if not tapped.
  Set `gridSnap` on the spawner (e.g. 220) and raise `spawnHeight` to get a mole
  grid instead of a band.
- **Combos / multipliers.** A new script on `hud` that listens for
  `touch-scored` on `game-root`, counts hits inside a time window and re-emits
  `touch-scored` with a bigger amount. `GameRules` needs no change.
- **A third type.** Copy a prefab, give its `core:Hitbox2D` a new group, add a
  node with a third `Spawner` (`create_node` + `add_component`), and append
  `<group>:score:5` to `touchRules`.
- **Punish misses.** Raise `missPenalty` — a tap that hits nothing then costs a
  life, which turns a relaxed collector into a precision game.
- **Sudden death.** `startingLives: 1`, or `winMode: survive` with a longer
  `timeLimitSec` so surviving the clock is the win.

Replacing a whole script the list above names is expected: use `fs_write` with
`overwrite: true` and a short `reason` (the size guard only blocks *silent*
wholesale rewrites).

## Do not touch

- The node ids above (rename `name`, never `id`), and the signal names.
- Component config on a **prefab instance** — the editor locks it. Prefabs carry
  fixed defaults only (their hitbox group); tunables live on plain nodes in
  `main.pix3scene`.
- The prefab hitbox groups must stay in sync with `touchRules`; the group is the
  only thing that separates "good" from "bad".

## Verify

1. `play_start` on `scenes/main.pix3scene`.
2. After ~2 s, children exist under `spawner-targets` and are falling.
3. `game_input` a tap on one of them → it disappears, `score-label` climbs, and
   the punch-scale fires.
4. Tap three hazards → `lives-bar` empties and `result-overlay` shows
   `GAME OVER`; `retry-button` restarts the scene.
