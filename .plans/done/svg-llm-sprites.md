# SVG sprites via the agent LLM (svg-llm image provider)

## Idea

For fast iteration, many sprites don't need a text-to-image model (nanobanana): schematic /
flat-vector graphics can be authored as **SVG by an LLM** and baked into a normal **PNG with real
alpha**. Wins over raster gen models:

- **Exact output size** — the caller asks for 96×32 and gets 96×32, no aspect-ratio lottery,
  no downscale pass.
- **Transparency for free** — no bg-removal worker, no ISNet artifacts.
- **Deterministic edits** — the SVG source is code; "make the outline thicker" is a small
  source edit, not a re-roll (same philosophy as the img2threejs Model Lab: asset = code).
- **Seconds and cents** — an LLM text completion vs. a metered image model.
- **Re-bake at any size** — keep the source, rasterize again at 2× later.

## Where it slots in: a new `ImageGenProvider`

Implement `svg-llm` as a fourth provider in `ImageGenProviderRegistry` (next to Gemini / OpenAI /
Strophe). Everything downstream then works for free: the Generate panel, the sprite editor,
`GenerationHistoryService`, `AssetGenService.postProcess/save`, the agent's `generate_asset` tool
(it already accepts `providerId`/`modelId` overrides) and `__PIX3_DEBUG__.assets`.

The provider owns **no API key and no model catalog of its own** — it delegates to the *LLM* stack:
the provider list is `LlmProviderRegistry`, the model list comes from `LlmModelCatalogService`
(filter: `supportsImages` not required for text-only gen, required for style references), and the
default pick is `AgentSettingsService.getSelectedProvider()` — i.e. "whatever the agent chat is
using right now" (bridge lanes included). Claude via the bridge is notably good at SVG.

### Contract extensions (small, backward-compatible)

- `ImageGenProvider.requiresApiKey?: boolean` (default `true`). For `svg-llm` it is `false`:
  `AssetGenService.generate` / the panel skip the key check; `status()` reports `keyConfigured`
  as "an LLM provider with a key/bridge is available".
- `GenerateImageParams.width?/height?: number` + `ImageModelCapabilities.supportsExactSize:
  boolean` (false for all raster providers). When exact size is supported the UI swaps the
  aspect-ratio picker for W×H inputs.
- `ImageGenProviderRegistry` constructs providers with `new` today; it is already `@injectable`,
  so inject the LLM-side services there and pass them into the `SvgLlmImageProvider` constructor.

## Generation pipeline (`SvgSpriteGenerator`, the provider stays thin)

1. **Prompt.** System prompt pins the contract: exactly one `<svg>` root with
   `viewBox="0 0 W H"`, transparent background (no full-bleed rect unless asked), **no**
   `<script>`, `<foreignObject>`, external `href`/`xlink:href`, `on*` attributes or CSS `url()`
   to external resources; text only via generic font families (SVG-as-image cannot load fonts);
   style guidance: flat vector game art, clean shapes, limited palette.
2. **Style references (the img2threejs move).** When the selected LLM model
   `supportsImages`, pass reference sprites from the project as image blocks: "match this
   palette / stroke weight / shading style". This reuses the existing `references` plumbing of
   `GenerateImageParams` — the provider converts them to `LlmMessage` image content.
3. **Call** `llmProvider.chat()` with the agent's selected model (per-call override via
   `modelId` in the form `"<llmProviderId>/<llmModelId>"`, since image-gen `modelId` is a single
   string).
