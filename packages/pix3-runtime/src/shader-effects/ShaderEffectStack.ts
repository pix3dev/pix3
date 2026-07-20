/**
 * Reusable attached-shader-effect machinery, extracted from GeometryMesh so any
 * node authoring a `MeshStandardMaterial` (target `standard`) or
 * `MeshBasicMaterial` (target `basic`) can host registry-backed effects.
 *
 * A stack owns the authored effect list, the merged uniform bag, and the
 * per-instance property schema. Unlike the original GeometryMesh code it can
 * drive MULTIPLE installed materials at once (the node's own material plus, in
 * the editor, a separate proxy material): all installed materials share the same
 * effect list and the same uniform `{ value }` refs, so a param edit reflects
 * everywhere without a recompile, and a define toggle recompiles them all.
 *
 * Node-agnostic — the runtime stays editor-agnostic. See `.plans/shader-effects-2d.md`.
 */
import { Color, type Material } from 'three';
import type { PropertySchema, PropertyDefinition } from '../fw/property-schema';
import { defineProperty } from '../fw/property-schema';
import type {
  AttachedShaderEffect,
  ShaderEffectParamDef,
  ShaderEffectParamType,
  ShaderEffectParamValue,
  ShaderEffectTarget,
} from './shader-effect-types';
import { effectSupportsTarget } from './shader-effect-types';
import { getShaderEffectType } from './ShaderEffectRegistry';
import { composeEffectShaders, shaderEffectsCacheKey } from './compose';

/** One authored, serialized effect attachment (one per type in v1). */
export interface ShaderEffectEntry {
  /** Registry id, e.g. `core:adjust`. */
  type: string;
  /** Defaults to true when omitted. */
  enabled?: boolean;
  /** Non-default param overrides (keyed by the effect's param keys). */
  params?: Record<string, unknown>;
}

export interface ShaderEffectStackOptions {
  /** Node type used as the instance PropertySchema's `nodeType`. */
  nodeType: string;
  /** Material family this stack drives (gates which effects can attach). */
  target: ShaderEffectTarget;
  /**
   * Called after attach/detach (NOT on param edits or enable toggles). Hosts use
   * it to sync side state such as the 2D batcher opt-out flag.
   */
  onAttachmentsChanged?: () => void;
}

/** A node that hosts a {@link ShaderEffectStack} (editor + script discovery). */
export interface ShaderEffectHost {
  getShaderEffectStack(): ShaderEffectStack;
}

/** Duck-type guard for {@link ShaderEffectHost}. */
export function isShaderEffectHost(node: unknown): node is ShaderEffectHost {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as Partial<ShaderEffectHost>).getShaderEffectStack === 'function'
  );
}

export class ShaderEffectStack {
  private readonly nodeType: string;
  private readonly target: ShaderEffectTarget;
  private readonly onAttachmentsChanged?: () => void;

  /** Ordered list of attached shader effects (one per type in v1). */
  private readonly effects: AttachedShaderEffect[] = [];
  /** Merged uniform bag across attached effects. The per-effect `{ value }` refs
   * are shared into every compiled program so param edits survive recompiles. */
  private fxUniforms: Record<string, { value: unknown }> = {};
  /** Every material this stack drives (node material + editor proxy material). */
  private readonly materials = new Set<Material>();
  /** Bumped on attach/detach; keys the instance-schema cache. */
  private revision = 0;
  private schemaCache: { rev: number; schema: PropertySchema } | null = null;

  constructor(options: ShaderEffectStackOptions) {
    this.nodeType = options.nodeType;
    this.target = options.target;
    this.onAttachmentsChanged = options.onAttachmentsChanged;
  }

  /** The material family this stack drives (the editor picker filters by it). */
  get materialTarget(): ShaderEffectTarget {
    return this.target;
  }

  /**
   * Wire the composer onto a material and register it for define-sync. Multiple
   * materials may be installed — all share the live effect list + uniform refs.
   * `onBeforeCompile` reads the live list so it always reflects the current set;
   * `customProgramCacheKey` versions the injected text so three recompiles when
   * the set/order changes.
   */
  install(material: Material): void {
    material.onBeforeCompile = shader => {
      composeEffectShaders(shader, this.effects, this.fxUniforms);
    };
    material.customProgramCacheKey = () => shaderEffectsCacheKey(this.effects);
    this.materials.add(material);
    this.syncDefinesOn(material, true);
  }

  /** Unregister a material (editor proxy rebuild/dispose). */
  uninstall(material: Material): void {
    this.materials.delete(material);
  }

