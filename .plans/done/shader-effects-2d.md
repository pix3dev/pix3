# Shader effects for 2D nodes (Construct 3-style) — implementation spec

Goal: generalize the existing GeometryMesh-only shader-effect system so effects
(registry-declared GLSL bundles with enabled flag + typed params) attach to 2D
nodes: **Sprite2D, AnimatedSprite2D, Button2D (skin)**. Effects must render in
the game runtime AND in the editor viewport (which draws separate proxy meshes).

Authoritative context (read before coding):
- `packages/pix3-runtime/src/shader-effects/` — types, registry, compose, builtins.
- `packages/pix3-runtime/src/nodes/3D/GeometryMesh.ts` — current attach/detach/
  schema/serialize machinery (lines ~305-520 + helpers at bottom) to EXTRACT.
- `packages/pix3-runtime/src/core/batch-2d.ts` — 2D quad batcher; meshes opt in
  via `mesh.userData[BATCHABLE_2D_KEY] = true`.
- `packages/pix3-runtime/src/core/SceneSaver.ts` — per-node-type serialization
  branches (`serializeNodeProperties`).
- `packages/pix3-runtime/src/core/GeometryMeshEffectsPersistence.spec.ts` — the
  persistence test pattern to mirror. MUST stay green.
- AGENTS.md rules apply (no `any`, path aliases, runtime stays editor-agnostic).

## Phase 1 — runtime (`packages/pix3-runtime`)

### 1. Types (`shader-effect-types.ts`)
- Add `export type ShaderEffectTarget = 'standard' | 'basic';`
  ('standard' = MeshStandardMaterial shader, 'basic' = MeshBasicMaterial).
- Add anchor `'color_fragment'` to `ShaderEffectAnchor` (exists in BOTH
  meshbasic.glsl.js and meshphysical.glsl.js; verified r183 — after it,
  `diffuseColor` (vec4) is in scope and writable).
- Add optional `targets?: ShaderEffectTarget[]` to `ShaderEffectTypeInfo`.
  Semantics: which material families the effect supports. Omitted =
  `['standard']` (back-compat). Add helper
  `export function effectSupportsTarget(info, target): boolean`.

### 2. Composer (`compose.ts`)
- `ANCHOR_INCLUDE` += `color_fragment: '#include <color_fragment>'`.
- `shaderEffectsCacheKey`: bump prefix literal to `'pix3-fx-v3:'` (injected-text
  version key; the old name said gmesh, now it is node-agnostic).
- No other logic changes — the composer is already node-agnostic.

### 3. NEW `ShaderEffectStack.ts` (same folder)
Extract the whole attached-effects machinery from GeometryMesh into a reusable
class. Move the module-level helpers from GeometryMesh.ts
(`cloneParamDefault`, `coerceParamValue`, `readEffectParam`, `paramEquals`,
`serializeParamValue`, `serializeEffectEntry`) into this module.

```ts
/** One authored, serialized effect attachment (was GeometryMeshEffectEntry). */
export interface ShaderEffectEntry {
  type: string;                       // registry id, e.g. 'core:adjust'
  enabled?: boolean;                  // default true
  params?: Record<string, unknown>;   // non-default overrides only
}

export interface ShaderEffectStackOptions {
  nodeType: string;                 // for the instance PropertySchema
  target: ShaderEffectTarget;       // material family this stack drives
  /** Called after attach/detach (NOT on param edits). Hosts use it to sync
   * the batcher opt-out flag. */
  onAttachmentsChanged?: () => void;
}

export class ShaderEffectStack {
  constructor(options: ShaderEffectStackOptions);

  /** Wire onBeforeCompile + customProgramCacheKey onto a material and register
   * it for define-sync. MULTIPLE materials may be installed (the node's own
   * material + the editor's proxy material) — all share the same effect list
   * and the same uniform `{value}` refs, so param edits reflect everywhere
   * without recompiles. */
  install(material: Material): void;
  /** Unregister a material (editor proxy rebuild/dispose). */
  uninstall(material: Material): void;

  attach(type: string, init?: { enabled?: boolean; params?: Record<string, unknown> }): boolean;
  detach(type: string): AttachedShaderEffect | null;
  setEnabled(type: string, on: boolean): void;
  /** Resolve by registry id OR short key ('core:adjust' | 'adjust') — script
   * convenience. Used by setParam/getParam/get. */
  get(typeOrKey: string): AttachedShaderEffect | undefined;
  setParam(typeOrKey: string, paramKey: string, value: unknown): boolean;
  getParam(typeOrKey: string, paramKey: string): unknown;
  getAttached(): readonly AttachedShaderEffect[];
  get isEmpty(): boolean;

  /** Per-instance schema (fx.<key>.enabled + fx.<key>.<param>), cached by an
   * internal revision — port of GeometryMesh.getInstancePropertySchema. */
  buildInstanceSchema(): PropertySchema | null;
  /** Advance onTick effects (play mode). */
  tick(dt: number): void;
  serialize(): ShaderEffectEntry[];
}
```

