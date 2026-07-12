# [postprocess-effects-list]

# Design spec: Registry-backed attached-effect list on the PostProcess node

Mirrors the shipped GeometryMesh pattern (`.plans/shader-effects-v2-list-design.md` → `packages/pix3-runtime/src/shader-effects/`). Same UX (Add-Effect picker + per-effect cards + enable/remove), same instance-schema mechanism for keyframe-animatability — but the effects are `postprocessing`-lib `Effect` objects composited by `PostProcessingPipeline`, **not** GLSL chunks injected into a material.

Engine-level change (runtime + serialization + editor ops/UI + docs) — per CLAUDE.md **requires user confirmation before implementation**, then `cd packages/pix3-runtime && npm run yalc:publish` + `yalc update` in DeepCore, and a `docs/nodes-and-systems.md` update.

**UX contract:** "Add Effect ▾" picker adds a post-effect instance to a PostProcess node; each attached effect renders as a card with an enable checkbox, its params, and Remove; effects are ordered but the composite order is **fixed-canonical** (user decision — see D4). Effect params + enable flags remain keyframe-animatable from the timeline.

---

## 0. The two hard constraints this design is built around

**C1 — Instance-schema funnel (same as mesh effects).** The animation/inspector/undo/prefab systems all resolve properties through `getNodePropertySchema(node)` (`packages/pix3-runtime/src/fw/property-schema-utils.ts:33-57`), which already merges an optional `node.getInstancePropertySchema()` after the static class schema. GeometryMesh proves this: its `fx.<key>.<param>` params are inspectable, keyframe-animatable, undoable, prefab-diffable with zero call-site edits (`GeometryMesh.ts:461-507`). PostProcess must expose its per-effect params the same way. **No schema-system edit is needed** — the funnel already supports instance schemas; PostProcess just implements the hook.

**C2 — Back-compat of animatable names (NEW; the mesh version did not face this).** Unlike the flat `fx*` impl (never committed/persisted — D6 of the mesh doc), PostProcess's flat scalars **shipped in P0.2 (2026-07-07/08)** and are live in DeepCore, verified animating in play mode. Existing scenes serialize flat keys (`bloomEnabled`, `bloomIntensity`, `vignetteOffset`, `chromaticAberrationOffset`, …) and animation clips may target those exact names. Therefore:

> **The built-in post-effects keep their historical flat property names as their instance-schema names.** `core:bloom`'s intensity param surfaces as the schema property `bloomIntensity` (not `pfx.bloom.intensity`); its enable toggle surfaces as `bloomEnabled`. Existing animation tracks and inspector references resolve unchanged. New/custom post-effects use the default `pfx.<key>.<param>` naming.

This is the single decision that makes migration lossless. A `schemaName` field on each param def carries the exact name (and doubles as the flat key read during migration).

---

## 1. Decisions (each fork, grounded)

**D1 — New `PostEffectRegistry`, parallel to `ShaderEffectRegistry`.** Module-level, lazy self-seeding built-ins on first access — identical bootstrap-free story (editor / game runtime / vitest). Lives in a new `packages/pix3-runtime/src/post-effects/` directory. Contract (`PostEffectTypeInfo`, §2) mirrors the picker-facing fields of `ShaderEffectTypeInfo` (id/key/displayName/description/category/keywords/params) so the picker UI is shared, but replaces GLSL fields (chunks/anchors/define/createUniforms) with a **postprocessing factory + live-sync** pair.

