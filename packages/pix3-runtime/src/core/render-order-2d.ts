import type { Object3D } from 'three';

import { Node2D } from '../nodes/Node2D';

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

function assignMeshSubtree(obj: Object3D, ctx: AssignContext): void {
  obj.renderOrder = ctx.next++;
  for (const child of obj.children) {
    assignMeshSubtree(child, ctx);
  }
}

function assignNode(node: Node2D, ctx: AssignContext): void {
  const { childNodes, own, overlay } = collectGroups(node);

  // 1. The node's own meshes render below its children, in authored order.
  for (const mesh of sortByAuthoredOrder(own)) {
    assignMeshSubtree(mesh, ctx);
  }

  // 2. Child nodes (and their subtrees) render on top, in hierarchy order.
  for (const child of childNodes) {
    assignNode(child, ctx);
  }

  // 3. Flagged overlay meshes render above the whole subtree (e.g. scrollbars).
  for (const mesh of sortByAuthoredOrder(overlay)) {
    assignMeshSubtree(mesh, ctx);
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
 */
export function assign2DRenderOrder(roots: readonly Object3D[]): void {
  const ctx: AssignContext = { next: 0 };
  for (const root of roots) {
    if (root instanceof Node2D) {
      assignNode(root, ctx);
    }
  }
}
