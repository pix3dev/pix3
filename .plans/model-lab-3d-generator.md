# Model Lab — in-editor 3D asset & scene generator (img2threejs-style)

Status: PLANNED
Reference: https://github.com/hoainho/img2threejs (studied from local copy)

Two lanes share one pipeline skeleton (staged passes + compile/validate + render + vision
review + self-correction), one panel, and one settings surface:
- **Model lane** — reference image → procedural Three.js factory → **GLB** asset.
- **Scene lane** — brief + asset inventory → declarative YAML → **.pix3scene** level.

## What img2threejs actually is

Not a neural image-to-mesh tool. It is an **agent pipeline for reconstruction-by-code**:

1. Vision analysis of one reference image → assessment (object class, complexity, detail
   inventory) → an `ObjectSculptSpec` JSON (component hierarchy, materials, sockets, feature
   review targets).
2. Deterministic validation gates (scripts, no LLM) block shallow specs before any codegen.
3. An LLM writes a **procedural Three.js factory** (`createXModel(): THREE.Group`) one locked
   *build pass* at a time: `blockout → structural → form-refinement → material → surface →
   lighting → interaction → optimization`.
4. After each pass: render → screenshot → side-by-side comparison sheet → **vision model scores
   it** (global + per-feature thresholds) → decision `continue | refine-spec | refine-code |
   request-input | stop`.
5. Prompt knowledge lives in markdown rubrics ("grimoire"): geometry patterns, PBR realism,
   3D vocabulary, attachment rules, self-correction guide.

The upstream repo implements the gates as Python scripts driven by Claude Code. We port the
*concepts* to in-editor TypeScript services — no Python, fully automated inside Pix3.

## Why this fits Pix3 almost 1:1

| img2threejs needs | Pix3 already has |
| --- | --- |
| Vision LLM for analysis/review | `LlmProviderRegistry` + `AgentVisionService` resolution pattern (`supportsImages`) |
| Codegen LLM | Same providers; reasoning-effort knob (`ReasoningEffort`), live catalogs (`LlmModelCatalogService`), bridge providers |
| Compile generated TS in browser | `ScriptCompilerService.bundleVirtualProject` (esbuild.wasm) |
| Render + screenshot loop | A dedicated three.js preview canvas in the panel (own renderer, like sprite-editor owns its canvas); `canvas.toBlob()` |
| Editor tab UI | sprite-editor panel pattern: `PANEL_COMPONENT_TYPES` + lazy import in `LayoutManager`, `EditorTabService.focusOrOpen*`, `Open*Command` in Tools menu |
| Save result into project | `ProjectStorageService.writeBinaryFile`; `MeshInstance` node already loads `res://….glb` |
| Settings persistence | `AgentSettingsService` / `AiImageSettingsService` localStorage pattern; API keys via `SecretStorageService` (reuse existing provider secret ids — **no new key storage**) |

Missing pieces: `GLTFExporter` (add lazy import from `three/examples/jsm/exporters/GLTFExporter.js`),
the pipeline orchestrator, the panel, prompt assets.

## Product shape

**"Model Lab"** — a main-area editor tab (like Sprite Editor). Inside the panel, two tabs,
plus a **lane switch** (Model | Scene) at the top of Generate — both lanes share the preview
viewport, pipeline monitor, controls, and settings; only inputs and save action differ:

### Tab 1 — Generate
- **Inputs** (left column): reference image (drag-drop file, pick from project assets, paste, or
  pull from 2D generation history — text→image→3D chain reuses the existing sprite generator);
  optional text prompt/intent; complexity hint (`simple|moderate|complex`); mode
  (`fast` = 3 passes, `quality` = 6 passes).
- **Live preview** (center): the panel's own three.js viewport with OrbitControls showing the
  *current* compiled model. Every successful compile hot-swaps the Group → the user literally
  watches the model get sculpted pass by pass. Grid + neutral studio lighting.
