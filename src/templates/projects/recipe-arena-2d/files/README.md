# Arena 2D

A playable skeleton: an avatar in a bounded field, two spawners dripping
pickups and hazards, touch resolved into score or damage, lives + a timer, and a
win/lose screen with RETRY / MENU. It plays as shipped — press play in
`scenes/main.pix3scene` before changing anything.

**`design/recipe.md` is the contract.** It lists the stable node ids, the
tunables (with their ranges), the extension points and what must not be renamed.
Read it first; tools and agents grep it.

## Layout

```
scenes/menu.pix3scene       entry / export scene — PLAY transitions to the game
scenes/main.pix3scene       the GAME (editor startup scene — iterate here)
scenes/prefabs/*.pix3scene  what the spawners instantiate
scripts/PlayerController.ts how the avatar moves          (swap this file whole)
scripts/Spawner.ts          timed instantiate + drift + despawn
scripts/TouchRules.ts       contact → semantic signals
scripts/ScoreHud.ts         signals → HUD widgets
scripts/GameRules.ts        score / lives / timer / win / lose / end flow
scripts/MenuFlow.ts         menu PLAY button
sprites/ph-*.png            near-white placeholders (tinted via core:tint)
```

## The rule that keeps it workable

One file, one responsibility. Each script is 70–140 lines on purpose: small
files can be edited surgically; monoliths get rewritten wholesale and lose the
changes that were already working. When you add a mechanic, add a script.

Signals are the seam between them:

```
TouchRules --touch-scored/touch-damaged--> GameRules --score-changed--> ScoreHud
                                                     --lives-changed-->
                                                     --time-changed-->
```