4. **Extract**: fenced ```svg block or the first `<svg…</svg>` span. Parse with `DOMParser`
   (`image/svg+xml`), detect `parsererror`. On failure: one retry appending the parser error to
   the conversation.
5. **Sanitize** (`svg-render.ts`): strip `<script>`, `<foreignObject>`, event attributes,
   external references. Belt-and-suspenders — the rasterizer below already runs in the
   browser's restricted SVG-as-image mode (no scripts, no external loads), but we also keep the
   source around, so it must be clean.
6. **Rasterize**: blob URL → `<img>` decode → canvas `drawImage` at exactly W×H → PNG with
   alpha → `GeneratedImage`. No supersampling needed (vector-crisp at any size). Guard: if the
   SVG has no `viewBox`, inject one from its width/height attributes before rendering.

## SVG source is a first-class artifact

- Extend `AssetImage` (handle) and the `GenerationHistoryService` record with optional
  `svgSource: string`.
- **Edit loop**: regenerating from a handle that has `svgSource` sends the *source* + the user's
  feedback to the LLM ("here is the current SVG, change X") — deterministic edits instead of a
  raster re-roll. In the panel this is the existing edit/reference flow; the provider detects an
  SVG-source reference and switches to edit mode.
- **Re-bake**: a `rasterizeSvg(source, w, h)` path lets a handle be re-baked at a new size
  without touching the LLM.
- Optional save toggle: write the `.svg` next to the `.png` (default off; project stays PNG-only
  unless the user opts in).

## Post-process interaction

`postProcess('sprite'|'icon')` must **skip background removal** when alpha is already real —
cheap check via existing `imageAlphaStats` (or a flag on the handle when `source === 'generated'`
by svg-llm). Running ISNet over a clean vector PNG only damages it. Trim/resize still apply
(usually no-ops because the size was exact).

## UI (Generate panel + sprite editor)

- Provider picker gains "SVG (Agent LLM)"; model picker lists the LLM catalog with the agent's
  current selection preselected; price hint = token pricing from `LlmModelPricing` or "LLM
  tokens".
- When the selected provider `supportsExactSize`: show W×H number inputs (with common presets
  64/128/256/512 and a lock-ratio toggle) instead of aspect ratio + image size.
- Result card shows an "SVG" badge; a source viewer (read-only `<pre>` or Monaco lite) with
  copy — hand-tweaking is a power-user affordance, not required for v1.
- No key nag for this provider; if no LLM is reachable, show the same "configure a provider in
  Agent settings" hint the chat uses.

## Agent tool + skills

- `generate_asset`: pass through `width`/`height`; document in the tool description: "for
  schematic/placeholder/UI graphics prefer providerId 'svg-llm' — exact size, real alpha,
  fast/cheap; use raster models for painterly art".
- Update `game-prototype` / `flow-increment` skills: placeholder art phase should default to
  svg-llm, upgrade to nanobanana later.

## Phase 2 (optional, after v1 proves out)

- **Vision refine loop** (img2threejs-style): rasterize → show the PNG to a vision model
  (`analyze_image` sidecar) → critique → source edit → repeat N≤2. Panel button "Refine";
  the in-editor agent already does this organically via preview.
- **State variants from one source**: generate a Button2D normal/hover/pressed/disabled set by
  asking the LLM for parameterized edits of the same SVG — far more consistent than four raster
  rolls.
- **Sprite sheets**: one SVG with a grid of cells, baked and sliced.

## Testing

happy-dom has no real canvas/`Image` decode — keep rasterization behind one function and unit-test
the pure parts: SVG extraction (fences, bare tag, garbage), sanitizer (script/foreignObject/on*/
external href removal), viewBox injection, prompt building, edit-mode detection. Live rasterization
is verified via the running editor (debug-running-game / `__PIX3_DEBUG__.assets`).

## Order of work

1. Contract extensions (`requiresApiKey`, `width/height`, `supportsExactSize`) + `svg-render.ts`
   (extract/sanitize/rasterize) with specs.
2. `SvgSpriteGenerator` + `SvgLlmImageProvider` + registry wiring + handle/history `svgSource`.
3. Panel UI (provider entry, W×H inputs, badge/source viewer) + postProcess skip-bg fix.
4. `generate_asset` width/height + tool description + skill updates.
5. (later) refine loop, state variants, sprite sheets.
