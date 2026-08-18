# Skill: flow-increment

> How to work in **Flow** — the prompt-first workspace, where a non-technical user watches
> their game on a live stage next to this chat. There is no file tree and no inspector on
> their screen: what you change, they see; what you break, they see too.

Read this FIRST in Flow, before `game-prototype` (which stays true for the build details).

## 1. You did not start from an empty project

A **recipe** was already expanded into this project: a playable skeleton of the genre —
menu → game → win/lose, controls, score. It runs right now.

- **`fs_read design/recipe.md` first. Always.** It is the map: stable node ids, which
  placeholder belongs to which node, the tunables and their ranges, the declared extension
  points, and what must not be touched. Everything you need to make a change lands there in
  one read.
- `design/brief.md` is what the user asked for; `design/progress.md` is the increment
  checklist; `design/decisions.md` records forks that are already settled — **read it before
  asking anything, so you never ask twice.**
- Then `scene_tree` once. That is enough exploration to start. Do not survey the project.
- **If `design/brief.md` notes that the request was downgraded** — a 3D ask served by a 2D
  recipe, a genre substituted for the nearest one — say so in your first message, plainly, in
  the user's language. Presenting the substitute as if it were the ask is how a request for a
  3D puzzle becomes isometric sprites that nobody wanted.

**Extend the recipe, do not rebuild it.** Adding an entity type, a rule, a spawner or a HUD
element is a few additive calls at an extension point the recipe declares. Rewriting
`GameRules.ts` because you would have structured it differently costs the user their working
game and costs you the rest of the turn.

## 2. One increment per turn

The user's first prompt is not a specification you must satisfy in one go. It is the start of
a conversation.

- Take the **first unchecked item** in `design/progress.md`, build it, prove it, report. Then
  stop. Do not chain three increments because there is budget left.
- Mark the item you are working on `- [~]` at the START of the turn and `- [x]` when it is
  proven — the header tracker on the user's screen is rendered from exactly those markers, so
  a stale checklist reads as a frozen product.
- Every increment ends **playable**. Never leave the game in a state where the stage is broken
  and the fix is "in the next turn".
- **Before building a genre staple, recall the real one.** One thought, not research: how is
  this thing built in the actual genre — which geometry, gaps and angles make it PLAYABLE
  (flippers pivot wide so their tips guard one narrow centre gap and the sides are walled off;
  bricks sit where the ball can reach; a snake grid fits the field)? Write the 2–3 constraints
  you are building to into `design/decisions.md`, then build to them. The canonical version is
  in your training data — consult it before the first `create_node`, not after the user sees a
  broken board.

## 3. Prove it, then say what you proved

`compile_scripts ok` is not proof, and `moved: true` is not proof of the *right* motion.
Before you close a turn that changed game logic: `play_start`, then `game_input` /
`game_observe` on the affected node, checking the signal that matches the mechanic (see
`game-prototype` §3), then `read_errors`.

