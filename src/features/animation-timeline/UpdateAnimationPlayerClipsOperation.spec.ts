import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import {
  AnimationPlayerBehavior,
  NodeBase,
  SceneManager,
  normalizeKeyframeAnimationSet,
  type KeyframeAnimationSet,
} from '@pix3/runtime';
import { createInitialAppState } from '@/state/AppState';
import { addClip, setClipDuration } from './clip-edit-utils';
import {
  ANIMATION_PLAYER_COMPONENT_TYPE,
  UpdateAnimationPlayerClipsOperation,
} from './UpdateAnimationPlayerClipsOperation';

const createOperationContext = (initialAnimations?: unknown) => {
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

  const node = new NodeBase({ id: 'node-1', type: 'Group', name: 'Node 1' });
  const player = new AnimationPlayerBehavior('player-1', ANIMATION_PLAYER_COMPONENT_TYPE);
  if (initialAnimations !== undefined) {
    player.config.animations = initialAnimations;
  }
  node.addComponent(player);

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
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  const context = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;

  return { context, player, state };
};

const getAnimations = (player: AnimationPlayerBehavior): KeyframeAnimationSet =>
  normalizeKeyframeAnimationSet(player.config.animations);

describe('UpdateAnimationPlayerClipsOperation', () => {
  it('applies the updater, marks the scene dirty, and supports undo/redo', async () => {
    const { context, player, state } = createOperationContext();
    const operation = new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'Add clip',
      updater: draft => {
        addClip(draft, 'intro');
      },
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(getAnimations(player).clips.map(c => c.name)).toEqual(['intro']);
    expect(state.scenes.descriptors['scene-1'].isDirty).toBe(true);

    if (!result.commit) {
      throw new Error('Expected commit');
    }

    await result.commit.undo();
    expect(getAnimations(player).clips).toHaveLength(0);

    await result.commit.redo();
    expect(getAnimations(player).clips.map(c => c.name)).toEqual(['intro']);
  });

  it('normalizes updater output', async () => {
    const { context, player } = createOperationContext();
    const operation = new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'Set garbage',
      updater: () =>
        ({
          version: '1.0.0',
          clips: [{ name: '  spaced  ', duration: -3, tracks: 'nope' }],
        }) as unknown as KeyframeAnimationSet,
    });

    const result = await operation.perform(context);
    expect(result.didMutate).toBe(true);

    const set = getAnimations(player);
    expect(set.clips[0].name).toBe('spaced');
    expect(set.clips[0].duration).toBeGreaterThan(0);
    expect(set.clips[0].tracks).toEqual([]);
  });

  it('returns didMutate=false when the updater is a no-op', async () => {
    const { context } = createOperationContext({
      version: '1.0.0',
      clips: [{ name: 'idle', duration: 1, loop: false, tracks: [] }],
    });
    const operation = new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'No-op',
      updater: () => undefined,
    });

    const result = await operation.perform(context);
    expect(result.didMutate).toBe(false);
  });

  it('uses previousSet for undo (coalesced drag semantics)', async () => {
    const initial = {
      version: '1.0.0',
      clips: [{ name: 'idle', duration: 1, loop: false, tracks: [] }],
    };
    const { context, player } = createOperationContext(initial);
    const dragStartSet = normalizeKeyframeAnimationSet(initial);

    // Simulate two commits of the same drag session; each passes the drag-start set.
    const first = await new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'Resize clip',
      previousSet: dragStartSet,
      updater: draft => {
        setClipDuration(draft.clips[0], 2);
      },
    }).perform(context);
    expect(first.didMutate).toBe(true);

    const second = await new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'Resize clip',
      previousSet: dragStartSet,
      updater: draft => {
        setClipDuration(draft.clips[0], 3);
      },
    }).perform(context);
    expect(second.didMutate).toBe(true);
    expect(getAnimations(player).clips[0].duration).toBe(3);

    if (!second.commit) {
      throw new Error('Expected commit');
    }

    // Undo of the surviving (coalesced) entry restores the pre-drag state.
    await second.commit.undo();
    expect(getAnimations(player).clips[0].duration).toBe(1);
  });

  it('mutates even when current equals next but previousSet differs (drag returns to start)', async () => {
    const initial = {
      version: '1.0.0',
      clips: [{ name: 'idle', duration: 1, loop: false, tracks: [] }],
    };
    const { context } = createOperationContext(initial);
    const dragStart = normalizeKeyframeAnimationSet({
      version: '1.0.0',
      clips: [{ name: 'idle', duration: 5, loop: false, tracks: [] }],
    });

    const result = await new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'player-1',
      label: 'Resize clip',
      previousSet: dragStart,
      updater: () => undefined,
    }).perform(context);

    // current === next, but undo must restore the drag-start set.
    expect(result.didMutate).toBe(true);
  });

  it('returns didMutate=false for a missing or non-player component', async () => {
    const { context } = createOperationContext();

    const missing = await new UpdateAnimationPlayerClipsOperation({
      nodeId: 'node-1',
      componentId: 'nope',
      label: 'x',
      updater: draft => {
        addClip(draft);
      },
    }).perform(context);
    expect(missing.didMutate).toBe(false);

    const wrongNode = await new UpdateAnimationPlayerClipsOperation({
      nodeId: 'missing-node',
      componentId: 'player-1',
      label: 'x',
      updater: draft => {
        addClip(draft);
      },
    }).perform(context);
    expect(wrongNode.didMutate).toBe(false);
  });
});
