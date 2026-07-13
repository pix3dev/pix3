import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeBase } from '@pix3/runtime';
import { appState } from '@/state';
import { clearErrors } from '@/core/agent-introspection';
import { AgentToolRegistry } from './AgentToolRegistry';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';

interface CommandMeta {
  metadata: { id: string; title: string; menuPath?: string };
}

/** Build a registry with fake dependencies injected in place of the DI-resolved ones. */
const buildRegistry = (overrides: Record<string, unknown> = {}): AgentToolRegistry => {
  const registry = new AgentToolRegistry();
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(registry, key, { value, configurable: true });
  }
  return registry;
};

const makeNode = (over: Record<string, unknown> = {}): NodeBase => {
  const node = Object.create(NodeBase.prototype) as Record<string, unknown>;
  Object.assign(node, {
    nodeId: 'n1',
    type: 'Node3D',
    name: 'Cube',
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    groups: [],
    components: [],
    children: [],
    properties: {},
    ...over,
  });
  return node as unknown as NodeBase;
};

describe('AgentToolRegistry', () => {
  beforeEach(() => {
    clearErrors();
  });

  it('lists the expected tools', () => {
    const names = buildRegistry()
      .list()
      .map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'scene_tree',
        'node_inspect',
        'find_nodes',
        'get_selection',
        'set_property',
        'list_component_types',
        'add_component',
        'set_component_property',
        'remove_component',
        'list_commands',
        'run_command',
        'fs_list',
        'fs_read',
        'fs_write',
        'fs_delete',
        'compile_scripts',
        'check_scripts',
        'play_start',
        'play_stop',
        'play_restart',
        'play_status',
        'read_logs',
        'read_errors',
        'viewport_screenshot',
        'generate_asset',
      ])
    );
  });

  it('specs() drops the handler', () => {
    const spec = buildRegistry().specs()[0];
    expect(spec).toHaveProperty('name');
    expect(spec).toHaveProperty('inputSchema');
    expect(spec).not.toHaveProperty('handler');
  });

  it('throws on an unknown tool', async () => {
    await expect(buildRegistry().execute('nope')).rejects.toThrow(/Unknown tool/);
  });

  describe('viewport_screenshot', () => {
    it('returns the capture with the image lifted into __images', async () => {
      const captureScreenshot = vi.fn(() => ({
        dataBase64: 'QUJD',
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      }));
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot } });

      const result = (await registry.execute('viewport_screenshot', { maxSize: 640 })) as Record<
        string,
        unknown
      >;

      expect(captureScreenshot).toHaveBeenCalledWith({ maxSize: 640 });
      expect(result.ok).toBe(true);
      expect(result.__images).toEqual([{ mimeType: 'image/jpeg', data: 'QUJD' }]);
    });

    it('reports a friendly error when the viewport is not initialized', async () => {
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot: () => null } });
      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not initialized/);
    });
  });

  describe('generate_asset', () => {
    const makeAssetGen = (keyConfigured: boolean) => ({
      status: vi.fn(async () => ({ keyConfigured })),
      generate: vi.fn(async () => ({ id: 'img-1', width: 512, height: 512 })),
      save: vi.fn(async () => ({
        path: 'assets/ui/button.png',
        width: 512,
        height: 512,
        bytes: 1234,
        mimeType: 'image/png',
      })),
      preview: vi.fn(async () => 'data:image/webp;base64,UFJFVklFVw=='),
      discard: vi.fn(),
    });

    it('refuses without a configured image key', async () => {
      const assetGen = makeAssetGen(false);
      const registry = buildRegistry({ assetGen });
      const result = (await registry.execute('generate_asset', {
        prompt: 'a button',
        name: 'assets/ui/button',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/API key/);
      expect(assetGen.generate).not.toHaveBeenCalled();
    });

    it('generates, saves, attaches a preview image, and frees the handle', async () => {
      const assetGen = makeAssetGen(true);
      const registry = buildRegistry({ assetGen });

      const result = (await registry.execute('generate_asset', {
        prompt: 'a button',
        name: 'assets/ui/button',
        transparent: true,
      })) as Record<string, unknown>;

      expect(assetGen.generate).toHaveBeenCalledWith({
        prompt: 'a button',
        references: undefined,
        transparent: true,
      });
      expect(assetGen.save).toHaveBeenCalledWith('img-1', 'assets/ui/button', {
        maxSize: undefined,
      });
      expect(result.ok).toBe(true);
      expect(result.saved).toMatchObject({ path: 'assets/ui/button.png' });
      expect(result.__images).toEqual([{ mimeType: 'image/webp', data: 'UFJFVklFVw==' }]);
      expect(assetGen.discard).toHaveBeenCalledWith('img-1');
    });
  });

  describe('filesystem tools', () => {
    const makeStorage = () => {
      const files = new Map<string, string>([['scripts/a.ts', 'export const x = 1;']]);
      return {
        files,
        // Mirrors ProjectStorageService: write/delete bump fileRefreshSignal.
        writeTextFile: vi.fn(async (path: string, content: string) => {
          files.set(path, content);
          appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
        }),
        deleteEntry: vi.fn(async (path: string) => {
          files.delete(path);
          appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
        }),
        readTextFile: vi.fn(async (path: string) => {
          const c = files.get(path);
          if (c === undefined) throw new Error('not found');
          return c;
        }),
        readBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
        listDirectory: vi.fn(async (dir: string) =>
          dir === 'scenes'
            ? [
                {
                  name: 'main.pix3scene',
                  kind: 'file' as const,
                  path: 'scenes/main.pix3scene',
                  size: 42,
                },
              ]
            : []
        ),
      };
    };

    it('fs_write delegates to storage and bumps fileRefreshSignal', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const before = appState.project.fileRefreshSignal || 0;

      const result = await registry.execute('fs_write', {
        path: 'res://scripts/spin.ts',
        content: 'code',
      });

      expect(storage.writeTextFile).toHaveBeenCalledWith('scripts/spin.ts', 'code');
      expect(result).toEqual({ ok: true, path: 'scripts/spin.ts' });
      expect(appState.project.fileRefreshSignal || 0).toBeGreaterThan(before);
    });

    it('fs_delete delegates and bumps fileRefreshSignal', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const before = appState.project.fileRefreshSignal || 0;
      await registry.execute('fs_delete', { path: 'scripts/a.ts' });
      expect(storage.deleteEntry).toHaveBeenCalledWith('scripts/a.ts');
      expect(appState.project.fileRefreshSignal || 0).toBeGreaterThan(before);
    });

    it('rejects paths containing ".."', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      await expect(registry.execute('fs_read', { path: '../secrets.txt' })).rejects.toThrow(/\.\./);
      await expect(
        registry.execute('fs_write', { path: 'scripts/../../x', content: 'y' })
      ).rejects.toThrow(/\.\./);
      await expect(registry.execute('fs_delete', { path: 'a/../../b' })).rejects.toThrow(/\.\./);
    });

    it('fs_read returns content for text and metadata for binary', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      expect(await registry.execute('fs_read', { path: 'scripts/a.ts' })).toEqual({
        path: 'scripts/a.ts',
        content: 'export const x = 1;',
      });
      expect(await registry.execute('fs_read', { path: 'art/icon.png' })).toEqual({
        path: 'art/icon.png',
        binary: true,
        mimeType: 'image/png',
        size: 3,
      });
    });

    it('fs_list maps directory entries', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      expect(await registry.execute('fs_list', { path: 'scenes' })).toEqual([
        { name: 'main.pix3scene', kind: 'file', path: 'scenes/main.pix3scene', size: 42 },
      ]);
    });
  });

  describe('run_command whitelist', () => {
    const allCommands: CommandMeta[] = [
      { metadata: { id: 'scene.add-node', title: 'Add Node', menuPath: 'edit' } },
      { metadata: { id: 'history.undo', title: 'Undo' } },
      { metadata: { id: 'project.open', title: 'Open Project…' } },
    ];
    const makeCommands = () => ({
      getAllCommands: () => allCommands,
      getCommand: (id: string) => allCommands.find(c => c.metadata.id === id),
    });

    it('runs a whitelisted command via the dispatcher', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      expect(await registry.execute('run_command', { commandId: 'scene.add-node' })).toEqual({
        ok: true,
      });
      expect(dispatcher.executeById).toHaveBeenCalledWith('scene.add-node');
    });

    it('refuses a non-whitelisted command without dispatching', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      const result = (await registry.execute('run_command', { commandId: 'project.open' })) as {
        ok: boolean;
        error?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not permitted/);
      expect(dispatcher.executeById).not.toHaveBeenCalled();
    });

    it('reports an unknown command id', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      const result = (await registry.execute('run_command', { commandId: 'bogus.thing' })) as {
        ok: boolean;
        error?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unknown command/);
      expect(dispatcher.executeById).not.toHaveBeenCalled();
    });

    it('list_commands marks which commands the agent may run', async () => {
      const registry = buildRegistry({ commands: makeCommands() });
      const list = (await registry.execute('list_commands')) as Array<{
        id: string;
        allowed: boolean;
      }>;
      const byId = Object.fromEntries(list.map(c => [c.id, c.allowed]));
      expect(byId['scene.add-node']).toBe(true);
      expect(byId['history.undo']).toBe(true);
      expect(byId['project.open']).toBe(false);
    });
  });

  it('set_property routes through UpdateObjectPropertyCommand on the dispatcher', async () => {
    const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
    const registry = buildRegistry({ dispatcher });
    const result = await registry.execute('set_property', {
      nodeId: 'n1',
      propertyPath: 'position.x',
      value: 5,
    });
    expect(result).toEqual({ ok: true });
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(UpdateObjectPropertyCommand);
  });

  describe('component tools', () => {
    const makeScriptRegistry = () => ({
      getAllComponentTypes: () => [
        {
          id: 'core:Rotate',
          displayName: 'Rotate',
          category: 'Behaviour',
          description: 'Spins a node.',
        },
      ],
      getComponentType: (id: string) => (id === 'core:Rotate' ? { id } : undefined),
      getComponentPropertySchema: (id: string) =>
        id === 'core:Rotate'
          ? { properties: [{ name: 'speed', type: 'number', ui: { label: 'Speed' } }] }
          : null,
    });

    it('list_component_types maps types with their property schema', async () => {
      const registry = buildRegistry({ scriptRegistry: makeScriptRegistry() });
      const types = (await registry.execute('list_component_types')) as Array<{
        id: string;
        properties: Array<{ name: string; type: string; label?: string }>;
      }>;
      expect(types).toEqual([
        {
          id: 'core:Rotate',
          displayName: 'Rotate',
          category: 'Behaviour',
          description: 'Spins a node.',
          properties: [{ name: 'speed', type: 'number', label: 'Speed' }],
        },
      ]);
    });

    it('add_component routes through AddComponentCommand and returns a componentId', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, scriptRegistry: makeScriptRegistry() });
      const result = (await registry.execute('add_component', {
        nodeId: 'n1',
        componentType: 'core:Rotate',
        config: { speed: 2 },
      })) as { ok: boolean; componentId?: string };
      expect(result.ok).toBe(true);
      expect(typeof result.componentId).toBe('string');
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(AddComponentCommand);
    });

    it('add_component rejects an unknown component type without dispatching', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, scriptRegistry: makeScriptRegistry() });
      const result = (await registry.execute('add_component', {
        nodeId: 'n1',
        componentType: 'core:Nope',
      })) as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/Unknown component type/);
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });

    it('set_component_property routes through UpdateComponentPropertyCommand', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher });
      const result = await registry.execute('set_component_property', {
        nodeId: 'n1',
        componentId: 'c1',
        propertyName: 'speed',
        value: 3,
      });
      expect(result).toEqual({ ok: true });
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(UpdateComponentPropertyCommand);
    });

    it('remove_component routes through RemoveComponentCommand', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher });
      const result = await registry.execute('remove_component', {
        nodeId: 'n1',
        componentId: 'c1',
      });
      expect(result).toEqual({ ok: true });
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(RemoveComponentCommand);
    });

    it('node_inspect surfaces componentId / componentType / enabled', async () => {
      const node = makeNode({
        components: [{ id: 'c1', type: 'core:Rotate', enabled: true, config: { speed: 1 } }],
      });
      const sceneManager = {
        getActiveSceneGraph: () => ({ nodeMap: new Map([['n1', node]]) }),
      };
      const registry = buildRegistry({ sceneManager });
      const dto = (await registry.execute('node_inspect', { nodeId: 'n1' })) as {
        components: Array<{ componentId: string; componentType: string; enabled: boolean }>;
      };
      expect(dto.components[0]).toMatchObject({
        componentId: 'c1',
        componentType: 'core:Rotate',
        enabled: true,
      });
    });
  });

  it('play tools drive the game.* commands and report status', async () => {
    const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
    const registry = buildRegistry({ dispatcher });
    expect(await registry.execute('play_start')).toEqual({ ok: true });
    expect(dispatcher.executeById).toHaveBeenCalledWith('game.start');

    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';
    expect(await registry.execute('play_status')).toEqual({
      isPlaying: true,
      playModeStatus: 'playing',
    });
    appState.ui.isPlaying = false;
  });

  describe('introspection tools', () => {
    const graph = {
      description: 'Scene',
      version: 'v1',
      rootNodes: [makeNode()],
      nodeMap: new Map<string, NodeBase>([['n1', makeNode({ name: 'Cube', type: 'Node3D' })]]),
    };
    const sceneManager = { getActiveSceneGraph: () => graph };

    it('scene_tree returns a wrapped tree with the scene version', async () => {
      const registry = buildRegistry({ sceneManager });
      const tree = (await registry.execute('scene_tree', { maxDepth: 2 })) as {
        nodeId: string;
        sceneVersion: string;
        children: unknown[];
      };
      expect(tree.nodeId).toBe('<scene-root>');
      expect(tree.sceneVersion).toBe('v1');
      expect(tree.children).toHaveLength(1);
    });

    it('find_nodes searches name and type', async () => {
      const registry = buildRegistry({ sceneManager });
      const matches = (await registry.execute('find_nodes', { text: 'cub' })) as unknown[];
      expect(matches).toEqual([{ nodeId: 'n1', type: 'Node3D', name: 'Cube' }]);
    });

    it('get_selection reads appState selection', async () => {
      appState.selection.nodeIds = ['n1', 'n2'];
      appState.selection.primaryNodeId = 'n1';
      appState.selection.hoveredNodeId = null;
      const result = await buildRegistry().execute('get_selection');
      expect(result).toEqual({ nodeIds: ['n1', 'n2'], primaryNodeId: 'n1', hoveredNodeId: null });
    });
  });

  it('compile_scripts returns a no-entry result when no Script subclasses exist', async () => {
    const storage = {
      listDirectory: vi.fn(async (dir: string) =>
        dir === 'scripts'
          ? [{ name: 'a.ts', kind: 'file' as const, path: 'scripts/a.ts', size: 1 }]
          : []
      ),
      readTextFile: vi.fn(async () => 'export const x = 1;'),
    };
    const registry = buildRegistry({ storage });
    const result = (await registry.execute('compile_scripts')) as { ok: boolean; message?: string };
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/No Script subclasses/);
  });

  it('read_errors returns the captured ring buffer', async () => {
    const registry = buildRegistry();
    clearErrors();
    console.error('agent-tool-registry-test-error');
    const errs = (await registry.execute('read_errors')) as Array<{ message: string }>;
    expect(errs.some(e => e.message.includes('agent-tool-registry-test-error'))).toBe(true);
  });
});
