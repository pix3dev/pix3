import { Mesh, type Scene } from 'three';
/**
 * Paint-order-preserving 2D quad batcher (Phase 3). A classic immediate-mode
 * sprite batcher: every frame it walks the same stamped `renderOrder` order the
 * 2D pass draws in, groups maximal contiguous runs of quads that share one
 * material state (same texture SOURCE + blending + layer band), and emits each
 * run as a single draw call — quads appended in stamped order.
 *
 * Invariant B1 (paint order) holds by construction: blocks (batch runs and
 * single passthrough meshes) inherit the stamped order of their first member as
 * `renderOrder`, so three's transparent-list sort draws blocks in original
 * order; within a batch, quads are appended to the index buffer in stamped
 * order, and a single draw rasterizes primitives in index order.
 *
 * Per-node opacity/tint ride a 4-component vertex color (never mutating a shared
 * batch material), so the existing fade system keeps working. Batched source
 * meshes are hidden via `material.visible = false` (removes them from the render
 * list without touching `Object3D.visible`, which game logic + raycast read).
 */
/** Marker on `mesh.userData`: this mesh's node opted the mesh into batching. */
export declare const BATCHABLE_2D_KEY = "pix3Batchable2D";
/** One ordered 2D mesh, produced by the render-order walk (see render-order-2d). */
export interface OrderedMesh2D {
    mesh: Mesh;
    order: number;
    overlay: boolean;
    visible: boolean;
}
export interface Batch2DStats {
    batches: number;
    quads: number;
    passthrough: number;
}
export declare class Batch2DSystem {
    private readonly group;
    private readonly pool;
    private readonly materials;
    private readonly batchMaps;
    private suppressed;
    readonly stats: Batch2DStats;
    constructor(scene: Scene);
    /** Active batch meshes this frame, in pool order (for tests / debugging). */
    get activeBatchMeshes(): Mesh[];
    /**
     * Rebuild all batches for one frame from the ordered 2D mesh list (already in
     * stamped `renderOrder`). Segments contiguous same-key runs, fills batch
     * geometries, and suppresses/restores source materials by delta.
     */
    update(ordered: readonly OrderedMesh2D[]): void;
    /** Group the ordered list into maximal contiguous batchable runs of length ≥ 2. */
    private segment;
    /**
     * Batch key for a mesh, or null if it must not batch. Batchable = opted-in +
     * effectively visible + non-transparent-zero + a stock MeshBasicMaterial with
     * normal blending. Runs group by texture SOURCE (so all views of one atlas
     * sheet — and multiple instances of the same raw texture — merge) + band.
     */
    private keyFor;
    private materialFor;
    /**
     * An identity-transform texture sharing the source's GPU image, used as the
     * batch material map so per-quad UVs are sampled raw (the source view carries a
     * non-identity offset/repeat we must not apply globally). One per source,
     * uploaded once (mirrors the Sprite2D.ownedTexture clone pattern).
     */
    private batchMapFor;
    dispose(): void;
}
