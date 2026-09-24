# Agent harness eval scenarios

How to test the in-editor agent harness (P0.1–P0.3) against real models and compare expected
vs actual, so tool descriptions / skill packs can be tuned per model. The judge is an external
Claude driving the running editor through the `chrome-devtools` MCP; the agent under test is the
in-editor agent (a cheap model like DeepSeek v4 on Zen).

## Setup

1. Dev server running, editor open in the MCP-attachable Chrome, a project loaded from the
   `minigame-2d` (or similar) template with a GDD + reference image in `design/`. Note the
   template now ships **separate scenes**: `main.pix3scene` is the gameplay scene (the editor's
   startup scene — what opens first and what `play_start` runs), and `menu.pix3scene` is the
   build entry (PLAY transitions to the game via `scene.changeScene`). So the agent builds the
   game in `main` and plays it directly, without a menu in the way.
2. An image-generation key configured (Asset Generator) and an LLM key for the model under test.
3. Everything is driven through `window.__PIX3_DEBUG__.agent` (see `debug-bridge.ts`, version ≥ 3)
   via the MCP `evaluate_script` tool.

## Driver primitives (evaluate_script)

```js
const D = window.__PIX3_DEBUG__;
D.agent.setProvider('opencode-zen', '<deepseek-model-id>');   // model under test
D.agent.setVisionHelper('opencode-zen');                       // '' modelId = auto-pick a vision model
D.agent.setAdvisor('cerebras', 'zai-glm-4.7');                 // ask_advisor target ('' = off)
await D.agent.newConversation();
const summary = await D.agent.send('собери каркас игры по GDD в main сцене');  // resolves when the loop ends
D.agent.transcript(40);        // texts + tool calls/results the model produced
D.scene(4);                    // resulting scene tree
D.errors();                    // captured runtime errors
D.agentTools.execute('play_status');
```

`agent.send()` resolves only when the whole agentic loop finishes (or errors — captured into
state, never thrown). Read `summary.status` (`idle`/`error`), `summary.lastAssistant`,
`summary.totalUsage`, then `transcript()` for the tool trace.

## Scorecard — the deterministic judge (bridge ≥ v5)

`D.eval.run(spec)` replaces the hand-driven expectation tables: after `agent.send()` finishes,
run a JSON spec of typed checks and get a reproducible pass/fail report. No LLM judgment
anywhere — checks measure the tool trace, scene graph, compile diagnostics, captured errors,
live gameplay (`game_input`/`game_observe`) and image alpha stats. `D.eval.checkKinds()` lists
the vocabulary; the engine is `src/core/agent-eval.ts`.

```js
const report = await D.eval.run(S1_SPEC);   // { name, ok, passed, failed, checks: [{label, pass, detail}], agent }
```

Checks run **in order** (play checks change state: they start/stop play mode themselves).
The report's `agent` footer carries status/notice/tokens for the results table. The judge's
remaining job is what the scorecard can't measure: reading the transcript for *process*
quality (churn, over-delegation to the advisor, ignored skill advice) and judging content
beyond binary checks. Judge each step as it lands — don't wait for the end of the run.

Ready-made specs for the Ring Racing template project (adjust node/file names per project):

