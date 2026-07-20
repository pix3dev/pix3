/**
 * Shader-effect contract types.
 *
 * A "shader effect" is a registry-declared bundle of GLSL chunks + uniforms +
 * an animatable param schema that a node (currently only {@link GeometryMesh})
 * can attach to its `MeshStandardMaterial` via `onBeforeCompile`. Effects are
 * pure data + injectors — they have NO lifecycle (unlike Script components), so
 * they live in a module-level registry rather than the DI ScriptRegistry.
 *
 * See `.plans/shader-effects-v2-list-design.md`.
 */
import type { PropertyUIHints } from '../fw/property-schema';

/**
 * GLSL injection anchors the composer understands. Verified against
 * `node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js` (r183):
 * - `uv_vertex` (vertex): `vPix3Uv` is in scope right after.
 * - `emissivemap_fragment` (fragment): `normal` + `totalEmissiveRadiance` in scope.
 * - `opaque_fragment` (fragment): `outgoingLight` still writable just before it.
 * - `color_fragment` (fragment): present in BOTH `meshbasic.glsl.js` and
 *   `meshphysical.glsl.js` (r183); right after it `diffuseColor` (vec4) is in
 *   scope and writable — the shared color anchor for basic + standard materials.
 */
export type ShaderEffectAnchor =
  | 'uv_vertex'
  | 'emissivemap_fragment'
  | 'opaque_fragment'
  | 'color_fragment';

/**
 * Which material family an effect's GLSL targets:
 * - `standard`: `MeshStandardMaterial` (PBR — GeometryMesh).
 * - `basic`: `MeshBasicMaterial` (unlit — the 2D sprite/skin pipeline).
 */
export type ShaderEffectTarget = 'standard' | 'basic';

export interface ShaderEffectChunk {
  stage: 'vertex' | 'fragment';
  anchor: ShaderEffectAnchor;
  position: 'after' | 'before';
  /** Raw GLSL; the composer wraps it in `#ifdef <define> ... #endif`. */
  glsl: string;
}

export type ShaderEffectParamType = 'number' | 'color' | 'vector2' | 'boolean';

export interface ShaderEffectVector2 {
  x: number;
  y: number;
}

export type ShaderEffectParamValue = number | string | ShaderEffectVector2 | boolean;

export interface ShaderEffectParamDef {
  /** Identifier-safe, dot-free. The schema name becomes `fx.<key>.<param>`. */
  key: string;
  type: ShaderEffectParamType;
  default: ShaderEffectParamValue;
  /**
   * Name of the uniform in this effect's bag to sync when the param changes.
   * `color` params are pushed through `Color.set(hex).convertSRGBToLinear()`
   * (matches `material.color`). Omit for CPU-only params (e.g. uv-scroll speed,
   * which feeds `onTick` instead of a uniform).
   */
  uniform?: string;
  ui?: PropertyUIHints;
}

export interface ShaderEffectTickContext {
  params: Readonly<Record<string, unknown>>;
  uniforms: Record<string, { value: unknown }>;
}

export interface ShaderEffectTypeInfo {
  /** Registry id, e.g. `core:dissolve`. Serialized as the effect's `type`. */
  id: string;
  /** Short key, e.g. `dissolve`. Namespaces property names + enforces uniqueness. */
  key: string;
  displayName: string;
  description: string;
  /** Picker grouping, e.g. 'Surface' / 'Color'. */
  category: string;
  keywords: string[];
  /** `#define` toggled by the effect's `enabled` flag, e.g. `PIX3_FX_DISSOLVE`. */
  define: string;
  /**
   * Material families this effect's GLSL supports. Omitted = `['standard']`
   * (back-compat with the GeometryMesh-only effects). A host stack refuses to
   * attach an effect whose targets don't include the stack's own target.
   */
  targets?: ShaderEffectTarget[];
  /** Declarations prepended once to the vertex shader (uniforms). */
  vertexPars?: string;
  /** Declarations prepended once to the fragment shader (uniforms, helper fns). */
  fragmentPars?: string;
  chunks: ShaderEffectChunk[];
  params: ShaderEffectParamDef[];
  /** Build a fresh uniform bag; the `{ value }` refs are shared into every
   * compiled program so param edits survive recompiles. */
  createUniforms(): Record<string, { value: unknown }>;
  /** Per-frame CPU update in play mode (e.g. uv-scroll offset accumulation). */
  onTick?(ctx: ShaderEffectTickContext, dt: number): void;
}

/**
 * Whether an effect supports a given material target. An effect with no declared
 * `targets` supports only `standard` (the original GeometryMesh-only default).
 */
export function effectSupportsTarget(
  info: ShaderEffectTypeInfo,
  target: ShaderEffectTarget
): boolean {
  const targets = info.targets ?? ['standard'];
  return targets.includes(target);
}

/** A shader effect attached to a node instance (one per type in v1). */
export interface AttachedShaderEffect {
  /** Registry id (`core:dissolve`). */
  type: string;
  info: ShaderEffectTypeInfo;
  enabled: boolean;
  /** Fully-resolved param values (defaults merged with authored overrides). */
  params: Record<string, unknown>;
  /** This effect's uniform bag (shared into compiled programs). */
  uniforms: Record<string, { value: unknown }>;
}