- **Pipeline monitor** (right/bottom): pass list with per-pass status (locked/running/review/
  passed/failed + fidelity score), streaming log (LLM text deltas, compile errors, review
  verdicts), and the comparison sheets (reference | render side-by-side) per review.
- **Controls**: Start / Pause / Stop; per-review manual override (Accept pass / Retry) so the
  user can steer in real time; iteration cap per pass.
- **Save**: "Save GLB…" → name + folder dialog (mirror `SaveGeneratedAssetDialogService`) →
  writes `assets/models/<name>.glb` (+ optionally `<name>.sculpt.json` and `<name>.factory.ts`
  next to it for later re-editing/re-generation). After save: offer "Add to scene" (creates a
  `MeshInstance` with `src`).

### Tab 2 — Settings
Two model slots, each a provider+model picker identical in UX to the Agent tab picker
(provider select → model select from `LlmModelCatalogService`, pricing hints, reasoning-effort
picker where supported):
- **Codegen model** — writes spec + factory code. Default: agent's selected model.
- **Vision model** — image analysis + pass review. Default: auto-resolve like
  `AgentVisionService` (first provider with key + vision model).
Plus: iteration cap, vision score threshold (default 0.7), default save folder, mode default.

## Architecture

New service domain `src/services/model-gen/`:

- **`Model3DGenSettingsService`** — localStorage prefs (`pix3.modelLabSettings:v1`):
  `codegenProviderId/codegenModelId`, `visionProviderId/visionModelId`,
  `reasoningEffortByModel`, `scoreThreshold`, `maxIterationsPerPass`, `mode`, `saveFolder`.
  Mirrors `AgentSettingsService`; keys delegated to existing provider secret ids.

- **`SculptSpec.ts`** — TS types for the spec (component tree, materials, detail inventory,
  feature review targets, pass states, review history) + a **deterministic validator**
  (port of `validate_sculpt_spec --strict-quality`: depth vs complexity, details mapped to
  components/materials, PBR sanity). Pure functions, unit-tested, zero tokens.

- **`Model3DGenService`** — the orchestrator (headless, DOM-free façade like `AssetGenService`
  so an agent tool / `__PIX3_DEBUG__` lane can drive it later). State machine per generation
  job; emits typed events (`stage-changed`, `log`, `model-updated`, `review-ready`, …) the
  panel subscribes to. Stages:
  1. **Intake** — load reference blob, deterministic probe (dims, alpha) via existing
     `image-ops`.
  2. **Assess** — vision call → assessment JSON (class, complexity, detail inventory).
     MVP scope: `object` (hard-surface) only; `character` returns "not supported yet".
  3. **Spec** — codegen call → SculptSpec JSON → deterministic validate; on failure, one
     self-repair round with validator errors appended.
  4. **Build pass loop** (per unlocked pass):
     a. codegen call → full factory module for the current pass (strict contract below);
     b. `ScriptCompilerService.bundleVirtualProject` → blob-URL import → `createModel(THREE)`;
        compile/runtime errors loop straight back to codegen (cheap, no vision);
     c. instantiate into preview scene (event → panel hot-swaps the Group, and the headless
        path renders offscreen);
     d. screenshot at canonical viewpoint(s) matched to the reference framing;
     e. **`ComparisonSheet.ts`** — canvas composite (reference | render, labels) — port of
        `make_comparison_sheet.py`;
     f. vision review call with the sheet + per-pass rubric → JSON scores + decision;
     g. `continue` → unlock next pass; `refine-code`/`refine-spec` → iterate (capped);
        `stop` → surface the blocker honestly (img2threejs's "cannot reach fidelity" is a
        valid result).
  5. **Done** — final Group retained for export; job summary (passes, scores, token usage).

