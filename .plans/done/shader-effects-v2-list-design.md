# [shader-effects-v2]

# Design spec: Registry-backed attached-effect list on GeometryMesh (replaces the flat `fx*` checkbox set)

**Статус:** реализовано (registry `packages/pix3-runtime/src/shader-effects/` + attached effects на GeometryMesh, коммит `5123ec0` и далее) — перенесён в done/ 2026-07-14. Follow-up для PostProcess — [postprocess-effects-list-design.md](../postprocess-effects-list-design.md) (ещё не реализован).

All claims verified against the working tree on disk (including the uncommitted flat-fx implementation: `git status` shows `M GeometryMesh.ts`, `M SceneLoader.ts`, `M ViewportRenderService.ts`, `M docs/node-types-reference.md`, `?? GeometryMeshEffectsPersistence.spec.ts` — nothing committed, nothing persisted in any scene). three r183 inspected in `node_modules`.

Engine-level change (runtime + serialization + editor ops/UI + docs) — per CLAUDE.md **requires user confirmation before implementation**, then `cd packages/pix3-runtime && npm run yalc:publish` + `yalc update` in DeepCore, and a `docs/node-types-reference.md` update.

**UX contract (user-confirmed):** mirror the script-component attach pattern — "Add Effect ▾" picker adds an effect instance to a GeometryMesh; each attached effect renders as a card with an enable checkbox, its params, and a Remove control; effects are ordered. Effect params (and the enable flags) remain keyframe-animatable from the timeline.

## 0. The hard constraint this design is built around (re-verified)

The animation system animates ONLY properties resolvable from the node's property schema:
- `getNodePropertySchema(node)` calls the **static** `node.constructor.getPropertySchema()` (`packages/pix3-runtime/src/fw/property-schema-utils.ts:14-26`).
- Clip binding: `getPropertyDefinition(getNodePropertySchema(node), track.property)` — exact top-level name match (`packages/pix3-runtime/src/animation/clip-evaluator.ts:336`, `fw/property-schema-utils.ts:48-53`).
- Timeline "Add Track" lists `getNodePropertySchema(target).properties` filtered by `SUPPORTED_TRACK_TYPES` = number/boolean/string/vector2/vector3/euler/color, `EXCLUDED_PROPERTIES`, `ui.hidden`, and `ui.readOnly` (incl. function form) (`src/ui/animation-timeline/animation-timeline-panel.ts:94-103`, `:2645-2683`).
- Component/script params are NOT animatable — no `component:`-style track target exists (`PropertyTrack` has only `targetPath` + `property`, `animation/keyframe-types.ts:38-54`).

Therefore attached-effect params must surface **as node schema properties**. The chosen mechanism (§3) makes the schema instance-aware at the single existing funnel.

## 1. Decisions (each fork, grounded)

**D1 — New `ShaderEffectRegistry`, not ScriptRegistry.** ScriptRegistry entries are component classes with lifecycle (`ComponentTypeInfo.componentClass: new (id, type) => ScriptComponent`, `core/ScriptRegistry.ts:20-38`; `ScriptComponent` carries `onUpdate`/`onAttach`/`node` back-refs, `core/ScriptComponent.ts:28-94`) and the registry is a DI instance populated per-project (`src/main.ts:115-119`, `register-project-scripts.ts`). Shader effects are pure data + GLSL injectors resolved inside `GeometryMesh`'s constructor during `SceneLoader.parseScene` — which has no ScriptRegistry access at that point in the node branch (`SceneLoader.ts:1498-1571` constructs the node directly). A module-level registry in the runtime package with **lazy built-in self-registration** (first `get` registers `core:dissolve/rim/uv-scroll/flash`) works identically in editor, game runtime, and vitest without bootstrap wiring. Contract type in §2 deliberately mirrors `ComponentTypeInfo`'s picker-facing fields (id/displayName/description/category/keywords) so the picker UI is a straight copy.

