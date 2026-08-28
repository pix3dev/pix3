# Prototype SFX via the agent LLM (txt2sfx → baked WAV)

Status: **shipped** — v1 (order of work 1–4) implemented and verified live; in `main` since
`25dfeba`/`47d0a13`/`208dbae` (2026-08-19). `@txt2sfx/*` are published to npm and consumed from the
registry; `SoundlineLlmAdapter` + the bundled recipe bank + `SfxGenService` live in
`src/services/sfx-gen/`, Sound mode is part of the `Generate` panel, and `generate_sfx` is a
registered agent tool referenced by the `game-prototype` / `flow-increment` / `asset-generation`
skills. **Phase 2 below is a deliberate backlog, not pending work.**

## Idea

Same move as [svg-llm-sprites](svg-llm-sprites.md), for sound: a prototype needs a *named,
game-specific* sound effect in seconds, not a sound designer. The engine is
[txt2sfx](https://github.com/txt2sfx/txt2sfx) (local checkout: `C:\Projects\txt2sfx`, Apache-2.0,
zero-dep TS packages, browser-ready): an LLM writes a `soundline` recipe, a validator checks it
against the physics of its category, `renderSound` renders it through `OfflineAudioContext`, and a
differential-evolution optimizer fits every `~value[min..max]` slot the model was unsure about.

**Positioning — this is a placeholder pipeline, not a shipping format.** Generated procedural
sounds are usually good enough for prototypes and rarely good enough for playables. So we bake to
a **normal WAV file in the project**, exactly like SVG is baked to PNG:

- the artifact in `res://sfx/` is an ordinary audio asset — `scene.audio.play('res://sfx/pop.wav')`,
  `AudioPlayer`, `core:PlaySound` all work untouched;
- the final mp3/ogg from a sound designer later **replaces the file**; nothing else changes;
- the soundline source is kept in generation history (the `svgSource` move) so "make it duller /
  shorter" is a deterministic source edit + re-render, not a re-roll.

The niche sits between the two audio layers pix3 already has:

| layer | what | cost |
|---|---|---|
| `scene.audio.sfx('tap')` | 9 fixed synth presets, no file | zero — first-frame instant |
| **this plan** | named, prompt-shaped sound baked to WAV | one LLM call + local render |
| `res://sfx/*.mp3` | designer-made files | human |

## What stays out of scope (deliberately)

- **The runtime is untouched.** No `@txt2sfx/*` dependency in `pix3-runtime`, nothing in the
  playable export, no soundline compilation at load. The output is a file.
- **No MP3/OGG encoding.** WAV encodes in-browser with zero deps (`encodeWav` ships in
  `@txt2sfx/core`); prototype size doesn't matter, and final files come from outside anyway.
  txt2sfx's own mediabunny lane is explicitly not pulled in.
- **No txt2sfx-bridge / MCP.** The in-editor agent reaches the LLM through pix3's own provider
  stack; validate/render/optimize run in the editor tab.

## Dependency mechanism (decide first)

`@txt2sfx/core|agent|optimizer|analyzer|shared` are `private: true` workspace packages today
(publishing is a txt2sfx v1.0 roadmap item). Options:

1. **Publish to npm** (recommended) — we own the repo; `@pix3` already has the OIDC
   trusted-publishing pipeline to copy. Pulls the roadmap item forward; pix3 depends on a normal
   version.
2. **yalc** for the interim — same flow as `@pix3/runtime` → DeepCore. Fine while iterating,
   not a state to release in.
3. Vendor a compiled snapshot — last resort, loses upstream fixes.

Consumed surface (small and stable): from `@txt2sfx/core` — `parse`, `validate`, `serialize`,
`renderSound`, `encodeWav`, `buildGraph`/`instantiate` (live audition); from `@txt2sfx/agent` —
`generateSound` (the loop), `systemPrompt`, `staticBank`, types `LLMProvider`/`AgentEvent`;
`@txt2sfx/optimizer`/`analyzer`/`shared` come transitively.

Grammar-freeze risk is acceptable in this shape: if soundline evolves, baked WAVs in projects are
unaffected — only the *edit* path for old history entries degrades. Stamp the grammar version
(`soundline/v0`) into history records anyway.

## Architecture: `src/services/sfx-gen/` (new domain)

Mirror of `image-gen`, one size smaller. No provider-registry detour — audio has no multi-provider
story, so the generator is the service.

