# Bouncer 2D

A playable skeleton: a ball under gravity, three bumpers, a paddle you steer,
and a drain at the bottom that costs a life. It plays — and glows, pops and
clicks — as shipped: press play in `scenes/main.pix3scene` before changing
anything.

**`design/recipe.md` is the contract.** Stable node ids, tunables with ranges,
extension points (including the full pinball path), and what must not be
renamed. Read it first.

## The ball physics is in this project, by choice

`scripts/ball-collision.ts` implements swept (continuous) circle-vs-segment and
circle-vs-circle collision with fixed substeps — the ball's whole displacement
is tested each substep, so no speed can skip a wall — and `scripts/BallBody.ts`
builds the colliders every frame from the **live world transforms** of ordinary
marker nodes. Rotate `paddle` in the inspector, animate it from a clip, or add
flippers: the physics follows with no extra code. `core:Hitbox2D` is an
axis-aligned overlap test that ignores rotation — never put it on the ball.

The engine also ships a general 2D rigid-body solver (`core:PhysicsBody2D` +
`core:Collider2D`, `scene.physics2d`) — reach for it when the game grows bodies
that push each other (stacks, debris, several balls); one ball against static
geometry is exactly what the swept solver here is for, and mixing the two on the
same ball is a bug.

Never `import` rapier here. It is a ~2 MB lazily-loaded wasm payload for 3D
only, it is not needed for this, and it would blow the export budget.

**Idle / builder variant (idle-pinball, plinko-tycoon):** the drain does not
have to cost a life. Set `startingLives` high or make the drain relaunch the ball
(`BallBody.resetBall()` after `ball-drained`) — a conveyor returning the ball
forever — and let the player spend the hits' coins on more bumpers. The paddle
can be deleted or hidden; the bumpers and the juice on `ball-hit` stay.

## The neon look is three cheap ingredients

1. **`post-fx` (a `PostProcess` node with `affect2D: true`)** — bloom picks up
   whatever is already bright (the cyan `board-trim` strips, the bumper cores, the
   gold paddle, the white ball) plus a light vignette. Bloom cannot invent
   brightness: to make something glow, brighten its colour — don't just raise
   `bloomIntensity`.
2. **`bg-glow`** — `ColorRect2D` has no gradients, so the background glow is a
   near-white radial-gradient PNG (`sprites/ph-bg.png`) tinted with `core:tint`,
   sitting over the darkest `ColorRect2D`. The board floor is translucent so it
   reads through the playfield.
3. **`Label2D` glow** (`glowColor` / `glowStrength`) on the HUD. The HUD is a
   `CanvasLayer2D`, which the runtime draws *after* post-processing and never
   blooms — deliberately, so score text stays crisp. Its glow is canvas-drawn.

Feel is engine one-liners, not code you have to write: `TouchRules` already calls
`scene.audio.sfx` (procedural SFX — no audio assets in this project),
`scene.juice.burst` / `floatText` / `punchScale` / `flash` / `shake` and
`scene.time.hitstop` on contact, and `GameRules` plays a win/lose jingle. Spawn
effects at board-space anchors: anything anchored to the HUD lands in the
un-bloomed overlay band.

## Layout

```
scenes/menu.pix3scene         entry / export scene   (menu-post-fx, glowing title)
scenes/main.pix3scene         the GAME (editor startup scene — iterate here)
scenes/ui/result.pix3scene    win/lose overlay, instanced into main hidden (editor-only)
scripts/ball-collision.ts     pure swept-collision math (unit-tested)
scripts/BallBody.ts           ball motion; colliders from marker world transforms
scripts/PaddleController.ts   input → paddle             (swap this for flippers)
scripts/TouchRules.ts         ball-hit → score / damage + sound, particles, popups
scripts/ScoreHud.ts           signals → HUD widgets
scripts/GameRules.ts          score / lives / win / lose / end flow + jingle
scripts/MenuFlow.ts           menu PLAY button
sprites/ph-*.png              near-white placeholders (tinted via core:tint)
```

Signals:

```
BallBody --ball-hit(kind,nodeId,speed,x,y)--> TouchRules
TouchRules --touch-scored/touch-damaged--> GameRules --score-changed--> ScoreHud
                                                     --lives-changed-->
```