**D2 — Instance-aware schema via ONE edit in `getNodePropertySchema`.** Exhaustive grep for consumers (see §3): every production caller goes through `getNodePropertySchema()`; no production code calls `node.constructor.getPropertySchema()` directly (direct static calls exist only in spec files and in the class-hierarchy `super.getPropertySchema()` chains inside node classes, plus DeepCore's `ShopPanelBehavior.ts:40-42` which resolves setters for *static* UIControl2D/Button2D props — unaffected). Adding the merge in the funnel means the timeline, clip evaluator, inspector, `UpdateObjectPropertyOperation`, SceneRunner live-edit, and the prefab diff machinery all see effect params with **zero call-site edits**.

**D3 — Property naming: `fx.<key>.<param>`** (`fx.dissolve.amount`, `fx.dissolve.enabled`, `fx.uvScroll.speed`). Verified safe:
- `PropertyTrack.property` is a plain string; normalization only trims (`keyframe-types.ts:47-48`, `:258-261`). Track add stores `propDef.name` verbatim (`animation-timeline-panel.ts:1477`).
- Lookup is exact-string match everywhere (`property-schema-utils.ts:52`, `UpdateObjectPropertyOperation.ts:58`, `SceneRunner.ts:734`, `animation-timeline-panel.ts:915`).
- No property-path dot-splitting exists in `src/` or the runtime (grep `\.split\('\.'\)` — only filename/version splits).
- Track labels render the raw name (`animation-timeline-panel.ts:2158`: `` `${targetPath || '(self)'} · ${property}` ``) — `fx.dissolve.amount` reads well.
`<key>` is a registry-declared short key (`dissolve`), not the full id (`core:dissolve`), keeping names compact; the registry enforces key uniqueness and `[a-zA-Z][a-zA-Z0-9]*` for keys and param names.

**D4 — One instance per effect type in v1.** Rationale: (a) stable animatable names with no persisted instance ids — `track.property` keeps resolving across save/load because the name derives from the type key alone; (b) stacking the same effect twice would require per-instance uniform renaming and duplicated GLSL helper functions (the chunks reference fixed uniform names like `uPix3DissolveAmount` — `GeometryMesh.ts:94-137` current chunks), a large GLSL-composition complication for near-zero v1 value; (c) Add-Effect picker simply filters out already-attached types. The attached list stays **ordered** (insertion order = composition order), so a later "stackable" upgrade only adds id-suffixing, not a format break.

**D5 — GLSL composition + program cache key.** Keep the flat impl's proven skeleton (`onBeforeCompile` + shared `{value}` uniform refs + `#ifdef`-gated chunks + `material.defines`; precedent `Particles3D.ts:627-652`) but build the injected text from the attached list. Re-verified in three r183:
- `material.defines` is read for all materials (`WebGLPrograms.js:187`) and folded into the program cache key (`WebGLPrograms.js:398-407`) — enable/disable toggles recompile correctly; disabled attached effects cost zero GPU.
- `customProgramCacheKey()` is folded into the key (`WebGLPrograms.js:367`, `:417`).
- **Critical**: programs are cached per-material keyed by the cache key, and `onBeforeCompile` runs ONLY on a key miss (`WebGLRenderer.js:2157-2178`, call at `:2175`). Since attach/detach changes the text the closure injects, the cache key MUST reflect the attached set + order: `customProgramCacheKey = () => 'pix3-gmesh-fx-v2:' + attached.map(e => e.type).join('+')`. (Defines alone are insufficient: an attached-but-disabled effect changes the injected text but not the defines.) Bump the `v2` literal on any GLSL text change.

**D6 — Serialization: ordered array, no flat-format back-compat.** `material.effects` becomes `[{ type, enabled, params }]`. The flat object format was never committed (git status verified) and per the task never persisted into any saved scene — recommend **dropping** the old `parseGeometryMeshEffects` object shape entirely; a defensive `Array.isArray` check makes non-array values parse as "no effects" (silent, safe). SceneSaver needs no change: the GeometryMesh branch already does `Object.assign(props, node.serializeConfig())` (`SceneSaver.ts:528-533`).

**D7 — Param edits + enable toggles reuse `UpdateObjectPropertyOperation` unchanged.** It resolves the prop via `getNodePropertySchema(node)` (`UpdateObjectPropertyOperation.ts:57-58`) — the instance merge covers it. Undo/redo (`:158-188`), play-mode forwarding via `getRuntimeLivePropertySink` (`:199-201` → `SceneRunner.applyLivePropertyUpdate` `:723-752`, which also routes through `getNodePropertySchema` on the clone), and viewport repaint (ops mark `state.scenes` → `ViewportRenderService` scene subscription calls `requestRender()`, `ViewportRenderService.ts:392-396`) are all free — the current flat `fx*` props already flow through exactly this path. Only structural changes need new ops: `AddEffectOperation` / `RemoveEffectOperation` (mirror `AddComponentOperation`/`RemoveComponentOperation`). Reorder is deferred (§7).

**D8 — GeometryMesh-only, extractable.** GeometryMesh remains the sole node authoring an editable `MeshStandardMaterial` (constructor `GeometryMesh.ts:192`). The registry, contract types, and the composer function live in a new `packages/pix3-runtime/src/shader-effects/` directory with no GeometryMesh imports; GeometryMesh owns only its `_effects` list, the uniform bag, and the instance-schema builder. Moving effects to MeshInstance later = adding the same three members there.

## 2. Effect registry contract (new files under `packages/pix3-runtime/src/shader-effects/`)

```ts
// shader-effect-types.ts
import type { PropertyUIHints } from '../fw/property-schema';

/** Injection anchors supported by the composer (verified against
 *  node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js, r183). */
export type ShaderEffectAnchor =
  | 'uv_vertex'              // vertex, inject after   (vPix3Uv is in scope)
  | 'emissivemap_fragment'   // fragment, inject after (normal + totalEmissiveRadiance in scope)
  | 'opaque_fragment';       // fragment, inject before (outgoingLight still writable)

export interface ShaderEffectChunk {
  stage: 'vertex' | 'fragment';
  anchor: ShaderEffectAnchor;
  position: 'after' | 'before';
  /** Raw GLSL; the composer wraps it in `#ifdef <define> ... #endif`. */
  glsl: string;
}

