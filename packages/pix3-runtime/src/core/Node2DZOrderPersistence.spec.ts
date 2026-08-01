import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Group2D } from '../nodes/2D/Group2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Node2D } from '../nodes/Node2D';

function findSetter(name: string): (node: unknown, value: unknown) => void {
  const def = Node2D.getPropertySchema().properties.find(p => p.name === name);
  if (!def) {
    throw new Error(`Node2D schema is missing "${name}"`);
  }
  return def.setValue;
}

async function roundTrip(root: Node2D): Promise<{ yaml: string; loaded: Node2D }> {
  const nodeMap = new Map<string, Node2D>();
  root.traverse(obj => {
    if (obj instanceof Node2D) {
      nodeMap.set(obj.nodeId, obj);
    }
  });

  const yaml = new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [root],
    nodeMap,
  });

  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
  const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
  return { yaml, loaded: graph.rootNodes[0] as Node2D };
}

describe('Node2D z-order persistence', () => {
  it('round-trips zIndex/zAsRelative edited through the property schema', async () => {
    const group = new Group2D({ id: 'hud', name: 'HUD' });
    const badge = new Sprite2D({ id: 'badge', name: 'Badge' });
    group.add(badge);

    // Exactly the path the Inspector and the agent's set_property take.
    findSetter('zIndex')(group, 12);
    findSetter('zIndex')(badge, -3);
    findSetter('zAsRelative')(badge, false);

    const { loaded } = await roundTrip(group);
    const loadedBadge = loaded.children.find(child => child instanceof Sprite2D) as Sprite2D;

    expect(loaded.zIndex).toBe(12);
    expect(loaded.zAsRelative).toBe(true);
    expect(loadedBadge.zIndex).toBe(-3);
    expect(loadedBadge.zAsRelative).toBe(false);
    // Absolute z ignores the parent's offset; the default one inherits it.
    expect(loadedBadge.effectiveZIndex).toBe(-3);
    findSetter('zAsRelative')(loadedBadge, true);
    expect(loadedBadge.effectiveZIndex).toBe(9);
  });

  it('keeps default z-order out of the serialized YAML', async () => {
    const group = new Group2D({ id: 'hud', name: 'HUD' });
    group.add(new Sprite2D({ id: 'badge', name: 'Badge' }));

    const { yaml } = await roundTrip(group);

    expect(yaml).not.toContain('zIndex');
    expect(yaml).not.toContain('zAsRelative');
  });
});
