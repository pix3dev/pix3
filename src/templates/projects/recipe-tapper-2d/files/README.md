# Tapper 2D

A playable skeleton: objects fall into the field, tapping them is the whole
game, one bad type punishes, and a countdown ends the run. It plays as
shipped — press play in `scenes/main.pix3scene` before changing anything.

**`design/recipe.md` is the contract.** Stable node ids, tunables with ranges,
extension points and what must not be renamed. Read it first.

## Layout

```
scenes/menu.pix3scene       entry / export scene — PLAY transitions to the game
scenes/main.pix3scene       the GAME (editor startup scene — iterate here)
scenes/prefabs/*.pix3scene  what the spawners instantiate
scripts/Spawner.ts          timed instantiate + drift + despawn
scripts/TouchRules.ts       a tap → semantic signals
scripts/ScoreHud.ts         signals → HUD widgets
scripts/GameRules.ts        score / lives / timer / win / lose / end flow
scripts/MenuFlow.ts         menu PLAY button
sprites/ph-*.png            near-white placeholders (tinted via core:tint)
```

Same script names and roles as the other recipes — `Spawner`, `TouchRules`,
`ScoreHud`, `GameRules` mean the same thing everywhere, only their contact
source differs (here: a pointer-down hit-test instead of a proximity test).

## The rule that keeps it workable

One file, one responsibility, 70–140 lines. Small files can be edited
surgically; monoliths get rewritten wholesale and lose the changes that were
already working. When you add a mechanic, add a script.

```
TouchRules --touch-scored/touch-damaged--> GameRules --score-changed--> ScoreHud
                                                     --lives-changed-->
                                                     --time-changed-->
```
