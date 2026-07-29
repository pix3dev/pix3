import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AssetLoader,
  AudioService,
  registerBuiltInScripts,
  ResourceManager,
  SceneLoader,
  ScriptRegistry,
  type NodeBase,
} from '@pix3/runtime';

import { collectNetKindPrefabPaths } from './net-kind-paths';

/**
 * Parse-check for the MultiplayerArena sample.
 *
 * The sample is the thing a person opens to find out whether multiplayer works, so a typo in its
 * hand-authored YAML reads as "multiplayer is broken". This loads both files through the real
 * `SceneLoader`, and pins the two facts the wire depends on: the avatar carries the replication
 * components, and the project resolves to exactly one spawnable prefab — so its `Kind` is 0 on
 * every client, which is what the room's allowlist is written against.
 */

const SAMPLE_ROOT = 'samples/MultiplayerArena';

function samplePath(relative: string): string {
  return resolve(process.cwd(), SAMPLE_ROOT, relative);
}

/** The sample's user scripts are not registered here, so the loader must tolerate unknown ones. */
function createLoader(): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  return new SceneLoader(assetLoader, registry, new ResourceManager('/'));
}

async function loadScene(relative: string) {
  const yaml = readFileSync(samplePath(relative), 'utf8');
  return createLoader().parseScene(yaml, { filePath: `res://${relative}` });
}

function walk(nodes: readonly NodeBase[], visit: (node: NodeBase) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children as NodeBase[], visit);
  }
}

function findByName(nodes: readonly NodeBase[], name: string): NodeBase | null {
  let found: NodeBase | null = null;
  walk(nodes, node => {
    if (!found && node.name === name) {
      found = node;
    }
  });
  return found;
}

describe('MultiplayerArena sample', () => {
  beforeAll(() => {
    // happy-dom has no canvas 2D context, and Label2D rasterises its text through one.
    const canvasProto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    canvasProto.getContext = vi.fn(() => ({
      setTransform: () => undefined,
      scale: () => undefined,
      fillRect: () => undefined,
      clearRect: () => undefined,
      fillText: () => undefined,
      measureText: () => ({ width: 0 }),
      fillStyle: '',
      font: '',
      textBaseline: '',
      textAlign: '',
    }));
  });

  it('loads the arena scene with its field, spawn points and HUD', async () => {
    const graph = await loadScene('src/assets/scenes/arena.pix3scene');

    const spawns = findByName(graph.rootNodes, 'Spawns');
    expect(spawns).not.toBeNull();
    // Eight seats: ArenaController seats a client by `clientId % markers.length`, and the room is
    // created for eight players.
    expect(spawns?.children.length).toBe(8);

    expect(findByName(graph.rootNodes, 'Players')).not.toBeNull();
    expect(findByName(graph.rootNodes, 'Scoreboard')).not.toBeNull();
    expect(findByName(graph.rootNodes, 'Move Stick')).not.toBeNull();
  });

  it('loads the player prefab with both replication components on its root', async () => {
    const graph = await loadScene('src/assets/prefabs/player.pix3scene');
    const root = graph.rootNodes[0];

    const componentTypes = root.components.map(component => component.type);
    expect(componentTypes).toContain('core:NetworkedNode');
    expect(componentTypes).toContain('core:ReplicatedTransform');

    // The component spawns the entity at whatever position the node has when it starts, and it
    // names the prefab it belongs to — a wrong path here spawns nothing on peers.
    const networked = root.components.find(component => component.type === 'core:NetworkedNode');
    expect(networked?.config.prefabPath).toBe('res://src/assets/prefabs/player.pix3scene');
    expect(networked?.config.spawnOnStart).not.toBe(false);

    expect(findByName(graph.rootNodes, 'It Ring')).not.toBeNull();
    expect(findByName(graph.rootNodes, 'Name')).not.toBeNull();
  });

  it('resolves to exactly one spawnable prefab, so the avatar is kind 0', () => {
    const table = collectNetKindPrefabPaths([
      'src/assets/scenes/arena.pix3scene',
      'src/assets/prefabs/player.pix3scene',
      'scripts/ArenaController.ts',
      'pix3project.yaml',
    ]);

    expect(table).toEqual(['res://src/assets/prefabs/player.pix3scene']);
  });
});