  /**
   * Attach a shader effect by registry id (e.g. `core:adjust`). One instance per
   * type — a duplicate attach is a no-op. Refuses effects whose targets don't
   * include this stack's target. Returns whether it attached.
   */
  attach(type: string, init?: { enabled?: boolean; params?: Record<string, unknown> }): boolean {
    if (this.effects.some(e => e.type === type)) {
      return false;
    }
    const info = getShaderEffectType(type);
    if (!info) {
      console.warn(`[ShaderEffectStack] Unknown shader effect "${type}" — skipped.`);
      return false;
    }
    if (!effectSupportsTarget(info, this.target)) {
      console.warn(
        `[ShaderEffectStack] Effect "${type}" does not support the "${this.target}" material — skipped.`
      );
      return false;
    }
    const effect: AttachedShaderEffect = {
      type,
      info,
      enabled: typeof init?.enabled === 'boolean' ? init.enabled : true,
      params: {},
      uniforms: info.createUniforms(),
    };
    for (const p of info.params) {
      const override = init?.params?.[p.key];
      effect.params[p.key] =
        override !== undefined ? coerceParamValue(override, p.type) : cloneParamDefault(p.default);
    }
    this.effects.push(effect);
    this.applyParamsToUniforms(effect);
    this.rebuildUniformBag();
    this.revision += 1;
    this.schemaCache = null;
    this.syncDefines(true);
    this.onAttachmentsChanged?.();
    return true;
  }

  /** Detach an effect by type. Returns the removed attachment (for undo) or null. */
  detach(type: string): AttachedShaderEffect | null {
    const idx = this.effects.findIndex(e => e.type === type);
    if (idx < 0) {
      return null;
    }
    const [removed] = this.effects.splice(idx, 1);
    this.rebuildUniformBag();
    this.revision += 1;
    this.schemaCache = null;
    this.syncDefines(true);
    this.onAttachmentsChanged?.();
    return removed ?? null;
  }

  /** Enable/disable an attached effect (recompiles every installed program). */
  setEnabled(type: string, on: boolean): void {
    const effect = this.effects.find(e => e.type === type);
    if (!effect || effect.enabled === on) {
      return;
    }
    effect.enabled = on;
    this.syncDefines(true);
  }

  /**
   * Resolve an attached effect by registry id OR short key
   * (`core:adjust` | `adjust`). Script/inspector convenience.
   */
  get(typeOrKey: string): AttachedShaderEffect | undefined {
    return this.effects.find(
      e => e.type === typeOrKey || e.info.id === typeOrKey || e.info.key === typeOrKey
    );
  }

  /** Set one param on an attached effect (+ sync its uniform). Returns success. */
  setParam(typeOrKey: string, paramKey: string, value: unknown): boolean {
    const effect = this.get(typeOrKey);
    if (!effect) {
      return false;
    }
    const param = effect.info.params.find(p => p.key === paramKey);
    if (!param) {
      return false;
    }
    this.writeEffectParam(effect, param, value);
    return true;
  }

  /** Read one param the way the inspector expects (vector2 → a fresh {x,y}). */
  getParam(typeOrKey: string, paramKey: string): unknown {
    const effect = this.get(typeOrKey);
    if (!effect) {
      return undefined;
    }
    const param = effect.info.params.find(p => p.key === paramKey);
    if (!param) {
      return undefined;
    }
    return readEffectParam(effect, param);
  }

  /** The attached effects, in composition order (read-only view). */
  getAttached(): readonly AttachedShaderEffect[] {
    return this.effects;
  }

  get isEmpty(): boolean {
    return this.effects.length === 0;
  }

  /**
   * Per-instance schema: the attached effects' params as `fx.<key>.<param>`
   * props (+ `fx.<key>.enabled`). Merged after the static schema by
   * `getNodePropertySchema`, which every schema consumer funnels through — so
   * effect params are inspectable, keyframe-animatable, undoable, and prefab-
   * diffable. Cached by `revision` (invalidated on attach/detach); the closures
   * capture the effect instance so identities stay stable for the animation
   * binder / preview snapshot.
   */
  buildInstanceSchema(): PropertySchema | null {
    if (this.effects.length === 0) {
      return null;
    }
    if (this.schemaCache && this.schemaCache.rev === this.revision) {
      return this.schemaCache.schema;
    }

    const properties: PropertyDefinition[] = [];
    const groups: NonNullable<PropertySchema['groups']> = {};

    for (const effect of this.effects) {
      const group = `Effect: ${effect.info.displayName}`;
      groups[group] = { label: effect.info.displayName, expanded: true };

      properties.push(
        defineProperty(`fx.${effect.info.key}.enabled`, 'boolean', {
          ui: { label: 'Enabled', group },
          getValue: () => effect.enabled,
          setValue: (_n: unknown, v: unknown) => this.setEnabled(effect.type, Boolean(v)),
        })
      );

      for (const param of effect.info.params) {
        properties.push(
          defineProperty(`fx.${effect.info.key}.${param.key}`, param.type, {
            ui: { ...(param.ui ?? {}), group, readOnly: () => !effect.enabled },
            getValue: () => readEffectParam(effect, param),
            setValue: (_n: unknown, v: unknown) => this.writeEffectParam(effect, param, v),
          })
        );
      }
    }

    const schema: PropertySchema = { nodeType: this.nodeType, properties, groups };
    this.schemaCache = { rev: this.revision, schema };
    return schema;
  }

  /** Play-mode only: advance any effect with a per-frame CPU update (uv-scroll). */
  tick(dt: number): void {
    for (const effect of this.effects) {
      if (effect.enabled && effect.info.onTick) {
        effect.info.onTick({ params: effect.params, uniforms: effect.uniforms }, dt);
      }
    }
  }

