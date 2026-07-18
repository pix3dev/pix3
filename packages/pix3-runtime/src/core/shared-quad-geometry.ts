import { PlaneGeometry } from 'three';

/**
 * A single 1×1 `PlaneGeometry` (centered at the origin, spanning [-0.5, 0.5] in
 * x and y, UVs 0→1) shared by every batchable 2D sprite mesh — `Sprite2D`,
 * `ColorRect2D`, `AnimatedSprite2D`. Instead of baking pixel dimensions into a
 * per-node `PlaneGeometry(w, h)`, nodes express their size via
 * `mesh.scale.set(width, height, 1)`. A unit quad scaled by (w, h) spans exactly
 * [-w/2, w/2] × [-h/2, h/2], identical to `PlaneGeometry(w, h)`, so rendering,
 * UV mapping, raycasting (three's `Mesh.raycast` applies `matrixWorld`, which
 * includes scale) and bounds are pixel-for-pixel unchanged.
 *
 * Why: resizing/spawning no longer disposes+recreates GPU geometry buffers (no
 * churn, fewer VAO binds, less GC), and the Phase-3 quad batcher can extract
 * every quad uniformly — four unit corners × `mesh.matrixWorld`.
 *
 * MUST NOT be disposed — it outlives every node and is referenced by many meshes
 * at once. Nodes that use it override {@link NodeBase.disposeResources} to free
 * only their own material, never this geometry (the default disposal pass would
 * otherwise dispose it via any single node teardown and break all the others).
 */
export const SHARED_UNIT_QUAD_GEOMETRY = new PlaneGeometry(1, 1);
