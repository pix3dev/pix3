import { InstancedMesh, Material, Vector3, type BufferGeometry } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import { type GeometryMaterialType } from './material-family';
import type { PropertySchema } from '../../fw/property-schema';
/**
 * The authored material, as it appears under `material:` in a `.pix3scene`.
 *
 * The same vocabulary `GeometryMesh` uses, minus the texture maps and shader effects — an
 * instanced mesh shares one material across every instance, so per-instance texturing is not a
 * thing this node can express, and the per-instance colour buffer covers the variation people
 * actually want. Maps can be added later without changing this shape.
 */
export interface InstancedMaterialConfig {
    /** Material family (see `GEOMETRY_MATERIAL_TYPES`). Defaults to `standard`. */
    type?: string;
    color?: string;
    /** `standard` only. */
    roughness?: number;
    /** `standard` only. */
    metalness?: number;
}
export interface InstancedMesh3DProps extends Omit<Node3DProps, 'type'> {
    maxInstances: number;
    geometry?: BufferGeometry;
    /**
     * A ready three.js material, for code that builds its own. Takes precedence over
     * {@link InstancedMesh3DProps.materialConfig} — a caller holding a real material means it.
     */
    material?: Material | Material[];
    /**
     * The authored material. This is the scene-file path: before it existed the loader built no
     * material at all, so every scene-authored instanced mesh silently rendered as shared white PBR,
     * unreachable from the inspector and untouched by the project's mobile material policy.
     */
    materialConfig?: InstancedMaterialConfig;
    castShadow?: boolean;
    receiveShadow?: boolean;
    enablePerInstanceColor?: boolean;
    frustumCulled?: boolean;
}
export interface InstanceTransformArrayView {
    readonly count: number;
    readonly positions?: Float32Array;
    readonly rotations?: Float32Array;
    readonly scales?: Float32Array;
}
export interface InstanceColorArrayView {
    readonly count: number;
    readonly colors: Float32Array;
}
export interface InstanceMatrixArrayView {
    readonly count: number;
    readonly matrices: Float32Array;
}
export interface InstancedWriteOptions {
    markTransformDirty?: boolean;
    markColorDirty?: boolean;
    computeBoundingSphere?: boolean;
    visibleCount?: number;
}
export interface InstancedMeshRaycastHit {
    node: InstancedMesh3D;
    object: InstancedMesh;
    instanceId: number;
    distance: number;
    point: Vector3;
}
export declare class InstancedMesh3D extends Node3D {
    readonly mesh: InstancedMesh;
    readonly maxInstances: number;
    readonly castShadow: boolean;
    readonly receiveShadow: boolean;
    readonly enablePerInstanceColor: boolean;
    private readonly matrixBuffer;
    private readonly colorBuffer;
    /** Authored material family; decides what is built and what round-trips. */
    private _materialType;
    /** True while the mesh renders a material this node built and therefore owns. */
    private _ownsMaterial;
    private transformsDirty;
    private colorsDirty;
    private boundsDirty;
    constructor(props: InstancedMesh3DProps);
    protected disposeResources(): void;
    /** Every material slot the mesh renders with (one, unless the geometry has groups). */
    private get materialSlots();
    /** The slot the single-value accessors read; `null` when the mesh has no material at all. */
    private get singleMaterial();
    /** The authored material family. */
    get materialType(): GeometryMaterialType;
    /**
     * Swap the material family in place, carrying the colour over.
     *
     * A caller-supplied material is replaced too: asking for a family is asking for that family, and
     * silently keeping the old material would be the same class of quiet no-op this whole change is
     * about. Roughness/metalness only exist on `standard`, so they come back at their defaults.
     */
    set materialType(value: GeometryMaterialType);
    /** Material colour as an authored `#rrggbb` — the same convention every other node serializes. */
    get color(): string;
    set color(value: string);
    /**
     * The authored material, in the shape a `.pix3scene` carries it — or `null` when this node's
     * material is not expressible in it.
     *
     * A multi-slot mesh is exactly that case: the block describes ONE material, so writing it would
     * quietly discard every slot but the first on the next load. Such a mesh is built by code, which
     * rebuilds it on load anyway, so the honest serialization is no block at all — which is also what
     * the file carried before this block existed.
     */
    serializeMaterialConfig(): InstancedMaterialConfig | null;
    /** A material's `color`, when it has one (every family here does; a custom one may not). */
    private colorOf;
    /** A material's PBR pair, defaulted for the families that do not carry them. */
    private pbrOf;
    get visibleInstanceCount(): number;
    set visibleInstanceCount(value: number);
    setGeometry(geometry: BufferGeometry): void;
    /**
     * Replace the material from code. The node owns whatever it renders, so the material being
     * replaced is disposed and the reported family is re-read from the new one — without both, a mesh
     * swapped to `basic` at runtime kept leaking a standard material and went on **saving**
     * `type: standard`, describing a material it had not rendered since load.
     */
    setMaterial(material: Material | Material[]): void;
    writeMatrices(data: InstanceMatrixArrayView, options?: InstancedWriteOptions): void;
    writeTransforms(data: InstanceTransformArrayView, options?: InstancedWriteOptions): void;
    writeColors(data: InstanceColorArrayView, options?: InstancedWriteOptions): void;
    markTransformsDirty(): void;
    markColorsDirty(): void;
    flush(): void;
    clearInstances(): void;
    getInstanceMatrixBuffer(): Float32Array;
    getInstanceColorBuffer(): Float32Array | null;
    static getPropertySchema(): PropertySchema;
    private applyWriteOptions;
    private validateCount;
    private clampVisibleCount;
    private validateOptionalArrayLength;
}
