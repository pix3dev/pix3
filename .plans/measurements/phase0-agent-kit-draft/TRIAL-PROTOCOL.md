# Phase 0 — agent trial protocol

Measures the **"Агенты."** bullet of Phase 0 in `.plans/external-agent-authoring.md`:
can an external agent (Claude Code, Codex) that has only this draft kit edit a recipe project
by writing files, fast, with valid scenes?

**Pass bar (from the plan's Phase 0 exit):** the agent writes **valid scenes in ≥ 2/3 of
runs**, and the **median "prompt → verified change" ≤ 60 s**. If YAML breaks
*systematically* (same error class in several runs), fix the kit / format docs first and
re-run; the CLI is not built until this passes.

## Setup (once per recipe)

1. In the editor: New Project → `Tapper 2D` / `Arena 2D` / `Bouncer 2D`, stored in a local
   folder (`~/pix3-trials/<recipe>`). This writes `pix3project.yaml` and the recipe files.
2. Remove the current agent overlay so it cannot contradict the draft:
   `AGENTS.md`, `CLAUDE.md`, `.claude/skills/pix3-game-dev/`, `.claude/skills/pix3-remote-preview/`.
   Keep `design/`, `.pix3/`.
3. Copy the draft kit in: `AGENTS.md`, `CLAUDE.md`, `.claude/skills/pix3-*/` from
   `.plans/measurements/phase0-agent-kit-draft/`. Do **not** copy `TRIAL-PROTOCOL.md` or
   `SOURCES.md`, and do not add `node-types-reference.md` (we measure the compact kit).
4. `git init && git add -A && git commit -m baseline`. Every run starts from
   `git reset --hard baseline && git clean -fd`.
5. `pix3` is not installed (no CLI yet) — confirm `command -v pix3` is empty, so the agent
   exercises the manual-pass fallback. If the strict-profile spike produced a Node validator,
   keep it **outside** the project; the operator runs it, not the agent.
6. Close the project in the editor during the run (the co-authoring spikes are measured
   separately). Exception: the optional human-edit probe below.

Agents: Claude Code (default model) and Codex (default model), fresh session per run,
started in the project folder with no extra instructions. 2 agents × 3 recipes × 3 tasks =
**18 runs**. Give the prompt verbatim; answer questions only with "your call" unless the
question is structural and the task text genuinely leaves it open.

## Tasks

Each recipe gets one **reskin/tune** task (edits existing values only), one **new mechanic**
task (new nodes/prefab + existing scripts), one **new node + script** task (a new
`scripts/*.ts` and the node it attaches to). All are derived from the recipe's
`design/recipe.md` tunables and extension points. "Expected edits" is for the operator, not
the agent.

### Tapper 2D (`recipe-tapper-2d`)

| # | Prompt | Expected edits | Traps it probes |
| --- | --- | --- | --- |
| T1 reskin | "Make it neon: near-black purple background, the good things cyan, the bad ones hot pink, everything falls 30% faster, and a round lasts 45 seconds." | `game-background.color`, `board-floor.color`; `core:tint` colour in `prefabs/target` + `prefabs/hazard`; `driftY` ×1.3 on both `user:Spawner`; `GameRules.timeLimitSec: 45` (+ `time-label` text) | unquoted `#` colours; tints live in prefab files, not on instances |
| T2 mechanic | "Add a rare golden star worth 5 points that falls faster than the others." | copy `prefabs/target` → `prefabs/bonus` (new root id, `core:Hitbox2D.group: bonus`, gold tint); new `Group2D` `spawner-bonus` with `user:Spawner` (`prefab`, low rate, faster `driftY`); `touchRules` += `;bonus:score:5` | prefab must have one root; component on the plain node, not an instance; rules string syntax |
| T3 node+script | "Add combos: taps within one second of each other build a multiplier shown as 'x3' next to the score, and the multiplier multiplies the points." | new `Label2D` `combo-label` under `hud`; new `scripts/Combo.ts` (schema, `touch-scored` listener) on `hud`; bonus points reach `GameRules` | recipe's extension text says "re-emit `touch-scored`" on `game-root` — a listener on the same signal re-emitting it recurses; watch how the agent handles it |

### Arena 2D (`recipe-arena-2d`)

| # | Prompt | Expected edits | Traps |
| --- | --- | --- | --- |
| A1 reskin | "Make the player twice as fast and a bit bigger, hazards red, pickups gold, and make it a 60-second survival — surviving the clock wins." | `PlayerController.speed` ×2, `radius` + `player` sprite `width/height`; prefab tints; `GameRules.winMode: survive`, `timeLimitSec: 60` | enum value spelling (`survive`); radius vs sprite size kept in sync |
| A2 mechanic | "Let me steer with the arrow keys or WASD instead of dragging, and add a short dash on Space." | `PlayerController.mode: keys`; dash added to `scripts/PlayerController.ts` (extension point: locomotion file may be replaced) with a `config` + schema entry | `getButton('Key_Space')` vocabulary; keep the class name/export; keep clamping to `board` |
| A3 node+script | "Add a chaser: a purple blob that appears every 5 seconds and slowly follows the player; touching it costs a life." | new `prefabs/chaser.pix3scene` (Sprite2D + `core:Hitbox2D` group `chaser` + `user:Chaser`); new `scripts/Chaser.ts` steering to `player` world position; new spawner node; `touchRules` += `;chaser:damage:1` | component inside a prefab file (allowed) vs on an instance (not); world vs local coordinates |

### Bouncer 2D (`recipe-bouncer-2d`)

| # | Prompt | Expected edits | Traps |
| --- | --- | --- | --- |
| B1 reskin | "Pastel look instead of neon: soft background, gentler glow, and make the ball heavier and a bit bigger." | `game-background`/`board-floor` colours, placeholder tints; `post-fx.bloomIntensity` down (+ `menu-post-fx`); `BallBody.gravity` stronger, `radius` + `ball` sprite size | PostProcess has flat properties, no transform; do not delete `post-fx` |
| B2 mechanic | "Add a row of bricks across the top that break when the ball hits them, 50 points each." | several box nodes `brick-*` under `walls`; `TouchRules` frees a hit `brick-*` and scores (extension point "Brick field") | volume of YAML (many nodes, unique ids); decoration vs collider grouping |
| B3 node+script | "Replace the paddle with two pinball flippers: left arrow flips the left one, right arrow the right one." | `flipper-left`/`flipper-right` under `paddles`; new `scripts/Flipper.ts` lerping `rotation.z` on `Key_ArrowLeft`/`Key_ArrowRight`; old `paddle` removed or hidden | rotation degrees (YAML) vs radians (script); ids of removed nodes referenced by `GameRules.freezeNodes` / `PaddleController` config |

## What counts as "valid"

A run's result is **valid** when the operator, opening the project in the editor, sees all of:

1. Every changed/new scene opens with no load error (no `SceneValidationError`, no
   "file does not parse" banner).
2. No inert nodes (Scene Tree warn badge / `inert-nodes` lint).
3. After script compilation: no script compile error, no `[SceneLoader] Component type … is
   not registered yet` that persists, no texture/`res://` load error, no
   `Override target … not found`.
4. No property silently dropped: `git diff` every new/changed key and check it against the
   node's / script's schema (inspector shows the value; a key that shows nowhere was
   ignored). Count each one as a **format error**.
5. If the spike's Node validator exists: it reports zero errors.

"**Verified change**" for timing = valid **and** the operator's one Play-mode check of the
asked behaviour (e.g. the combo label counts). Behaviour failures are recorded separately;
they do not fail the format bar, but they are reported next to it.

## Record per run

| Field | How |
| --- | --- |
| `agent`, `recipe`, `task`, `run_id` | |
| `t_first_write` | seconds from prompt submit to the agent's first file write |
| `t_done` | seconds from prompt submit to the agent's "done" message |
| `t_verified` | seconds from prompt submit to a change that passes "valid" + the Play check (if the operator had to report errors back, the clock keeps running; add the turns) |
| `valid_first_try` | yes/no — the first "done" state was valid |
| `format_errors` | count + class (yaml-parse, unquoted-colour, unknown-type, unknown-key, wrong-type, bad-res-path, instance-with-components, prefab-multi-root, duplicate-id, schema-missing, ts-compile, emoji-label) |
| `turns` | user messages until verified (the task prompt = 1) |
| `questions_before_change` | questions asked before the first file write (target 0) |
| `unnecessary_questions` | questions about non-structural things (colour, speed, count) or more than one per turn |
| `did_manual_pass` | did the agent run/attempt `pix3 check`, then do the manual checklist |
| `rule_violations` | whole-scene rewrite, renamed stable id, removed `visible: false`, emoji as art, overlay shown by hand instead of `GameRules.finish` |
| `files_read` | how many files the agent read before its first write (exploration cost) |
| `tokens` / `cost` | if the agent reports them |
| `notes` | anything the kit should have said |

Summary per agent: share of runs with `valid_first_try`, median `t_verified`, total
`format_errors` by class, mean `turns`, total `unnecessary_questions`.

## Optional probes

- **Human-edit probe (rule 2).** Before T3/A3/B3, with the project open in the editor, move
  `score-label` by hand and let it autosave; then give the task. Record whether the agent
  re-read `main.pix3scene` before writing and whether the hand edit survived.
- **Control arm.** Repeat the three tapper tasks with the current overlay
  (`src/templates/agent/**`) instead of the draft kit, to see what the draft buys.

## Decision after the trial

- Pass bar met → Phase 1 builds the generator from `SOURCES.md`.
- Same format-error class in ≥ 3 runs → fix that section of the kit (or the format itself),
  re-run only the failing tasks.
- Behaviour failures dominate while format is clean → the gap is `game_run`/MCP (Phase 3),
  not the kit.
