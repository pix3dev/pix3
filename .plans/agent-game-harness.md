# Agent Game-Prototyping Harness — Implementation Plan

**Goal (ИКР):** a lazy user opens a template project with a GDD + reference image in `design/`,
sends 2–4 short messages to the in-editor agent (weak-but-cheap coding model like DeepSeek v4),
and gets a **playable prototype with decent generated art**. The harness — tools, prompts,
skills, presets — does the heavy lifting so the model doesn't have to be smart.

**Design principle:** move intelligence out of the model into deterministic tools and
checklist-style knowledge. Weak models follow explicit recipes well; they fail at open-ended
planning and at visual judgment. So: (a) tools produce game-ready output by default,
(b) skills give step-by-step recipes, (c) a vision sidecar gives text-only models "eyes",
(d) an eval loop lets us tune prompts per model against real outcomes.

Status quo (verified in code, 2026-07-14):

- `AgentToolRegistry` (25 tools) — `generate_asset` calls `AssetGenService.generate()` → `save()`
  directly; **no bg-removal, no trim, no downscale default** even though `AssetGenService`
  already implements `removeBackground()`, `crop()`, `resize()`, `compress()`
  (`src/services/AssetGenService.ts`). The 256px preview is taken from the **original**
  handle, not the saved/processed one (`AgentToolRegistry.generateAsset`).
- Tool-emitted images (`AGENT_TOOL_IMAGES_KEY`) are appended to the next user turn
  **unconditionally** — no gating on `model.capabilities.supportsImages`
  (`AgentChatService.runLoop`). DeepSeek v4 (Zen) is `supportsImages: false`.
- System prompt (`AgentChatService.buildSystemPrompt`) = generic rules + AGENTS.md (≤16k)
  + scene outline. No game-workflow knowledge, no skill index.
- Template infra already copies an agent overlay into every new project
  (`src/templates/agent/` → AGENTS.md, CLAUDE.md, design/README.md, `.claude/skills/**`)
  via `ProjectTemplateService`. It targets **external** agents (hand-edit YAML), which
  partly contradicts the in-editor system prompt ("never hand-edit scene files").
- `window.__PIX3_DEBUG__` exposes `assets` (AssetGenService) but **not** the agent chat —
  no way to drive/eval the embedded agent programmatically.

---

## P0.1 — Game-ready asset pipeline in `generate_asset` (biggest visible win)

Files: `src/services/agent/AgentToolRegistry.ts`, `src/services/AssetGenService.ts`,
`src/services/image-gen/image-ops.ts` (+specs).

1. **New image op `trimImageBlob`** in `image-ops.ts`: scan the alpha channel for the opaque
   bounding box, crop with configurable padding (default ~2px). Deterministic, canvas-based,
   same style as `cropImageBlob`. Expose as `AssetGenService.trim(id, {padding})`.
