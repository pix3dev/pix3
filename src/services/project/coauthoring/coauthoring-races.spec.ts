import { beforeEach, describe, expect, it } from 'vitest';
import { appState, resetAppState } from '@/state';
import { entryKey } from '@/services/project/external-merge/protected-set';
import {
  SCENE_ID,
  SCENE_PATH,
  agentScene,
  createMergeHarness,
  type MergeHarness,
} from './merge-harness.spec-helper';

/**
 * The live race scenarios of plan §4.3 / Phase 2 "done when", run as a script: a fake "agent"
 * writes to the project folder, the REAL stabilisation window (`ExternalChangeService`) settles
 * it, and the batch goes through the REAL merge consumer into the REAL graph. After every run:
 * each manual edit is either in the final file or recoverable from the journal, and none was
 * replaced without the banner.
 */

const POSITION = entryKey('a', ['properties', 'transform', 'position']);
const banner = () => appState.project.coauthoring.merges[SCENE_PATH];
const conflictMerges = (h: MergeHarness) =>
  h.mergeLines().filter(l => l.event === 'merge' && l.status === 'conflicts');
const protectedKeys = (h: MergeHarness) =>
  h.protectedSets.get(SCENE_PATH).entries.map(e => entryKey(e.nodeId, e.path));

async function journalHas(h: MergeHarness, x: number): Promise<boolean> {
  for (const record of await h.journal.listVersions(SCENE_PATH)) {
    const text = await h.journal.readVersion(record);
    if (
      text?.includes(`- ${x}\n`) ||
      text?.includes(`[${x}, 20]`) ||
      text?.includes(`- ${x}\r\n`)
    ) {
      return true;
    }
  }
  return false;
}

/** The promise: the manual x is in the file, or recoverable — and a replacement shows a banner. */
async function expectManualEditSafe(h: MergeHarness, x: number): Promise<void> {
  const onDisk = h.diskPositionOfA()?.[0] === x;
  expect(onDisk || (await journalHas(h, x))).toBe(true);
  if (!onDisk) expect(banner()).toBeDefined();
}

beforeEach(() => {
  resetAppState();
});