- **`SfxGenService`** (`@injectable`) — orchestrates one generation:
  1. resolve the LLM lane exactly like `SvgSpriteGenerator.resolveTarget` does
     (`AgentSettingsService.getSelectedProvider()` by default, composite
     `"<llmProviderId>/<llmModelId>"` override per call, graceful fallback when a stored lane
     disappeared);
  2. run `generateSound({ prompt, provider: adapter, render, bank, maxIterations })` — the loop
     owns parse → validate → render → repair; we stream its `AgentEvent`s to the UI;
  3. on `accepted` (or `distance`): render final buffer, `encodeWav`, hold a working handle
     `{ wavBlob, soundline, durationMs, peak, issues }`;
  4. `save(handle, name)` → `res://sfx/<name>.wav` via the same `writeBinaryFile` +
     ensure-parent-directory path `AssetGenService.save` uses (extract or duplicate the small
     helper — don't couple to the image service).
- **`SoundlineLlmAdapter`** — pix3 `LlmProvider.chat()` wrapped as txt2sfx `LLMProvider`
  (`name`, `model`, `complete(request): Promise<string>`). Map system+messages, temperature,
  abort signal. This is the only glue with any thickness.
- **`sfx-recipe-bank.ts`** — `staticBank()` over a curated subset (~15–20) of txt2sfx's
  `presets/*.soundline`, bundled as raw strings at build time (game-relevant picks: ui clicks,
  coin, powerup, explosion, laser, whoosh, footstep…). Few-shot quality decides output quality;
  the HTTP/FTS5 bank stays a txt2sfx-server concern.
- **Render fn** — `renderSound` takes a context *factory*; pass
  `opts => new OfflineAudioContext(opts)`. Keep it injected (constructor arg / setter) so specs
  under happy-dom can stub it — same discipline as `svg-render.ts` rasterization.
- **Audition** — `buildGraph`/`instantiate` on a shared `AudioContext` for the panel's Play
  button (the live graph, i.e. the actual product), plus replay of the rendered buffer.

### History

Extend `GenerationRecord` (`GenerationHistoryService`) rather than build a second store:
`kind?: 'image' | 'sound'` (default image), `soundlineSource?: string`,
`grammarVersion?: string`, `durationMs?: number`; blob = the WAV. The image panel filters
`kind !== 'sound'`; the sound UI filters the opposite.

### Edit loop

Regenerating from a handle/history record that has `soundlineSource` sends the source + user
feedback ("here is the current soundline, change X") through the same loop — mirror of the
`svgSource` edit mode. `initialMessage`/`repairMessage` from `@txt2sfx/agent` already carry the
plumbing; the edit prompt is ours.

## UI: Generate panel gains a **Sound** mode

A small mode toggle at the top of the existing Generate panel (Image | Sound) — a whole second
panel isn't warranted, and history/target-binding chrome is shared.

Sound mode shows:
- prompt + Generate; live progress from `AgentEvent`s (retrieval → request → validated →
  rendered → generation ticks → done) instead of a spinner — the fit phase is the slow part and
  txt2sfx emits per-generation events specifically so a UI can show the search working;
- result card: **Play** (live graph), duration, peak/clipped badge, validator issues (warnings
  included), read-only soundline source with copy;
- **Save** → name + `res://sfx/` destination (reuse the save dialog service pattern);
- regenerate-with-feedback on the current result (the edit loop above);
- no key nag ever: availability = "an LLM provider with a key/bridge is reachable", same hint as
  the chat when none is.

`~`-slot sliders (the playground's per-number tuning) are **phase 2** — v1 ships
generate/listen/tweak-by-words/save.

## Agent tool: `generate_sfx`

New tool in `AgentToolRegistry`, sibling of `generate_asset`:

- input: `prompt` (required), `name` (save name; default derived — `@txt2sfx/agent` ships
  `audioAssetName`/`assetFileName` for exactly this), `feedback` + `soundline` for edit mode,
  optional `maxIterations`;
- returns: saved `res://sfx/<name>.wav` path, duration, peak, the soundline (so the agent can do
  deterministic follow-up edits), validator warnings;
- description teaches the ladder: *"for instant feedback sounds use `scene.audio.sfx(preset)`;
  for a named, game-specific prototype SFX use this tool — the WAV it saves is meant to be
  replaced by a designer file later; never generate music/ambience/voice with it"* (the txt2sfx
  contract refuses voices by design — surface that as a normal outcome, not an error);
- skills: `game-prototype` / `flow-increment` sound phase becomes preset → `generate_sfx` when a
  sound needs character → final files on polish. Same paragraph structure as the svg-llm
  placeholder-art guidance.

## Replacement story (one sentence of docs, zero code)

Saved prototypes live under `res://sfx/` with the `.wav` extension in scene/script references.
Swapping in a final file either keeps the name (`pop.wav` stays `pop.wav`) or renames through the
asset browser — `ProjectService` move-remap already rewrites references. Document the convention
in the skills; no new machinery.

## Phase 2 (after v1 proves out)

- `~`-slot sliders on the result card (optimizer search-space = UI affordance, straight from the
  playground).
- Target matching: drop a reference recording → `extractProfile` → the optimizer fits against it
  (`target` option of `generateSound`). Turns "sounds wrong" into a measured distance.
- Batch variants: one prompt → N takes, pick by ear (cheap — the LLM call is the only metered
  part).
- Export shim for byte-obsessed playables: compile accepted recipes to the ~1 KB Web Audio
  function (`codegen`) instead of shipping the WAV — opt-in flag on the HTML export. This is the
  only item that would ever touch the runtime/export, and it stays optional.
- Grow the built-in `SfxSynth` presets from soundline recipes (single source of truth for both
  layers).

## Testing

happy-dom has no `OfflineAudioContext`/`AudioContext` — keep both behind injected factories and
unit-test the pure parts: the `SoundlineLlmAdapter` request mapping (system prompt, abort,
error → `ProviderError` retryability), static bank construction from bundled presets, composite
model-id resolution (shared helper with `SvgSpriteGenerator` — extract `parseSvgModelId` into a
neutral module), save-path normalization/extension, history record shape. The loop, validator,
renderer and optimizer are txt2sfx's own test surface (1826 tests) — don't re-test them here.
Live verification via `debug-running-game`: generate → save → `scene.audio.play` the saved path →
assert the buffer decoded (duration > 0) through `__PIX3_DEBUG__`.

## Order of work

1. Dependency decision + publish/yalc `@txt2sfx/*`; extract the shared LLM-lane resolver out of
   `SvgSpriteGenerator`.
2. `SoundlineLlmAdapter` + `sfx-recipe-bank` + `SfxGenService` (generate → render → wav → save)
   with specs; history extension.
3. Generate panel Sound mode (progress events, play, issues, source viewer, save dialog).
4. `generate_sfx` tool + skill updates (`game-prototype`, `flow-increment`) + replacement-story
   docs line.
5. (later) sliders, target matching, export shim, preset unification.
