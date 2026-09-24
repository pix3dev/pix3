# Carrom

A carrom prototype on the Pix3 engine: a 1000 px board, a heavy striker, the
real turn structure (continuation on your own pot, Queen-and-cover, striker
fouls with a penalty man) and an AI opponent.

Build spec: `.plans/done/carrom-prototype.md`. This README covers what is here now and
how to drive it.

## Status

Milestones **M0 – M5** are implemented: skeleton, board + striker, rack +
pockets, rules + turn loop + HUD, the AI opponent, and the feel pass. You play
white against `user:CarromAI` as black. `ai.toggle {enabled: false}` turns the
game into hot-seat; `autoplay {enabled: true}` hands both colours to the AI.

Not done: **M6 (optional)** — the generated wood-frame overlay and the
single-file HTML export size check.

## Layout

```
scenes/main.pix3scene     the board, the striker, the aim guide and the HUD
scenes/man-white.pix3scene
scenes/man-black.pix3scene
scenes/queen.pix3scene    one-root prefabs, spawned into Board/Pieces
scripts/carrom-geometry.ts  all constants + the pure helpers (no Script here)
scripts/GameController.ts   state machine, rules, pockets, AI turn, commands, debug provider
scripts/ShotInput.ts        the human gesture (slide to place, pull back to aim)
scripts/AimGuide.ts         first-contact preview (dots, rubber band, ghost, deflection)
scripts/CarromAI.ts         the opponent's shot search
scripts/Disc.ts             piece identity + contact SFX
scripts/StrikerTrail.ts     ghost trail on a fast striker
sprites/                    baked art; board.jpg is 1600x1600 for a 1000x1000 Sprite2D
design/                     the offline page that bakes the art
```

`scripts/carrom-geometry.ts` is the single source of truth for every number. The
board art is baked from the same constants, so **if a sprite looks misaligned the
code is wrong, not the art** — do not nudge positions to make them fit.

## How to play

- Drag the striker sideways along its baseline to place it (±240 px).
- Pull back from anywhere inside the board and release to shoot. Power is the
  pull length; the bar and the guide colour show it.
- The guide stops at the first thing the striker will actually hit, draws a
  ghost striker there and a short deflection arrow off the struck man.
- Shots are clamped to a forward cone, so you cannot shoot backwards.

## Rules in force

| Event on a strike | Outcome |
| --- | --- |
| Own man pocketed, no foul | Credited; you keep the turn. |
| Nothing pocketed | Turn passes. Not a foul. |
| Opponent's man pocketed | Credited to the opponent; turn passes. |
| Striker pocketed | Everything pocketed this strike returns to the centre, plus one man of your colour (or a "due" if you have none banked). Turn passes. |
| Queen + own man, same strike | Queen covered; turn continues. |
| Queen alone | You keep the turn and must pocket an own man on the very next strike, or she goes back to the centre and the turn passes. |
| Own last man while the Queen is uncovered | The man goes back to the centre; turn passes. |

**Win:** first player with all 9 men pocketed *after* the Queen has been covered.
Score = opponent's men left on the board, +3 if the winner covered the Queen.

Deliberately cut for the prototype: the "pocket a man before the Queen counts"
rule, thumb and back shots, the striker-crosses-the-front-line rule, the 29-point
match, break re-tries, and pieces landing on top of each other.

## Driving it without gestures

Everything is reachable through `scene.commands`, and the game registers a
`registerGameDebug` provider (`window.__PIX3_GAME_DEBUG__`) whose `actions()` and
`action()` forward to that registry.

| Command | Arguments | Effect |
| --- | --- | --- |
| `restart` | — | Fresh rack, zeroed score, white to break. |
| `shoot` | `{ angleDeg, power }` | Launch the striker. 90° is straight up; power is 0..1. Refused outside the forward cone or below 0.08 power. |
| `place-striker` | `{ x }` | Slide the striker along the shooter's line (clamped to ±240). |
| `settle` | — | Force every disc to a dead stop and resolve the strike now. |
| `layout` | `{ discs, striker?, shooter?, pocketed?, queen? }` | Clear the board and place exactly these pieces — the rule-test harness. Always leaves the game in `AIM`, so the next strike is yours to `shoot` even when the shooter is the AI. |
| `ai.toggle` | `{ enabled }` | Turn the AI opponent on or off. Off is hot-seat. Omitting `enabled` keeps the current value. |
| `autoplay` | `{ enabled }` | Let the AI play both colours, for soak runs. Omitting `enabled` flips it. |

`layout`'s `pocketed` (`{white, black}`) and `queen`
(`board` / `pending-cover:<colour>` / `covered:<colour>`) are extensions beyond
the spec's shape: without them the win condition and the cover rules cannot be
reached from a single `layout` call.

The snapshot is documented in `GameController.snapshot()`; the fields are
`state`, `shooter`, `whiteLeftOnBoard`, `blackLeftOnBoard`, `whitePocketed`,
`blackPocketed`, `due`, `queen`, `discs[]`, `striker`, `lastStrike`,
`kineticEnergy`, `timeScale`, `settleTimerSec`, plus `aiEnabled`, `autoplay`,
`aiDifficulty`, `aiThinkElapsedSec`, `winner`, `score` and `pockets`.

## The AI

`user:CarromAI` searches nine striker placements × its own men (plus the Queen
once it has one banked) × four pockets, using the **same** circle sweep the aim
guide draws — so it cannot see a line the guide calls blocked. It scores the cut
angle squared against the length of the pot, then adds aim noise scaled by
`aiDifficulty`: difficulty is accuracy only, never knowledge, so a weak AI picks
the shot a good one would and misses it.

Three layers stop it stalling the turn loop, because a hung turn is the one
failure that makes the prototype unplayable rather than merely weak:

1. `CarromAI.pickShot` always returns something — with no pot available it aims
   at the nearest own man **in front of** its baseline, which guarantees contact.
2. `GameController.computeAiShot` catches a throw and sanitizes the result
   (finite numbers, unit direction, cone-clamped, legal power).
3. `AI_THINK` leaves on either the think delay or a hard 600-frame cap, and
   `fireAiShot` falls through chosen shot → straight-ahead rescue → passing the
   turn outright. It can never sit.

## Engine notes worth knowing before editing

- **Cloth drag is script-side.** `core:PhysicsBody2D` only has exponential
  `linearDamping`; a carrom board needs constant deceleration, so
  `GameController.applyClothDrag` bleeds 220 px/s² off every moving disc and
  snaps the last 6 px/s to zero. It only touches bodies that are actually
  moving — `setVelocity` wakes a body, so an unconditional call would keep the
  whole board awake forever.
- **Pockets are a distance check, not sensors.** A circle sensor is overlap
  based and would swallow a disc that merely grazed the mouth.
- **Restitution is one number.** The solver combines it as `max`, so a cushion
  cannot be less bouncy than the discs.
- **The striker is the only `bullet` body.** CCD sweeps against static geometry
  only, which is why the launch speed is capped at 2200 px/s.
- **Containers are `Group2D`, not `Node2D`.** A plain `Node2D` is *saved* with a
  `transform:` block but *loaded* from flat `position:` — a save/load round trip
  would silently drop its position. `Group2D` reads `transform:`.
- **`strikerLineY()` is the opposite sign to `forwardSign()`.** White sits at
  y = −346 and shoots +y; black sits at +346 and shoots −y. Deriving the
  baseline from the shot direction puts each striker on the other player's line,
  and every shot then fires off the board. It is a one-character mistake with no
  compile-time signal, which is why the function spells both cases out.
