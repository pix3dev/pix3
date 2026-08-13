import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import type { PropertySchema } from '@/fw';
import { Script } from '@pix3/runtime';
import { NodeBase, SceneManager, ScriptRegistry } from '@pix3/runtime';
import { createInitialAppState } from '@/state/AppState';
import { UpdateComponentPropertyOperation } from './UpdateComponentPropertyOperation';

class TestComponent extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = { speed: 1 };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TestComponent',
      properties: [
        {
          name: 'speed',
          type: 'number',
          getValue: (component: unknown) => (component as TestComponent).config.speed,
          setValue: (component: unknown, value: unknown) => {
            const parsed = Number(value);
            (component as TestComponent).config.speed = Number.isFinite(parsed) ? parsed : 0;
          },
        },
      ],
    };
  }
}

const createOperationContext = () => {
  const state = createInitialAppState();
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://scene.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const node = new NodeBase({ id: 'node-1', type: 'Node3D', name: 'Node 1' });

  const registry = new ScriptRegistry();
  registry.registerComponent({
    id: 'test:component',
    displayName: 'Test Component',
    description: 'Test component',
    category: 'Test',
    componentClass: TestComponent,
    keywords: ['test'],
  });

  const component = registry.createComponent('test:component', 'comp-1');
  if (!component) {
    throw new Error('Failed to create test component');
  }
  node.addComponent(component);

  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  };

  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph'> = {
    getActiveSceneGraph: () => sceneGraph,
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      if (token === ScriptRegistry) {
        return registry as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  const context = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;

  return { context, component, state };
};

describe('UpdateComponentPropertyOperation', () => {
  it('stores a number property as a number even when the caller passes a string', async () => {
    // Automation (the agent's set_component_property) passes model JSON through verbatim. Left
    // as-is, `"1.5"` reached the saved scene as a quoted number — one measured increment spent its
    // whole iteration budget chasing those quotes.
    const { context, component } = createOperationContext();

    const result = await new UpdateComponentPropertyOperation({
      nodeId: 'node-1',
      componentId: 'comp-1',
      propertyName: 'speed',
      value: '1.5',
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(component.config.speed).toBe(1.5);
    expect(typeof component.config.speed).toBe('number');
  });

  it('updates component property and supports undo/redo', async () => {
    const { context, component, state } = createOperationContext();
    const operation = new UpdateComponentPropertyOperation({
      nodeId: 'node-1',
      componentId: 'comp-1',
      propertyName: 'speed',
      value: 4,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(component.config.speed).toBe(4);
    expect(state.scenes.descriptors['scene-1'].isDirty).toBe(true);

    if (!result.commit) {
      throw new Error('Expected commit');
    }

    await result.commit.undo();
    expect(component.config.speed).toBe(1);

    await result.commit.redo();
    expect(component.config.speed).toBe(4);
  });

  it('returns didMutate=false for unknown property', async () => {
    const { context } = createOperationContext();
    const operation = new UpdateComponentPropertyOperation({
      nodeId: 'node-1',
      componentId: 'comp-1',
      propertyName: 'unknown',
      value: 4,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(false);
  });

  it('returns didMutate=false for unknown component', async () => {
    const { context } = createOperationContext();
    const operation = new UpdateComponentPropertyOperation({
      nodeId: 'node-1',
      componentId: 'missing-component',
      propertyName: 'speed',
      value: 4,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(false);
  });
});