```js
const S1_SPEC = { name: 'S1 каркас по GDD', checks: [
  { kind: 'tool-called', tool: 'read_skill', inputMatch: 'game-prototype', withinFirstCalls: 6 },
  { kind: 'file', path: 'design/progress.md', contains: '[' },       // plan written down
  { kind: 'compile-clean', typeCheck: true },
  { kind: 'node-exists', name: 'Player Car' },
  { kind: 'node-component', node: 'Player Car', componentType: 'user:' },
  { kind: 'play-clean', settleMs: 2000 },
]};

const S2_SPEC = { name: 'S2 спрайт из референса', checks: [
  { kind: 'tool-order', first: 'analyze_image', then: 'generate_asset' },
  { kind: 'tool-called', tool: 'generate_asset', inputMatch: '"transparent":\\s*true' },
  { kind: 'asset', path: 'src/assets/textures/player_car.png', requireAlpha: true, maxDimension: 1024 },
  { kind: 'node-property', node: 'Player Car', property: 'texture', matches: '^res://.*player_car\\.png$' },
]};
// + content QC stays on the judge: D.assets.open(path) → preview → your own eyes
// ("exactly ONE car, no scene?") — the scorecard proves mechanics, not art content.

const S3_SPEC = { name: 'S3 играбельный прототип', checks: [
  { kind: 'tool-called', tool: 'read_errors' },                       // verify loop ran
  { kind: 'compile-clean', typeCheck: true },
  { kind: 'play-clean', settleMs: 2000, keepPlaying: true },
  { kind: 'input-moves', steps: [{ type: 'key', code: 'ArrowUp', ms: 1500 }],
    observe: ['Player Car'], keepPlaying: true },
  { kind: 'observe-moving', nodes: ['AI Car 1'], sampleMs: 1500 },    // stops play (last gameplay check)
  { kind: 'no-errors' },
]};
```

Paste a spec + `D.eval.run(...)` into one `evaluate_script` call. On failure, `detail` carries
the evidence (`AI Car 1: did NOT move`, `compile failed: … (scripts/Car.ts:127)`) — that string
goes straight into the results table and points at what to tune.

## Scenarios

### S1 — "каркас по GDD" (structure + behaviour, no art)
Prompt: *"Прочитай design/ и собери играбельный каркас в main сцене."*
Expect:
- `transcript()` shows a `read_skill('game-prototype')` call early (skill index worked).
- Scripts created via `fs_write` + `compile_scripts` returns ok (no compile errors).
- `D.scene()` shows the expected screens/nodes wired; behaviour attached via components.
- `play_start` then `D.errors()` is empty; `play_status().isPlaying === true`.
Fail signals: skipped read_skill; compile errors left unfixed; runtime errors on play.

### S2 — "спрайт из референса" (art pipeline + vision)
Prompt: *"Сгенерируй спрайт машины в стиле референса и поставь его на Player Car."*
Expect:
- Model calls `analyze_image` on the design reference (text-only model has no other way to see it)
  and reuses style tokens in the `generate_asset` prompt.
- `generate_asset` called with `transparent:true` and `postProcess` `sprite` (or default).
- Saved file: has alpha, trimmed to content (saved dims << original dims in the result),
  ≤ project default maxSize. Verify via `D.assets.open(path)` → `preview` → `analyze_image`
  ("transparent, centered, not cropped, no leftover background?").
- The Player Car node's texture property is set to the saved `res://…` path.
Fail signals: raw full-size image saved; background left in; texture not applied; no analyze_image
and the model "pretended" to see the reference.

### S3 — "играбельный прототип" (multi-turn end-to-end)
Turns: build → *"запусти и почини что не работает"* → *"добавь условие победы/поражения"*.
Expect across turns:
- `verify-and-fix` skill read; `play_start` → `read_errors` loop visible in transcript.
- Input actually drives the player (inspect via `D.liveFind` during play, or game debug surface).
- A reachable win/lose state; no captured errors at the end.
Fail signals: declares done without running; never reads errors; win/lose unreachable.

### Advisor as an eval knob

`ask_advisor` (bridge ≥ v4) lets the model under test consult a stronger model (stateless, one
Q + caller-passed context per call). Run S1/S3 in three configurations — advisor off /
`cerebras zai-glm-4.7` / a Claude model — and compare pass rate, tokens, and advisor-call count
(visible in `transcript()`). Expected failure modes to watch: over-delegation (advisor called for
routine steps), vague questions with empty context (generic advice), ignoring the advice.

## Recording results

For each (model, scenario) run, note in a table: pass/fail per expectation, tokens
(`summary.totalUsage`), wall-feel, and the specific failure. Failures feed edits to:
- **Tool descriptions** (`AgentToolRegistry`) when the model misuses a tool or wrong args.
- **Skill packs** (`src/services/agent/agent-skills/*.md`) when the *process* went wrong.
- **System-prompt rules** (`AgentChatService.buildSystemPrompt`) when it ignored a skill.

Re-run after each edit; keep the winning presets/prompts. This is the tuning loop.
