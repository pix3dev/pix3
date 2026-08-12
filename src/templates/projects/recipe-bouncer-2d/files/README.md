# Bouncer 2D

A playable skeleton: a ball under gravity, three bumpers, a paddle you steer,
and a drain at the bottom that costs a life. It plays as shipped — press play in
`scenes/main.pix3scene` before changing anything.

**`design/recipe.md` is the contract.** Stable node ids, tunables with ranges,
extension points (including the full pinball path), and what must not be
renamed. Read it first.

## The physics is in this project, not in the engine

Pix3 ships **no rigidbody solver**, and `core:Hitbox2D` is an axis-aligned
overlap test that ignores rotation. Both are dead ends for a ball: a fast ball
would tunnel through a wall between two frames, and a tilted paddle cannot be
described by an axis-aligned box at all.

So `scripts/ball-collision.ts` implements swept (continuous) circle-vs-segment
and circle-vs-circle collision with fixed substeps — the ball's whole
displacement is tested each substep, so no speed can skip a wall — and
`scripts/BallBody.ts` builds the colliders every frame from the **live world
transforms** of ordinary marker nodes. Rotate `paddle` in the inspector, animate
it from a clip, or add flippers: the physics follows with no extra code.

Never `import` rapier here. It is a ~2 MB lazily-loaded wasm payload, it is not
needed for this, and it would blow the export budget.

## Layout

```
scenes/menu.pix3scene         entry / export scene
scenes/main.pix3scene         the GAME (editor startup scene — iterate here)
scripts/ball-collision.ts     pure swept-collision math (unit-tested)
scripts/BallBody.ts           ball motion; colliders from marker world transforms
scripts/PaddleController.ts   input → paddle             (swap this for flippers)
scripts/TouchRules.ts         ball-hit signals → score / damage
scripts/ScoreHud.ts           signals → HUD widgets
scripts/GameRules.ts          score / lives / win / lose / end flow
scripts/MenuFlow.ts           menu PLAY button
sprites/ph-*.png              near-white placeholders (tinted via core:tint)
```

Signals:

```
BallBody --ball-hit(kind,nodeId,speed,x,y)--> TouchRules
TouchRules --touch-scored/touch-damaged--> GameRules --score-changed--> ScoreHud
                                                     --lives-changed-->
```