export type ShaderEffectParamType = 'number' | 'color' | 'vector2' | 'boolean';

export interface ShaderEffectParamDef {
  /** Identifier-safe, dot-free (schema name becomes `fx.<key>.<param>`). */
  key: string;
  type: ShaderEffectParamType;
  default: number | string | { x: number; y: number } | boolean;
  /** Uniform in this effect's bag to sync on write. 'color' params are pushed
   *  through `Color.set(hex).convertSRGBToLinear()` (matches material.color,
   *  GeometryMesh.ts:188); omit for CPU-only params (e.g. uvScroll.speed). */
  uniform?: string;
  ui?: PropertyUIHints;   // label/min/max/step/precision/slider/unit/description
}

export interface ShaderEffectTickContext {
  params: Readonly<Record<string, unknown>>;
  uniforms: Record<string, { value: unknown }>;
}

export interface ShaderEffectTypeInfo {
  id: string;            // 'core:dissolve' — serialized `type`
  key: string;           // 'dissolve' — property-name + uniqueness namespace
  displayName: string;   // picker + card header
  description: string;
  category: string;      // picker grouping (e.g. 'Surface', 'Color')
  keywords: string[];
  define: string;        // 'PIX3_FX_DISSOLVE'
  /** Declarations prepended once per stage (uniforms, helper fns). The shared
   *  `varying vec2 vPix3Uv` is owned by the composer, not by effects. */
  vertexPars?: string;
  fragmentPars?: string;
  chunks: ShaderEffectChunk[];
  params: ShaderEffectParamDef[];
  /** Fresh `{value}` bag; refs are shared into every compiled program. */
  createUniforms(): Record<string, { value: unknown }>;
  /** Per-frame CPU update in play mode (uv-scroll offset accumulation). */
  onTick?(ctx: ShaderEffectTickContext, dt: number): void;
}

// ShaderEffectRegistry.ts — module-level, lazily seeds built-ins on first access.
export function registerShaderEffect(info: ShaderEffectTypeInfo): void; // validates key/param regexes + uniqueness
export function getShaderEffectType(id: string): ShaderEffectTypeInfo | undefined;
export function getAllShaderEffectTypes(): ShaderEffectTypeInfo[];
```

`register-builtin-effects.ts` ports the four effects 1:1 from the flat impl: GLSL from `FX_PARS`/`FX_DISSOLVE_RIM`/`FX_FLASH` (`GeometryMesh.ts:94-137`), split per effect (`pix3Hash`/`pix3Noise` go into dissolve's `fragmentPars`); uniform names and defaults from `_fxUniforms` (`GeometryMesh.ts:164-175`) and `defaultEffects()` (`:914-921`); uv-scroll's `onTick` ports the accumulation from `tick()` (`:497-504`, `offset = (offset + speed*dt) % 1`). The uv-scroll vertex chunk keeps the `#if defined(PIX3_FX_UVSCROLL) && defined(USE_MAP)` inner guard (`:398-400`).