**D2 — Each effect owns its `postprocessing` construction (full extensibility, "Approach B").** `PostEffectTypeInfo.createEffect(ctx, params)` returns a `postprocessing` `Effect`; `applyLive(effect, params)` pushes animatable params into the live effect each frame. The pipeline becomes a **generic** stack builder: it filters enabled attached effects, calls `createEffect` in canonical order, merges them into one `EffectPass`, and calls `applyLive` per frame. Adding a new post-effect (film grain, DoF, …) = one registry entry, **zero pipeline edits**. Registry modules use `import type` only for `postprocessing` — the live module is passed in via `ctx.pp` (the pipeline's existing lazy `import('postprocessing')`), so code-splitting is preserved (no static import pulls the ~heavy lib into the main bundle).

**D3 — Property naming: legacy flat names for built-ins (C2), `pfx.<key>.<param>` for the rest.** `PostEffectParamDef.schemaName` overrides the generated name. Built-ins set `schemaName: 'bloomIntensity'` etc.; the enable prop uses `info.enabledSchemaName` (`'bloomEnabled'`). Verified name-safety is the same as the mesh doc's D3 (exact-string match everywhere; no dot-splitting on property names anywhere in `src/` or runtime).

**D4 — Fixed canonical composite order (user decision).** The attached list is ordered (insertion order, shown top-to-bottom in the inspector) but the **composite** order is fixed by a per-effect `order: number` in the registry (AO is upstream/separate; then `bloom(10) → chromaticAberration(20) → vignette(30)`; LUT/tonemap would be last). The pipeline sorts enabled effects by `info.order` before building the `EffectPass`. No reorder UI, no order in serialization. Rationale: post-stack order is a footgun (wrong order looks broken) with little authoring value; matches Godot/Unity's fixed post ordering.

**D5 — One instance per effect type in v1.** Same rationale as the mesh D4 — stable animatable names with no persisted instance ids (a track's `property` keeps resolving across save/load because the name derives from the type key), and the picker filters out already-attached types. List stays ordered so a later "stackable" upgrade is additive.

**D6 — AO stays a fixed group on PostProcess for THIS deliverable; extraction to its own node is a clean phase-2 (see §8).** AO is not a stackable screen effect you add/remove — it is a scene-environment setting with a project-tier cascade (`getResolvedAOMode()` → project default → `inherit`/`adaptive`, `PostProcess.ts:255-274`, wired to the project manifest via `setProjectAODefault`). Modelling it as a list effect would either break that cascade or bolt a bespoke "inherit/adaptive" enum onto the generic effect contract. Keeping `aoMode`/`ssaoIntensity`/`ssaoRadius` as static props (unchanged) is zero-risk. `affect2D` likewise stays a static "General" prop. **Fork surfaced to the user** (the user said AO "можно вообще в отдельную ноду вынести"): confirm whether to extract AO into its own node now or sequence it as phase-2.

**D7 — Param edits + enable toggles reuse `UpdateObjectPropertyOperation` unchanged (C1).** Only structural changes (attach/detach) need new ops. New parallel `AddPostEffectOperation`/`RemovePostEffectOperation` + commands (checking `instanceof PostProcess`), leaving the shipped GeometryMesh effect ops untouched (lower risk than duck-typing one shared op across two node types). Picker + inspector card markup are shared/parameterized (§7).

**D8 — Serialization: `effects` array in the node's flat props, with load-time migration from old flat keys (C2).** New shape `properties.effects: [{ type, enabled, params }]` (params keyed by short `key`, only non-defaults). Loader: `effects` array present → new format; else flat `*Enabled` keys present → migrate; else → default (attach `core:bloom` enabled, matching today's `POST_PROCESS_DEFAULTS.bloomEnabled`). Migration attaches **every** built-in whose flat data was serialized (preserving `enabled` + params) so no historical animatable name is lost. AO/affect2D keys stay flat, unchanged. SceneSaver needs no change (`:589` already delegates to `serializeConfig()`).

---

## 2. Post-effect registry contract (new `packages/pix3-runtime/src/post-effects/`)

```ts
// post-effect-types.ts
import type { PropertyUIHints } from '../fw/property-schema';
import type { Effect } from 'postprocessing';        // type-only — erased at compile
import type { Camera, Scene, WebGLRenderer } from 'three';

export type PostEffectParamType = 'number' | 'boolean' | 'color' | 'vector2';
export type PostEffectParamValue = number | boolean | string | { x: number; y: number };

export interface PostEffectParamDef {
  key: string;                       // short, identifier-safe (e.g. 'intensity')
  type: PostEffectParamType;
  default: PostEffectParamValue;
  /** Full schema/animation property name. Built-ins set legacy flat names
   *  ('bloomIntensity') for back-compat (C2); omit → 'pfx.<key>.<param>'. */
  schemaName?: string;
  /** true → a change forces a pass rebuild (e.g. bloom.radius/mipmapBlur, LUT src).
   *  false/omitted → pushed live via applyLive each frame (smooth to animate). */
  structural?: boolean;
  ui?: PropertyUIHints;
}

export interface PostEffectBuildContext {
  pp: typeof import('postprocessing');   // live module (pipeline's lazy import)
  camera: Camera;                        // effect camera (3D if present, else ortho)
  scene: Scene;
  renderer: WebGLRenderer;
}

export interface PostEffectTypeInfo {
  id: string;                 // 'core:bloom' — serialized `type`
  key: string;                // 'bloom' — uniqueness + default name namespace
  displayName: string;
  description: string;
  category: string;           // picker grouping ('Glow' / 'Lens' / 'Color')
  keywords: string[];
  /** Fixed composite order (D4); lower = earlier in the EffectPass. */
  order: number;
  /** Schema/animation name of the enable toggle. Built-ins: 'bloomEnabled' etc. */
  enabledSchemaName: string;
  params: PostEffectParamDef[];
  /** Build the postprocessing Effect from resolved params. */
  createEffect(ctx: PostEffectBuildContext, params: Readonly<Record<string, unknown>>): Effect;
  /** Push non-structural (animatable) params into the live Effect each frame. */
  applyLive(effect: Effect, params: Readonly<Record<string, unknown>>): void;
  /** Free extra GPU resources (LUT texture, …); the EffectPass disposes the
   *  Effect itself, so most built-ins need nothing here. */
  dispose?(effect: Effect): void;
}

/** A post-effect attached to a PostProcess instance (one per type in v1). */
export interface AttachedPostEffect {
  type: string;                        // 'core:bloom'
  info: PostEffectTypeInfo;
  enabled: boolean;
  params: Record<string, unknown>;     // resolved values (defaults merged), keyed by param.key
}
```

`PostEffectRegistry.ts` — module-level, `registerPostEffect` / `getPostEffectType(id)` / `getAllPostEffectTypes()`, lazy-seeding `BUILTIN_POST_EFFECTS`, validating `key`/`schemaName` regexes + id/key/schemaName uniqueness (schemaName uniqueness matters — two effects must not both claim `bloomEnabled`).

`register-builtin-post-effects.ts` — ports today's three working effects out of `PostProcessingPipeline.rebuild` (`:282-307`):

| id | key | order | params (schemaName · structural) | createEffect / applyLive |
|---|---|---|---|---|
| `core:bloom` | bloom | 10 | intensity(`bloomIntensity`), threshold(`bloomThreshold`,struct), smoothing(`bloomSmoothing`,struct), radius(`bloomRadius`,struct) | `new pp.BloomEffect({mipmapBlur:true, intensity, luminanceThreshold, luminanceSmoothing, radius})`; applyLive → `e.intensity` (threshold/smoothing/radius live-settable via `e.luminanceMaterial` — promote to live if cheap, else structural) |
| `core:chromatic-aberration` | chromaticAberration | 20 | offset(`chromaticAberrationOffset`) | `new pp.ChromaticAberrationEffect({offset: new Vector2(o,o), radialModulation:false, modulationOffset:0})`; applyLive → `e.offset.set(o,o)` |
| `core:vignette` | vignette | 30 | offset(`vignetteOffset`), darkness(`vignetteDarkness`) | `new pp.VignetteEffect({offset, darkness})`; applyLive → `e.offset`, `e.darkness` |

(LUT/`core:color-grading` — order 40 — is a **follow-up**: needs async `LookupTexture` load via AssetLoader, a `structural` `src` param, and a `dispose` that frees the texture. It stays out of v1, exactly as it is today scaffold-only.)

Export the module from `packages/pix3-runtime/src/index.ts` (pattern: the `shader-effects/*` export block).

---

## 3. PostProcess node refactor (`packages/pix3-runtime/src/nodes/PostProcess.ts`)

**Remove** the bloom/vignette/CA flat members + accessors + their static schema props/groups (`bloomEnabledValue`…`chromaticAberrationOffsetValue`, and the Bloom/Vignette/Chromatic-Aberration/Color-Grading groups). **Keep** `affect2D` + the whole AO cascade (`aoMode`, `ssaoIntensity`, `ssaoRadius`, `getResolvedAOMode`, `normalizeAOMode`, project-default helpers) and their static "General"/"Ambient Occlusion" groups **unchanged** (D6).

**Add** the attach-list state + API (copy the shape from `GeometryMesh.ts:86-92, 327-384`):

```ts
private _effects: AttachedPostEffect[] = [];
private _effectsRevision = 0;
private _instanceSchemaCache: { rev: number; schema: PropertySchema } | null = null;

attachEffect(type, init?): boolean;              // dedup by type; resolve info; merge param defaults
detachEffect(type): AttachedPostEffect | null;   // returns state for undo
setEffectEnabled(type, on): void;
getAttachedEffects(): readonly AttachedPostEffect[];
getInstancePropertySchema(): PropertySchema | null;   // C1
```

**Constructor** reads `props.effects` (new) OR migrates flat keys (C2/D8):

```ts
const raw = props.effects ?? (props.properties?.effects);
if (Array.isArray(raw) && raw.length) {
  for (const e of raw) this.attachEffect(String(e.type), { enabled: e.enabled, params: e.params });
} else if (hasLegacyFlatKeys(p)) {                 // p = this.properties
  for (const info of getAllPostEffectTypes()) {
    if (p[info.enabledSchemaName] === undefined && !anyParamPresent(info, p)) continue;
    const params = {}; for (const pd of info.params) { const v = p[pd.schemaName ?? defaultName]; if (v !== undefined) params[pd.key] = v; }
    this.attachEffect(info.id, { enabled: Boolean(p[info.enabledSchemaName]), params });
  }
} else {
  this.attachEffect('core:bloom');                 // default new node (bloom on), matches POST_PROCESS_DEFAULTS
}
```

**`getInstancePropertySchema()`** — same structure as `GeometryMesh.ts:470-507`, but names come from the effect's `schemaName`/`enabledSchemaName`, group `'Effect: <displayName>'`, params `readOnly: () => !effect.enabled`. getValue/setValue read/write `effect.params[key]` (no uniform sync — the pipeline reads params each frame via `applyLive`). Setting a param just writes `effect.params[key]`; the viewport repaint from the op makes the pipeline re-read it.

**`getConfig()`** returns the new shape the pipeline consumes:

```ts
interface ResolvedPostEffect { type: string; info: PostEffectTypeInfo; params: Readonly<Record<string, unknown>>; }
interface PostProcessConfig {
  affect2D: boolean;
  ssao: { enabled: boolean; intensity: number; radius: number };   // from AO cascade — unchanged
  effects: ResolvedPostEffect[];                                    // enabled, sorted by info.order (D4)
}
```

**`isActive()`** = `this._effects.some(e => e.enabled) || getResolvedAOMode()==='realtime'`.

**`serializeConfig()`** — emit `affect2D`, the AO keys (unchanged), and `effects: [{type, enabled, params}]` (params = non-default only; omit `effects` when empty). Drops the old flat bloom/vignette/CA keys.

---

## 4. Pipeline refactor (`packages/pix3-runtime/src/core/PostProcessingPipeline.ts`)

Keep the whole banding skeleton (3D RenderPass → AO passes → ClearDepth → 2D RenderPass → merged EffectPass), lazy import, RT sizing, force-clear handling. Change only the **effect-stack** section:

- `rebuild` (`:279-314`): replace the hardcoded bloom/vignette/CA blocks with
  ```ts
  const ctx = { pp, camera: effectCamera, scene, renderer: this.renderer };
  this.active = config.effects                        // already enabled + order-sorted by getConfig
    .map(e => ({ info: e.info, effect: e.info.createEffect(ctx, e.params) }));
  if (this.active.length) { this.effectPass = new pp.EffectPass(effectCamera, ...this.active.map(a => a.effect)); composer.addPass(this.effectPass); }
  ```
  The AO/SSAO block (`:213-252`) stays verbatim (reads `config.ssao`).
- `computeSignature` (`:169-182`): the effect part becomes `config.effects.map(e => e.type + structuralParamsKey(e)).join('+')` where `structuralParamsKey` hashes only params flagged `structural` (bloom threshold/smoothing/radius). AO/camera/affect2D parts unchanged. → attach/detach/toggle/structural-param-change rebuilds; animatable-param change does not.
- `applyLiveValues` (`:317-334`): `for (const a of this.active) a.info.applyLive(a.effect, paramsFor(a));` + keep the SSAO intensity/radius live writes.
- `disposeEffects` (`:336-355`): dispose `this.effectPass` then `for (const a of this.active) a.info.dispose?.(a.effect)`; drop the per-effect typed fields (`bloom`/`vignette`/`chromaticAberration`). Keep SSAO fields.

`getConfig()` supplies `effects` already filtered-to-enabled and order-sorted, so the pipeline stays dumb. `PostProcessConfig` moves/updates in `PostProcess.ts` (pipeline imports the type from there as today, `:17`).

---

## 5. Instance-schema funnel — no edit needed (C1)

`getNodePropertySchema` already merges `getInstancePropertySchema()` (`property-schema-utils.ts:44-56`). PostProcess opts in by implementing the hook. The mesh doc's exhaustive call-site audit (§3 of that doc) already proved every consumer — clip-evaluator binding, timeline `collectAnimatableProperties`, `captureTrackValue`, inspector `propertySchema`, `UpdateObjectPropertyOperation`, `SceneRunner.applyLivePropertyUpdate`, prefab diff snapshots — funnels through it. PostProcess params inherit all of that for free. (Confirm PostProcess participates in play-mode clone the same way — SceneRunner clones via serialize→parse, so the clone re-attaches the same effects; live prop updates route through `getNodePropertySchema` on the clone.)

---

## 6. Serialization — exact edit list

Runtime:
1. `nodes/PostProcess.ts` — §3 (state/API/getConfig/isActive/serializeConfig/migration).
2. `core/PostProcessingPipeline.ts` — §4 (generic stack) + `PostProcessConfig` shape.
3. `core/SceneLoader.ts:1114-1119` — **no structural change**; `new PostProcess({...baseProps})` still works (constructor reads `properties.effects` or migrates). Optionally thread `props.effects` explicitly for clarity.
4. `core/SceneSaver.ts:589` — **no change** (delegates to `serializeConfig`).
5. `index.ts` — export `post-effects/*`.

Back-compat: load-time migration (C2/D8). Forward-compat: a NEW-format scene read by an OLD @pix3/runtime would ignore `effects` and default — mitigated by `yalc:publish` to DeepCore (no dual-write). Note in risks.

---

## 7. Editor: ops, commands, picker, inspector

**Picker — parameterize by catalog kind** (avoid a second component):
- `EffectPickerService.showPicker(kind: 'shader' | 'post', excludeTypes)` — store `kind` on the instance; the existing GeometryMesh call passes `'shader'`.
- `pix3-effect-picker.ts` — read `kind` from the instance and pick `getAllShaderEffectTypes()` vs `getAllPostEffectTypes()`. Both infos expose the picker fields (id/displayName/description/category/keywords); type the picker against a shared `{id;displayName;description;category;keywords}` view. `renderEffectPickerHost` (`pix3-editor-shell.ts:1238-1252`) passes `kind` through.

**Operations/commands** (`src/features/effects/`): new `AddPostEffectOperation` / `RemovePostEffectOperation` + `AddPostEffectCommand` / `RemovePostEffectCommand`, copies of the mesh ones (`AddEffectOperation.ts` etc.) with `instanceof PostProcess`. `affectsNodeStructure:false`, tags `['effects','post']`. Preconditions: active scene + target node (+ prefab-instance lock via `isPrefabInstanceNode`, same as mesh — post-effect attach-lists aren't prefab override diffs; param values are, via C1).

**Inspector** (`inspector-panel.ts`):
- `renderPostEffectsSection()` — parallel to `renderEffectsSection()` (`:2650-2728`), rendered when `primaryNode instanceof PostProcess`, next to it in `renderProperties` (`:2212`). Same card markup; the enable/disable button and the params-filter key come from `effect.info.enabledSchemaName` (not `fx.<key>.enabled`); toggle via `applyPropertyChange(effect.info.enabledSchemaName, enabled)`. Factor the shared card markup into a helper taking `(effect, enablePropName, groupPrefix, structureLocked, onToggle, onRemove)` to avoid duplication.
- `onAddPostEffect/onRemovePostEffect/onTogglePostEffect` mirror the mesh handlers, dispatching the post-effect commands and using the `'post'` picker kind.
- `renderProperties` group filter (`:2188`) already skips `'Effect: '` groups → post-effect groups are card-rendered, not double-rendered. ✓
- Schema/value refresh + viewport repaint after add/remove are automatic (scenes subscription + op dirty-marking), same as mesh.

---

## 8. Phase-2 (optional, user-gated): extract AO into its own node

If confirmed, a follow-up branch adds an `AmbientOcclusion` (or keeps a dedicated) node owning `aoMode`/`ssaoIntensity`/`ssaoRadius` + the cascade; PostProcess drops the AO group entirely. Migration reads old `aoMode` off a PostProcess and (on load) synthesizes a sibling AO node — more involved than field migration, hence sequenced separately so the effects-list refactor ships clean and low-risk first. **Not in this deliverable unless the user chooses "extract now".**

---

## 9. Invariants preserved (checklist)

- **Keyframe animation** — built-ins keep flat schema names via `schemaName`; existing `bloomIntensity`/… tracks resolve unchanged (C2). New params animatable via the funnel (C1). Animatable-param changes are live (no per-frame rebuild) via `structural:false` + `applyLive` (D2/§4).
- **Undo/redo** — param/enable via `UpdateObjectPropertyOperation` (unchanged); attach/detach via new ops with captured `{enabled,params}` restore (D7).
- **Back-compat migration** — old flat scenes → attach-list on load, no name/value loss; new-node default = bloom on (D8).
- **Render order** — fixed canonical via `info.order` sort in `getConfig()` (D4); banding/force-clear/RT-sizing untouched (§4).
- **AO cascade** — static props + project-manifest wiring untouched (D6).
- **Code-splitting** — registry `import type` only; `postprocessing` reaches effects via `ctx.pp` (D2).

---

## 10. Tests + rollout

- **New** `packages/pix3-runtime/src/post-effects/PostEffectRegistry.spec.ts` — lazy seeding, duplicate id/key/schemaName rejection, name validation.
- **Rewrite/extend** `packages/pix3-runtime/src/core/PostProcessPersistence.spec.ts` — (1) new-node default attaches `core:bloom`; (2) **old flat scene migrates** (bloomEnabled/bloomIntensity/vignette…/CA… → attached list, values intact, enabled preserved); (3) round-trip new `effects` array (non-default params only, disabled preserved, unknown type warns+skips); (4) instance schema contains `bloomIntensity` and static `getPropertySchema()` does **not** (funnel tripwire); (5) animation binding: a clip track `property:'bloomIntensity'` resolves via `getNodePropertySchema` (the C2 guarantee); (6) `getConfig().effects` order-sorted + enabled-filtered; AO cascade unchanged.
- **Optional** `AddPostEffectOperation.spec.ts` — add/undo/redo, prefab-lock precondition.
- Composer render correctness needs WebGL (not happy-dom) — manual editor smoke test (create PostProcess, add/toggle bloom+vignette+CA, animate `bloomIntensity` 0→1 in play mode) + drive via chrome-devtools MCP, same as P0.2 verification.
- Rollout: `cd packages/pix3-runtime && npm run yalc:publish` → `yalc update` in DeepCore; update `docs/nodes-and-systems.md` PostProcess entry (attach model + names).

---

## 11. Risks / not verified

- **Forward-compat**: new-format scenes are unreadable by an un-republished old runtime (no dual-write). Mitigation: republish DeepCore in the same change.
- **`postprocessing` live-settable props**: bloom threshold/smoothing/radius live-settability (via `luminanceMaterial`) not re-verified against v6.39.2 — if not cleanly live, keep them `structural` (functional, just rebuilds on change; matches today's behavior where they're in the signature).
- **Funnel is convention, not compiler-enforced** — same fragility as mesh effects; the tripwire test (10.4) guards it.
- **Migration list clutter**: attaching disabled vignette/CA on migration (to preserve their animatable names) shows them as disabled cards; acceptable, user can Remove.
- **Cached `PropertyDefinition` identities** across a preview session — same accepted behavior as mesh effects (removing an effect mid-preview leaves stale closures writing into a detached param bag; no crash, values discarded).
