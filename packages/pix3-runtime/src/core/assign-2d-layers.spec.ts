import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { Node2D } from '../nodes/Node2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Group2D } from '../nodes/2D/Group2D';
import { CanvasLayer2D } from '../nodes/2D/CanvasLayer2D';
import { assign2DLayers } from './assign-2d-layers';
import { LAYER_2D, LAYER_2D_OVERLAY } from '../constants';

const OVERLAY_MASK = 1 << LAYER_2D_OVERLAY;
const MAIN_MASK = 1 << LAYER_2D;

describe('assign2DLayers', () => {
  it('routes a CanvasLayer2D subtree (nodes and raw meshes) to the overlay layer', () => {
    const root = new Node2D({ id: 'root', name: 'Root' });
    const worldSprite = new Sprite2D({ id: 'world', name: 'World' });
    const hud = new CanvasLayer2D({ id: 'hud', name: 'HUD' });
    const hudSprite = new Sprite2D({ id: 'hud-sprite', name: 'HudSprite' });
    const rawMesh = new Mesh();
    hud.add(hudSprite);
    hudSprite.add(rawMesh);
    root.add(worldSprite, hud);

    const hasOverlay = assign2DLayers([root]);

    expect(hasOverlay).toBe(true);
    expect(worldSprite.layers.mask).toBe(MAIN_MASK);
    expect(hud.layers.mask).toBe(OVERLAY_MASK);
    expect(hudSprite.layers.mask).toBe(OVERLAY_MASK);
    expect(rawMesh.layers.mask).toBe(OVERLAY_MASK);
  });

  it('returns false and leaves everything on the main layer with no CanvasLayer2D', () => {
    const root = new Node2D({ id: 'root', name: 'Root' });
    const a = new Sprite2D({ id: 'a', name: 'A' });
    root.add(a);

    expect(assign2DLayers([root])).toBe(false);
    expect(a.layers.mask).toBe(MAIN_MASK);
  });

  it('re-heals routing in both directions across re-parenting', () => {
    const root = new Node2D({ id: 'root', name: 'Root' });
    const hud = new CanvasLayer2D({ id: 'hud', name: 'HUD' });
    const plain = new Group2D({ id: 'plain', name: 'Plain' });
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    root.add(hud, plain);

    // Under the CanvasLayer2D → overlay (Node2D.add just stamped LAYER_2D).
    hud.add(sprite);
    assign2DLayers([root]);
    expect(sprite.layers.mask).toBe(OVERLAY_MASK);

    // Re-parent out to a plain group → back to the main layer.
    plain.add(sprite);
    assign2DLayers([root]);
    expect(sprite.layers.mask).toBe(MAIN_MASK);
  });

  it('routes a nested CanvasLayer2D subtree idempotently across repeated runs', () => {
    const root = new CanvasLayer2D({ id: 'outer', name: 'Outer' });
    const inner = new CanvasLayer2D({ id: 'inner', name: 'Inner' });
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    inner.add(sprite);
    root.add(inner);

    assign2DLayers([root]);
    assign2DLayers([root]);

    expect(root.layers.mask).toBe(OVERLAY_MASK);
    expect(inner.layers.mask).toBe(OVERLAY_MASK);
    expect(sprite.layers.mask).toBe(OVERLAY_MASK);
  });
});
