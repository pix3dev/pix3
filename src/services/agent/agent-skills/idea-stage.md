# Skill: idea-stage

> How to work at the **idea stage** of Flow — before there is a game. The user sees their
> design document where the game stage will later be, this chat next to it, and nothing
> else. No scene, no scripts, no play mode. Nothing you do this stage can be "run".

Read this FIRST at the idea stage. `flow-increment` becomes true later, after the user
presses "Start prototype" and a recipe is expanded into the project.

## 1. The document is the product

`design/gdd.md` is the idea. Not the conversation — the conversation gets compacted and the
file does not.

- **Everything you and the user agree on goes into the document in the SAME turn.** A
  decision that lives only in a chat message is a decision that will be re-litigated in ten
  turns, and the user cannot see it in the place they are reading.
- It is seeded with a fixed section skeleton (Concept, Core loop & mechanics, Controls,
  Screens & UI, Art & audio, Progression & difficulty, Open questions) and with the user's
  original prompt quoted under "What the user asked for". **Never delete that quote** — it is
  the only record of what was actually asked, in their words.
- Keep the `# Title` and `**Pitch:**` lines: the header above the document reads them.
- Empty sections are honest. A section you fill with plausible filler reads to the user as a
  decision that was made without them, and unpicking that costs more than the blank did.

## 2. Edit it with `str_replace`, read it in sections

- **`str_replace` is the default edit.** Replace the heading plus the body of one section, not
  the file. A full `fs_write` over a document the user has been reading is how a previous
  session silently reverted the user's own paragraph — the editor refuses it for larger files
  unless you pass `overwrite: true` with a `reason`, and "it was easier" is not one. The
  legitimate case is a genuine restructure the user asked for; say so in the `reason`.
- **Do not inline the whole document into your context.** `fs_read` with `offset`/`limit`, or
  read the one section you are about to change. When the user selects a fragment in the
  document, that exact source slice arrives as an attachment on their message — edit against
  it, do not re-read the file to "check".
- `design/decisions.md` records settled forks. **Read it before you ask anything**, so you
  never ask twice.
- Attached documents live under `design/source/`. Read the section you need; never inline a
  20-page GDD.

## 3. End the turn with a question

`ask_user` ends your turn with a question plus option chips, and at this stage that is the
**normal** way for a turn to end — not a failure to finish.

- One or two questions. Not five: a chip row of five is a form, and the user came here to
  talk.
- Ask about the forks where a wrong guess means redoing the game later: "does the run last a
  minute or ten?", "portrait or landscape?", "one screen or a level list?", "is the failure a
  timer or a health bar?"
- **Choose the small stuff yourself and say so in one line.** Which shade of blue, what the
  currency is called, how many hearts — pick, write it into the document, mention it in a
  half-sentence ("went with three hearts — say the word if you want more").
- The answer to an `ask_user` question is filed in `design/decisions.md` **for you**, by the
  editor, before your next turn starts. Do not re-record it. What is still yours to do is to
  write the consequence into the relevant `gdd.md` section the moment you have it.

## 4. Only STRUCTURAL decisions go in the decisions log

`design/decisions.md` is read at the start of every compacted conversation, so each entry
costs context forever. The bar is the same as for `ask_user`: **a choice where being wrong
means rebuilding something.** Genre, session shape, win/lose condition, orientation, whether
progression exists. Not colours, not names, not numbers you can tune later.

Never write the file by hand — `record_decision { question, choice, reason?, alternatives? }`
appends the one canonical line. Use it for a fork the user settled **in prose** ("actually,
let's make it one long level"), which no `ask_user` answer covered. Recording a question that
is already in the log replaces that line instead of adding a second, so following an
auto-recorded answer with the reason you learned is safe — and is the only reason to record
a fork the user answered through a chip.

## 5. Every artefact lives in `references/` — the folder is not yours to pick

Whatever you generate at this stage goes to `references/`, and `generate_asset` puts it there
even when the name you passed said another folder. That is not a bug to work around: the
references column — the one place the user looks for the picture you just drew — lists that
folder, so a file anywhere else is a file they will not find.

So: **do not "fix" the location afterwards.** A `process_asset` copy into `design/` followed by
`fs_delete` of the original (a real session did exactly that) takes the artefact out of the list
and leaves the user staring at a column that says nothing was made. If the request named a
different folder, keep the file where the tool put it and say so in one line — the saved path
comes back in the tool result, so point at that.

The same goes for anything you write by hand for the user to look at: a mockup, a table, a
scratch note that is not the design document itself belongs in `references/`.

## 6. Moodboards: ask the question with pictures

When the conversation reaches "what should it look like", do not describe three styles in
prose. Generate them.

- 2–4 candidates in one turn via `generate_asset`, named `mood-<n>.png`. At this stage a bare
  name lands in `references/` on its own — you do not need to spell the folder out. Give each a
  short prompt that differs in ONE axis (flat vector vs painterly vs pixel), not in three —
  the point is a comparison the user can make.
- The tool records each generation in `references/index.json` itself, with your prompt as the
  caption. The one thing it cannot know is what the picture is FOR: add `role: "style-candidate"`
  to those entries so the cards read as a set of candidates rather than as finished art.
- **End that turn with "which one is closer?"** The candidates ARE the question.
- The choice is theirs to make, not yours to guess: they either say which one in the chat or
  press "make this the style" on the card where the panel offers it. Never write
  `design/style.md` from a candidate you happen to like — once they HAVE chosen, record the
  choice in `design/decisions.md` and write `style.md` from that candidate.
- Object and layout references work as they do at the prototype stage: `role: content` is a
  thing to depict, `role: layout` is structure to read and never to copy.

## 7. There is no game yet — do not reach for one

At this stage the project holds one empty 2D canvas that nothing opens. The scene, script,
play-mode and gameplay tools are **not available to you here**, and that is deliberate: a
turn spent creating nodes for a design nobody has agreed to is a turn spent on work that the
recipe is about to overwrite.

- No `create_node`, no `compile_scripts`, no `play_start`, no screenshots of a scene that
  does not exist.
- Do not "get a head start" by writing scripts into `scripts/`. Pressing "Start prototype"
  expands a genre recipe into this project; anything you wrote against a guess at that recipe
  is dead code at best.
- Your tools here are the document, the references and the questions. That is the whole job.

## 8. Ending a turn, in the user's language

1. One or two sentences on what the document now says that it did not before — phrased for
   someone who has never opened a game engine.
2. The question (§3), through `ask_user`, or 2–3 concrete next steps as short imperative
   phrases if the idea genuinely has no open fork left.

Never end with a silent "Готово!", and never claim the document says something you did not
write into it.
