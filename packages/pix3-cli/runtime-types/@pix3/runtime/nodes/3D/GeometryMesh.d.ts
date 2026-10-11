import { Mesh, type Texture } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import { type GeometryMaterialType } from './material-family';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import type { AttachedShaderEffect } from '../../shader-effects/shader-effect-types';
import { ShaderEffectStack, type ShaderEffectEntry, type ShaderEffectHost } from '../../shader-effects/ShaderEffectStack';
/**
 * The material families and their builder live in `material-family` — `InstancedMesh3D` authors the
 * same three. Re-exported here because these names are public API that consumer projects import
 * from `@pix3/runtime`, and moving a file is not a reason to break them.
 */
export { GEOMETRY_MATERIAL_TYPES, DEFAULT_GEOMETRY_MATERIAL_TYPE, type GeometryMaterialType, } from './material-family';
/** Supported primitive kinds. `size` is interpreted per-shape (see buildGeometry). */
export declare const GEOMETRY_KINDS: readonly ["box", "sphere", "plane", "cylinder", "cone", "torus"];
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];
/**
 * One authored, serialized shader-effect attachment.
 * @deprecated Renamed to {@link ShaderEffectEntry} now that effects are
 * node-agnostic. Kept as an alias for DeepCore / consumer back-compat.
 */
export type GeometryMeshEffectEntry = ShaderEffectEntry;
/**
 * Ordered list of attached shader effects, as serialized under `material.effects`.
 * @deprecated Use `ShaderEffectEntry[]`.
 */
