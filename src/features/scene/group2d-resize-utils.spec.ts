import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Group2D, Node2D, Sprite2D } from '@pix3/runtime';
import {
  buildFitPlans,
  buildProportionalResizePlans,
  collectProportionalTargets,
  computeContentsLocalRect,
} from './group2d-resize-utils';

/** Center-origin corner measurer (like getNodeOnlyLocalCorners for center-origin node types). */
function centerCorners(node: Node2D): THREE.Vector3[] {
  const dims = node as Node2D & { width?: number; height?: number };
  const hw = (dims.width ?? 100) / 2;
  const hh = (dims.height ?? 100) / 2;
  return [
    new THREE.Vector3(-hw, -hh, 0),
    new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0),
    new THREE.Vector3(-hw, hh, 0),
  ];
}

/**
 * Anchor-aware corner measurer, mirroring the Sprite2D/TiledSprite2D branch of
 * `ViewportRenderService.getNodeOnlyLocalCorners`: the sprite occupies
 * `[-ax·w .. (1-ax)·w] × [-ay·h .. (1-ay)·h]` in node-local space.
 */
function measureCorners(node: Node2D): THREE.Vector3[] {
  if (node instanceof Sprite2D) {
    const w = node.width ?? 64;
    const h = node.height ?? 64;
    const ax = node.anchor?.x ?? 0.5;
    const ay = node.anchor?.y ?? 0.5;
    return [
      new THREE.Vector3(-ax * w, -ay * h, 0),
      new THREE.Vector3((1 - ax) * w, -ay * h, 0),
      new THREE.Vector3((1 - ax) * w, (1 - ay) * h, 0),
      new THREE.Vector3(-ax * w, (1 - ay) * h, 0),
    ];
  }
  return centerCorners(node);
}

let idCounter = 0;
function makeGroup(width: number, height: number, x = 0, y = 0): Group2D {
  const group = new Group2D({ id: `g${++idCounter}`, width, height });
  group.position.set(x, y, 0);
  return group;
}

