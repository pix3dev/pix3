import type { Object3D } from 'three';
/**
 * Optional per-mesh collector invoked during the render-order walk, in stamped
 * order. Feeds the Phase-3 quad batcher without a second traversal: `overlay` is
 * the layer band (LAYER_2D_OVERLAY vs the main band), `visible` is inherited
 * visibility (all ancestors + self visible).
 */
export type RenderOrder2DSink = (mesh: Object3D, order: number, overlay: boolean, visible: boolean) => void;
/**
 * Marker flag (set on `object.userData`) for meshes that must render ABOVE the
 * descendant subtree of their owning {@link Node2D} instead of below it.
 *
 * The 2D overlay pass is rendered with an orthographic camera and `depthTest:
 * false` materials, so draw order is decided purely by `renderOrder`. By default
 * a node's own meshes are drawn below its child nodes; flag a mesh with this when
 * it has to float on top of the node's children — e.g. a ScrollContainer
 * scrollbar that overlays the scrolled content.
 */
export declare const OVERLAY_2D_FLAG = "pix3Overlay2D";
/**
 * Assigns `renderOrder` to every mesh in the given 2D node trees so that draw
 * order follows the scene-graph hierarchy: a node deeper / later in the tree
 * renders on top of nodes that come before it, while each node's internal mesh
 * stacking (skin below label, scrollbar above content, ...) is preserved.
 *
 * This is the single source of truth for 2D layering — both the editor viewport
 * and the runtime call it before the orthographic overlay pass. Without it the
 * 2D render list falls back to three.js's stable sort (object creation id) for
 * equal-`renderOrder`, equal-depth meshes, which does not match the hierarchy
 * the user authored.
 *
 * `Node2D.zIndex` overrides that hierarchy order: nodes are bucketed by effective
 * z (inherited when `zAsRelative`, the default) and the DFS order only breaks ties
 * inside a bucket. With every node at the default z the sort is skipped entirely
 * and the result is exactly the plain DFS order.
 *
 * Allocation contract: the outermost call allocates nothing per node or per
 * mesh (see {@link unitPool}); with z-order in use the only per-call cost is
 * whatever the engine's `Array.prototype.sort` needs internally. A call nested
 * inside a `sink` falls back to private buffers (see {@link activeWalks}).
 */
export declare function assign2DRenderOrder(roots: readonly Object3D[], sink?: RenderOrder2DSink): void;