export type GeometryMeshEffectsConfig = ShaderEffectEntry[];
export interface GeometryMeshProps extends Omit<Node3DProps, 'type'> {
    geometry?: string;
    size?: [number, number, number];
    /** Whether the mesh casts shadows. Defaults to true (what every scene authored
     * before this was exposed already renders as). */
    castShadow?: boolean;
    /** Whether the mesh receives shadows cast by others. Defaults to true. */
    receiveShadow?: boolean;
    material?: {
        /** Material family (see {@link GEOMETRY_MATERIAL_TYPES}). Defaults to `standard`. */
        type?: string;
        color?: string;
        /** `standard` only. */
        roughness?: number;
        /** `standard` only. */
        metalness?: number;
        /** res:// path of a baked ambient-occlusion map (see the AO baker). */
        aoMap?: string;
        /** 0..1 strength of the AO map (default 1). */
        aoMapIntensity?: number;
        /** res:// path of the albedo (diffuse) map. Required for UV-scroll to show. */
        map?: string;
        /** Registry-backed shader effects attached to this mesh. */
        effects?: GeometryMeshEffectsConfig;
    };
}
export declare class GeometryMesh extends Node3D implements InstancePropertySchemaProvider, ShaderEffectHost {
    private _geometry?;
    private _material?;
    /** Authored geometry kind / size, kept so serialization survives round-trips
     * (the three.js BufferGeometry doesn't carry the authored primitive name). */
    private _geometryKind;
    private _size;
    /** res:// path of the baked AO map, kept for serialization (the runtime
     * Texture is loaded async by the loader / assigned by the AO baker). */
    private _aoMapSrc;
    /** Authored AO-map strength. Kept separate from the live
     * `material.aoMapIntensity` so runtime suppression (when realtime SSAO wins
     * the AO-mode cascade) can zero the effect without losing the authored value
     * on save. */
    private _aoMapIntensity;
    /** When true, the baked AO map is suppressed at render time (SSAO is driving
     * AO instead). Runtime-only — never serialized. */
    private _aoSuppressed;
    /** res:// path of the albedo map, kept for serialization (the Texture itself
     * is loaded async by the loader / editor viewport sync). */
    private _mapSrc;
    /** Authored material family; decides what is built and what round-trips. */
    private _materialType;
    /**
     * Registry-backed shader effects attached to the mesh material.
     *
     * Built in the constructor rather than as a field initializer because its target family depends
     * on the authored material type, which is only known once props are in hand.
     */
    private readonly effectStack;
    constructor(props: GeometryMeshProps);
    protected disposeResources(): void;
    /**
     * Build a primitive geometry from a kind + `size`. `size` is a single
     * `[x, y, z]` vector interpreted per-shape so one editable field works for
     * every primitive:
     * - box: full extents (x, y, z)
     * - sphere: diameter = x
     * - plane: a horizontal floor of x by z (rotated into the XZ plane)
     * - cylinder / cone: diameter = x, height = y
     * - torus: outer diameter = x, tube thickness scales with y
     */
    private static buildGeometry;
    /** The authored material family. */
    get materialType(): GeometryMaterialType;
    /**
     * Swap the material family in place, carrying over everything the new family can hold.
     *
     * Colour and the albedo map survive every family; roughness/metalness only exist on `standard`
     * and are re-defaulted when coming back to it; the AO map survives because all three families
     * support `aoMap`. Attached shader effects are re-installed onto the new material, and the ones
     * whose GLSL does not target the new family are dropped with a warning rather than left attached
     * and silently dead.
     */
    set materialType(value: GeometryMaterialType);
    /** Swap the child mesh's geometry to match the current kind + size. */
    private rebuildGeometry;
    /**
     * Ensure the dedicated lightmap UV set (`uv1`) exists on the current geometry.
     * The AO baker calls this before baking — the UV must exist before the texture
     * does. Idempotent.
     */
    ensureLightmapUV(): void;
    /** The child render mesh (exposed for the AO baker to read geometry/matrix). */
    get renderMesh(): Mesh | undefined;
    /**
     * Assign (or clear) the baked ambient-occlusion map. The AO map samples the
     * dedicated lightmap UV set (channel 1 / `uv1`), which is generated lazily so
     * a mesh with no AO pays no extra attribute cost.
     */
    setAOMap(texture: Texture | null): void;
    /** Authored strength of the AO map (0..1). Unaffected by runtime suppression. */
    get aoMapIntensity(): number;
    set aoMapIntensity(value: number);
    /**
     * Runtime-only: suppress (or restore) the baked AO map's contribution without
     * touching the authored intensity. Used by the AO-mode cascade so a scene set
     * to realtime SSAO doesn't double up with its baked maps.
     */
    setAOSuppressed(suppressed: boolean): void;
    /** res:// path of the baked AO map, or '' when none. Set by the AO baker. */
    get aoMapSrc(): string;
    set aoMapSrc(value: string);
    /**
     * Assign (or clear) the albedo (diffuse) map. 3D textures keep mipmaps (unlike
     * the 2D pipeline); only the colour space is forced. The res:// path is tracked
     * separately in `_mapSrc` for serialization.
     */
    setMap(texture: Texture | null): void;
    /**
     * Update the authored albedo-map path from an inspector resource value
     * (`{ type: 'texture', url }` or a plain string). The Texture is loaded by the
     * editor viewport sync / scene loader, mirroring Sprite3D's texture ref.
     */
    setMapResource(value: unknown): void;
    /** res:// path of the albedo map, or '' when none. */
    get mapSrc(): string;
    set mapSrc(value: string);
    /** The shader-effect stack driving the mesh material (editor + script access). */
    getShaderEffectStack(): ShaderEffectStack;
    /**
     * Wire the composer onto a freshly-built material via the effect stack, which
     * versions + injects the live attached-effect set (`onBeforeCompile` +
     * `customProgramCacheKey`) and syncs the `PIX3_FX_*` defines onto it.
     */
    private installEffectComposer;
    /**
     * Attach a shader effect by registry id (e.g. `core:dissolve`). One instance
     * per type in v1 — a duplicate attach is a no-op. Returns whether it attached.
     */
    attachEffect(type: string, init?: {
        enabled?: boolean;
        params?: Record<string, unknown>;
    }): boolean;
    /** Detach an effect by type. Returns the removed attachment (for undo) or null. */
    detachEffect(type: string): AttachedShaderEffect | null;
    /** Enable/disable an attached effect (recompiles the program). */
    setEffectEnabled(type: string, on: boolean): void;
    /** The attached effects, in composition order (read-only view). */
    getAttachedEffects(): readonly AttachedShaderEffect[];
    /**
     * Per-instance schema: the attached effects' params as `fx.<key>.<param>`
     * props (+ `fx.<key>.enabled`). Merged after the static schema by
     * `getNodePropertySchema` — so effect params are inspectable, keyframe-
     * animatable, undoable, and prefab-diffable. See {@link ShaderEffectStack}.
     */
    getInstancePropertySchema(): PropertySchema | null;
    /** Play-mode only: advance any effect with a per-frame CPU update (uv-scroll). */
    tick(dt: number): void;
    /**
     * Generate a deterministic, non-overlapping lightmap UV set (`uv1`) for a
     * primitive. A box needs a real 6-face atlas (its base `uv` overlaps faces);
     * the other primitives already have a unique [0,1] layout, so their base `uv`
     * is copied. Idempotent and cheap.
     */
    private static applyLightmapUV;
    get geometryKind(): GeometryKind;
    set geometryKind(value: string);
    /** Current `[x, y, z]` size vector (see {@link buildGeometry} for per-shape meaning). */
    get size(): [number, number, number];
    set size(value: [number, number, number]);
    /**
     * Authored configuration as a plain object for scene serialization. Reads the
     * LIVE material so inspector edits (which mutate the three.js material in
     * place, not `node.properties`) survive save and the play-mode serialize→parse
     * clone. Keys match the loader's expected property names one-to-one; the
     * transform is serialized separately by the generic Node3D path.
     */
    serializeConfig(): Record<string, unknown>;
    /** Push the node's authored shadow flags onto the child mesh the renderer actually sees. */
    private applyShadowFlags;
    private get _mesh();
    /**
     * The material as "something with a colour and a map" — true of all three families.
     * Colour edits must keep working when the mesh is not PBR, which `_stdMaterial` cannot express.
     */
    private get _colorMaterial();
    private get _stdMaterial();
    static getPropertySchema(): PropertySchema;
}