describe('group2d-resize-utils', () => {
  describe('collectProportionalTargets', () => {
    it('classifies width/height children as "size" and recurses into them', () => {
      const group = makeGroup(100, 100);
      const child = makeGroup(40, 40, 20, 0);
      const grandchild = makeGroup(10, 10, 5, 0);
      child.add(grandchild);
      group.add(child);

      const targets = collectProportionalTargets(group);
      expect(targets.map(t => t.node)).toEqual([child, grandchild]);
      expect(targets.every(t => t.kind === 'size')).toBe(true);
    });

    it('treats any size-bearing 2D node (not just Group2D) as a container', () => {
      // A sprite parenting another sprite is a "container for another object" too: resizing the
      // face sprite should scale its eye-sprite child (the motivating case).
      const face = new Sprite2D({ id: `s${++idCounter}`, width: 150, height: 150 });
      const eye = new Sprite2D({ id: `s${++idCounter}`, width: 20, height: 20 });
      eye.position.set(10, 5, 0);
      face.add(eye);

      const targets = collectProportionalTargets(face);
      expect(targets.map(t => t.node)).toEqual([eye]);
      expect(targets[0].kind).toBe('size');
    });

    it('skips anchored (layoutEnabled) children and their subtrees', () => {
      const group = makeGroup(100, 100);
      const anchored = makeGroup(40, 40, 10, 0);
      const anchoredChild = makeGroup(10, 10);
      anchored.add(anchoredChild);
      anchored.layoutEnabled = true;
      const normal = makeGroup(20, 20, -10, 0);
      group.add(anchored);
      group.add(normal);

      const targets = collectProportionalTargets(group);
      expect(targets.map(t => t.node)).toEqual([normal]);
    });
  });

  describe('buildProportionalResizePlans', () => {
    it('scales child position and size by (fx, fy)', () => {
      const group = makeGroup(100, 100);
      const child = makeGroup(40, 40, 30, 10);
      group.add(child);

      const plans = buildProportionalResizePlans(
        group,
        { width: 100, height: 100 },
        { width: 200, height: 100 } // fx=2, fy=1
      );

      expect(plans).toHaveLength(1);
      const plan = plans[0];
      expect(plan.nodeId).toBe(child.nodeId);
      expect(plan.currentState.position).toEqual({ x: 60, y: 10 });
      expect(plan.currentState.width).toBe(80);
      expect(plan.currentState.height).toBe(40);
      expect(plan.previousState.position).toEqual({ x: 30, y: 10 });
      expect(plan.previousState.width).toBe(40);
    });

    it('returns no plans when both factors are 1', () => {
      const group = makeGroup(100, 100);
      group.add(makeGroup(40, 40, 30, 10));
      const plans = buildProportionalResizePlans(
        group,
        { width: 100, height: 100 },
        { width: 100, height: 100 }
      );
      expect(plans).toEqual([]);
    });

    it('forces a factor of 1 on a zero-size axis', () => {
      const group = makeGroup(0, 100);
      const child = makeGroup(40, 40, 30, 10);
      group.add(child);
      const plans = buildProportionalResizePlans(
        group,
        { width: 0, height: 100 },
        { width: 50, height: 200 } // fx→1 (guard), fy=2
      );
      expect(plans[0].currentState.position).toEqual({ x: 30, y: 20 });
      expect(plans[0].currentState.width).toBe(40); // unchanged on x
      expect(plans[0].currentState.height).toBe(80);
    });
  });

  describe('computeContentsLocalRect + buildFitPlans', () => {
    it('computes the union of children in group-local space', () => {
      const group = makeGroup(100, 100);
      const child = makeGroup(40, 40, 20, 0); // occupies [0..40] x [-20..20]
      group.add(child);

      const rect = computeContentsLocalRect(group, centerCorners);
      expect(rect).not.toBeNull();
      expect(rect!.minX).toBeCloseTo(0);
      expect(rect!.maxX).toBeCloseTo(40);
      expect(rect!.minY).toBeCloseTo(-20);
      expect(rect!.maxY).toBeCloseTo(20);
    });

    it('returns null when there are no Node2D descendants', () => {
      const group = makeGroup(100, 100);
      expect(computeContentsLocalRect(group, centerCorners)).toBeNull();
    });

    it('fits the box to contents without moving children in world space', () => {
      const group = makeGroup(100, 100);
      const child = makeGroup(40, 40, 20, 0);
      group.add(child);
      group.updateWorldMatrix(true, false);
      const childWorldBefore = child.getWorldPosition(new THREE.Vector3());

      const rect = computeContentsLocalRect(group, centerCorners)!;
      const plans = buildFitPlans(group, rect);

      // Group plan first: size wraps contents, origin shifts to rect center (20, 0).
      const groupPlan = plans[0];
      expect(groupPlan.nodeId).toBe(group.nodeId);
      expect(groupPlan.currentState.width).toBeCloseTo(40);
      expect(groupPlan.currentState.height).toBeCloseTo(40);
      expect(groupPlan.currentState.position!.x).toBeCloseTo(20);
      expect(groupPlan.currentState.position!.y).toBeCloseTo(0);

      // Child compensates by -c so its world position is preserved.
      const childPlan = plans[1];
      expect(childPlan.nodeId).toBe(child.nodeId);
      expect(childPlan.currentState.position).toEqual({ x: 0, y: 0 });

      // Apply the plans and confirm world-invariance.
      group.position.set(
        groupPlan.currentState.position!.x,
        groupPlan.currentState.position!.y,
        group.position.z
      );
      group.width = groupPlan.currentState.width!;
      group.height = groupPlan.currentState.height!;
      child.position.set(
        childPlan.currentState.position!.x,
        childPlan.currentState.position!.y,
        child.position.z
      );
      group.updateWorldMatrix(true, false);
      const childWorldAfter = child.getWorldPosition(new THREE.Vector3());
      expect(childWorldAfter.x).toBeCloseTo(childWorldBefore.x);
      expect(childWorldAfter.y).toBeCloseTo(childWorldBefore.y);
    });

    it('measures the contents rect in group-local space regardless of the group transform', () => {
      // The union is expressed in G-local, so rotating/scaling G must not change it.
      const upright = makeGroup(100, 100, 7, -3);
      upright.add(makeGroup(40, 40, 20, 0));
      const transformed = makeGroup(100, 100, 7, -3);
      transformed.rotation.set(0, 0, Math.PI / 6);
      transformed.scale.set(2, 3, 1);
      transformed.add(makeGroup(40, 40, 20, 0));

      const a = computeContentsLocalRect(upright, centerCorners)!;
      const b = computeContentsLocalRect(transformed, centerCorners)!;
      expect(b.minX).toBeCloseTo(a.minX);
      expect(b.maxX).toBeCloseTo(a.maxX);
      expect(b.minY).toBeCloseTo(a.minY);
      expect(b.maxY).toBeCloseTo(a.maxY);
    });

    it('expands the rect by a rotated child’s true footprint', () => {
      const group = makeGroup(100, 100);
      const child = makeGroup(40, 40); // 45° → half-diagonal 20·√2 ≈ 28.284
      child.rotation.set(0, 0, Math.PI / 4);
      group.add(child);

      const rect = computeContentsLocalRect(group, centerCorners)!;
      expect(rect.maxX).toBeCloseTo(Math.SQRT2 * 20);
      expect(rect.minY).toBeCloseTo(-Math.SQRT2 * 20);
    });

    it('honours a sprite child’s anchor when measuring', () => {
      const group = makeGroup(100, 100);
      // anchor (0,0) = bottom-left, so the sprite occupies x[10..50] y[10..50] in group-local space.
      const sprite = new Sprite2D({
        id: `s${++idCounter}`,
        width: 40,
        height: 40,
        anchor: [0, 0],
      });
      sprite.position.set(10, 10, 0);
      group.add(sprite);

      const rect = computeContentsLocalRect(group, measureCorners)!;
      expect(rect.minX).toBeCloseTo(10);
      expect(rect.maxX).toBeCloseTo(50);
      expect(rect.minY).toBeCloseTo(10);
      expect(rect.maxY).toBeCloseTo(50);
    });

    it('shifts a rotated, scaled group’s position through its linear part (p + L·c)', () => {
      const group = makeGroup(100, 100, 10, 20);
      group.rotation.set(0, 0, Math.PI / 6);
      group.scale.set(2, 3, 1);
      group.add(makeGroup(40, 40, 20, 0)); // rect x[0..40] y[-20..20] → c = (20, 0)

      const rect = computeContentsLocalRect(group, centerCorners)!;
      const [groupPlan] = buildFitPlans(group, rect);
      const cos = Math.cos(Math.PI / 6);
      const sin = Math.sin(Math.PI / 6);
      expect(groupPlan.currentState.position!.x).toBeCloseTo(10 + 2 * 20 * cos);
      expect(groupPlan.currentState.position!.y).toBeCloseTo(20 + 2 * 20 * sin);
      expect(groupPlan.currentState.width).toBeCloseTo(40);
      expect(groupPlan.currentState.height).toBeCloseTo(40);
    });

    it('clamps a degenerate (single-point) contents rect to 1×1', () => {
      const group = makeGroup(100, 100);
      const zeroSized = new Sprite2D({ id: `s${++idCounter}`, width: 0, height: 0 });
      group.add(zeroSized);

      const rect = computeContentsLocalRect(group, measureCorners)!;
      const [groupPlan] = buildFitPlans(group, rect);
      expect(groupPlan.currentState.width).toBe(1);
      expect(groupPlan.currentState.height).toBe(1);
    });
  });
});
