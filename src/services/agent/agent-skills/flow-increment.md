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

## 3. Prove it, then say what you proved

`compile_scripts ok` is not proof, and `moved: true` is not proof of the *right* motion.
Before you close a turn that changed game logic: `play_start`, then `game_input` /
`game_observe` on the affected node, checking the signal that matches the mechanic (see
`game-prototype` §3), then `read_errors`.

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

## 7. Keep your own context small

Your memory is the `design/*.md` files, not this conversation — it gets compacted. So:

- write decisions and progress into the files **as you go**, not at the end;
- read file sections, not whole files (`fs_read` with `offset`/`limit`, `read_skill` with
  `section`);
- prefer `str_replace` for edits. A full `fs_write` over an existing file is how a previous
  session silently reverted its own working fix — the editor now refuses it for larger files
  unless you pass `overwrite: true` with a reason, and that refusal is a hint, not an obstacle
  to route around.
