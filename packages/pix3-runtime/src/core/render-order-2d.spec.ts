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
});
