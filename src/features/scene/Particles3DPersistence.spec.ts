import { describe, expect, it } from 'vitest';

import {
  AssetLoader,
  AudioService,
  Particles3D,
  ResourceManager,
  SceneLoader,
  SceneSaver,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';

class InMemoryResourceManager extends ResourceManager {
  private readonly files: Record<string, string>;

  constructor(files: Record<string, string>) {
    super('/');
    this.files = files;
  }

  override async readText(resource: string): Promise<string> {
    const normalized = resource.replace(/\\/g, '/');
    const value = this.files[normalized];
    if (typeof value !== 'string') {
      throw new Error(`Missing in-memory resource: ${resource}`);
    }
    return value;
  }

  override normalize(resource: string): string {
    return resource.replace(/\\/g, '/');
  }
}

function createLoader(files: Record<string, string> = {}): SceneLoader {
  const resources = new InMemoryResourceManager(files);
  const scriptRegistry = new ScriptRegistry();
  registerBuiltInScripts(scriptRegistry);
  const audioService = new AudioService();
  const assetLoader = new AssetLoader(resources, audioService);
  return new SceneLoader(assetLoader, scriptRegistry, resources);
}

function createGraph(rootNode: Particles3D): SceneGraph {
  return {
    version: '1.0.0',
    rootNodes: [rootNode],
    nodeMap: new Map([[rootNode.nodeId, rootNode]]),
    metadata: {},
  };
}

describe('Particles3D persistence', () => {
  it('serializes and reloads disableRotation', async () => {
    const saver = new SceneSaver();
    const node = new Particles3D({
      id: 'particles-root',
      name: 'Particles',
      disableRotation: true,
    });

    const yaml = saver.serializeScene(createGraph(node));
    expect(yaml).toContain('disableRotation: true');

    const loader = createLoader();
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as Particles3D;

    expect(loaded.disableRotation).toBe(true);

    const particle = {
      active: false,
      age: 0,
      lifetime: 0,
      position: loaded.position.clone(),
      velocity: loaded.position.clone(),
      size: 0,
      rotation: -1,
      angularVelocity: -1,
    };

    (loaded as unknown as { activateParticle: (value: typeof particle) => void }).activateParticle(
      particle
    );

    expect(particle.rotation).toBe(0);
    expect(particle.angularVelocity).toBe(0);
  });

  it('keeps backward-compatible default when disableRotation is absent', async () => {
    const sceneText = `
version: 1.0.0
root:
  - id: particles-root
    type: Particles3D
    properties:
      emissionRate: 4
      maxParticles: 16
`;

    const loader = createLoader();
    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as Particles3D;

    expect(loaded.disableRotation).toBe(false);
  });

  it('round-trips trail + sub-emitter fields and simulationSpace: world', async () => {
    const saver = new SceneSaver();
    const node = new Particles3D({
      id: 'particles-root',
      name: 'Particles',
      simulationSpace: 'world',
      trailEnabled: true,
      trailLifetime: 0.75,
      trailWidth: 0.2,
      trailSegments: 24,
      trailFade: 0.4,
      subEmitterId: 'burst-target',
      subEmitterBurstCount: 12,
      subEmitterInheritVelocity: 0.6,
    });

    const yaml = saver.serializeScene(createGraph(node));
    expect(yaml).toContain('simulationSpace: world');
    expect(yaml).toContain('trailEnabled: true');
    expect(yaml).toContain('trailSegments: 24');
    expect(yaml).toContain('subEmitterId: burst-target');

    const loader = createLoader();
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as Particles3D;

    expect(loaded.simulationSpace).toBe('world');
    expect(loaded.trailEnabled).toBe(true);
    expect(loaded.trailLifetime).toBeCloseTo(0.75, 5);
    expect(loaded.trailWidth).toBeCloseTo(0.2, 5);
    expect(loaded.trailSegments).toBe(24);
    expect(loaded.trailFade).toBeCloseTo(0.4, 5);
    expect(loaded.subEmitterId).toBe('burst-target');
    expect(loaded.subEmitterBurstCount).toBe(12);
    expect(loaded.subEmitterInheritVelocity).toBeCloseTo(0.6, 5);
  });

  it('applies defaults when the new trail/sub-emitter fields are absent', async () => {
    const sceneText = `
version: 1.0.0
root:
  - id: particles-root
    type: Particles3D
    properties:
      emissionRate: 4
      maxParticles: 16
`;

    const loader = createLoader();
    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as Particles3D;

    expect(loaded.simulationSpace).toBe('local');
    expect(loaded.trailEnabled).toBe(false);
    expect(loaded.trailLifetime).toBeCloseTo(0.3, 5);
    expect(loaded.trailWidth).toBeCloseTo(0.05, 5);
    expect(loaded.trailSegments).toBe(16);
    expect(loaded.trailFade).toBeCloseTo(1, 5);
    expect(loaded.subEmitterId).toBe('');
    expect(loaded.subEmitterBurstCount).toBe(8);
    expect(loaded.subEmitterInheritVelocity).toBe(0);
  });
});