**Verify with state, not with pictures.** `game_observe` returns real positions, scale, opacity,
child counts and rendered `text` — that is how you check "the apple sits on a grid cell"
(`position.x % cellSize === 0`) or "the score went up" (read `score-label`'s `text`). A
screenshot plus `analyze_image` costs several iterations, answers "I don't see it" as often as
not, and cannot tell you a number. Keep screenshots for questions that are genuinely visual —
"does this look like a snake?" — and never use them to locate a node.

The harness enforces this: while a gameplay change of yours is unproven, `viewport_screenshot`
and `analyze_image` refuse and point you back at `game_input`/`game_observe`. When the question
really is visual, pass `visualReason` saying so and they run.

**Prove the FUNCTION, not the mechanism.** "The key moves the flipper" is mechanism; the
increment's purpose is "the flipper can save the ball". After a mechanic lands, run the game
twice: a few seconds with NO input (`game_observe`), then a driven run (`game_input`) — the
driven run must measurably beat the unattended one (survival time, score, game state). An
increment that leaves the game losing itself in seconds regardless of input is NOT done,
whatever the per-node verdicts say — and the stage idles unattended between turns, so an
instantly-lost board is what the user stares at. Measured: a flipper increment shipped with
every key "proven" while the ball drained around the flippers' open sides in ~3 s, every run.

**`visible: true` does NOT mean on screen.** It is the node's own flag; an invisible ancestor
hides the entire subtree, so the node draws nothing and cannot be tapped. Showing a result label
and a retry button while leaving their parent overlay hidden reads as a perfect win screen in
every property and shows nothing on the stage — that exact mistake cost two turns. When a node is
in that state the snapshot carries `hiddenByAncestor` and the `hint`/`verdict` say NOT ON SCREEN,
and a tap on it is refused with the reason. To reveal an overlay, make the **container** visible.

**A button that does nothing: read `control` before theorising.** `game_observe` reports
`control: { enabled, hovering, pressed }` for every UI control. `enabled: false` means the press
can never register — the recipe binds the result-overlay's RETRY handler and leaves the button
disabled until *its own* game-over path enables it, so a script that shows the overlay itself gets
an on-screen button that ignores every tap. `hovering: false` after a hover means the pointer never
reached its bounds. Measured: three turns were spent guessing at engine internals for a button whose
snapshot said `enabled: false` all along.

**Start each verification from a known state.** Re-run `play_start` (or `play_restart`) before the
input sequence that proves the increment. Driving a fresh sequence onto a board left over from the
previous attempt makes the `before` snapshot already satisfy what you are testing — an agent
"proved" a reset that never happened because the cells it read were dirty from the run before.
Read your own `before` values: if they already show the end state, the run proves nothing.

If after a few honest attempts you cannot prove it, **say so plainly** — what you tried, what
you saw, what you think is wrong. A truthful "I could not get the collision to register"
beats a cheerful "Done!" that the user disproves in two seconds on the stage.

## 4. Ending a turn: summary + a fork, in the user's language

Close every turn with:

1. one or two sentences on what is playable NOW, phrased for someone who has never opened a
   game engine ("стрелки двигают героя, монетки собираются, счёт растёт"), and
2. **2-3 concrete options for what to do next**, as short imperative phrases. The UI turns
   them into clickable chips, so "добавить бомбы" is useful and "let me know what you think"
   is not.

Never end with a silent "Готово!".

## 5. Asking is allowed — about structure only

`ask_user` ends your turn with a question and option chips, and it does **not** count as an
unverified turn. Use it when the answer changes the STRUCTURE of the scene or the scripts:

- "победа по очкам или по времени?" — different rules, different HUD → **ask**
- "враги волнами или постоянным потоком?" — different spawner shape → **ask**
- what shade of blue the background is, how fast the enemies are, which font size → **choose
  it yourself** and say so in one line ("сделал 3 волны — скажи, если не то").

Write the answer into `design/decisions.md` the moment you get it. That file survives context
compaction; the conversation does not.

## 6. Assets never block the game

Placeholders are already in place and already tinted to the brief's palette. Generate art in
the background (`queue_asset` when it exists, otherwise as a late increment) and keep playing
the game with placeholders until then. The chat must never sit for 40 seconds waiting on an
image.

**Juice is cheap — spend it as you go.** `scene.juice.burst(target)`,
`scene.juice.floatText('+100', { at: target })`, `scene.audio.sfx('score')` and `Label2D`'s
`glowColor`/`glowStrength` are one-liners with no assets and no setup. Add the sound, the burst
and the score popup **in the same increment as the mechanic they belong to** — feel deferred to a
late "polish" increment is feel the user never gets to see.

## 7. Keep your own context small

Your memory is the `design/*.md` files, not this conversation — it gets compacted. So:

- write decisions and progress into the files **as you go**, not at the end;
- read file sections, not whole files (`fs_read` with `offset`/`limit`, `read_skill` with
  `section`);
- prefer `str_replace` for edits. A full `fs_write` over an existing file is how a previous
  session silently reverted its own working fix — the editor refuses it for larger files unless
  you pass `overwrite: true` with a `reason`.

**When the recipe blesses replacing a file** (`recipe.md` says "REPLACE … entirely" — typically
the movement script, because a grid stepper or a jumper shares nothing with free movement),
that IS the sanctioned path. Do it in one call:

```
fs_write { path: "scripts/PlayerController.ts", content: "…",
           overwrite: true, reason: "recipe-blessed swap: grid locomotion" }
```

Do not go looking for a way around the refusal, and do not rebuild the file through a dozen
`str_replace` calls.

## 8. The stage is already running

In Flow the game plays continuously next to the chat — you did not start it and you should not
stop it.

- `play_start` while it is running returns `alreadyRunning: true`. That is success. Do NOT
  `play_stop` just so `play_start` can "work".
- To pick up a fresh script build: `compile_scripts`, then **`play_restart`** (one call).
- `play_stop` is for the rare case where you must edit with nothing ticking — start it again
  before you finish, because a stopped stage is a black screen for the user.
