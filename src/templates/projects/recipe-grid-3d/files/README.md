# Grid 3D

A playable skeleton for tap-to-carve 3D puzzles: a solid block of cubes, a
perspective camera looking at it, and a tap that removes one cube. Some cubes
are core — hitting one costs a life. Clear every non-core cube to win.

It plays as shipped — press play in `scenes/main.pix3scene` before changing
anything, so you know what "working" looked like.

- `scenes/menu.pix3scene` — entry scene; PLAY transitions to the board.
- `scenes/main.pix3scene` — the board: camera, lights, `board-anchor`, HUD.
- `scripts/GridBoard.ts` — builds the cubes and turns a tap into a removal.
- `scripts/GridRules.ts` — score, lives, win/lose, the debug provider.
- `scripts/ScoreHud.ts`, `scripts/MenuFlow.ts` — display and menu, shared with
  the other recipes.

The cubes are generated, not authored: board size lives in `GridBoard`'s config
(`sizeX/sizeY/sizeZ`), so a bigger block is one number, not a scene edit.

Read `design/recipe.md` for the node map, the tunables and what not to touch.