2. **`postProcess` presets on the `generate_asset` tool** (enum param, described so the model
   picks correctly):
   - `sprite` (default when `transparent: true`): bg-removal (worker, engine/quality from
     prefs) → trim to alpha bbox → downscale to `maxSize`.
   - `icon`: like `sprite` + pad to square (centered) so icon grids align.
   - `texture` / `background`: no bg-removal, downscale only.
   - `none`: raw save (today's behavior).
3. **Default `maxSize`** from `AiImageSettingsService.getPreferences().defaultSaveMaxSize`
   when the arg is omitted — never write 2–3k px originals into the project silently.
   Report `original` vs `saved` dimensions in the result JSON.
4. **Fix preview**: preview the handle that was actually saved (post-processing), not the
   raw generation.
5. **New tool `process_asset`**: apply the same pipeline (bg-removal/trim/resize/re-encode)
   to an **existing** project image (`AssetGenService.open()` → transforms → `save()`).
   Lets the agent repair earlier bad assets and process user-imported ones.
6. Update the `generate_asset` tool description to teach the recipe: "for sprites/icons
   request `transparent: true` and mention 'single object, centered, plain background'
   in the prompt".

Success: a one-line user ask ("сделай спрайт машины") produces a trimmed, alpha-transparent,
≤defaultSaveMaxSize PNG that looks correct when applied to a Sprite2D.

## P0.2 — Vision sidecar: give text-only coding models eyes

Files: `src/services/agent/AgentChatService.ts`, `AgentToolRegistry.ts`,
`AgentSettingsService`, agent panel settings UI.

1. **Gate tool-emitted image blocks** on the active model's `supportsImages`. For text-only
   models: don't attach the image; replace with a text note
   `"(image captured — this model has no vision; call analyze_image to inspect it)"`.
   Keep attachments gating in the panel as is (already checks supportsImages).
2. **New tool `analyze_image`**: `{ source, question }` where `source` is a project path
   (`res://…`), `"viewport"` (fresh screenshot), or a generation handle id. Sends the image +
   question to a **vision helper model** and returns its text answer.
   - Settings: a "vision helper" provider/model pick in agent settings (default: first
     configured provider whose selected model has `supportsImages`, prefer a cheap one —
     Gemini Flash-Lite tier). Reuses the same key store (`AgentSettingsService.getApiKey`).
   - Implementation is a one-shot `provider.chat()` with the image block + question, no tools.
3. Recipe (encoded in the P0.3 skill, not code): before generating art, run `analyze_image`
   on `design/references/*` with a fixed question ("list style tokens: palette hex, rendering
   style, lighting, camera angle — as a comma list for an image prompt") and reuse the answer
   in every `generate_asset` prompt → **style consistency across assets**.

Success: with DeepSeek v4 selected, the agent can QC its own generated sprite and check the
viewport layout (via the sidecar) without the user switching models.

## P0.3 — Built-in skills (knowledge packs) for the in-editor agent

Files: new `src/services/agent/agent-skills/` (md files bundled via `?raw` import, same
pattern as templates), `AgentChatService.buildSystemPrompt`, `AgentToolRegistry.ts`;
`src/templates/agent/AGENTS.md` (harmonize).

1. **Mechanism**: editor-shipped markdown packs + a `read_skill` tool
   (`{ id, section? }` — return whole file or one `##` section; keeps results under the 24k
   truncation). System prompt gets a 3–5 line index: `id — when to use` and the rule
   "when the task matches, read the skill BEFORE acting".
2. **Packs** (each ≤150 lines, imperative checklists, written for weak models):
   - `game-prototype`: the GDD→prototype loop. Read `design/` → restate the game in 5 bullets →
     build in increments (screen flow → core mechanic → win/lose → polish), verify each
     increment (`play_start` → `read_errors` → fix) before the next; placeholder-first art
     policy (ColorRect2D until mechanics work), art generation last.
   - `asset-generation`: style-token extraction via `analyze_image`, prompt recipe per asset
     kind, `postProcess` preset choice, naming (`src/assets/textures/<kind>/<name>.png`),
     applying to nodes (which property paths take `res://` textures).
   - `verify-and-fix`: the debugging loop — `play_status`/`read_errors`/`read_logs`/
     `check_scripts`, common runtime error patterns and their fixes.
   Source material: condense from `src/templates/agent/skills/pix3-game-dev/SKILL.md` and
   `docs/nodes-and-systems.md` — do not duplicate the full catalog; the packs teach *process*,
   `list_component_types`/`node_inspect` supply the *facts*.
3. **Harmonize the template `AGENTS.md`**: keep it as the project-specific hook (GDD location,
   art style notes, project conventions), strip the external-agent YAML-editing instructions
   into a separate section explicitly labeled "external file-editing agents only", so the
   in-editor agent doesn't pick up contradictory rules.

Success: the same one-line prompt produces a structured multi-increment build instead of a
single-shot scene dump; behavior is steerable by editing md files, not code.

## P0.4 — Eval harness: drive the embedded agent programmatically

Files: `src/core/debug-bridge.ts` (+ a scenario checklist doc, no product UI).

1. **Expose the agent on the debug bridge**: `__PIX3_DEBUG__.agent = { send(text), stop(),
   newConversation(), getState(), setProvider(id, modelId) }` where `send()` resolves when
   status returns to `idle`/`error` (subscribe + promise). Mirrors how `assets` is exposed.
2. **Scenario suite** (doc in `.plans/agent-eval-scenarios.md`, executed by Claude via
   chrome-devtools MCP — no in-editor runner needed yet):
   - S1 "каркас по GDD" → expect: screens exist in scene_tree, scripts compile, play w/o errors.
   - S2 "спрайт из референса" → expect: alpha channel present, trimmed bbox ≈ content,
     ≤maxSize, node texture set, style tokens visible in the generate prompt (from history).
   - S3 "играбельный прототип" (multi-turn) → expect: play_start, input moves the player,
     win/lose reachable, no captured errors.
   Judge = external Claude: inspect via `__PIX3_DEBUG__` + scene_tree + screenshots; record
   pass/fail + failure notes per model (DeepSeek v4 / Gemini Flash / Cerebras) in the doc.
3. Iterate: failures feed edits to P0.1 tool descriptions and P0.3 skill texts. This loop is
   the mechanism the user asked for ("test the external agent, compare expected vs actual,
   adjust prompts/presets").

## P1 (after P0 proves out)

- **P1.1 Sprite-sheet multi-gen**: `generate_asset` variant generating an N×M grid in one
  image ("uniform grid, N items, plain background") → deterministic slice (`cropImageBlob`)
  → per-cell trim → N files. Amortizes generation cost for icon sets / button states.
  Run the eval first — grid-layout reliability varies by image model.
- **P1.2 Game-canvas screenshot**: capture the *running* game (Game tab canvas), not just the
  edit-mode viewport — completes the verify loop visually. Extend `viewport_screenshot`
  with `target: 'game'` or add `game_screenshot`.
- **P1.3 Downscale quality**: stepped-halving resize in `image-ops` for crisper sprites;
  WebP default for backgrounds; per-project size budget warning in save results.
- **P1.4 Routing presets in the panel**: one-click combos ("Coding: DeepSeek v4 + Vision:
  Gemini Flash-Lite"), cost/1M shown (already in catalog), persisted per project.
- **P1.5 Prompt hardening for weak models**: few-shot tool-call examples in the system prompt
  when the selected model family is known to fumble arguments; richer self-repair hints in
  tool error strings (partially exists).

## Rejected / deferred

- In-editor multi-agent orchestration (planner + coder) — complexity not justified before
  P0.3/P0.4 data exists.
- Embedding/RAG knowledge base — curated skills + `read_skill` beat it at this corpus size.
- Simulated input driving for gameplay tests — revisit after P1.2.

## Verification (per phase)

- Unit: image-ops trim/pipeline specs; AgentToolRegistry spec additions (postProcess branches,
  process_asset, analyze_image arg validation); ChatService spec for image gating.
- E2E: run the S1–S3 scenarios via the debug bridge on at least DeepSeek v4 + one vision model;
  compare against the pre-change baseline (current template behavior).
- `npm run lint` / `type-check` / `vitest run` per repo conventions (mind the CRLF gotcha).
