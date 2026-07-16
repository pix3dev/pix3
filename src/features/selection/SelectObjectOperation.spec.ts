import { describe, expect, it } from 'vitest';
import { proxy } from 'valtio/vanilla';

import { createOperationContext, snapshotOperationState } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';

import { SelectObjectOperation } from './SelectObjectOperation';

describe('SelectObjectOperation', () => {
  it('replaces selection with provided node ids and restores it through undo and redo', async () => {
    const state = proxy(createInitialAppState());
    state.selection.nodeIds = ['node-a'];
    state.selection.primaryNodeId = 'node-a';

    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({
      nodeIds: ['node-b', 'node-c'],
      primaryNodeId: 'node-c',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.nodeIds).toEqual(['node-b', 'node-c']);
    expect(state.selection.primaryNodeId).toBe('node-c');

    await result.commit?.undo();
    expect(state.selection.nodeIds).toEqual(['node-a']);
    expect(state.selection.primaryNodeId).toBe('node-a');

    await result.commit?.redo();
    expect(state.selection.nodeIds).toEqual(['node-b', 'node-c']);
    expect(state.selection.primaryNodeId).toBe('node-c');
  });

  it('uses the first selected node as primary when the requested primary is missing', async () => {
    const state = proxy(createInitialAppState());
    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({
      nodeIds: ['node-b', 'node-c', 'node-b'],
      primaryNodeId: 'node-z',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.nodeIds).toEqual(['node-b', 'node-c']);
    expect(state.selection.primaryNodeId).toBe('node-b');
  });

  it('sets the isolation scope and restores it through undo and redo', async () => {
    const state = proxy(createInitialAppState());
    state.selection.nodeIds = ['node-a'];
    state.selection.primaryNodeId = 'node-a';
    state.selection.focusNodeId = 'old-scope';

    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({
      nodeId: 'child',
      focusNodeId: 'container',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.nodeIds).toEqual(['child']);
    expect(state.selection.focusNodeId).toBe('container');

    await result.commit?.undo();
    expect(state.selection.nodeIds).toEqual(['node-a']);
    expect(state.selection.focusNodeId).toBe('old-scope');

    await result.commit?.redo();
    expect(state.selection.focusNodeId).toBe('container');
  });

  it('mutates when only the scope changes (same selection, new focus)', async () => {
    const state = proxy(createInitialAppState());
    state.selection.nodeIds = ['node-a'];
    state.selection.primaryNodeId = 'node-a';
    state.selection.focusNodeId = null;

    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({
      nodeIds: ['node-a'],
      primaryNodeId: 'node-a',
      focusNodeId: 'container',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.focusNodeId).toBe('container');
  });

  it('leaves the scope untouched when focusNodeId is omitted', async () => {
    const state = proxy(createInitialAppState());
    state.selection.focusNodeId = 'container';

    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({ nodeId: 'node-b' });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.focusNodeId).toBe('container');
  });

  it('removes an already selected node during additive toggle and reassigns the primary node', async () => {
    const state = proxy(createInitialAppState());
    state.selection.nodeIds = ['node-a', 'node-b'];
    state.selection.primaryNodeId = 'node-a';

    const context = createOperationContext(state, snapshotOperationState(state));
    const operation = new SelectObjectOperation({
      nodeId: 'node-a',
      additive: true,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.selection.nodeIds).toEqual(['node-b']);
    expect(state.selection.primaryNodeId).toBe('node-b');
  });
});
