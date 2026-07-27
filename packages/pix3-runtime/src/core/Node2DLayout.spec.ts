import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Group2D } from '../nodes/2D/Group2D';

function createLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

describe('Node2D anchor layout', () => {
  it('serializes and parses the shared Node2D layout payload for Sprite2D', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-anchor',
      name: 'Anchored Sprite',
      position: new Vector2(-810, -430),
      width: 200,
      height: 100,
      layout: {
        enabled: true,
        horizontalAlign: 'left',
        verticalAlign: 'bottom',
      },
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
    });

    expect(yaml).toContain('layout:');
    expect(yaml).toContain('horizontalAlign: left');
    expect(yaml).toContain('verticalAlign: bottom');
    expect(yaml).not.toContain('offsetMin:');
    expect(yaml).not.toContain('offsetMax:');

    const graph = await createLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Sprite2D;

    expect(loaded.layoutEnabled).toBe(true);
    expect(loaded.horizontalAlign).toBe('left');
    expect(loaded.verticalAlign).toBe('bottom');
  });

  it('keeps authored left and bottom margins when the runtime viewport expands', () => {
    const sprite = new Sprite2D({
      id: 'sprite-runtime',
      name: 'Runtime Sprite',
      position: new Vector2(-810, -430),
      width: 200,
      height: 100,
      layout: {
        enabled: true,
        horizontalAlign: 'left',
        verticalAlign: 'bottom',
      },
    });

    sprite.applyAnchoredLayoutRecursive(
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 }
    );

    expect(sprite.position.x).toBeCloseTo(-1130);
    expect(sprite.position.y).toBeCloseTo(-610);
    expect(sprite.width).toBe(200);
    expect(sprite.height).toBe(100);
  });

  it('stretches Group2D using authored left and right margins', () => {
    const group = new Group2D({
      id: 'stretch-group',
      name: 'Stretch Group',
      position: new Vector2(0, 0),
      width: 200,
      height: 80,
      layout: {
        enabled: true,
        horizontalAlign: 'stretch',
        verticalAlign: 'center',
      },
    });

    group.applyAnchoredLayoutRecursive({ width: 600, height: 300 }, { width: 400, height: 300 });

    expect(group.position.x).toBeCloseTo(0);
    expect(group.position.y).toBeCloseTo(0);
    expect(group.width).toBeCloseTo(400);
    expect(group.height).toBeCloseTo(80);
  });
});