Exports: add `export * from './shader-effects/...'` to `packages/pix3-runtime/src/index.ts` (pattern: `index.ts:5,57,90`).

## 3. Instance-aware schema — mechanism + exhaustive call-site audit

### Mechanism (the only schema-system edit)

```ts
// fw/property-schema-utils.ts — getNodePropertySchema (currently :14-26)
export interface InstancePropertySchemaProvider {
  /** Per-instance properties (attached shader effects, …) merged after the
   *  static schema. Must return stable PropertyDefinition identities between
   *  calls while the attach-list is unchanged (cache + revision counter). */
  getInstancePropertySchema(): PropertySchema | null;
}

export function getNodePropertySchema(node: NodeBase): PropertySchema {
  const ctor = node.constructor as { getPropertySchema?: () => PropertySchema };
  const staticSchema = typeof ctor.getPropertySchema === 'function'
    ? ctor.getPropertySchema()
    : { nodeType: 'Unknown', properties: [] };
  const inst = (node as Partial<InstancePropertySchemaProvider>).getInstancePropertySchema?.();
  if (!inst || inst.properties.length === 0) return staticSchema;
  return {
    ...staticSchema,
    properties: [...staticSchema.properties, ...inst.properties],
    groups: { ...staticSchema.groups, ...inst.groups },
  };
}
```

GeometryMesh implements the hook: for each attached effect, emit `fx.<key>.enabled` (boolean; setValue flips `enabled`, syncs the define via the existing set/delete + `needsUpdate` pattern, `GeometryMesh.ts:466-493`) and one prop per param (`fx.<key>.<param>`; setValue writes `params[key]` and syncs the mapped uniform — number assign / color `set().convertSRGBToLinear()` / vector2 copy, mirroring `syncFxUniforms` `:450-462`). Each effect's props get `ui.group = 'Effect: <displayName>'` and group defs `{ label: displayName }`. The built definitions are cached on the node and invalidated by attach/remove/reorder (a `_effectsRevision` counter) — `getValue`/`setValue` closures capture the effect instance, so per-call rebuilding is wasteful and would also break `AnimationTimelinePreviewService`'s snapshot `propDef` identity expectations (`AnimationTimelinePreviewService.ts:270-283` holds `propDef` across a session).

### Call-site audit (every production consumer, verified by reading each)

| Call site | Behavior with merged schema | Edit needed |
|---|---|---|
| `animation/clip-evaluator.ts:336` — clip binding | resolves `fx.*` tracks; `applyClipAtTime` (`:353-365`) drives uniforms via setValue | none |
| `src/ui/animation-timeline/animation-timeline-panel.ts:2658` — `collectAnimatableProperties` | `fx.*` props listed (all types ∈ `SUPPORTED_TRACK_TYPES` `:94-102`; not in `EXCLUDED_PROPERTIES` `:103`) | none |
| `animation-timeline-panel.ts:915` — `captureTrackValue` (autokey/record) | resolves by exact name | none |
| `src/ui/object-inspector/inspector-panel.ts:552` — schema cached in `this.propertySchema` | re-fetched on every `appState.scenes` mutation (`:289-291` subscription); add/remove ops mark the scene dirty → refresh is automatic | §7 UI only |
| `src/features/properties/UpdateObjectPropertyOperation.ts:57` | param edits + enable toggles work incl. undo/redo | none |
| `packages/pix3-runtime/src/core/SceneRunner.ts:733` — `applyLivePropertyUpdate` | live play-mode edits reach the clone (clone has same attached effects via serialize→parse, `SceneRunner.ts:171-178`) | none |
| `core/SceneSaver.ts:677` — `captureComparableProperties` (prefab instance diffs) | `fx.*` values participate in prefab override diffs — desired | none |
| `core/SceneLoader.ts:765` — prefab base snapshot | consistent with above (effects are attached before snapshot: constructor applies them) | none |
| `core/SceneLoader.ts:825` — `applyLegacyInstanceRootProperties` | `fx.*` overrides apply via setValue; unknown keys fall to `node.properties` (`:834-837`) — harmless | none |
| `core/SceneLoader.ts:698` — `remapNodeReferences` | only `type === 'node'` props touched (`:722-724`); effect params never are | none |
| `nodes/Node2D.ts:683` — layout size writeback | width/height/size/radius only; GeometryMesh isn't Node2D; hook check is a `typeof` — negligible cost | none |

