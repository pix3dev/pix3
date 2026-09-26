import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { entryKey } from '@/services/project/external-merge/protected-set';
import { ACK_FILE } from './coauthoring-paths';
import { CHANGED_NODES_HIGHLIGHT_MS } from './ExternalMergeService';
import { ProtectedSetService } from './ProtectedSetService';
import {
  SCENE_ID,
  SCENE_PATH,
  SCENE_RES,
  agentScene,
  createMergeHarness,
  type MergeHarness,
} from './merge-harness.spec-helper';

const POSITION = entryKey('a', ['properties', 'transform', 'position']);
const banner = () => appState.project.coauthoring.merges[SCENE_PATH];
const merges = (h: MergeHarness) => h.mergeLines().filter(l => l.event === 'merge');
const sceneWrites = (h: MergeHarness) => h.storage.writes.filter(w => w.path === SCENE_PATH);

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ExternalMergeService — the four outcomes through the batch consumer', () => {
  it('empty P: plain reload from A (fast path), nothing written back, no banner', async () => {
    const h = await createMergeHarness();
    h.agentWrites(agentScene({ ax: 55 }));
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([55, 20]);
    expect(sceneWrites(h)).toHaveLength(0);
    expect(banner()).toBeUndefined();
    expect(h.diskState.isKnownHash(SCENE_PATH, await h.diskHash())).toBe(true);
    // A is now E (the version the editor accepted).
    expect(h.diskState.getEditorVersion(SCENE_PATH)?.hash).toBe(await h.diskHash());
  });

  it('clean and M == A: reload from A, no write-back, merge-log stamped with A’s hash', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    // The agent read the autosaved file and changes something else.
    h.agentWrites(agentScene({ ax: 100, bName: 'Renamed' }));
    const writesBefore = sceneWrites(h).length;
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.nameOf('b')).toBe('Renamed');
    expect(sceneWrites(h)).toHaveLength(writesBefore);
    expect(banner()).toBeUndefined();
    // Equality is not a read event: the entry stays protected.
    expect(h.protectedSets.get(SCENE_PATH).entries.map(e => entryKey(e.nodeId, e.path))).toContain(
      POSITION
    );
    const [line] = merges(h);
    expect(line).toMatchObject({
      file: SCENE_PATH,
      status: 'clean',
      mergedHash: await h.diskHash(),
    });
  });

  it('clean and M != A (agent carried the pre-edit file): M loaded and written, no banner', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100); // not autosaved: E still has x = 10
    h.agentWrites(agentScene({ ax: 10, bName: 'Renamed' }));
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.nameOf('b')).toBe('Renamed');
    expect(h.diskPositionOfA()).toEqual([100, 20]);
    expect(banner()).toBeUndefined();
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
    const [line] = merges(h);
    expect(line).toMatchObject({ status: 'clean', mergedHash: await h.diskHash() });
    expect(JSON.stringify(line)).toContain('human-unchanged-by-agent');
  });

  it('conflicts: human value kept in graph and on disk, banner, merge-log, journal first', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    h.agentWrites(agentScene({ ax: 20 }));
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.diskPositionOfA()).toEqual([100, 20]);
    expect(banner()).toMatchObject({ status: 'conflicts', sceneId: SCENE_ID });
    expect(banner().conflicts).toHaveLength(1);
    expect(banner().conflicts[0]).toMatchObject({
      kind: 'property',
      humanValue: [100, 20],
      agentValue: [20, 20],
    });
    expect(banner().restoreRef).toMatch(/^\.pix3\/recovery\//);
    const [line] = merges(h);
    expect(line).toMatchObject({ status: 'conflicts', mergedHash: await h.diskHash() });
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('reloaded'));
  });

  it('rejected: last good graph kept, nothing written, autosave held, whole-scene banner', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    const writesBefore = sceneWrites(h).length;
    h.agentWrites(agentScene({ ax: 20, dupId: true }));
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.has('b')).toBe(true);
    expect(sceneWrites(h)).toHaveLength(writesBefore);
    expect(banner()).toMatchObject({ status: 'rejected' });
    expect(banner().reason).toMatch(/duplicate node id/);
    expect(h.diskState.isPendingExternal(SCENE_PATH)).toBe(true);
    expect(merges(h)[0]).toMatchObject({ status: 'rejected' });

    // [Keep mine] writes the editor's version over the agent's and releases the hold.
    expect(await h.merge.keepMine(SCENE_PATH)).toBe(true);
    expect(h.diskPositionOfA()).toEqual([100, 20]);
    expect(h.diskState.isPendingExternal(SCENE_PATH)).toBe(false);
    expect(banner()).toBeUndefined();
    expect(h.mergeLines().some(l => l.event === 'keep-mine')).toBe(true);
  });

  it('rejected → [Accept agent’s version] loads A as is and releases P', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    h.agentWrites(agentScene({ ax: 20, dupId: true }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(banner()?.status).toBe('rejected');
    // The agent fixes its file; the human accepts whatever is on disk now.
    h.agentWrites(agentScene({ ax: 20 }));
    expect(await h.merge.acceptRejected(SCENE_PATH)).toBe(true);
    expect(h.positionOfA()).toEqual([20, 20]);
    expect(h.protectedSets.get(SCENE_PATH).entries).toHaveLength(0);
    expect(h.diskState.isPendingExternal(SCENE_PATH)).toBe(false);
  });

  it('non-owner window: never merges, just reloads the disk', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    h.setOwner(false);
    h.agentWrites(agentScene({ ax: 20 }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(h.positionOfA()).toEqual([20, 20]);
    expect(banner()).toBeUndefined();
    expect(h.mergeLines()).toHaveLength(0);
  });
});