  /** Serialize the attached effects (only non-default params emitted). */
  serialize(): ShaderEffectEntry[] {
    return this.effects.map(effect => serializeEffectEntry(effect));
  }

  // ---------------------------------------------------------------------------

  /** Rebuild the merged uniform bag from the per-effect bags (refs reused). */
  private rebuildUniformBag(): void {
    const bag: Record<string, { value: unknown }> = {};
    for (const effect of this.effects) {
      Object.assign(bag, effect.uniforms);
    }
    this.fxUniforms = bag;
  }

  /** Sync the `PIX3_FX_*` defines onto every installed material. */
  private syncDefines(needsUpdate: boolean): void {
    for (const material of this.materials) {
      this.syncDefinesOn(material, needsUpdate);
    }
  }

  /** Set/clear the `PIX3_FX_*` defines on one material from the enabled effects. */
  private syncDefinesOn(material: Material, needsUpdate: boolean): void {
    material.defines ??= {};
    const defines = material.defines;
    for (const key of Object.keys(defines)) {
      if (key.startsWith('PIX3_FX_')) {
        delete defines[key];
      }
    }
    for (const effect of this.effects) {
      if (effect.enabled) {
        defines[effect.info.define] = '';
      }
    }
    if (needsUpdate) {
      material.needsUpdate = true;
    }
  }

  private applyParamsToUniforms(effect: AttachedShaderEffect): void {
    for (const p of effect.info.params) {
      this.applyParamToUniform(effect, p);
    }
  }

  private applyParamToUniform(effect: AttachedShaderEffect, param: ShaderEffectParamDef): void {
    if (!param.uniform) {
      return;
    }
    const uniform = effect.uniforms[param.uniform];
    if (!uniform) {
      return;
    }
    const value = effect.params[param.key];
    switch (param.type) {
      case 'number':
        (uniform as { value: number }).value = Number(value);
        break;
      case 'color':
        (uniform.value as Color).set(String(value)).convertSRGBToLinear();
        break;
      case 'vector2': {
        const vec = value as { x: number; y: number };
        (uniform.value as { set: (x: number, y: number) => void }).set(vec.x, vec.y);
        break;
      }
      case 'boolean':
        (uniform as { value: number }).value = value ? 1 : 0;
        break;
    }
  }

  /** Write one effect param (from a schema setValue) + sync its uniform. */
  private writeEffectParam(
    effect: AttachedShaderEffect,
    param: ShaderEffectParamDef,
    value: unknown
  ): void {
    effect.params[param.key] = coerceParamValue(value, param.type);
    this.applyParamToUniform(effect, param);
  }
}

// -----------------------------------------------------------------------------
// Module-level helpers (moved verbatim from GeometryMesh.ts).
// -----------------------------------------------------------------------------

/** Fresh copy of a param default (vector2 defaults are objects — must clone). */
function cloneParamDefault(value: ShaderEffectParamValue): unknown {
  return value && typeof value === 'object' ? { ...(value as object) } : value;
}

/** Coerce an inbound value to the stored representation for a param type. */
function coerceParamValue(value: unknown, type: ShaderEffectParamType): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'color':
      return String(value);
    case 'vector2': {
      if (Array.isArray(value)) {
        return { x: Number(value[0]) || 0, y: Number(value[1]) || 0 };
      }
      const vec = value as { x?: unknown; y?: unknown };
      return { x: Number(vec?.x) || 0, y: Number(vec?.y) || 0 };
    }
    case 'boolean':
      return Boolean(value);
  }
}

/** Read a param the way the inspector expects (vector2 → a fresh {x,y}). */
function readEffectParam(effect: AttachedShaderEffect, param: ShaderEffectParamDef): unknown {
  const value = effect.params[param.key];
  if (param.type === 'vector2') {
    const vec = value as { x: number; y: number };
    return { x: vec.x, y: vec.y };
  }
  return value;
}

function paramEquals(a: unknown, b: unknown, type: ShaderEffectParamType): boolean {
  if (type === 'vector2') {
    const va = a as { x: number; y: number };
    const vb = b as { x: number; y: number };
    return va.x === vb.x && va.y === vb.y;
  }
  return a === b;
}

function serializeParamValue(value: unknown, type: ShaderEffectParamType): unknown {
  if (type === 'vector2') {
    const vec = value as { x: number; y: number };
    return { x: vec.x, y: vec.y };
  }
  return value;
}

/** Serialize one attachment, emitting only params that differ from default. */
function serializeEffectEntry(effect: AttachedShaderEffect): ShaderEffectEntry {
  const entry: ShaderEffectEntry = { type: effect.type, enabled: effect.enabled };
  const params: Record<string, unknown> = {};
  for (const p of effect.info.params) {
    const value = effect.params[p.key];
    if (!paramEquals(value, p.default, p.type)) {
      params[p.key] = serializeParamValue(value, p.type);
    }
  }
  if (Object.keys(params).length > 0) {
    entry.params = params;
  }
  return entry;
}