**No production bypasses exist**: grep for `\.getPropertySchema\(` across runtime + src shows only (a) `property-schema-utils.ts:21` itself, (b) intra-hierarchy `super/Base.getPropertySchema()` calls inside node classes' own static schemas, (c) spec files, (d) `ScriptRegistry.ts:111` (component schemas — different domain). DeepCore was scanned too: only static-prop setter resolution (`ShopPanelBehavior.ts:40-42`) and its own script schemas — unaffected.

**What breaks if a future call site bypasses the merge**: it would see only static props — effect params would silently vanish from that feature (the exact failure mode this design avoids). Guard: the persistence spec asserts `fx.*` props are absent from `GeometryMesh.getPropertySchema()` (static) and present via `getNodePropertySchema(node)` — turning a future refactor to direct static calls into a red test. Also update `docs/property-schema-system.md` to state the funnel rule.

## 4. GLSL composition (composer in `shader-effects/compose.ts`, installed by GeometryMesh)

Replaces `installFxShader` (`GeometryMesh.ts:390-411`). Same anchors, verified unchanged (r183 `meshphysical.glsl.js`: vertex `#include <uv_vertex>`; fragment `#include <emissivemap_fragment>` after `normal_fragment_begin`; `#include <opaque_fragment>`):

```ts
material.onBeforeCompile = shader => {
  if (this._effects.length === 0) return;
  Object.assign(shader.uniforms, this._fxUniforms);           // shared {value} refs (flat-impl pattern, :392)
  shader.vertexShader =
    'varying vec2 vPix3Uv;\n' + vertexParsOf(this._effects) + shader.vertexShader;
  shader.vertexShader = inject(shader.vertexShader, 'uv_vertex', 'after',
    'vPix3Uv = uv;\n' + chunksFor(this._effects, 'vertex', 'uv_vertex'));
  shader.fragmentShader =
    'varying vec2 vPix3Uv;\n' + fragmentParsOf(this._effects) + shader.fragmentShader;
  shader.fragmentShader = inject(shader.fragmentShader, 'emissivemap_fragment', 'after',
    chunksFor(this._effects, 'fragment', 'emissivemap_fragment'));
  shader.fragmentShader = inject(shader.fragmentShader, 'opaque_fragment', 'before',
    chunksFor(this._effects, 'fragment', 'opaque_fragment'));
};
material.customProgramCacheKey = () =>
  'pix3-gmesh-fx-v2:' + this._effects.map(e => e.type).join('+');
```