describe('co-authoring races (live, fake agent on the storage)', () => {
  it('(а) x=0 → human 100, autosaved → agent writes 20 from its stale read: graph 100, banner, log', async () => {
    const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    await h.humanMoveA(100);
    expect((await h.autosave()).outcome).toBe('saved');
    h.agentWrites(agentScene({ ax: 20 }));
    await h.settleExternal();

    expect(h.positionOfA()).toEqual([100, 20]);
    expect(h.diskPositionOfA()).toEqual([100, 20]);
    expect(banner()?.status).toBe('conflicts');
    expect(conflictMerges(h)).toHaveLength(1);
    await expectManualEditSafe(h, 100);
  });

  it('(б) reverse race: autosave while the agent’s version is pending never clobbers it', async () => {
    const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    h.agentWrites(agentScene({ ax: 20, bName: 'AgentB' }));
    h.externalChanges.report(SCENE_PATH);
    await h.externalChanges.tick(); // first snapshot: not settled yet
    await h.humanMoveA(100);
    // Held (pending), or refused by the pre-write check — never written over the agent.
    expect(h.diskState.isPendingExternal(SCENE_PATH)).toBe(true);
    await h.settleExternal();
    expect(h.nameOf('b')).toBe('AgentB'); // the agent's edit arrived
    expect(h.positionOfA()).toEqual([100, 20]); // the human's too
    expect(h.diskPositionOfA()).toEqual([100, 20]);
  });

  it('(в) a batch continued without re-reading hits P on every write, not just the first', async () => {
    const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    await h.humanMoveA(100);
    await h.autosave();
    for (const [x, name] of [
      [20, 'B1'],
      [20, 'B2'],
      [30, 'B3'],
    ] as const) {
      h.agentWrites(agentScene({ ax: x, bName: name }));
      await h.settleExternal();
      expect(h.positionOfA()).toEqual([100, 20]);
      expect(h.nameOf('b')).toBe(name);
      expect(banner()?.status).toBe('conflicts');
      expect(protectedKeys(h)).toContain(POSITION);
    }
    expect(conflictMerges(h)).toHaveLength(3);
  });

  it('(д) accidental equality is not a read: 100 accepted silently, the next 20 still conflicts', async () => {
    const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    await h.humanMoveA(100);
    await h.autosave();
    h.agentWrites(agentScene({ ax: 100, bName: 'Round' }));
    await h.settleExternal();
    expect(h.positionOfA()).toEqual([100, 20]);
    expect(banner()).toBeUndefined();
    expect(protectedKeys(h)).toContain(POSITION);

    h.agentWrites(agentScene({ ax: 20, bName: 'Round' }));
    await h.settleExternal();
    expect(h.positionOfA()).toEqual([100, 20]);
    expect(banner()?.status).toBe('conflicts');
  });

  it('(ж) a manual delete stays deleted when the agent writes its old file back', async () => {
    const h = await createMergeHarness();
    await h.humanDelete('c');
    await h.autosave();
    h.agentWrites(agentScene({ ax: 42 })); // still has C
    await h.settleExternal();

    expect(h.has('c')).toBe(false);
    expect(h.positionOfA()).toEqual([42, 20]); // everything else of the agent's lands
    const root = (h.diskDoc().root as Array<{ children: Array<{ id: string }> }>)[0];
    expect(root.children.map(c => c.id)).toEqual(['a', 'b']);
    expect(banner()?.conflicts.map(c => c.kind)).toEqual(['node-resurrected']);
  });

  it('(и) protection survives a restart through .pix3/protected.json', async () => {
    const first = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    await first.humanMoveA(100);
    await first.autosave();
    await first.protectedSets.flush();

    resetAppState();
    const second = await createMergeHarness({ storage: first.storage });
    second.agentWrites(agentScene({ ax: 20 }));
    await second.settleExternal();
    expect(second.positionOfA()).toEqual([100, 20]);
    expect(second.diskPositionOfA()).toEqual([100, 20]);
    expect(banner()?.status).toBe('conflicts');
  });

  it('the agent with a confirmed read (pix3 read → ack) leaves the dispute without a loop', async () => {
    const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
    await h.humanMoveA(100);
    await h.autosave();
    h.agentWrites(agentScene({ ax: 20 }));
    await h.settleExternal();
    expect(banner()?.status).toBe('conflicts');

    // The agent re-reads the merged file and acks exactly those bytes, then writes 80.
    const hash = await h.diskHash();
    h.storage.files.set(
      '.pix3/ack.json',
      JSON.stringify({ acks: [{ path: SCENE_PATH, sha256: hash, at: 'now' }] })
    );
    h.agentWrites(agentScene({ ax: 80 }));
    await h.settleExternal();
    expect(h.positionOfA()).toEqual([80, 20]);
    expect(banner()).toBeUndefined();
    expect(h.ackFile()?.acks).toEqual([]);

    // And stays out: the next write is taken as is.
    h.agentWrites(agentScene({ ax: 81 }));
    await h.settleExternal();
    expect(h.positionOfA()).toEqual([81, 20]);
  });

  it.each(Array.from({ length: 20 }, (_, run) => run))(
    'run %i: truncate + partial writes before the stale version — last good graph, edit safe',
    async run => {
      const h = await createMergeHarness({ initialText: agentScene({ ax: 0 }) });
      const manual = 100 + run;
      await h.humanMoveA(manual);
      if (run % 3 !== 0) await h.autosave(); // some runs race before the autosave landed
      const full = agentScene({ ax: 20 + run, bName: `Agent${run}` });
      const steps = [
        '', // truncate
        full.slice(0, 20 + ((run * 7) % 40)), // partial
        run % 2 === 0 ? full.slice(0, full.length - 5) : '', // partial / truncate again
      ];
      for (const step of steps) {
        h.agentWrites(step);
        h.externalChanges.report(SCENE_PATH);
        await h.externalChanges.tick();
        await h.externalChanges.tick();
        // A broken intermediate never replaces the graph; a truncated prefix that still PARSES
        // and holds still for the window is a version like any other (it may drop B for a
        // moment) — but it cannot take the manual value, which is in P.
        expect(h.positionOfA()).toEqual([manual, 20]);
      }
      h.agentWrites(full);
      await h.settleExternal();

      expect(h.positionOfA()).toEqual([manual, 20]);
      expect(h.nameOf('b')).toBe(`Agent${run}`);
      expect(appState.scenes.descriptors[SCENE_ID]).toBeDefined();
      await expectManualEditSafe(h, manual);
    }
  );
});
