import { MathUtils } from 'three';
import { describe, expect, it } from 'vitest';

import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Node2D } from '../nodes/Node2D';

/**
 * A plain `Node2D` must survive a save/load round trip.
 *
 * `SceneSaver` writes a 2D node's placement only inside `properties.transform`,
 * and the loader's `Node2D` branch used to read only the flat `properties.position`
 * keys — the one 2D branch of sixteen that did. The effect was silent and delayed:
 * a hand-authored node loaded correctly the first time, the first editor save
 * rewrote it into `transform:`, and the next load dropped it at the origin. Nothing
 * warned, and the data was still in the file under a key nothing read.
 *
 * Plain `Node2D` is what an agent (or a person) reaches for as a grouping/marker
 * node, so the failure lands on hand-authored scenes first.
 */

function createLoader(): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
}

const AUTHORED_FLAT = `
version: 1.0.0
root:
  - id: marker
    type: Node2D
    name: Marker
    properties:
      position: [120, -340]
      rotation: 30
      scale: [2, 3]
`;

const AUTHORED_TRANSFORM = `
version: 1.0.0
root:
  - id: marker
    type: Node2D
    name: Marker
    properties:
      transform:
        position: [120, -340]
        rotation: 30
        scale: [2, 3]
`;

describe('Node2D placement round trip', () => {
  it('reads the flat keys a hand-authored scene uses', async () => {
    const scene = await createLoader().parseScene(AUTHORED_FLAT, { filePath: 'res://t.pix3scene' });
    const node = scene.rootNodes[0] as Node2D;
    expect(node.position.x).toBe(120);
    expect(node.position.y).toBe(-340);
    // `Node2D` stores the authored degrees as three.js radians on `rotation.z`.
    expect(MathUtils.radToDeg(node.rotation.z)).toBeCloseTo(30, 6);
    expect(node.scale.x).toBe(2);
    expect(node.scale.y).toBe(3);
  });

  it('reads the `transform` block the saver actually writes', async () => {
    const scene = await createLoader().parseScene(AUTHORED_TRANSFORM, {
      filePath: 'res://t.pix3scene',
    });
    const node = scene.rootNodes[0] as Node2D;
    expect(node.position.x).toBe(120);
    expect(node.position.y).toBe(-340);
    // `Node2D` stores the authored degrees as three.js radians on `rotation.z`.
    expect(MathUtils.radToDeg(node.rotation.z)).toBeCloseTo(30, 6);
    expect(node.scale.x).toBe(2);
    expect(node.scale.y).toBe(3);
  });

  it('survives a real save → load cycle without drifting to the origin', async () => {
    const loaded = await createLoader().parseScene(AUTHORED_FLAT, {
      filePath: 'res://t.pix3scene',
    });
    const yaml = new SceneSaver().serializeScene(loaded);

    // The saver's own output is the input that used to lose the placement.
    const reloaded = await createLoader().parseScene(yaml, { filePath: 'res://t.pix3scene' });
    const node = reloaded.rootNodes[0] as Node2D;
    expect({ x: node.position.x, y: node.position.y }).toEqual({ x: 120, y: -340 });
    // `Node2D` stores the authored degrees as three.js radians on `rotation.z`.
    expect(MathUtils.radToDeg(node.rotation.z)).toBeCloseTo(30, 6);
    expect({ x: node.scale.x, y: node.scale.y }).toEqual({ x: 2, y: 3 });
  });
});