- **Generated-code contract** (enforced by prompt + post-compile checks):
  - `export function createModel(THREE: typeof import('three')): THREE.Group` — pure factory,
    no imports besides the injected `THREE`, no DOM, no async, deterministic (seeded noise).
  - Materials: `MeshStandardMaterial`/`MeshPhysicalMaterial` only; canvas-generated textures
    allowed (GLTFExporter embeds them as PNG). **No ShaderMaterial** — it wouldn't survive GLB
    export.
  - Geometry: primitives, `ExtrudeGeometry`/`LatheGeometry`/`TubeGeometry`, instancing,
    displacement — the grimoire geometry-pattern recipes.
  - `group.userData.sculptRuntime` (pivots/sockets) kept — it exports into GLB `extras` for
    free and stays useful for rigging later.

- **`Model3DExportService`** — lazy-import `GLTFExporter`, `parse(group, …, {binary: true})`
  → ArrayBuffer → `ProjectStorageService.writeBinaryFile`. Ensure parent dirs (reuse the
  `AssetGenService.ensureParentDirectory` approach). Returns path + byte size.

- **Prompt assets** `src/services/model-gen/prompts/` — the grimoire distilled into lean TS
  string modules (system prompt, geometry patterns, PBR rules, 3D vocabulary, per-pass
  acceptance rubrics, review JSON schema). Stable ordering so the Anthropic cache hint
  (`LlmCacheHint.systemStableChars`) keeps the big prefix cached across the many calls of one
  job.

UI `src/ui/model-lab/`:
- `pix3-model-lab-panel.ts` + `.ts.css` — Lit, Light DOM, `ComponentBase`, IconService icons,
  amber tokens. Owns its `WebGLRenderer` (disposed in `disconnectedCallback`), renders only
  while the tab is visible/animating (respect the on-demand-render philosophy).
- `src/features/editor/OpenModelLabCommand.ts` (`menuPath: 'tools'`, keywords: 3d, model,
  glb, generate…), `EditorTabService.focusOrOpenModelLab()`, `LayoutManager`
  `PANEL_COMPONENT_TYPES.modelLab: 'model-lab'` + lazy import + title/icon.

## Scene lane — generating .pix3scene levels

The same algorithm generalizes cleanly to level generation, with one key simplification: the
LLM's build artifact is **declarative YAML, not a program**. `.pix3scene` is
`root: [{id, type, name, properties, children}]` with node types from the runtime registry and
`res://` asset references — exactly the shape LLMs author reliably, and the runtime
`SceneLoader.parseScene` already gives a free deterministic validator (unknown node types, bad
properties, missing assets) with zero tokens. No esbuild, no code contract.

