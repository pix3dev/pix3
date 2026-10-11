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
 * Node-agnostic — the runtime stays editor-agnostic. See `.plans/done/shader-effects-2d.md`.
 */
import { type Material } from 'three';
import type { PropertySchema } from '../fw/property-schema';
import type { AttachedShaderEffect, ShaderEffectTarget } from './shader-effect-types';
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
export declare function isShaderEffectHost(node: unknown): node is ShaderEffectHost;
export declare class ShaderEffectStack {
    private readonly nodeType;
    private target;
    private readonly onAttachmentsChanged?;
    /** Ordered list of attached shader effects (one per type in v1). */
    private readonly effects;
    /** Merged uniform bag across attached effects. The per-effect `{ value }` refs
     * are shared into every compiled program so param edits survive recompiles. */
    private fxUniforms;
    /** Every material this stack drives (node material + editor proxy material). */
    private readonly materials;
    /** Bumped on attach/detach; keys the instance-schema cache. */
    private revision;
    private schemaCache;
    constructor(options: ShaderEffectStackOptions);
    /** The material family this stack drives (the editor picker filters by it). */
    get materialTarget(): ShaderEffectTarget;
    /**
     * Point the stack at a different material family (its host swapped its material type).
     *
     * Effects whose GLSL does not declare the new target are detached and named in a warning: an
     * effect left attached to a material it cannot compile against is a feature that silently stops
     * working, which is exactly the class of failure this file's neighbours are here to end.
     */
    retarget(next: ShaderEffectTarget): void;
    /**
     * Wire the composer onto a material and register it for define-sync. Multiple
     * materials may be installed — all share the live effect list + uniform refs.
     * `onBeforeCompile` reads the live list so it always reflects the current set;
     * `customProgramCacheKey` versions the injected text so three recompiles when
     * the set/order changes.
     */
    install(material: Material): void;
    /** Unregister a material (editor proxy rebuild/dispose). */
    uninstall(material: Material): void;
    /**
     * Attach a shader effect by registry id (e.g. `core:adjust`). One instance per
     * type — a duplicate attach is a no-op. Refuses effects whose targets don't
     * include this stack's target. Returns whether it attached.
     */
    attach(type: string, init?: {
        enabled?: boolean;
        params?: Record<string, unknown>;
    }): boolean;
    /** Detach an effect by type. Returns the removed attachment (for undo) or null. */
    detach(type: string): AttachedShaderEffect | null;
    /** Enable/disable an attached effect (recompiles every installed program). */
    setEnabled(type: string, on: boolean): void;
    /**
     * Resolve an attached effect by registry id OR short key
     * (`core:adjust` | `adjust`). Script/inspector convenience.
     */
    get(typeOrKey: string): AttachedShaderEffect | undefined;
    /** Set one param on an attached effect (+ sync its uniform). Returns success. */
    setParam(typeOrKey: string, paramKey: string, value: unknown): boolean;
    /** Read one param the way the inspector expects (vector2 → a fresh {x,y}). */
    getParam(typeOrKey: string, paramKey: string): unknown;
    /** The attached effects, in composition order (read-only view). */
    getAttached(): readonly AttachedShaderEffect[];
    get isEmpty(): boolean;
    /**
     * Per-instance schema: the attached effects' params as `fx.<key>.<param>`
     * props (+ `fx.<key>.enabled`). Merged after the static schema by
     * `getNodePropertySchema`, which every schema consumer funnels through — so
     * effect params are inspectable, keyframe-animatable, undoable, and prefab-
     * diffable. Cached by `revision` (invalidated on attach/detach); the closures
     * capture the effect instance so identities stay stable for the animation
     * binder / preview snapshot.
     */
    buildInstanceSchema(): PropertySchema | null;
    /** Play-mode only: advance any effect with a per-frame CPU update (uv-scroll). */
    tick(dt: number): void;
    /** Serialize the attached effects (only non-default params emitted). */
    serialize(): ShaderEffectEntry[];
    /** Rebuild the merged uniform bag from the per-effect bags (refs reused). */
    private rebuildUniformBag;
    /** Sync the `PIX3_FX_*` defines onto every installed material. */
    private syncDefines;
    /** Set/clear the `PIX3_FX_*` defines on one material from the enabled effects. */
    private syncDefinesOn;
    private applyParamsToUniforms;
    private applyParamToUniform;
    /** Write one effect param (from a schema setValue) + sync its uniform. */
    private writeEffectParam;
}
