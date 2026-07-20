import * as THREE from 'three';
import { Group2D, Node2D } from '@pix3/runtime';
import type {
  Transform2DCompleteParams,
  Transform2DState,
} from '@/features/properties/Transform2DCompleteOperation';

/**
 * Pure geometry for the two coupled Group2D features:
 *
 * - **Fit to contents** ({@link computeContentsLocalRect} + {@link buildFitPlans}) — recompute a
 *   group's width/height (and center-origin) to wrap its subtree, WITHOUT moving any child in world
 *   space.
 * - **Proportional child resize** ({@link buildProportionalResizePlans}) — when a group is resized
 *   `(oldW,oldH) → (newW,newH)`, scale its children's positions and sizes by `(fx,fy)` about the
 *   group's center origin, Figma-style.
 *
 * No DI, no ViewportRenderService dependency (the node-corner measurer is injected), so this module
 * can later be promoted into `packages/pix3-runtime` if a game ever needs runtime proportional
 * resize. All math is expressed against `@pix3/runtime` node types + `three` only.
 */

/** Returns a node's own (node-local, pre-matrixWorld) corner points — e.g. VRS.getNodeOnlyLocalCorners. */
export type Node2DCornerMeasurer = (node: Node2D) => THREE.Vector3[];

export interface LocalRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Union of every `Node2D` descendant's node-only rect, expressed in `group`'s local frame.
 * Includes each nested Group2D's own box (via the measurer) AND recurses into its children, so
 * nothing visual or logical sticks out of the fitted box. Returns `null` when the group has no
 * `Node2D` descendants.
 */
export function computeContentsLocalRect(
  group: Group2D,
  measure: Node2DCornerMeasurer
): LocalRect | null {
  group.updateWorldMatrix(true, false);
  const groupWorldInverse = group.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  let expanded = false;

  const visit = (parent: Node2D): void => {
    for (const child of parent.children) {
      if (!(child instanceof Node2D)) continue;
      child.updateWorldMatrix(true, false);
      for (const corner of measure(child)) {
        const inGroupLocal = corner
          .clone()
          .applyMatrix4(child.matrixWorld)
          .applyMatrix4(groupWorldInverse);
        box.expandByPoint(inGroupLocal);
        expanded = true;
      }
      visit(child);
    }
  };
  visit(group);

  if (!expanded) return null;
  return { minX: box.min.x, minY: box.min.y, maxX: box.max.x, maxY: box.max.y };
}

/**
 * Plans for "fit to contents": resize/reposition the group so its box wraps `rect`, and counter-shift
 * each direct child so its world position is unchanged. Group2D is center-origin, so moving the
 * origin onto the rect center `c` (in group-local) requires translating the group's parent-space
 * position by the linear part of the group's local matrix applied to `c`, and shifting each direct
 * child by `-c` in group-local. Deeper descendants are relative to their parents and stay untouched.
 * Returns the group plan first (so its anchor reflow runs before the explicit child plans).
 */
export function buildFitPlans(group: Group2D, rect: LocalRect): Transform2DCompleteParams[] {
  const newWidth = Math.max(1, rect.maxX - rect.minX);
  const newHeight = Math.max(1, rect.maxY - rect.minY);
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;

  const theta = group.rotation.z;
  const sx = group.scale.x;
  const sy = group.scale.y;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // p' = p + L·c, where L = R(θ)·diag(sx, sy)
  const nextPosX = group.position.x + sx * cx * cos - sy * cy * sin;
  const nextPosY = group.position.y + sx * cx * sin + sy * cy * cos;

  const plans: Transform2DCompleteParams[] = [
    {
      nodeId: group.nodeId,
      previousState: {
        position: { x: group.position.x, y: group.position.y },
        width: group.width,
        height: group.height,
      },
      currentState: {
        position: { x: nextPosX, y: nextPosY },
        width: newWidth,
        height: newHeight,
      },
    },
  ];

  for (const child of group.children) {
    if (!(child instanceof Node2D)) continue;
    plans.push({
      nodeId: child.nodeId,
      previousState: { position: { x: child.position.x, y: child.position.y } },
      currentState: { position: { x: child.position.x - cx, y: child.position.y - cy } },
    });
  }

  return plans;
}

/** How a node participates in proportional resize: via width/height (recurse) or via scale (stop). */
export interface ProportionalTarget {
  node: Node2D;
  kind: 'size' | 'scale';
}

export interface ProportionalBaseState {
  kind: 'size' | 'scale';
  position: { x: number; y: number };
  scale: { x: number; y: number };
  width?: number;
  height?: number;
}

interface Node2DDims {
  width?: number;
  height?: number;
}

