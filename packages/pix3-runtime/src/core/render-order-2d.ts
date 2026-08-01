import type { Object3D } from 'three';

import { Node2D } from '../nodes/Node2D';
import { LAYER_2D_OVERLAY } from '../constants';

/**
 * Optional per-mesh collector invoked during the render-order walk, in stamped
 * order. Feeds the Phase-3 quad batcher without a second traversal: `overlay` is
 * the layer band (LAYER_2D_OVERLAY vs the main band), `visible` is inherited
 * visibility (all ancestors + self visible).
 */
export type RenderOrder2DSink = (
  mesh: Object3D,
  order: number,
  overlay: boolean,
  visible: boolean
) => void;

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
export const OVERLAY_2D_FLAG = 'pix3Overlay2D';

interface AssignContext {
  next: number;
}

/**
 * One stamping step: a mesh subtree that must receive a contiguous block of
 * `renderOrder` values, tagged with the effective z of the node that owns it and
 * with that node's inherited visibility.
 */
interface PaintUnit {
  /** Nulled after stamping so a pooled entry never pins a removed mesh alive. */
  obj: Object3D | null;
  z: number;
  visible: boolean;
}

interface CollectContext {
  units: PaintUnit[];
  count: number;
  /** Set when any node carries a non-default z, i.e. the DFS order needs a sort. */
  needsSort: boolean;
}

/**
 * Reused across calls so the common (all-default z) path allocates nothing in
 * steady state — this walk runs every frame in the runtime. Entries are recycled
 * by overwriting their fields; `count` is the live length. Safe as module state
 * because the walk is synchronous and never re-entrant.
 */
const unitPool: PaintUnit[] = [];

function pushUnit(ctx: CollectContext, obj: Object3D, z: number, visible: boolean): void {
  const existing = ctx.units[ctx.count];
  if (existing) {
    existing.obj = obj;
    existing.z = z;
    existing.visible = visible;
  } else {
    ctx.units.push({ obj, z, visible });
  }
  ctx.count++;
}

interface NodeMeshGroups {
  childNodes: Node2D[];
  own: Object3D[];
  overlay: Object3D[];
}

function collectGroups(node: Node2D): NodeMeshGroups {
  const childNodes: Node2D[] = [];
  const own: Object3D[] = [];
  const overlay: Object3D[] = [];

  for (const child of node.children) {
    if (child instanceof Node2D) {
      childNodes.push(child);
    } else if (child.userData && child.userData[OVERLAY_2D_FLAG]) {
      overlay.push(child);
    } else {
      own.push(child);
    }
  }

  return { childNodes, own, overlay };
}

/**
 * Orders a node's own meshes by their authored `renderOrder`, falling back to
 * add-order for ties. This is the intra-node stacking the controls encode with
 * their hardcoded `renderOrder` values (e.g. Button2D background 999 < label
 * 1001) — which does NOT match add-order, because UIControl2D adds its label in
 * the base constructor (via `super()`) before the subclass adds its skin mesh.
 *
 * The sort is idempotent across frames: once rebased to contiguous values the
 * relative order is preserved, so re-running on already-assigned meshes is a
 * no-op, and any freshly created mesh (carrying its high authored value) sorts
 * back into place on the next pass.
 */
function sortByAuthoredOrder(meshes: Object3D[]): Object3D[] {
  // Sort the (throwaway) array in place. Array.prototype.sort is stable
  // (ES2019+), so equal-`renderOrder` meshes keep their add-order without the
  // explicit index tie-break — avoiding the decorate/sort/undecorate array
  // allocations. This runs every frame in the runtime, so the churn matters.
  return meshes.sort((a, b) => a.renderOrder - b.renderOrder);
}

function assignMeshSubtree(
  obj: Object3D,
  ctx: AssignContext,
  parentVisible: boolean,
  sink?: RenderOrder2DSink
): void {
  obj.renderOrder = ctx.next++;
  const visible = parentVisible && obj.visible !== false;
  if (sink) {
    sink(obj, obj.renderOrder, obj.layers.isEnabled(LAYER_2D_OVERLAY), visible);
  }
  for (const child of obj.children) {
    assignMeshSubtree(child, ctx, visible, sink);
  }
}

function collectNode(
  node: Node2D,
  ctx: CollectContext,
  parentVisible: boolean,
  parentZ: number
): void {
  const { childNodes, own, overlay } = collectGroups(node);
  const nodeVisible = parentVisible && node.visible !== false;
  const z = node.zAsRelative ? parentZ + node.zIndex : node.zIndex;
  if (z !== 0) {
    ctx.needsSort = true;
  }

  // 1. The node's own meshes render below its children, in authored order.
  for (const mesh of sortByAuthoredOrder(own)) {
    pushUnit(ctx, mesh, z, nodeVisible);
  }

  // 2. Child nodes (and their subtrees) render on top, in hierarchy order.
  for (const child of childNodes) {
    collectNode(child, ctx, nodeVisible, z);
  }

  // 3. Flagged overlay meshes render above the whole subtree (e.g. scrollbars).
  for (const mesh of sortByAuthoredOrder(overlay)) {
    pushUnit(ctx, mesh, z, nodeVisible);
  }
}

/**
 * Assigns `renderOrder` to every mesh in the given 2D node trees so that draw
 * order follows the scene-graph hierarchy: a node deeper / later in the tree
 * renders on top of nodes that come before it, while each node's internal mesh
 * stacking (skin below label, scrollbar above content, …) is preserved.
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
 */
export function assign2DRenderOrder(roots: readonly Object3D[], sink?: RenderOrder2DSink): void {
  const collect: CollectContext = { units: unitPool, count: 0, needsSort: false };
  for (const root of roots) {
    if (root instanceof Node2D) {
      collectNode(root, collect, true, 0);
    }
  }

  // `Array.prototype.sort` is stable (ES2019+), so equal-z units keep DFS order.
  // The slice is the only allocation on this path and only happens when z-order
  // is actually in use.
  const units = collect.needsSort
    ? unitPool.slice(0, collect.count).sort((a, b) => a.z - b.z)
    : unitPool;

  const ctx: AssignContext = { next: 0 };
  for (let i = 0; i < collect.count; i++) {
    const obj = units[i].obj;
    if (obj) {
      assignMeshSubtree(obj, ctx, units[i].visible, sink);
    }
  }

  // Drop references so the pool does not pin removed meshes alive between frames.
  for (let i = 0; i < collect.count; i++) {
    unitPool[i].obj = null;
  }
}