### Inputs
- **Brief** (text): "a desert canyon arena with a central shrine…", intended camera/gameplay.
- Optional **reference image(s)**: concept art / mood board (drives the vision review the same
  way the model lane's reference photo does; without one, review scores against the brief).
- **Asset inventory** (the palette — this is the piece the model lane doesn't have):
  a deterministic catalog pass over the project enumerates usable building blocks:
  - GLB/GLTF models (`MeshInstance` fodder) — path, byte size, and a **thumbnail** rendered by
    the panel's own preview renderer (load → frame → screenshot, cached per content hash);
  - prefab/sub-scenes (`.pix3scene` usable as instanced children);
  - primitive + light + environment node types (from the runtime node registry — the same
    catalog `docs/nodes-and-systems.md` documents);
  - textures/materials where relevant.
  Thumbnails are captioned once by the vision model ("low-poly sandstone arch, ~4m") and cached
  (IndexedDB, keyed by content hash) so repeated jobs don't re-bill the inventory. The spec
  stage receives the palette as compact text (id, caption, dimensions).

### Pipeline mapping (what changes vs the model lane)

| Stage | Model lane | Scene lane |
| --- | --- | --- |
| Intake | reference photo probe | brief + optional refs + **inventory scan** |
| Spec | ObjectSculptSpec (components/materials) | **LevelSpec**: zones/areas with bounds + purpose, palette assignment (which assets dress which zone), lighting plan, camera intent, navigation/flow notes |
| Build passes | blockout → structure → form → material → lighting → optimization | **layout-blockout** (ground, zone volumes from primitives) → **major placement** (hero assets, architecture) → **set dressing** (props, repetition/scatter with seeded jitter) → **lighting & atmosphere** (lights, env, post) → **polish** (camera, cleanup) |
| Artifact per pass | factory TS module | full scene YAML (small scenes) or **node-ops patch** (add/move/reparent/set-property ops applied to the working graph) once scenes outgrow whole-file regeneration |
| Compile gate | esbuild + blob import | `SceneLoader.parseScene` + asset-path existence check + property-schema validation |
| Render | panel preview, single canonical view | panel preview via runtime SceneLoader/SceneService; screenshots from **multiple viewpoints per review**: top-down orthographic (layout legibility) + the scene's own Camera3D view + 1–2 orbit shots |
| Review rubric | silhouette/details/PBR vs photo | composition, zone coverage, asset variety/repetition, scale sanity (door ≈ 2m), lighting mood vs brief; per-zone feature targets from the LevelSpec |
| Output | GLB via GLTFExporter | `.pix3scene` text via `ProjectStorageService.writeTextFile` → openable as a normal editor scene tab immediately; LevelSpec JSON saved alongside for regeneration |

### Scene-lane specifics
- **Determinism**: scatter/repetition is expressed as explicit node lists in the YAML (the LLM
  emits them), or via a tiny deterministic expander in the pipeline ("scatter N of X in zone Y,
  seed S" → nodes) to keep token cost flat for large prop counts. The expander output is
  ordinary nodes — the saved scene has no runtime dependency on Model Lab.
- **Iteration efficiency**: passes 2+ send only the LevelSpec + a compact tree digest
  (id/type/name/position per node) instead of the full YAML back into context; the vision sheet
  carries the visual state. Node-ops patches keep edit turns cheap.
- **Editing existing scenes** (post-MVP): open a scene as the starting graph and run set-dressing
  or lighting passes over it — same ops path, review vs "before" screenshots.
- **Synergy chain**: 2D generator (concept/reference) → model lane (missing building blocks as
  GLB) → scene lane (assembly). The scene lane's spec stage can flag "palette gap: no bridge
  asset" and suggest a model-lane job for it.
- **Relation to the in-editor agent**: the agent's scene tools already mutate the *live* editor
  scene through commands/undo. The scene lane deliberately stays sandboxed (own preview, own
  file output) like the model lane — no undo-history coupling, no risk to the user's open scene;
  the user opens the generated file when satisfied. Shared prompt assets (node catalog, scale
  conventions) live in one place so agent and Model Lab don't drift.

## Cost & loop control

Per pass ≈ 1 codegen + 1 vision call (+ compile/validate-error retries, codegen-only).
`quality` mode (6 passes: blockout, structure, form, material, lighting, optimization) ≈
12–16 calls/job; `fast` mode (blockout, form+material merged, final review) ≈ 6–8. Iteration
cap per pass (default 3) prevents runaway refine loops; every review verdict is shown live so
the user can Accept/Stop early. Token usage surfaced per job (LlmUsage aggregation).

Scene lane: same shape (5 passes ≈ 10–14 calls) + a one-time inventory captioning cost that
amortizes across jobs via the caption cache. Multi-viewpoint review sends 2–3 images per
review call instead of 1.

## Phases

1. **Skeleton + plumbing proof** — panel/tab/command wiring, Settings tab with both pickers
   (reuse agent picker markup), preview viewport, GLB export of a hardcoded test Group saved
   into the project and loaded via MeshInstance. *Proves the whole non-LLM chain end-to-end.*
2. **Single-shot generation** — intake → assess → spec → ONE full factory generation →
   compile → preview → manual save. No review loop yet; errors loop back to codegen.
3. **Pass-gated review loop** — pass state machine, screenshots, comparison sheets, vision
   scoring, self-correction decisions, manual overrides, streaming log.
4. **Polish + integration** — job history (IndexedDB, mirror `GenerationHistoryService`),
   save spec/factory alongside GLB + "Regenerate from spec", "Add to scene" action, agent
   tool (`generate_model_3d`) + `__PIX3_DEBUG__` lane, docs (`docs/nodes-and-systems.md`
   note + spec bump).
5. **Scene lane MVP** — lane switch in the panel, asset inventory scan + thumbnail/caption
   cache, LevelSpec stage, whole-file YAML generation with `SceneLoader.parseScene` validate
   gate, preview via runtime scene loading, multi-viewpoint review, save `.pix3scene` +
   "Open in editor". Reuses the Phase-3 pass/review machinery as-is.
6. **Scene lane depth** — node-ops patch editing (large scenes), deterministic scatter
   expander, editing existing scenes, palette-gap → model-lane handoff, agent tool
   (`generate_scene_3d`).

Deferred (post-MVP): character/anatomy track, likeness projection, texture baking from the
reference photo, SkinnedMesh/rig export, LOD generation.

## Risks / notes

- **GLB fidelity**: GLTFExporter bakes standard-material scenes well; canvas textures embed as
  PNGs; `userData` → `extras`. The code contract above exists precisely to keep everything
  exportable. Verify early (Phase 1) on Windows-ARM/ANGLE.
- **Vision honesty**: cheap vision models over-approve. Threshold + per-feature rubric in the
  review prompt, and the user sees every sheet live — manual Reject is one click.
- **Generated code safety**: same trust level as existing in-editor user scripts (esbuild →
  blob import). Factory gets only `THREE`; no runtime/window access in the prompt contract,
  and it runs in the panel's isolated scene, not the user's document.
- **Preview ≠ editor viewport**: the panel owns its renderer; no `ViewportRenderService`
  coupling, no proxy-visual work needed (this is NOT a scene-tree node until the GLB is saved
  and instantiated via MeshInstance).
- **Reference framing**: MVP renders the model from a default 3/4 view; camera-matching to the
  reference (img2threejs `solve_camera_pose`) is a quality booster we can add in Phase 3 by
  asking the vision model for approximate azimuth/elevation during Assess.

## Backlog (post Phase-6, not scheduled)

Status of the plan: Phases 1–6 (core, minus node-ops) shipped on `feat/scene-per-level` /
`worktree-model-lab-3d`. Everything below is unscheduled backlog captured 2026-07-23.

### B0. Neural image→3D provider (the priority direction)
Honest assessment from real use: the **procedural reconstruction-by-code** approach (our whole
model lane + img2threejs) is NOT production-quality for models next to **dedicated 3D-generation
models**. A side-by-side with Copilot "Experiments" (image→3D) produced an order-of-magnitude
better GLB (clean stylized house) than our procedural output. Direction: add a **neural
generation mode** to Model Lab that calls a specialized image→3D (and/or text→3D) service and
gets a GLB back directly.
- **Copilot Experiments itself is not a public API** — but the same capability is available via
  metered 3D-gen APIs: Meshy, Tripo (TripoSR/Tripo3D), Rodin/Hyper3D, Luma Genie, Stability
  SF3D, CSM.ai, Kaedim, etc. Most are REST: POST image (or text) → poll → download `.glb`.
- **Architecture fit is excellent** — it slots into the EXISTING chain: image → provider API →
  GLB bytes → `Model3DExportService`/`ProjectStorageService.writeBinaryFile` → `MeshInstance` →
  add to scene. Only the *generation step* changes; save/preview/add-to-scene are already built
  (Phase 1). No procedural code contract, no esbuild, no per-pass review needed for a neural GLB.
- **Shape:** a generation-provider abstraction so **Procedural (code)** and **Neural (API)**
  coexist — a mode toggle (or a third lane) in the panel. A `Model3DGenProvider` interface
  (`generate(image|prompt) → GLB blob + metadata`) with a procedural impl (current pipeline
  wrapped) and one-or-more neural impls. Reuse the panel preview (load the returned GLB via
  `GltfBlobLoader`), Save, Add-to-scene, and history.
- **Keys off the browser:** a metered 3D-gen provider key belongs in `pix3-agent-bridge`'s
  credential-injecting proxy (same pattern as OpenAI/Anthropic/Zen) — editor registers it as a
  dynamic provider; the browser never sees the key. (Direct-with-CORS providers could be static
  like Gemini, but the bridge proxy is the safer default.)
- **Open questions:** which provider(s) to support first (licensing/ToS for commercial game
  assets, cost per model, poll latency, GLB quality/topology, PBR vs vertex-color output,
  attribution); async job UX (poll + progress in the panel); text→3D vs image→3D vs image+text.
- Procedural lane stays useful for: no-API-key / offline, fully-deterministic + diffable output,
  and as the img2threejs-style "understandable code" path — but neural should likely become the
  DEFAULT for "I just want a good model".

### B1. Model-lane fidelity (procedural) — from img2threejs main + v1.3
Only worth doing if we keep investing in the procedural path (see B0). Ranked by value/cost:
- **Camera-pose match** (`solve_camera_pose`) — ask vision for approx azimuth/elevation at Assess;
  render the review shot from that pose so vision compares like-for-like. *High / low.*
- **CIEDE2000 (ΔE00) color gate + reference color sampling** (v1.3) — pure-TS perceptual color
  metric (sRGB→CIELAB→ΔE00) + band-median color sampling from the reference; use as a
  **deterministic, token-free** color check in review and to feed the material pass real colors.
  *High / low.*
- **Detail-inventory → component gate** (`build_detail_inventory` + strict-quality) — force the
  spec to map identity-defining details (eyes, ornament, gloss) to components before codegen;
  block shallow specs. *High / medium.*
- **Real `refine-spec`** — re-run the spec stage with feedback instead of folding into
  `refine-code` (fixes structural, not just parametric, misses). *High / medium.*
- **PBR evidence + de-light** (`extract_pbr_evidence`, `delight_albedo`) — derive
  color/roughness/metalness from the reference, remove baked lighting. *Medium / medium.*
- **Per-feature acceptance policy** (`feature_acceptance_policy`) — gate on per-feature scores,
  not just global. *Medium / low.*
- **Texture projection** (`bake_projected_texture`) — project the reference photo onto geometry
  (canvas texture, GLB-compatible) for "looks like the photo" fidelity. *High value / high cost.*
- **Character/anatomy track** (`grimoire/character/*`, v1.2) — unlock characters/organics.
  *High / very high.* (Neural (B0) likely a better answer for characters.)
- Minor recipes: `Shape.holes`/oval cutout extrusion, InstancedMesh single-draw hint (we have
  `InstancedMesh3D`), candy/anodized material classification, Divine-Eye color diagnostics
  (Hue-Zone-Parity / Specular-Wash, report-only). *Low.*
- **Suitability gate** — reject non-viable reference images before spending tokens. *Low / low.*

### B2. Scene-lane depth — node-ops patch editing (deferred from Phase 6)
Incremental large-scene edits via an op-list (`create`/`set`/`move`/`convert`) applied to the
working graph instead of whole-file YAML regeneration, once scenes outgrow whole-file regen.
Keeps token cost flat for big levels. Whole-file regen works for MVP-sized scenes today.

### B3. Scene-lane inventory captions (deferred from Phase 5)
Vision-caption GLB/prefab thumbnails once, cached in IndexedDB by content hash, and feed the
captions to the LevelSpec stage so the generator knows what each asset *looks like* (MVP passes
only path + dims + category).