Behavior ported 1:1 from GeometryMesh: one instance per type; attach validates
the registry id AND `effectSupportsTarget(info, this.target)` (warn + return
false otherwise); merged uniform bag rebuilt on attach/detach; defines
(`PIX3_FX_*`) synced onto EVERY installed material with `needsUpdate = true`;
`customProgramCacheKey` closure reads the live list.

Host discovery (editor + scripts):
```ts
export interface ShaderEffectHost {
  getShaderEffectStack(): ShaderEffectStack;
}
export function isShaderEffectHost(node: unknown): node is ShaderEffectHost;
```

Export everything (incl. ShaderEffectEntry, ShaderEffectStack, isShaderEffectHost,
effectSupportsTarget) from `shader-effects/index.ts` and the package root
`index.ts`. Keep `GeometryMeshEffectEntry`/`GeometryMeshEffectsConfig` as
deprecated type aliases re-exported from GeometryMesh.ts (DeepCore compat).

### 4. GeometryMesh refactor
Replace `_effects/_fxUniforms/_effectsRevision/_instanceSchemaCache` + methods
with a `ShaderEffectStack` (`nodeType: 'GeometryMesh'`, `target: 'standard'`).
- Keep the public API delegating: `attachEffect`, `detachEffect`,
  `setEffectEnabled`, `getAttachedEffects`, `getInstancePropertySchema`,
  effects part of `serializeConfig`, `tick`.
- Implement `ShaderEffectHost`.
- `installEffectComposer(material)` → `stack.install(material)`.
- `GeometryMeshEffectsPersistence.spec.ts` and `GeometryMeshPersistence.spec.ts`
  must pass unchanged.

### 5. Built-in effects (`register-builtin-effects.ts`)
Mark targets on existing: DISSOLVE `['standard']`, RIM `['standard']`,
UV_SCROLL `['standard', 'basic']` (its chunk is `vMapUv += ...` under
`USE_MAP` — valid in meshbasic), FLASH `['standard', 'basic']`
(`outgoingLight` exists in meshbasic before `opaque_fragment`).

Add three new dual-target (`['basic', 'standard']`) effects, category 'Color',
all chunks at anchor `color_fragment`, position 'after', operating on
`diffuseColor.rgb`:

- **`core:adjust` / key `adjust` / define `PIX3_FX_ADJUST`** — displayName
  "Adjust (Brightness/Contrast/Saturation)". Params (all number, slider):
  `saturation` (0..2, default 1, uniform uPix3AdjustSaturation),
  `contrast` (0..2, default 1, uniform uPix3AdjustContrast),
  `brightness` (0..2, default 1, uniform uPix3AdjustBrightness).
  GLSL (apply in this order):
  ```glsl
  float pix3AdjL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(vec3(pix3AdjL), diffuseColor.rgb, uPix3AdjustSaturation);
  diffuseColor.rgb = (diffuseColor.rgb - 0.5) * uPix3AdjustContrast + 0.5;
  diffuseColor.rgb *= uPix3AdjustBrightness;
  ```
- **`core:grayscale` / key `grayscale` / define `PIX3_FX_GRAYSCALE`** — param
  `amount` (0..1, default 1, slider, uniform uPix3GrayAmount); mix rgb toward
  its Rec.709 luminance by amount.
