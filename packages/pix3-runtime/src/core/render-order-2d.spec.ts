import { describe, expect, it } from 'vitest';
import { Mesh, type Object3D } from 'three';

import { Group2D } from '../nodes/2D/Group2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { ScrollContainer2D } from '../nodes/2D/UI/ScrollContainer2D';
import { Node2D } from '../nodes/Node2D';
import { assign2DRenderOrder, OVERLAY_2D_FLAG } from './render-order-2d';

/** Collect this node's own meshes (not descending into child Node2D nodes). */
function ownMeshes(node: Node2D): Mesh[] {
  const meshes: Mesh[] = [];
  for (const child of node.children) {
    if (child instanceof Node2D) continue;
    child.traverse((obj: Object3D) => {
      if (obj instanceof Mesh) meshes.push(obj);
    });
  }
  return meshes;
}

function singleMeshOrder(node: Node2D): number {
  const meshes = ownMeshes(node);
  return meshes.length ? meshes[0].renderOrder : -1;
}

describe('assign2DRenderOrder', () => {
  it('draws a later sibling on top of an earlier one (the reported $18-over-panel case)', () => {
    // Mirrors main-scene: the gold-counter label is an EARLIER sibling than the
    // panel, yet old code pinned the label mesh at renderOrder 1001 so it floated
    // above the panel. Simulate that by pre-setting the earlier node's mesh high.
    const amount = new Sprite2D({ id: 'amount', name: 'Gold Counter' });
    ownMeshes(amount)[0].renderOrder = 1001;
    const panel = new Sprite2D({ id: 'panel', name: 'Shop Panel Background' });

    assign2DRenderOrder([amount, panel]);

    expect(singleMeshOrder(panel)).toBeGreaterThan(singleMeshOrder(amount));
  });

  it('orders a node’s own meshes by authored renderOrder, not add-order', () => {
    // Faithful to Button2D: UIControl2D adds the label (renderOrder 1001) in
    // super() BEFORE the subclass adds its skin mesh (renderOrder 999). Add-order
    // would hide the label behind the skin; authored renderOrder must win.
    const control = new Group2D({ id: 'btn', name: 'Shop Close Button' });
    const label = new Mesh();
    label.renderOrder = 1001; // added first, like the UIControl2D label
    control.add(label);
    const skin = new Mesh();
    skin.renderOrder = 999; // added second, like the Button2D background
    control.add(skin);

    assign2DRenderOrder([control]);

    expect(label.renderOrder).toBeGreaterThan(skin.renderOrder);
  });

  it('keeps a scroll container scrollbar above its scrolled content', () => {
    const container = new ScrollContainer2D({
      id: 'scroll',
      name: 'Scroll',
      width: 100,
      height: 100,
      showScrollbar: true,
    });
    const content = new Sprite2D({ id: 'content', name: 'tool_1' });
    container.add(content);

    assign2DRenderOrder([container]);

    let thumbOrder = -1;
    let thumbIsOverlay = false;
    container.traverse(obj => {
      if (obj instanceof Mesh && obj.name.endsWith('ScrollbarThumb')) {
        thumbOrder = obj.renderOrder;
        thumbIsOverlay = obj.userData[OVERLAY_2D_FLAG] === true;
      }
    });

    expect(thumbIsOverlay).toBe(true);
    expect(thumbOrder).toBeGreaterThan(singleMeshOrder(content));
  });

  it('orders nested children above their parent and is idempotent across passes', () => {
    const parent = new Sprite2D({ id: 'parent', name: 'Panel' });
    const child = new Sprite2D({ id: 'child', name: 'Icon' });
    parent.add(child);
    const sibling = new Sprite2D({ id: 'sibling', name: 'Later' });

    assign2DRenderOrder([parent, sibling]);
    const first = [singleMeshOrder(parent), singleMeshOrder(child), singleMeshOrder(sibling)];

    // child renders above its parent; later sibling above the whole parent subtree.
    expect(first[1]).toBeGreaterThan(first[0]);
    expect(first[2]).toBeGreaterThan(first[1]);

    // Re-running must not change the result.
    assign2DRenderOrder([parent, sibling]);
    expect([singleMeshOrder(parent), singleMeshOrder(child), singleMeshOrder(sibling)]).toEqual(
      first
    );
  });

  it('lifts a node above a later sibling when zIndex is raised', () => {
    const back = new Sprite2D({ id: 'back', name: 'Back' });
    const front = new Sprite2D({ id: 'front', name: 'Front' });

    assign2DRenderOrder([back, front]);
    expect(singleMeshOrder(back)).toBeLessThan(singleMeshOrder(front));

    back.zIndex = 1;
    assign2DRenderOrder([back, front]);

    expect(singleMeshOrder(back)).toBeGreaterThan(singleMeshOrder(front));
    // Persisted for free by SceneSaver, which spreads `properties`.
    expect(back.properties.zIndex).toBe(1);

    // Back to the default → the plain DFS order returns, and the property is dropped.
    back.zIndex = 0;
    assign2DRenderOrder([back, front]);
    expect(singleMeshOrder(back)).toBeLessThan(singleMeshOrder(front));
    expect('zIndex' in back.properties).toBe(false);
  });

  it('inherits zIndex down the subtree by default and takes it absolute when zAsRelative is off', () => {
    const lifted = new Sprite2D({ id: 'lifted', name: 'Lifted' });
    const insideLifted = new Sprite2D({ id: 'inside', name: 'Inside' });
    lifted.add(insideLifted);
    lifted.zIndex = 5;

    const later = new Sprite2D({ id: 'later', name: 'Later' });
    const escapee = new Sprite2D({ id: 'escapee', name: 'Escapee' });
    lifted.add(escapee);

    assign2DRenderOrder([lifted, later]);
    // The whole lifted subtree floats above the later sibling.
    expect(singleMeshOrder(insideLifted)).toBeGreaterThan(singleMeshOrder(later));

    // Absolute z opts the child out of its parent's offset.
    escapee.zAsRelative = false;
    assign2DRenderOrder([lifted, later]);
    expect(singleMeshOrder(escapee)).toBeLessThan(singleMeshOrder(lifted));
    expect(escapee.properties.zAsRelative).toBe(false);
  });

  it('reads an authored zIndex out of the serialized properties bag', () => {
    const authored = new Sprite2D({
      id: 'authored',
      name: 'Authored',
      properties: { zIndex: 3, zAsRelative: false },
    });

    expect(authored.zIndex).toBe(3);
    expect(authored.zAsRelative).toBe(false);
  });

  it('clamps zIndex to the Godot-compatible integer range', () => {
    const node = new Sprite2D({ id: 'clamp', name: 'Clamp' });

    node.zIndex = 1.7;
    expect(node.zIndex).toBe(2);

    node.zIndex = 99999;
    expect(node.zIndex).toBe(4096);

    node.zIndex = Number.NaN;
    expect(node.zIndex).toBe(0);
  });

  // The cases below pin the pooled, allocation-free walk: the partition into
  // own / child-node / overlay classes is done by three passes over `children`
  // instead of three arrays, own meshes are sorted in place inside the pool, and
  // the pool is shared across calls — so leaks between frames, stale tails and
  // re-entrancy are the ways it could go wrong without changing any single-tree
  // result the tests above already check.

  it('emits own meshes (authored order, stable ties), then child subtrees, then overlay meshes regardless of add order', () => {
    const node = new Group2D({ id: 'mixed', name: 'Mixed' });
    const ownLate = new Mesh();
    ownLate.renderOrder = 5;
    node.add(ownLate);
    const child = new Sprite2D({ id: 'child', name: 'Child' });
    node.add(child);
    const overlayHigh = new Mesh();
    overlayHigh.renderOrder = 9;
    overlayHigh.userData[OVERLAY_2D_FLAG] = true;
    node.add(overlayHigh);
    const ownEarly = new Mesh();
    ownEarly.renderOrder = 3;
    node.add(ownEarly);
    const ownTie = new Mesh();
    ownTie.renderOrder = 5; // equal to ownLate, added later → stays after it
    node.add(ownTie);
    const overlayLow = new Mesh();
    overlayLow.renderOrder = 7;
    overlayLow.userData[OVERLAY_2D_FLAG] = true;
    node.add(overlayLow);

    assign2DRenderOrder([node]);

    expect(ownEarly.renderOrder).toBeLessThan(ownLate.renderOrder);
    expect(ownLate.renderOrder).toBeLessThan(ownTie.renderOrder);
    expect(ownTie.renderOrder).toBeLessThan(singleMeshOrder(child));
    expect(singleMeshOrder(child)).toBeLessThan(overlayLow.renderOrder);
    expect(overlayLow.renderOrder).toBeLessThan(overlayHigh.renderOrder);
  });

  it('does not leak pooled entries between walks: a smaller tree after a larger one stamps a fresh 0..n-1 range', () => {
    const orders = (...nodes: Node2D[]): number[] =>
      nodes.flatMap(node => ownMeshes(node).map(mesh => mesh.renderOrder)).sort((a, b) => a - b);

    const big = new Group2D({ id: 'big', name: 'Big' });
    for (let i = 0; i < 24; i++) {
      big.add(new Sprite2D({ id: `big-${i}`, name: `Big ${i}` }));
    }
    assign2DRenderOrder([big]);

    // Plain DFS path: the pool holds a 24-node tail from the previous call.
    const a = new Sprite2D({ id: 'a', name: 'A' });
    const b = new Sprite2D({ id: 'b', name: 'B' });
    assign2DRenderOrder([a, b]);
    expect(orders(a, b)).toEqual(orders(a, b).map((_, i) => i));
    expect(singleMeshOrder(a)).toBeLessThan(singleMeshOrder(b));

    // z-bucketed path: exercise the reused sort buffer with a big tree first…
    big.zIndex = 2;
    assign2DRenderOrder([big]);
    // …then a small one; the stale tail must not take part in the sort.
    a.zIndex = 1;
    assign2DRenderOrder([a, b]);
    expect(orders(a, b)).toEqual(orders(a, b).map((_, i) => i));
    expect(singleMeshOrder(a)).toBeGreaterThan(singleMeshOrder(b));
  });

  it('survives a re-entrant call from the sink without corrupting the outer walk', () => {
    const outerA = new Sprite2D({ id: 'outer-a', name: 'Outer A' });
    const outerB = new Sprite2D({ id: 'outer-b', name: 'Outer B' });
    const innerA = new Sprite2D({ id: 'inner-a', name: 'Inner A' });
    const innerB = new Sprite2D({ id: 'inner-b', name: 'Inner B' });

    let nested = false;
    assign2DRenderOrder([outerA, outerB], () => {
      if (!nested) {
        nested = true;
        // Would overwrite (and then null out) the outer walk's pooled units if
        // the nested call shared the pool — outerB would never be stamped.
        assign2DRenderOrder([innerA, innerB]);
      }
    });

    const outerOrders = [...ownMeshes(outerA), ...ownMeshes(outerB)]
      .map(mesh => mesh.renderOrder)
      .sort((x, y) => x - y);
    expect(outerOrders).toEqual(outerOrders.map((_, i) => i));
    expect(singleMeshOrder(outerA)).toBeLessThan(singleMeshOrder(outerB));
    expect(singleMeshOrder(innerA)).toBe(0);
    expect(singleMeshOrder(innerA)).toBeLessThan(singleMeshOrder(innerB));
  });
});
