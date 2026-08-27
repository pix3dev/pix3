# Blank 2D

Everything a run needs **except the mechanic**: a bounded field, a HUD, score /
lives / timer bookkeeping, and a win/lose screen with RETRY. Press play in
`scenes/main.pix3scene` and you get an empty field with `SCORE 0` — that is
correct, and it is the point.

Use this when the game's core loop is not what another recipe ships (grid or
turn-based movement, word / card / board games, builders, idle). The first thing
to build is the mechanic itself, controls included; building it here beats
deleting somebody else's mechanic first.

**`design/recipe.md` is the contract.** It lists the stable node ids, the
tunables (with their ranges), the extension points and what must not be renamed.
Read it first; tools and agents grep it.

## Layout

```
scenes/main.pix3scene    the ONLY scene — the game. There is no menu on purpose.
scripts/GameRules.ts     score / lives / timer / win / lose / end flow / restart
scripts/ScoreHud.ts      signals → HUD widgets (display only)
design/recipe.md         the contract
design/tests/            reachability ledger + one example routine (a format seed)
```

## How your mechanic plugs in

Write a script, attach it to a node inside `board`, and score through
`GameRules` — either by emitting on `game-root`:

```ts
this.findNode('game-root')?.emit('score-added', 1);
this.findNode('game-root')?.emit('life-lost', 1);
```

…or by calling the component directly (`addScore`, `loseLife`, `finish`). The
HUD, the end screen and RETRY then work with no further wiring.

## The rule that keeps it workable

One file, one responsibility. Keep each script in the 70–140 line range: small
files can be edited surgically; monoliths get rewritten wholesale and lose the
comments that explained them. When a mechanic outgrows its file, split it rather
than growing it.

## No menu yet

A menu is a screen between you and the thing you are working on. Add one only
once the game is fun: create `scenes/menu.pix3scene`, have its PLAY button
`scene.changeScene('res://scenes/main.pix3scene', {transition: 'fade'})`, then
point Project Settings → Default Export Scene Path at it. `Play Scene` keeps
running whatever scene is open, so the menu never gets in the way again.