- **`core:tint` / key `tint` / define `PIX3_FX_TINT`** — params `color`
  (color, default '#ffffff', uniform uPix3TintColor) and `amount` (0..1,
  default 1, slider, uniform uPix3TintAmount); multiply tint:
  `diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uPix3TintColor, saturate(uPix3TintAmount));`

Unique GLSL local variable names per effect (they may coexist in one shader).
Keyword lists in the Construct 3 spirit (brightness, darken, hover, hsl, ...).

### 6. Wire the 2D hosts: Sprite2D, AnimatedSprite2D, Button2D
Each node:
- props gain `effects?: ShaderEffectEntry[]`.
- constructor: create `ShaderEffectStack` (`target: 'basic'`, nodeType =
  class name; Button2D installs on `buttonMaterial`, sprites on `material`),
  `stack.install(material)` BEFORE attaching entries, then attach each
  `props.effects` entry; `onAttachmentsChanged` sets the batcher flag:
  `mesh.userData[BATCHABLE_2D_KEY] = stack.isEmpty` (an effected mesh must NOT
  batch — the batcher would draw it with its own stock material; passthrough
  meshes render with their own material, so the injection just works).
- implement `ShaderEffectHost` + `InstancePropertySchemaProvider`
  (`getInstancePropertySchema() → stack.buildInstanceSchema()`) — see how
  GeometryMesh declares it; the schema merge path
  (`fw/property-schema-utils.ts`) already handles any provider.
- convenience delegations (public, script-facing): `attachEffect`,
  `detachEffect`, `setEffectEnabled`, `setEffectParam(typeOrKey, param, value)`,
  `getAttachedEffects`.
- `tick(dt)`: call `stack.tick(dt)` (Button2D already overrides tick — add the
  call; sprites add an override calling super).
- NOTE Sprite2D.setTexture resets `material.color` — unrelated, don't touch.

### 7. Serialization (SceneSaver)
In the `Sprite2D`, `AnimatedSprite2D`, `Button2D` branches of
`serializeNodeProperties`: always `delete props.effects;` first (the properties
bag carries the YAML-loaded value, which goes stale after editor detach), then
`if (!stack.isEmpty) props.effects = stack.serialize();`.
Verify the SceneLoader passes node YAML `properties` through to constructors
unmodified (it does for texture/width/etc.) — then loading needs no change.
Play-mode clone (serialize→parse) must round-trip effects.

### 8. Runtime tests (vitest, happy-dom)
- New `packages/pix3-runtime/src/core/Sprite2DEffectsPersistence.spec.ts`
  mirroring GeometryMeshEffectsPersistence.spec.ts: attach `core:adjust` with a
  non-default brightness to a Sprite2D → SceneSaver round-trip → entry
  `{ type, enabled, params: { brightness } }`; detach-all → no `effects` key;
  Button2D round-trip too.
- Batch opt-out: Sprite2D with an effect has
  `mesh.userData[BATCHABLE_2D_KEY] === false`, back to true after detach.
- Target gating: attaching `core:rim` (standard-only) to a Sprite2D returns
  false and attaches nothing.
- Stack multi-install: two materials installed, `setEnabled` flips
  `defines.PIX3_FX_*` + `needsUpdate` on both.
- compose: `color_fragment` chunks inject into a fake meshbasic-shaped shader
  string (follow existing ShaderEffectRegistry.spec.ts style).
Run: `npx vitest run packages/pix3-runtime` — plus the full
`npm run test` and `npm run type-check` at the end. Do NOT run repo-wide
prettier/lint --fix (CRLF noise); lint only files you touched via
`npx eslint <files>`.

## Phase 2 — editor (src/) [SEPARATE TASK — do not start in phase 1]
- Generalize `src/features/effects/*` operations + `inspector-panel.ts` gating
  from `instanceof GeometryMesh` to `isShaderEffectHost`.
- Effect picker filters by the host stack's target.
- ViewportRenderService: install the node's stack on 2D proxy materials
  (`createSprite2DVisual`, `createAnimatedSprite2DVisual`, UIControl2D visual
  for Button2D), uninstall on proxy disposal, requestRender after effect ops.

## Out of scope
- ColorRect2D/TiledSprite2D/Label2D hosts, per-effect custom user GLSL
  (user-defined effect registration already works via registerShaderEffect),
  multiple instances of one effect type, editor onTick preview.
