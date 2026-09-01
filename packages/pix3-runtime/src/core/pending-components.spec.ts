import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { SceneManager } from './SceneManager';
import { ScriptRegistry } from './ScriptRegistry';
import { Script } from './ScriptComponent';

/**
 * Regression guard for the most expensive defect of the Flow-vs-chat measurement: a scene that
 * opened before its project scripts compiled came back **without** its `user:*` components, and the
 * next save — any agent mutation triggers one — wrote that loss into the `.pix3scene`. Observed in
 * 3 of 4 runs: `GameRules`/`ScoreHud` disappeared from `game-root`/`hud` right after `create_node`.
 */

class GameRules extends Script {
  lives = 3;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { lives: 3 };
  }

  static override getPropertySchema() {
    return {
      nodeType: 'GameRules',
      properties: [
        {
          name: 'lives',
          type: 'number' as const,
          getValue: (c: unknown) => (c as GameRules).lives,
          setValue: (c: unknown, value: unknown) => {
            (c as GameRules).lives = value as number;
          },
        },
      ],
    };
  }
}

const SCENE_YAML = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: game-rules
        type: 'user:GameRules'
        enabled: true
        config:
          lives: 5
`;

function makeStack(): { loader: SceneLoader; saver: SceneSaver; registry: ScriptRegistry } {
  const registry = new ScriptRegistry();
  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    registry,
    new ResourceManager('/')
  );
  return { loader, saver: new SceneSaver(), registry };
}

function registerGameRules(registry: ScriptRegistry): void {
  registry.registerComponent({
    id: 'user:GameRules',
    displayName: 'GameRules',
    description: 'test',
    category: 'Project',
    componentClass: GameRules,
    keywords: [],
  });
}

describe('components whose script type is not registered yet', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('parks the definition on the node instead of dropping it', async () => {
    const { loader } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];

    expect(root.components).toHaveLength(0);
    expect(root.pendingComponents).toEqual([
      { id: 'game-rules', type: 'user:GameRules', enabled: true, config: { lives: 5 } },
    ]);
  });

  it('survives a save/load round-trip with its config intact', async () => {
    const { loader, saver } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    // This is the step that used to destroy the data: any agent mutation saves the scene.
    const savedYaml = saver.serializeScene(graph);

    expect(savedYaml).toContain('user:GameRules');
    expect(savedYaml).toContain('lives: 5');

    const reloaded = await loader.parseScene(savedYaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    expect(reloaded.rootNodes[0].pendingComponents).toHaveLength(1);
  });

  it('attaches the parked component once the type registers, applying its authored config', async () => {
    const { loader, registry } = makeStack();

    const graph = await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/main.pix3scene' });
    registerGameRules(registry);

    const attached = loader.resolvePendingComponents(graph.rootNodes);

    expect(attached).toBe(1);
    const root = graph.rootNodes[0];
    expect(root.pendingComponents).toHaveLength(0);
    expect(root.components).toHaveLength(1);
    expect(root.components[0].id).toBe('game-rules');
    expect((root.components[0] as GameRules).lives).toBe(5);
  });

  it('resolves through SceneManager across every open scene', async () => {
    const { loader, saver, registry } = makeStack();
    const manager = new SceneManager(loader, saver);

    manager.setActiveSceneGraph(
      'scene-a',
      await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/a.pix3scene' })
    );
    manager.setActiveSceneGraph(
      'scene-b',
      await loader.parseScene(SCENE_YAML, { filePath: 'res://scenes/b.pix3scene' })
    );

    registerGameRules(registry);

    expect(manager.resolvePendingComponents()).toBe(2);
    // Idempotent: nothing left to attach on a second pass.
    expect(manager.resolvePendingComponents()).toBe(0);
    expect(manager.getSceneGraph('scene-a')?.rootNodes[0].components).toHaveLength(1);
    expect(manager.getSceneGraph('scene-b')?.rootNodes[0].components).toHaveLength(1);
  });

  it('reaches components parked on nested children', async () => {
    const { loader, registry } = makeStack();
    const nested = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    children:
      - id: hud
        type: Group2D
        name: Hud
        components:
          - id: score-hud
            type: 'user:GameRules'
            enabled: true
            config:
              lives: 7
`;

    const graph = await loader.parseScene(nested, { filePath: 'res://scenes/main.pix3scene' });
    registerGameRules(registry);

    expect(loader.resolvePendingComponents(graph.rootNodes)).toBe(1);
    const hud = graph.nodeMap.get('hud');
    expect(hud?.components).toHaveLength(1);
    expect((hud?.components[0] as GameRules).lives).toBe(7);
  });

  it('keeps a live component and a parked one side by side when saving', async () => {
    const { loader, saver, registry } = makeStack();
    registerGameRules(registry);

    const mixed = `version: '1.0.0'
root:
  - id: game-root
    type: Group2D
    name: GameRoot
    components:
      - id: game-rules
        type: 'user:GameRules'
        enabled: true
        config:
          lives: 5
      - id: score-hud
        type: 'user:ScoreHud'
        enabled: true
        config:
          prefix: 'Score: '
`;

    const graph = await loader.parseScene(mixed, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];
    expect(root.components).toHaveLength(1);
    expect(root.pendingComponents).toHaveLength(1);

    const savedYaml = saver.serializeScene(graph);
    expect(savedYaml).toContain('user:GameRules');
    expect(savedYaml).toContain('user:ScoreHud');
    expect(savedYaml).toContain('prefix: "Score: "');
  });
});