- `chunksFor` concatenates matching chunks **in attach order**, each wrapped `#ifdef <define> … #endif` by the composer.
- The shared `vPix3Uv` varying + assignment is composer-owned (dissolve and uv-scroll both consume it); emitted only when ≥1 effect is attached. `attribute vec2 uv` is unconditional in the WebGLProgram vertex prefix (verified in the v1 spec, `WebGLProgram.js:624`), so this is safe without a bound map.
- Enable/disable = define flip + `needsUpdate` (recompile; cached per combo). Attach/detach = uniforms merged/removed from `_fxUniforms`, define synced, `needsUpdate = true`, and the **cache key changes** → three re-runs `onBeforeCompile` with the new text (`WebGLRenderer.js:2171-2178`). Detach may leave a stale program in the per-material map — harmless (keyed separately, GC'd on material dispose).
- Attached-but-disabled effects: text injected, `#ifdef` compiled out — zero GPU cost (defines fold into the cache key, `WebGLPrograms.js:398-407`).

`tick(dt)` (play-mode only, `NodeBase.tick` recursion semantics unchanged): for each attached+enabled effect with `onTick`, call `onTick({ params, uniforms }, dt)`, then `super.tick(dt)`. UV-scroll stays static in the edit-mode viewport (no ticks outside play — accepted in v1, unchanged).

## 5. GeometryMesh state + API (replaces the flat members)

```ts
interface AttachedShaderEffect {
  type: string;                       // registry id ('core:dissolve')
  info: ShaderEffectTypeInfo;         // resolved once at attach
  enabled: boolean;
  params: Record<string, unknown>;    // fully-resolved values (defaults merged)
}

private _effects: AttachedShaderEffect[] = [];
private _fxUniforms: Record<string, { value: unknown }> = {};  // merged bags
private _effectsRevision = 0;                                  // schema-cache key
private _instanceSchemaCache: { rev: number; schema: PropertySchema } | null = null;

// Public API (used by ops + loader + tests):
attachEffect(type: string, init?: { enabled?: boolean; params?: Record<string, unknown> }): boolean;
detachEffect(type: string): AttachedShaderEffect | null;   // returns state for undo
getAttachedEffects(): readonly AttachedShaderEffect[];
setEffectEnabled(type: string, on: boolean): void;          // define sync + needsUpdate (pattern :466-493)
getInstancePropertySchema(): PropertySchema | null;         // §3
```

Constructor: build material → install composer (`onBeforeCompile` set once; it reads `_effects` live) → `attachEffect` for each entry in `props.material.effects` **before** first render (defines set pre-compile — no churn, same rationale as the flat impl comment `GeometryMesh.ts:197-199`). `GeometryMeshProps.material.effects` type changes to the array shape. Albedo-map members (`_mapSrc`, `setMap`, `setMapResource`, `map` schema prop `:688-700`) are kept unchanged.

`serializeConfig()` (`:579-603`): replace the `serializeEffects(this._fx)` call with the array emitter:

```yaml
material:
  effects:
    - type: core:dissolve
      enabled: true
      params: { amount: 0.6, edgeColor: '#123456' }   # only non-default params
    - type: core:flash
      enabled: false                                   # attached-but-disabled persists
```

Attached-but-default effects still serialize (the attachment itself is authored state); `params` omitted when all-default; `effects` omitted when the list is empty.

## 6. Serialization — exact edit list

Runtime (`packages/pix3-runtime/src/`):
1. `nodes/3D/GeometryMesh.ts` — §5 (delete list in §8).
2. `core/SceneLoader.ts` — `GeometryMeshProperties.material.effects` (`:113`) becomes `Array<Record<string, unknown>>`; rewrite `parseGeometryMeshEffects` (`:2115-2168`) to: `Array.isArray` guard → per entry read `type` (string), `enabled` (boolean, default true), `params` (record; coerce per the registry param defs — number/`asString` color/`{x,y}` or 2-array vector2/boolean); **unknown `type` → `console.warn` + skip** (mirrors the unknown-component warn `:388-391`). The `case 'GeometryMesh'` branch (`:1498-1571`) is otherwise unchanged (aoMap/map loading stays).
3. `core/SceneSaver.ts` — **no change** (`:528-533` already delegates to `serializeConfig`).
4. `index.ts` — export the `shader-effects/` module; the `GeometryMeshEffectsConfig` export changes shape (grep shows no external consumers beyond SceneLoader).

Back-compat: none (D6). DeepCore scan found no `material.effects` usage.

## 7. Editor: operations, commands, picker, inspector

**Operations** (`src/features/effects/`, mirroring `src/features/scripts/`):
- `AddEffectOperation` (`effects.add-effect`): resolve node from `sceneManager.getActiveSceneGraph().nodeMap` → `node.attachEffect(type)` → mark scene dirty; undo `detachEffect`, redo re-attach (mirror `AddComponentOperation.ts:37-127`; no id generation needed — type is the identity).
- `RemoveEffectOperation`: capture `{enabled, params}` before detach for undo (mirror `RemoveComponentOperation.ts:62-105`).
- `AddEffectCommand` / `RemoveEffectCommand`: preconditions mirror `AddComponentCommand.ts:34-45` — active scene, target node, **prefab-instance lock** via `isPrefabInstanceNode` (effect attach-lists, like component lists, are not part of prefab override diffs — only param values are, via §3's schema-diff path).
- Param edits + enable toggles: `UpdateObjectPropertyCommand`/`Operation`, unchanged (D7).
- Reorder: deferred to v1.1 (`ReorderEffectOperation` — splice + dirty + cache-key change handles the rest). v1 order = attach order; with the current four effects the only same-anchor pair is dissolve/rim, whose order is visually irrelevant (independent additive terms).

**Picker**: new `src/services/EffectPickerService.ts` + `src/ui/shared/pix3-effect-picker.ts` — direct copies of `BehaviorPickerService` (88 lines of generic promise plumbing) and `pix3-behavior-picker.ts` (search/category-grid/description panel, minus the "Create New" button), reading `getAllShaderEffectTypes()` filtered to types not already attached. Host in `pix3-editor-shell.ts` next to `renderPickerHost` (`:1195-1233`) with `effect-selected`/`effect-picker-cancelled` events. (Optional later cleanup: genericize `BehaviorPickerService<T>`; not required.)

**Inspector** (`src/ui/object-inspector/inspector-panel.ts`):
1. New `renderEffectsSection()` rendered for `primaryNode instanceof GeometryMesh` alongside `renderScriptsSection()` (`:2200`): header "Effects" + Add button (→ `EffectPickerService.showPicker()` → `AddEffectCommand`, mirroring `onAddBehavior` `:2601-2614`); one card per `getAttachedEffects()` entry — header row = enable checkbox (dispatches `UpdateObjectPropertyCommand` on `fx.<key>.enabled`) + `displayName` + Remove link (→ `RemoveEffectCommand`); body = the effect's instance props rendered with the existing `renderPropertyInput` (they're already in `this.propertySchema` and `this.propertyValues` — `syncValuesFromNode` `:540-571` handles them generically).
2. Exclude effect groups from the generic group loop: in `renderProperties` (`:2176-2187`) filter out `groupName.startsWith('Effect: ')` (they're rendered by the cards instead).
3. Schema/value refresh after add/remove is automatic (scenes subscription `:289-291`); viewport repaint automatic (`ViewportRenderService.ts:392-396`).
4. `ViewportRenderService.syncGeometryMeshMap` (`:5149`) and the albedo-map flow: **unchanged**.

## 8. Migration from the just-shipped flat impl (all uncommitted)

Delete/replace in `GeometryMesh.ts`: `GeometryMeshEffectsConfig` (object form) / `ResolvedEffects` / `FxUniforms` / `FX_DEFINES` (`:52-87`), `FX_PARS`/`FX_DISSOLVE_RIM`/`FX_FLASH` (`:94-137` — content moves into `register-builtin-effects.ts`), `_fx` + `_fxUniforms` initializers (`:161-175`), `installFxShader` (`:390-411` → composer), `applyEffectsConfig`/`syncFxUniforms`/`syncFxDefines`/`setEffectEnabled` (`:414-493`), uv-scroll body of `tick` (`:497-504` → generic onTick loop), all 15 `fx*` schema props + the `Effects` group (`:702-887`, `:892`), `defaultEffects`/`serializeEffects` (`:914-921`, `:942-986`). Keep: albedo-map everything, `serializeConfig` skeleton, `readResourceUrl`.
`SceneLoader.ts`: rewrite `parseGeometryMeshEffects` (§6). `ViewportRenderService.ts`: no change. `docs/node-types-reference.md`: rewrite the Effects subsection (attach model + naming). `GeometryMeshEffectsPersistence.spec.ts`: rewrite (§9). Timeline/clip-evaluator/SceneSaver: untouched.

## 9. Test plan

**A. Rewrite `packages/pix3-runtime/src/core/GeometryMeshEffectsPersistence.spec.ts`** (keep `makeLoader`/`serialize`/`stdMaterial` helpers `:13-53`; happy-dom, no WebGL — assert on defines/uniforms/strings):
1. *Instance schema*: after `attachEffect('core:dissolve')`, `getNodePropertySchema(node)` contains `fx.dissolve.amount` etc. and the **static** `GeometryMesh.getPropertySchema()` does not (the bypass tripwire, §3); detach removes them; definitions are identity-stable across calls until the attach-list changes.
2. *Param → uniform*: set `fx.dissolve.amount` via the merged schema → param + `uPix3DissolveAmount.value`; color round-trips sRGB hex (`#00ff00` pattern).
3. *Enable toggle*: define set/cleared + `material.version` bump (pattern of current test `:71-84`).
4. *Persistence*: attach dissolve (params tweaked) + flash (disabled) → YAML has ordered `effects:` array, only non-default params, `enabled: false` preserved; parse → attached list, params, defines match; unknown `type` in YAML warns + skips and the rest load.
5. *GLSL composition*: run `onBeforeCompile` against `ShaderLib.physical` — every anchor matched, chunks wrapped in the right `#ifdef`s, chunk order follows attach order, uniform refs shared; `customProgramCacheKey()` differs between `[dissolve]`, `[dissolve,rim]`, `[rim,dissolve]`.
6. *tick*: uv-scroll `onTick` accumulates (0.2 uv/s × 0.5 s → 0.1) only when enabled; components still tick (stub Script pattern `:177-205`).
7. *Animation binding*: build a `KeyframeClip` with a `property: 'fx.dissolve.amount'` track, `createClipBindings(node, clip)` resolves it (no missingTargets), `applyClipAtTime` writes the uniform — the end-to-end animatability guarantee.

**B. New `shader-effects/ShaderEffectRegistry.spec.ts`**: lazy built-in seeding; duplicate key/id rejection; param-name validation.

**C. Editor (optional but cheap)**: `AddEffectOperation.spec.ts` mirroring `UpdateComponentPropertyOperation.spec.ts` — add/undo/redo, prefab-lock precondition.

Run only these + existing `GeometryMeshPersistence.spec.ts`; pre-existing repo noise (~32 tsc errors, CRLF lint flood) — isolate diffs per the known playbook.

## 10. Risks / fragile points / not verified

- **The funnel is a convention, not a compiler guarantee.** Nothing stops future code from calling `SomeNode.getPropertySchema()` statically and silently missing effect props. Mitigations: test A1 tripwire + a rule note in `docs/property-schema-system.md`. This is the single most fragile aspect of the instance-schema approach.
- **Cached `PropertyDefinition` identities.** `createClipBindings` (`clip-evaluator.ts:308-346`) and the preview snapshot (`AnimationTimelinePreviewService.ts:270-283`) hold `propDef`/closures across a session. Removing an effect mid-preview leaves stale closures writing into the detached instance's `params`/uniform bag — no crash, no render effect (program recompiled without the chunks), values discarded on re-attach. `AnimationPlayerBehavior` rebinds via `invalidateBindings`/`ensureBinding` (`AnimationPlayerBehavior.ts:255-284`). Accept + document.
- **Tracks referencing detached effects** become `missingTargets` (warn path `clip-evaluator.ts:337-339`) — same UX as tracks on deleted nodes (timeline shows the existing warning triangle only for missing *nodes*, `animation-timeline-panel.ts:2159-2162`; a missing-property indicator is a possible polish item).
- **Params of disabled effects are hidden from "Add Track"** if we keep the flat impl's `readOnly: enabled`-gating (filter at `animation-timeline-panel.ts:2668-2680`). Recommendation: keep `readOnly` gating for params (inspector clarity) — authors enable the effect before animating it; the `enabled` prop itself stays always-editable/animatable (boolean flips recompile — first flip compiles, later flips hit three's program cache; keep the "animate the amount, not the toggle" doc note).
- **Prefab instances**: attach-list changes on instances are locked (mirroring components); param overrides work via the schema diff. A prefab-source effect removal with an instance param override leaves an orphan `fx.*` key applied into `node.properties` (`SceneLoader.ts:834-837`) — harmless, same as components today.
- **three upgrade fragility**: string anchors verified for r183; test A5 turns anchor drift into a red test. Cache-key-miss-only `onBeforeCompile` behavior (`WebGLRenderer.js:2157-2178`) is version-sensitive — the cache-key-includes-order rule must survive upgrades.
- **Shadows don't dissolve** (depth pass uses `MeshDepthMaterial`; unchanged v1 limitation; future `customDepthMaterial`).
- **Not verified**: actual WebGL compilation of composed variants (happy-dom CI has no GL — manual editor smoke test required: attach all four, toggle each, animate `fx.dissolve.amount` 0→1 in play mode); collaboration/multi-client echo of the new ops (out of scope, follows existing op semantics); any DeepCore reliance on the *object*-shaped `GeometryMeshEffectsConfig` export (scan found none, but DeepCore is on a yalc'd runtime — republish required).
