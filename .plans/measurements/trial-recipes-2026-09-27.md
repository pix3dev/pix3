# Recipe trial with the real CLI — 3 recipes x 3 tasks (2026-09-27)

Protocol: `phase0-agent-kit-draft/TRIAL-PROTOCOL.md`, updated for the shipped CLI: the kit is the
one `pix3 new` writes (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/pix3-*`, `.mcp.json`), no editor
connected, so the kit's own rule applies: `pix3 check --json`, then `pix3 smoke --json`.
CLI 1.6.0 from source (`node packages/pix3-cli/src/index.ts`), Node v24.21.0, Linux x64.
Projects: `pix3 new recipe-{tapper,arena,bouncer}-2d` in a scratch dir, `git init` + baseline
commit, `git checkout -- . && git clean -fdq` between tasks (`.pix3/` is git-ignored and kept).

**Agent:** one Claude Opus 5.5 subagent playing both the operator and the "external agent" —
allowed only the project folder and the CLI, never the pix3 repo. Prompts verbatim from the
protocol, no questions asked (defaults chosen). Timestamps via `date +%s.%N` written from inside
the agent's own tool calls, so every duration includes the agent's generation/thinking time
between calls. It is **not** the protocol's 18-run design (no Codex, no fresh session per run, no
editor Play check) — see "How this differs from a real session" before reading the numbers.

## Results

`t_write` = start → first file write; `t_check` = start → first `pix3 check` finished;
`t_green` = start → first green `check` (exit 0, 0 errors); `t_smoke` = start → green
`pix3 smoke scenes/main.pix3scene`. Every first check was green, so `t_check = t_green`.

### Tapper 2D

| task | t_write | t_check | t_green | t_smoke | tool calls | checks | codes seen | valid 1st | questions (defaults taken) |
|---|---|---|---|---|---|---|---|---|---|
| T1 reskin (neon, +30% fall, 45 s) | 18.0 s | 19.9 s | **19.9 s** | 34.3 s ¹ | 7 | 1 | W_PROPERTY_RANGE x2 (baseline) | yes | shade of "near-black purple" (`#0d0614`); menu bg too? (yes) |
| T2 golden star worth 5 | 18.0 s | 19.9 s | **19.9 s** | 30.0 s | 4 | 1 | same 2 W | yes | spawn rate / fall speed (7±4 s, driftY −480); art (wrote `sprites/star.svg`) |
| T3 combo multiplier + "x3" | 26.4 s | 28.3 s | **28.3 s** | 34.9 s | 3 | 1 | same 2 W | yes | where "next to the score" is (under it, y 790); max multiplier (10) |

### Arena 2D

| task | t_write | t_check | t_green | t_smoke | tool calls | checks | codes seen | valid 1st | questions (defaults taken) |
|---|---|---|---|---|---|---|---|---|---|
| A1 2x speed, bigger, red/gold, 60 s survive | 16.7 s | 18.6 s | **18.6 s** | 19.5 s | 3 | 1 | same 2 W | yes | "a bit bigger" = 1.25x (radius 75, sprite 150, touchRadius 78) |
| A2 keys + dash on Space | 19.1 s | 20.9 s | **20.9 s** | 21.9 s | 2 | 1 | same 2 W | yes | dash numbers (2200 px/s, 0.15 s, 0.6 s cooldown); keep pointer mode reachable (yes, `mode` stays a select) |
| A3 chaser every 5 s | 28.6 s | 30.5 s | **30.5 s** | 32.3 s | 2 | 1 | same 2 W; smoke: W_SMOKE_LOADER x3 | yes | chaser speed (140 px/s), cap (4), lifetime (20 s) |

### Bouncer 2D

| task | t_write | t_check | t_green | t_smoke | tool calls | checks | codes seen | valid 1st | questions (defaults taken) |
|---|---|---|---|---|---|---|---|---|---|
| B1 pastel, gentler glow, heavier/bigger ball | 36.0 s | 37.9 s | **37.9 s** | 38.9 s | 5 | 2 ² | same 2 W | yes ² | light or dark pastel ground (light); how much heavier (gravity −1600 → −2300, radius 30 → 38) |
| B2 brick row, 50 each | 23.1 s | 25.4 s | **25.4 s** | 27.7 s | 2 | 1 | same 2 W; smoke: W_SMOKE_LOADER x3 | yes | brick count/size (8 x 100x40 at y 700); win when all broken? (no, not asked) |
| B3 two flippers on arrows | 44.6 s | 46.6 s | **46.6 s** | 55.9 s | 3 | 1 | same 2 W | yes | delete `PaddleController.ts`? (kept, unused); add inlane guides? (yes, see defects) |

¹ The first smoke (no scene argument) ran `scenes/menu.pix3scene` at 25.9 s and proved nothing
about the change — defect D1. 34.3 s is the rerun on `scenes/main.pix3scene`. All other rows use
the explicit scene from the start.
² B1's first check was green, but the agent's own bulk `sed` turned `vignetteDarkness: 0.55` into
`0.255` in the menu (a `0.5` → `0.25` substitution matching a prefix). A valid value, so no tool
could flag it; the agent saw it in `git diff` and fixed it (second check green at 49.5 s). It counts
as valid-first-check under the protocol's definition (no `E_*`), but it is a real authoring slip.

### Summary

| metric | value | target |
|---|---|---|
| median start → green `check` (9 runs) | **25.4 s** (18.6 / 19.9 / 19.9 / 20.9 / **25.4** / 28.3 / 30.5 / 37.9 / 46.6) | ≤ 30 s (≤ 60 s acceptable) |
| median start → green `smoke` on the game scene | 32.3 s | — |
| worst run | B3 flippers, 46.6 s check / 55.9 s smoke | — |
| valid on the first check (no `E_*`) | **9 / 9** | ≥ 2/3 |
| `check` runs per task | 1.1 mean (10 total); 0 error codes in any run | — |
| questions asked | 0 (all forks resolved with defaults, listed above) | 0 |
| tool calls per task | median 3 (2 – 7) | — |
| `check` wall time | 1.9 – 2.3 s each (tsc included) | — |
| `smoke` wall time | 0.8 – 2.4 s (120 – 900 frames) | — |

Behaviour was **not** verified in play for any run (no editor, and `pix3 smoke` feeds no input):
the combo, the dash, the flippers, brick breaking and the bonus star are "compiles, loads, runs
2–15 s without a throw", nothing more. What smoke's `registerGameDebug` snapshot did show:
T1 `timeLeftSec: 43` at 2 s (45 s round), A1 `winMode: survive`, `timeLeftSec: 58`; A3 the
unattended player lost all lives by 11 s (baseline: 1 life left at 15 s), consistent with a chaser
reaching it; B3 the unattended ball kept 3 lives for 14.5 s on resting flippers + guides.

## Defects found (kit / CLI / recipe)

**D1 — `pix3 smoke` with no argument tests the menu, not the game (CLI + kit). Confirmed.**
Kit, `AGENTS.md` rule 4: "**No editor connected?** Run `pix3 smoke` after `check`: it runs the
game headless in Node for 2 s". `pix3-verify`: "`pix3 smoke` (after a green `check`) runs the entry
scene". In every recipe the entry scene is `scenes/menu.pix3scene` (MenuFlow only), and input is
empty, so PLAY is never pressed and `main.pix3scene` never loads. Probe: `throw new Error("probe")`
in `ScoreHud.onStart` → `pix3 smoke` = `ok: true, scene: scenes/menu.pix3scene, errors: []`;
`pix3 smoke scenes/main.pix3scene` = `E_SMOKE_SCRIPT`. An agent following the kit literally gets a
green smoke over a game that throws on start. Needed: default to the scene(s) changed since the
last check (or the editor startup scene / every scene with components), or at least follow a
`changeScene` target; and the kit should say "`pix3 smoke <the scene you changed>`".

**D2 — every recipe's baseline emits 2 warnings (templates).** `W_PROPERTY_RANGE labelFontSize is 96
… outside the inspector's 8..64 range` (menu title) and `… is 88 …` (result label), on every `check`
in all three recipes, before any edit. The agent has to learn to filter them out; a real agent
may "fix" them (shrinking the title) or report them as its own. Needed: widen the inspector range
(96 px titles are normal at 1080x1920) or change the templates.

**D3 — `W_SMOKE_LOADER` for a headless limitation (CLI).** Any `scene.juice.flash` in smoke
(arena damage, bouncer drain — both baseline code) yields
`W_SMOKE_LOADER '[SceneService] Cannot create flash overlay: canvas has no parent element.' count 3`.
The code name says "loader problem"; it is the DOM shim. It appeared in A3 and B2 only because
those runs lasted long enough for a hit — i.e. it looks like the agent's change caused it.
Needed: give the shim canvas a parent, or report it under `notes` like the audio note.

**D4 — Tapper combo extension point describes a recursion trap without saying so (recipe).**
`design/recipe.md`: "A new script on `hud` that listens for `touch-scored` on `game-root`, counts
hits inside a time window and **re-emits `touch-scored`** with a bigger amount. `GameRules` needs no
change." A listener on `touch-scored` that emits `touch-scored` on the same node re-enters itself;
the kit's `Combo` sample in `pix3-scripts` sidesteps it (emits `combo-changed`) but never names
the trap. The agent here added a re-entrancy flag and re-emitted only the *extra*
`amount * (m − 1)`. Worse than the trap itself: **no offline check can catch it** — it fires only on
a tap, and smoke has no input (D6), so the naive version passes `check` and `smoke` green
(inferred from D6, not reproduced). Needed: recipe text "emit the EXTRA points under a
re-entrancy guard, or add a `bonusAmount` arg / a `score-bonus` signal GameRules listens to".

**D5 — A script inside a spawned prefab keeps running after game over (recipe/GameRules).**
Arena recipe: "Chasers: a script on the prefab that steers toward `player`'s world position —
contact is already punished." `GameRules.finish()` disables components only on the nodes listed in
`freezeNodes` (`for (const component of node.components)`), not on the instances under a
spawner, so a naive chaser keeps crawling over the result card — breaking the recipe's own
`terminalVisual: static` playtest contract. The agent caught it by reading `GameRules.ts` and made
`Chaser` stop on `game-won`/`game-lost`. Needed: either `finish()` also freezes components of the
freeze nodes' descendants, or the recipe line says "stop it on `game-won`/`game-lost`".

**D6 — No way to drive input offline (CLI, gap).** 6 of 9 tasks (T2, T3, A2, A3, B2, B3)
are input- or contact-driven; `smoke` proves only "nothing threw". `pix3-verify` is honest about
it ("Nothing is drawn, heard or tapped"), so this is a gap, not a lie. Cheap wins: `--key
Key_Space@30` / `--tap x,y@frame` / `--emit game-root:touch-scored:1@frame`, and a per-id node
count or `--watch <id>` in the result (`nodes: {start: 46, end: 46}` could not tell whether a brick
broke or the star spawned).

**D7 — Flipper extension point is geometrically ambiguous (recipe).** Bouncer: "Two oriented boxes
under `paddles` (`flipper-left`, `flipper-right`) pivoted at their inner ends; … lerps `rotation.z`
−25° → +35°". (a) `BallBody` takes each **direct** child of `paddles` as a box centred on the
node (`childNodes(parent)` = `parent.children`), so "pivoted at the end" cannot be a pivot parent
(`Group2D` under `paddles` would itself become the collider); the script must move the centre
along the flipper each frame — the recipe does not say so. (b) Real flippers pivot at their
**outer** ends with tips toward the centre; "inner ends" reads backwards. (c) The right flipper
needs the angles mirrored; not mentioned. (d) With flippers pivoted ~160 px in from the walls the
ball drains around their outer ends — the recipe's own "Verify 3" ("never let the ball round its
open sides") requires inlane guides that the extension point does not mention. The agent added
`guide-left`/`guide-right` boxes under `walls`.

**D8 — Pastel reskin vs bloom threshold (recipe, minor).** Recipe: "Bloom lifts only what is
*already* bright — brighten the colour or lower `bloomThreshold` (0.58), don't raise intensity",
and `main.pix3scene`: "the Flow theme pack turns it … down for pastel". A pastel theme on a light
ground puts the whole background over 0.58 and blooms everything; the needed move is to **raise**
`bloomThreshold` (the agent set 0.92) — the kit only ever describes lowering it. Unverifiable
without a render.

**D9 — Offline verify path is described two ways (kit, minor).** `pix3-scene-format` "Recipe tool
names": `play_start, game_input, …` → "otherwise `pix3 check`, then ask the human to press Play";
`AGENTS.md` rule 4 adds `pix3 smoke`. Same fallback, two answers; align on "check → smoke <scene>
→ ask the human, naming what to look for".

Not defects, worth keeping: tints live in prefab files and the kit says so (T1/A1 found them first
try); `winMode: survive` spelled right from the recipe tunables; `Key_Space` vocabulary right from
`pix3-scripts`; `pix3 tree` gave the arena/bouncer node map in one call; the SVG template in
`pix3-nodes` produced a valid star on the first write (T2); `check --json` diagnostics carry `file`.

## Verdict

- Median start → green `check` **25.4 s ≤ 30 s target** — met, on this setup. Valid on the first
  check **9/9 ≥ 2/3** — met. Worst case 46.6 s (flippers), within the 60 s "acceptable" bar.
- The format side of the kit is solid: zero `E_*` in 10 checks across three recipes and nine tasks,
  including three new scripts, two new prefabs, an SVG and a 70-line YAML insertion.
- The weak side is **verification without an editor**: D1 means the kit's own recipe for it tests
  the wrong scene, and D4/D5/D6 are behaviour bugs that a green `check` + `smoke` cannot see. Fix D1
  (default scene) and D2 (baseline warnings) before the live-agent trial; D4/D5/D7 are one-line
  recipe text edits.

## How this differs from a real session (read before quoting the numbers)

- **One agent, nine runs, warm context.** The kit (`AGENTS.md`, `pix3-scene-format`,
  `pix3-scripts`, `pix3-verify` sections) was read once, in T1 (T1's 18 s to first write includes
  it). Every later run started with the kit already in context; a fresh Claude Code session per
  run would re-read `AGENTS.md` + one or two skills — estimate **+10–20 s per run**, which moves the
  median to roughly 35–45 s: over the 30 s target, inside the 60 s acceptable bar. T2/T3 also
  reused `main.pix3scene` from T1's read instead of re-reading it (rule 2).
- **Batched tool calls.** The agent wrote files, ran `check` and `smoke` in one shell call where it
  could (median 3 calls per task). Claude Code with separate Edit/Write/Bash calls would make
  5–10 calls per task, each with its own round-trip — another few seconds per call.
- **Clock start.** `start` is taken in the agent's first tool call; the prompt-reading and first
  planning before it (a few seconds) are not counted. Everything after it, including generation
  of the file contents, is.
- **Prior knowledge.** The agent knows three.js/TypeScript well and did not hit a single type
  error; a weaker or less-familiar model would likely take 1–2 more `check` rounds on the three
  script tasks.
- **No Play check.** The protocol's "verified change" requires an operator Play check; none was
  possible here, so these are "green check" times, not "verified" times.

Raw logs: scratch `trial3/times.log`, `*.check1.json`, `*.smoke.json` (session scratchpad, not in
the repo).

## D6 proposal — `pix3 smoke --input <steps.json>` / `--until` (design only, not implemented)

1. **Surface.** `pix3 smoke <scene> --input steps.json [--until '<predicate>']`, where `steps.json` is exactly the `steps` array `game_input` takes (`GameInputStep`: `tap`/`key`/`keys`/`drag`/`wait`/`hover`/`invoke`, design-space coords, `target` by id/name), and `--until` is `game_run`'s predicate shape (a `registerGameDebug` snapshot path + op + value, e.g. `phase == "over"`). The same file then runs headless and live — an agent writes it once.
2. **Report.** Per step: frame it ran on, the target's projected point (or "could not project"), and after it the watched ids (`--watch brick-3,star`) as `{ exists, position, visible }`; `until` → `{ met: true, frame }` or `met: false` at the frame budget (exit 1 with `E_SMOKE_UNTIL`, a new code the kit drift spec must learn).
3. **What `GameInputService` needs to run under the shim.** It lives in the editor (`src/services/agent/GameInputService.ts`) behind DI, `appState.ui.isPlaying` and `GamePlaySessionService`; the step executor has to move into a host-free module (`@pix3/runtime/testing`, next to `createHeadlessGame`) taking `{ runner, canvas, windowRef, stepFrames(n) }` — the editor keeps the DI wrapper, smoke calls the module directly.
4. `wait` must advance the **manual clock** (`runner` in `mode: 'manual'`, N × 1/60 s) instead of wall-clock `setTimeout`; tap/drag need `runner.projectNodeToCanvas`, i.e. an active Camera2D and a canvas with `width`/`height` + `getBoundingClientRect` (the shim canvas already has both, sized to the manifest viewport).
5. Events: the shim already defines `PointerEvent`/`KeyboardEvent` classes and an `EventTarget`-backed canvas/window, so `dispatchPointer` / `window.dispatchEvent(new KeyboardEvent(...))` reach the runtime `InputService` unchanged; `setPointerCapture` is stubbed. Missing today: `pointerId`/`clientX` defaults on the shim event classes (they copy `init`, which is enough if the executor passes them).
6. `invoke` (the `Interactive` descriptor path) is DOM-free and ports as is; `hover` needs nothing beyond pointermove.
7. Cheapest first slice: `key`/`keys`/`wait` + `--until` (covers A2 dash, B3 flippers); then `tap` by `target` (T2/T3 taps, combo), then `drag`.
8. Non-goals: pixels, audio, reachability journal (editor-only proofs stay editor-only — a headless tap is not a human-reachable proof).
