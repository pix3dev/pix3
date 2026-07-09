import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';

function findSetter(name: string): (node: unknown, value: unknown) => void {
  const def = ColorRect2D.getPropertySchema().properties.find(p => p.name === name);
  if (!def) {
    throw new Error(`ColorRect2D schema is missing "${name}"`);
  }
  return def.setValue;
}

async function roundTrip(node: ColorRect2D): Promise<ColorRect2D> {
  const yaml = new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });

  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
  const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
  return graph.rootNodes[0] as ColorRect2D;
}

describe('ColorRect2D scene persistence', () => {
  it('serializes width/height/color/opacity authored at construction', async () => {
    const node = new ColorRect2D({
      id: 'panel',
      name: 'Panel',
      width: 720,
      height: 560,
      color: '#161b26',
      opacity: 0.92,
    });

    const loaded = await roundTrip(node);

    expect(loaded.width).toBe(720);
    expect(loaded.height).toBe(560);
    expect(loaded.color).toBe('#161b26');
    expect(loaded.opacity).toBeCloseTo(0.92);
  });

  it('persists Inspector-style color/size edits through serialize -> parse', async () => {
    // Reproduces the play-mode bug: entering play mode serializes the live graph
    // and re-parses it. The color/width/height property setters mutate instance
    // fields (not node.properties), so without a dedicated SceneSaver branch the
    // stale construction-time values would be emitted instead of the edits.
    const node = new ColorRect2D({
      id: 'panel',
      name: 'Panel',
      width: 720,
      height: 560,
      color: '#161b26',
      opacity: 0.92,
    });

    // Simulate Inspector edits via the exact property-schema path the editor uses.
    findSetter('color')(node, '#3b72e8');
    findSetter('width')(node, 640);
    findSetter('height')(node, 480);

    const loaded = await roundTrip(node);

    expect(loaded.color).toBe('#3b72e8');
    expect(loaded.width).toBe(640);
    expect(loaded.height).toBe(480);
    expect(loaded.opacity).toBeCloseTo(0.92);
  });
});
