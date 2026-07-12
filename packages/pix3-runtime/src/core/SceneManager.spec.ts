import { describe, expect, it } from 'vitest';

import { SceneManager, type SceneGraph } from './SceneManager';
import type { SceneLoader } from './SceneLoader';
import type { SceneSaver } from './SceneSaver';
import type { NodeBase } from '../nodes/NodeBase';

// setActiveScene / setActiveSceneGraph / getActiveSceneGraph never touch the
// loader or saver, so trivial stubs are enough to exercise the active-pointer
// contract without standing up the whole parse/serialize chain.
function makeManager(): SceneManager {
  return new SceneManager({} as SceneLoader, {} as SceneSaver);
}

function makeGraph(marker: string): SceneGraph {
  const nodeMap = new Map<string, NodeBase>();
  // A sentinel entry lets a test assert the graph was NOT disposed (dispose
  // clears nodeMap) when we merely switch the active pointer.
  // `groups` must be iterable — setActiveSceneGraph builds a group map over it.
  nodeMap.set(marker, { nodeId: marker, groups: new Set<string>() } as unknown as NodeBase);
  return { version: '1.0.0', rootNodes: [], nodeMap, metadata: {} };
}

describe('SceneManager active-scene pointer', () => {
  it('setActiveScene switches to an already-registered graph without replacing it', () => {
    const manager = makeManager();
    const graphA = makeGraph('a-root');
    const graphB = makeGraph('b-root');

    manager.setActiveSceneGraph('a', graphA);
    manager.setActiveSceneGraph('b', graphB);
    // Last one loaded is active — this is the tab-switch bug's starting state.
    expect(manager.getActiveSceneGraph()).toBe(graphB);

    const switched = manager.setActiveScene('a');

    expect(switched).toBe(true);
    // The very desync the fix targets: the active graph must follow the pointer.
    expect(manager.getActiveSceneGraph()).toBe(graphA);
    // Same instance, node identity intact — the graph was moved-to, not rebuilt.
    expect(manager.getSceneGraph('a')).toBe(graphA);
    expect(graphA.nodeMap.has('a-root')).toBe(true);
    // The previously-active graph is left untouched and still registered.
    expect(manager.getSceneGraph('b')).toBe(graphB);
    expect(graphB.nodeMap.has('b-root')).toBe(true);
  });

  it('setActiveScene returns false and leaves the active pointer unchanged for an unknown id', () => {
    const manager = makeManager();
    const graphA = makeGraph('a-root');
    manager.setActiveSceneGraph('a', graphA);

    const switched = manager.setActiveScene('does-not-exist');

    expect(switched).toBe(false);
    expect(manager.getActiveSceneGraph()).toBe(graphA);
  });
});
