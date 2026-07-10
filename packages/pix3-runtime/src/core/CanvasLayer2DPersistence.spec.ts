import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { CanvasLayer2D } from '../nodes/2D/CanvasLayer2D';

function makeLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

describe('CanvasLayer2D scene persistence', () => {
  it('round-trips type + size + transform', async () => {
    const layer = new CanvasLayer2D({
      id: 'hud',
      name: 'HUD',
      width: 1920,
      height: 1080,
    });
    layer.position.set(10, -20, 0);

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [layer],
      nodeMap: new Map([[layer.nodeId, layer]]),
    });

    expect(yaml).toContain('type: CanvasLayer2D');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as CanvasLayer2D;

    expect(loaded).toBeInstanceOf(CanvasLayer2D);
    expect(loaded.isCanvasLayer).toBe(true);
    expect(loaded.width).toBe(1920);
    expect(loaded.height).toBe(1080);
    expect(loaded.position.x).toBeCloseTo(10);
    expect(loaded.position.y).toBeCloseTo(-20);
  });

  it('applies size defaults for a freshly created layer', async () => {
    const layer = new CanvasLayer2D({ id: 'hud', name: 'HUD' });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [layer],
      nodeMap: new Map([[layer.nodeId, layer]]),
    });

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as CanvasLayer2D;

    expect(loaded.width).toBe(100);
    expect(loaded.height).toBe(100);
  });
});
