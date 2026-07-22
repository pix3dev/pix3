import { describe, expect, it, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { appState, resetAppState } from '@/state';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { SceneCRDTBinding } from '@/services/collab/SceneCRDTBinding';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import type { CommandContext } from '@/core/command';

type Listener = (event: OperationEvent) => void;

class FakeOperationService {
  private listener: Listener | null = null;

  addListener(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }

  emit(event: OperationEvent): void {
    this.listener?.(event);
  }

  async invoke(): Promise<{ didMutate: true }> {
    this.emit(createCompletedEvent(false));
    return { didMutate: true };
  }

  async invokeAndPush(): Promise<true> {
    this.emit(createCompletedEvent(true));
    return true;
  }
}

class FakeCollaborationService {
  isRemoteUpdate = false;
  readonly ydoc = new Y.Doc();

  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  getLocalOrigin(): string {
    return 'pix3-local';
  }
}

describe('SceneCRDTBinding', () => {
  beforeEach(() => {
    resetAppState();
    appState.scenes.descriptors['scene-1'] = {
      id: 'scene-1',
      filePath: 'res://scenes/main.pix3scene',
      name: 'Main',
      version: '1.0.0',
      isDirty: false,
      lastSavedAt: null,
      fileHandle: null,
      lastModifiedTime: null,
    };
  });

  it('syncs Yjs snapshots only for history-backed commits', () => {
    const binding = createBinding();
    const operationService = new FakeOperationService();
    const collabService = new FakeCollaborationService();

    binding.bindToOperationService(
      operationService as unknown as OperationService,
      collabService as unknown as never
    );
    binding.bindToYDoc(collabService.getYDoc(), 'scene-1');

    operationService.emit(createCompletedEvent(false));

    const sceneMapBeforeCommit = collabService
      .getYDoc()
      .getMap<Y.Map<unknown>>('scenes')
      .get('scene-1');
    expect(sceneMapBeforeCommit?.get('snapshot')).toBeUndefined();

    operationService.emit(createCompletedEvent(true));

    const sceneMapAfterCommit = collabService
      .getYDoc()
      .getMap<Y.Map<unknown>>('scenes')
      .get('scene-1');
    expect(sceneMapAfterCommit?.get('snapshot')).toBe('serialized-scene');
  });

  it('keeps inspector preview updates local and syncs only commit updates', async () => {
    const binding = createBinding();
    const operationService = new FakeOperationService();
    const collabService = new FakeCollaborationService();

    binding.bindToOperationService(
      operationService as unknown as OperationService,
      collabService as unknown as never
    );
    binding.bindToYDoc(collabService.getYDoc(), 'scene-1');

    const previewCommand = new UpdateObjectPropertyCommand({
      nodeId: 'node-1',
      propertyPath: 'intensity',
      value: 2.5,
      historyMode: 'preview',
    });

    await previewCommand.execute(createCommandContext(operationService));

    const previewSceneMap = collabService.getYDoc().getMap<Y.Map<unknown>>('scenes').get('scene-1');
    expect(previewSceneMap?.get('snapshot')).toBeUndefined();

    const commitCommand = new UpdateObjectPropertyCommand({
      nodeId: 'node-1',
      propertyPath: 'intensity',
      value: 2.5,
      historyMode: 'commit',
    });

    await commitCommand.execute(createCommandContext(operationService));

    const commitSceneMap = collabService.getYDoc().getMap<Y.Map<unknown>>('scenes').get('scene-1');
    expect(commitSceneMap?.get('snapshot')).toBe('serialized-scene');
  });
});

function createBinding(): SceneCRDTBinding {
  const binding = new SceneCRDTBinding();
  const sceneGraph = {
    version: '1.0.0',
    description: 'Main',
    rootNodes: [],
    metadata: {},
  };

  Object.defineProperty(binding, 'getSceneManager', {
    value: () => ({
      getSceneGraph: () => sceneGraph,
      getActiveSceneGraph: () => sceneGraph,
      serializeScene: () => 'serialized-scene',
    }),
    configurable: true,
  });

  return binding;
}

function createCompletedEvent(pushedToHistory: boolean): OperationEvent {
  return {
    type: 'operation:completed',
    metadata: {
      id: 'scene.update-object-property',
      title: 'Update Object Property',
      description: 'Update a property on a scene object',
      tags: ['property'],
    },
    didMutate: true,
    pushedToHistory,
    timestamp: Date.now(),
  };
}

function createCommandContext(operationService: FakeOperationService): CommandContext {
  return {
    state: appState,
    snapshot: { scenes: { activeSceneId: 'scene-1' } },
    container: {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(token: unknown): T => {
        if (token === OperationService) {
          return operationService as unknown as T;
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    },
    requestedAt: Date.now(),
  } as unknown as CommandContext;
}