/**
 * Walk `container`'s subtree collecting the nodes proportional resize should touch, per the rule
 * **"handled via width/height ⇒ recurse; handled via scale ⇒ stop"** (prevents double-scaling and
 * gives Figma-like results for arbitrary nesting). `layoutEnabled` (anchored) children — and their
 * subtrees — are skipped: the anchor system reflows them on container resize instead. Pre-order, so a
 * parent always precedes its descendants.
 *
 * `container` is any `Node2D` that gets resized, not only a `Group2D`: a Sprite2D (or any size-bearing
 * node) parenting other 2D nodes is a "container for another object" too, so resizing it should scale
 * its children the same way (e.g. a face sprite with a blinking-eye sprite child). A leaf with no
 * eligible children just yields `[]` — a no-op.
 */
export function collectProportionalTargets(container: Node2D): ProportionalTarget[] {
  const targets: ProportionalTarget[] = [];
  const visit = (parent: Node2D): void => {
    for (const child of parent.children) {
      if (!(child instanceof Node2D)) continue;
      if (child.layoutEnabled) continue; // anchor layout owns it → skip its whole subtree
      const dims = child as Node2D & Node2DDims;
      if (typeof dims.width === 'number' && typeof dims.height === 'number') {
        targets.push({ node: child, kind: 'size' });
        visit(child); // its frame did not scale → scale its contents explicitly
      } else {
        targets.push({ node: child, kind: 'scale' }); // descendants inherit via the transform
      }
    }
  };
  visit(container);
  return targets;
}

/**
 * Mutate a node in place to its proportionally-scaled state (live gizmo drag). Position scales by
 * `(fx, fy)` about the group origin; a `size` node scales width/height (clamped to `minSize`) keeping
 * its `scale` stable, a `scale` node scales its transform `scale`. Idempotent w.r.t. `base`, so it can
 * be reapplied every frame without drift.
 */
export function applyProportionalToNode(
  node: Node2D,
  base: ProportionalBaseState,
  fx: number,
  fy: number,
  minSize = 0
): void {
  node.position.set(base.position.x * fx, base.position.y * fy, node.position.z);
  const dims = node as Node2D & Node2DDims;
  if (base.kind === 'size') {
    dims.width = Math.max(minSize, (base.width ?? 0) * fx);
    dims.height = Math.max(minSize, (base.height ?? 0) * fy);
    node.scale.set(base.scale.x, base.scale.y, 1);
  } else {
    node.scale.set(base.scale.x * fx, base.scale.y * fy, 1);
  }
}

/** Snapshot the fields proportional resize will scale from, for a target node in its current state. */
export function captureProportionalBase(target: ProportionalTarget): ProportionalBaseState {
  const dims = target.node as Node2D & Node2DDims;
  const base: ProportionalBaseState = {
    kind: target.kind,
    position: { x: target.node.position.x, y: target.node.position.y },
    scale: { x: target.node.scale.x, y: target.node.scale.y },
  };
  if (target.kind === 'size') {
    base.width = dims.width;
    base.height = dims.height;
  }
  return base;
}

function buildProportionalPlan(
  nodeId: string,
  base: ProportionalBaseState,
  fx: number,
  fy: number
): Transform2DCompleteParams {
  const previousState: Transform2DState = { position: { x: base.position.x, y: base.position.y } };
  const currentState: Transform2DState = {
    position: { x: base.position.x * fx, y: base.position.y * fy },
  };
  if (base.kind === 'size') {
    previousState.width = base.width;
    previousState.height = base.height;
    currentState.width = Math.max(0, (base.width ?? 0) * fx);
    currentState.height = Math.max(0, (base.height ?? 0) * fy);
  } else {
    previousState.scale = { x: base.scale.x, y: base.scale.y };
    currentState.scale = { x: base.scale.x * fx, y: base.scale.y * fy };
  }
  return { nodeId, previousState, currentState };
}

/**
 * Descendant plans for scaling a group's children when the group resizes `from → to`. `baseStates`
 * (keyed by nodeId) supplies the pre-resize state for live gizmo drags; when omitted, each target's
 * current state is captured (one-shot inspector/command path). Does NOT include the group's own
 * width/height plan — the caller owns that (and must order it first).
 */
export function buildProportionalResizePlans(
  group: Group2D,
  from: { width: number; height: number },
  to: { width: number; height: number },
  baseStates?: ReadonlyMap<string, ProportionalBaseState>
): Transform2DCompleteParams[] {
  const fx = from.width > 0 ? to.width / from.width : 1;
  const fy = from.height > 0 ? to.height / from.height : 1;
  if (fx === 1 && fy === 1) return [];

  const plans: Transform2DCompleteParams[] = [];
  for (const target of collectProportionalTargets(group)) {
    const base = baseStates?.get(target.node.nodeId) ?? captureProportionalBase(target);
    plans.push(buildProportionalPlan(target.node.nodeId, base, fx, fy));
  }
  return plans;
}
