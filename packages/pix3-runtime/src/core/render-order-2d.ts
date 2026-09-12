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
 * by overwriting their fields; `count` is the live length.
 *
 * Why it matters: with SkyDefender in play the editor allocated ~190 KB per
 * frame and spent 5-9 % of frames in GC pauses of 20-70 ms. An earlier version
 * of this file partitioned each node's children into THREE fresh arrays per node
 * per frame (child nodes / own meshes / overlay meshes) plus a per-node wrapper
 * object — thousands of short-lived arrays a frame for a few hundred 2D nodes.
 * Every buffer the walk needs now lives in this module and is reused; nothing
 * here is allocated per node or per frame.
 */
const unitPool: PaintUnit[] = [];

/**
 * Reused buffer for the z-bucketed path: a copy of the live pool range that is
 * sorted by effective z. Only touched while some node has a non-default z. Its
 * entries alias {@link unitPool} objects (whose `obj` is nulled after every
 * pass), so a stale tail pins no mesh.
 */
const sortScratch: PaintUnit[] = [];

/**
 * Re-entrancy guard for the module-level buffers. The collect phase calls no
 * user code, but the stamp phase invokes the caller's `sink`, and a sink that
 * ran this walk again on another tree would overwrite the pool the outer call is
 * still iterating. A nested call therefore gets fresh, private buffers; only the
 * outermost walk uses the pool. The guard is a depth counter (not a boolean) so
 * a walk that throws out of a sink leaves the state consistent via `finally`.
 */
let activeWalks = 0;

/** Stable ascending order by effective z; DFS order breaks ties. */
const compareByZ = (a: PaintUnit, b: PaintUnit): number => a.z - b.z;

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

function isOverlayMesh(obj: Object3D): boolean {
  return Boolean(obj.userData && obj.userData[OVERLAY_2D_FLAG]);
}

/** Authored `renderOrder` of a live unit (a just-pushed unit always has an obj). */
function authoredOrderOf(unit: PaintUnit): number {
  return unit.obj ? unit.obj.renderOrder : 0;
}

/**
 * Orders the units in `[start, ctx.count)` by their mesh's authored
 * `renderOrder`, keeping add-order for ties. This is the intra-node stacking the
 * controls encode with their hardcoded `renderOrder` values (e.g. Button2D
 * background 999 < label 1001) — which does NOT match add-order, because
 * UIControl2D adds its label in the base constructor (via `super()`) before the
 * subclass adds its skin mesh.
 *
 * The sort is idempotent across frames: once rebased to contiguous values the
 * relative order is preserved, so re-running on already-assigned meshes is a
 * no-op, and any freshly created mesh (carrying its high authored value) sorts
 * back into place on the next pass.
 *
 * Implemented as an in-place stable insertion sort over the pool range rather
 * than `Array.prototype.sort` on a copied array: a node owns a handful of meshes
 * (typically 1-3), the range is already sorted on every frame after the first,
 * and — the point — it allocates nothing. Moving an entry only on a strictly
 * greater key is what keeps it stable.
 */
function sortUnitRangeByAuthoredOrder(ctx: CollectContext, start: number): void {
  const units = ctx.units;
  for (let i = start + 1; i < ctx.count; i++) {
    const unit = units[i];
    const order = authoredOrderOf(unit);
    let j = i - 1;
    while (j >= start && authoredOrderOf(units[j]) > order) {
      units[j + 1] = units[j];
      j--;
    }
    units[j + 1] = unit;
  }
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
  const children = obj.children;
  for (let i = 0; i < children.length; i++) {
    assignMeshSubtree(children[i], ctx, visible, sink);
  }
}

/**
 * Collects one node's paint units in paint order. The node's children are
 * classified three ways — child {@link Node2D}s, flagged overlay meshes, and
 * everything else (the node's own meshes) — and emitted as: own meshes (authored
 * order), then the child-node subtrees (hierarchy order), then overlay meshes
 * (authored order). Instead of partitioning into three lists first, the walk
 * makes three cheap passes over `node.children`, each picking one class; the
 * only buffer involved is the pool range the units are pushed into, sorted in
 * place. Same output, zero allocation.
 */
function collectNode(
  node: Node2D,
  ctx: CollectContext,
  parentVisible: boolean,
  parentZ: number
): void {
  const nodeVisible = parentVisible && node.visible !== false;
  const z = node.zAsRelative ? parentZ + node.zIndex : node.zIndex;
  if (z !== 0) {
    ctx.needsSort = true;
  }

  const children = node.children;
  const childCount = children.length;

  // 1. The node's own meshes render below its children, in authored order.
  const ownStart = ctx.count;
  for (let i = 0; i < childCount; i++) {
    const child = children[i];
    if (!(child instanceof Node2D) && !isOverlayMesh(child)) {
      pushUnit(ctx, child, z, nodeVisible);
    }
  }
  sortUnitRangeByAuthoredOrder(ctx, ownStart);

  // 2. Child nodes (and their subtrees) render on top, in hierarchy order.
  for (let i = 0; i < childCount; i++) {
    const child = children[i];
    if (child instanceof Node2D) {
      collectNode(child, ctx, nodeVisible, z);
    }
  }

  // 3. Flagged overlay meshes render above the whole subtree (e.g. scrollbars).
  const overlayStart = ctx.count;
  for (let i = 0; i < childCount; i++) {
    const child = children[i];
    if (!(child instanceof Node2D) && isOverlayMesh(child)) {
      pushUnit(ctx, child, z, nodeVisible);
    }
  }
  sortUnitRangeByAuthoredOrder(ctx, overlayStart);
}

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
export function assign2DRenderOrder(roots: readonly Object3D[], sink?: RenderOrder2DSink): void {
  const pooled = activeWalks === 0;
  activeWalks++;
  try {
    const collect: CollectContext = { units: pooled ? unitPool : [], count: 0, needsSort: false };
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (root instanceof Node2D) {
        collectNode(root, collect, true, 0);
      }
    }

    // `Array.prototype.sort` is stable (ES2019+), so equal-z units keep DFS order.
    // The sort runs on a reused copy of the live range (the pool itself may hold
    // a stale tail from a larger earlier scene, which must not take part) and
    // only when z-order is actually in use.
    let units = collect.units;
    if (collect.needsSort) {
      const sorted = pooled ? sortScratch : [];
      sorted.length = collect.count;
      for (let i = 0; i < collect.count; i++) {
        sorted[i] = units[i];
      }
      sorted.sort(compareByZ);
      units = sorted;
    }

    const ctx: AssignContext = { next: 0 };
    for (let i = 0; i < collect.count; i++) {
      const unit = units[i];
      const obj = unit.obj;
      if (obj) {
        assignMeshSubtree(obj, ctx, unit.visible, sink);
      }
    }

    // Drop references so the pool does not pin removed meshes alive between frames.
    for (let i = 0; i < collect.count; i++) {
      collect.units[i].obj = null;
    }
  } finally {
    activeWalks--;
  }
}