describe('ExternalMergeService — accept (undoable) and restore from the journal', () => {
  it('Accept agent’s version: applies A’s value, releases P; undo/redo swap graph and P', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    h.agentWrites(agentScene({ ax: 20, bName: 'AgentB' }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(banner()?.status).toBe('conflicts');
    const graphAfterMerge = h.sceneManager.getSceneGraph(SCENE_ID);

    expect(await h.merge.acceptConflicts(SCENE_PATH)).toBe(true);
    expect(h.positionOfA()).toEqual([20, 20]);
    expect(h.nameOf('b')).toBe('AgentB');
    expect(h.protectedSets.get(SCENE_PATH).entries).toHaveLength(0);
    expect(banner()).toBeUndefined();
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true); // autosave writes it

    await h.operations.undo();
    expect(h.sceneManager.getSceneGraph(SCENE_ID)).toBe(graphAfterMerge); // same instance back
    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.protectedSets.get(SCENE_PATH).entries.map(e => entryKey(e.nodeId, e.path))).toEqual([
      POSITION,
    ]);

    await h.operations.redo();
    expect(h.positionOfA()).toEqual([20, 20]);
    expect(h.protectedSets.get(SCENE_PATH).entries).toHaveLength(0);
    expect(h.mergeLines().some(l => l.event === 'accept-agent')).toBe(true);
  });

  it('per-item Accept keeps the other conflicts in the banner', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.operations.invokeAndPush(
      new (
        await import('@/features/properties/UpdateObjectPropertyOperation')
      ).UpdateObjectPropertyOperation({ nodeId: 'b', propertyPath: 'name', value: 'HumanB' })
    );
    await h.autosave();
    h.agentWrites(agentScene({ ax: 20, bName: 'AgentB' }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(banner().conflicts).toHaveLength(2);
    const positionConflict = banner().conflicts.find(c => c.nodeId === 'a')!;

    await h.merge.acceptConflicts(SCENE_PATH, [positionConflict.id]);
    expect(h.positionOfA()).toEqual([20, 20]);
    expect(h.nameOf('b')).toBe('HumanB');
    expect(banner().conflicts.map(c => c.nodeId)).toEqual(['b']);
  });

  it('Restore my version before the agent’s changes: journal version, one undoable op, into P', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    // Agent renames B (not protected — taken silently) and fights over A (conflict).
    h.agentWrites(agentScene({ ax: 20, bName: 'AgentB' }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(h.nameOf('b')).toBe('AgentB');

    expect(await h.merge.restoreBeforeMerge(SCENE_PATH)).toBe(true);
    expect(h.nameOf('b')).toBe('B');
    expect(h.positionOfA()).toEqual([100, 20]);
    // The restored value is a human decision now: protected against the agent's stale file.
    expect(h.protectedSets.get(SCENE_PATH).entries.map(e => entryKey(e.nodeId, e.path))).toContain(
      entryKey('b', ['name'])
    );
    expect(banner()).toBeUndefined();

    await h.operations.undo();
    expect(h.nameOf('b')).toBe('AgentB');
    expect(
      h.protectedSets.get(SCENE_PATH).entries.map(e => entryKey(e.nodeId, e.path))
    ).not.toContain(entryKey('b', ['name']));
  });

  it('lists the last journal versions for the tab context menu, newest first', async () => {
    const h = await createMergeHarness();
    for (const x of [1, 2, 3]) {
      await h.humanMoveA(x);
      await h.autosave();
    }
    const versions = await h.merge.listVersions(SCENE_RES, 2);
    expect(versions).toHaveLength(2);
    expect(versions[0].createdAt).toBeGreaterThan(versions[1].createdAt);
    expect(await h.merge.restoreVersion(SCENE_ID, versions[1])).toBe(true);
    expect(h.positionOfA()).toEqual([2, 20]);
  });
});

describe('ExternalMergeService — acks (one-shot) and the merge log', () => {
  it('an ack of a version the editor wrote releases its entries and is removed from ack.json', async () => {
    const h = await createMergeHarness();
    await h.humanMoveA(100);
    await h.autosave();
    const readHash = await h.diskHash(); // `pix3 read` of the autosaved file
    h.storage.files.set(
      ACK_FILE,
      JSON.stringify({
        acks: [
          { path: SCENE_PATH, sha256: readHash, at: 'now' },
          { path: SCENE_PATH, sha256: 'f'.repeat(64), at: 'now' },
          { path: 'scenes/other.pix3scene', sha256: readHash, at: 'now' },
        ],
      })
    );
    // The agent read x = 100 and deliberately writes 80.
    h.agentWrites(agentScene({ ax: 80 }));
    await h.merge.handleBatch([SCENE_PATH]);

    expect(h.positionOfA()).toEqual([80, 20]);
    expect(banner()).toBeUndefined();
    expect(h.protectedSets.get(SCENE_PATH).entries).toHaveLength(0);
    // One-shot: this file's acks are gone; another file's ack stays.
    expect(h.ackFile()?.acks).toEqual([
      { path: 'scenes/other.pix3scene', sha256: readHash, at: 'now' },
    ]);
    const events = h.mergeLines().map(l => l.event);
    expect(events).toContain('ack-applied');
    expect(events).toContain('ack-unknown');
  });

  it('keeps the merge log a ring of 500 lines', async () => {
    const h = await createMergeHarness();
    const entries = Array.from({ length: 520 }, (_, i) => ({
      event: 'ack-unknown' as const,
      hash: `${i}`,
    }));
    await h.mergeLog.append(SCENE_PATH, entries);
    const lines = h.mergeLines();
    expect(lines).toHaveLength(500);
    expect(lines[0]).toMatchObject({ hash: '20', file: SCENE_PATH });
  });

  it('a non-owner window never writes the merge log or ack.json', async () => {
    const h = await createMergeHarness();
    h.setOwner(false);
    await h.mergeLog.append(SCENE_PATH, [{ event: 'ack-unknown', hash: 'x' }]);
    await h.acks.consume(SCENE_PATH, ['x']);
    expect(h.storage.writes).toHaveLength(0);
  });
});

describe('ExternalMergeService — changed-node highlight', () => {
  it('marks the nodes an external version changed, and clears them after the highlight', async () => {
    const h = await createMergeHarness();
    h.merge.configureForTests({ highlightMs: 20 });
    h.agentWrites(agentScene({ bName: 'Renamed' }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(appState.project.coauthoring.recentlyChangedNodeIds).toEqual(['b']);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(appState.project.coauthoring.recentlyChangedNodeIds).toEqual([]);
    expect(CHANGED_NODES_HIGHLIGHT_MS).toBe(3000);
  });

  it('keeps the selection of surviving nodes by id and drops deleted ones', async () => {
    const h = await createMergeHarness();
    appState.selection.nodeIds = ['a', 'c'];
    appState.selection.primaryNodeId = 'c';
    h.agentWrites(agentScene({ withC: false }));
    await h.merge.handleBatch([SCENE_PATH]);
    expect(appState.selection.nodeIds).toEqual(['a']);
    expect(appState.selection.primaryNodeId).toBe('a');
  });
});

describe('ProtectedSetService round trip is visible to the merge (restart)', () => {
  it('uses the P persisted in .pix3/protected.json after an editor restart', async () => {
    const first = await createMergeHarness();
    await first.humanMoveA(100);
    await first.autosave();
    await first.protectedSets.flush();
    expect(
      ProtectedSetService.parse(first.storage.files.get('.pix3/protected.json')!).get(SCENE_PATH)
        ?.entries
    ).toHaveLength(1);

    resetAppState();
    const second = await createMergeHarness({ storage: first.storage });
    expect(second.positionOfA()).toEqual([100, 20]);
    second.agentWrites(agentScene({ ax: 20 })); // the agent's stale batch continues
    await second.merge.handleBatch([SCENE_PATH]);
    expect(second.positionOfA()).toEqual([100, 20]);
    expect(banner()?.status).toBe('conflicts');
  });
});
