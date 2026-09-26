import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { sha256 } from '@/services/project/external-merge/hash';
import { ExternalChangeService, UNREADABLE_NOTICE_MS } from './ExternalChangeService';
import { SceneDiskStateService } from './SceneDiskStateService';
import { MemoryStorage, wire } from './memory-storage.spec-helper';

const SCENE = (name: string) => `version: 1.0.0\nroot:\n  - id: n\n    name: ${name}\n`;

function createService() {
  const storage = new MemoryStorage();
  const diskState = new SceneDiskStateService();
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const service = wire(new ExternalChangeService(), {
    storage,
    diskState,
    logger,
    journal: { reset: vi.fn() },
  });
  let now = 1_000_000;
  // Timers never fire on their own: the spec drives every step with `tick()`.
  service.configureForTests({ now: () => now, stabilityIntervalMs: 1e9 });
  const batches: string[][] = [];
  let failNext: string[] = [];
  service.onExternalBatch(paths => {
    batches.push([...paths]);
    const failed = failNext;
    failNext = [];
    return { failed };
  });
  return {
    service,
    storage,
    diskState,
    logger,
    batches,
    advance: (ms: number) => {
      now += ms;
    },
    failOnce: (paths: string[]) => {
      failNext = paths;
    },
  };
}

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExternalChangeService — stabilisation window', () => {
  it('delivers a version only after two consecutive identical snapshots', async () => {
    const h = createService();
    h.storage.files.set('scenes/a.pix3scene', SCENE('one'));
    h.service.report('res://scenes/a.pix3scene');
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(true);

    await h.service.tick(); // first snapshot
    expect(h.batches).toEqual([]);

    h.storage.files.set('scenes/a.pix3scene', SCENE('two')); // still being written
    await h.service.tick();
    expect(h.batches).toEqual([]);

    await h.service.tick(); // two equal snapshots
    expect(h.batches).toEqual([['scenes/a.pix3scene']]);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(false);
  });

  it('delivers files changed within one quiet window together', async () => {
    const h = createService();
    h.storage.files.set('scenes/a.pix3scene', SCENE('a'));
    h.storage.files.set('scenes/b.prefab', SCENE('b'));
    h.service.report('scenes/a.pix3scene');
    await h.service.tick();
    h.service.report('scenes/b.prefab'); // arrives while a is settling
    await h.service.tick(); // a stable, b first snapshot
    expect(h.batches).toEqual([]);
    await h.service.tick();
    expect(h.batches).toEqual([['scenes/a.pix3scene', 'scenes/b.prefab']]);
  });

  it('recognises its own write by hash and never delivers it', async () => {
    const h = createService();
    const text = SCENE('mine');
    h.storage.files.set('scenes/a.pix3scene', text);
    h.diskState.recordWrite('scenes/a.pix3scene', await sha256(text), 3);
    h.service.report('scenes/a.pix3scene');
    await h.service.tick();
    await h.service.tick();
    expect(h.batches).toEqual([]);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(false);
    await expect(h.service.whenSettled()).resolves.toBeUndefined();
  });

  it('holds an unparsable scene (last good graph kept), notices after ~5 s, loads once valid', async () => {
    const h = createService();
    h.storage.files.set('scenes/a.pix3scene', 'root: [\n  - id: broken');
    h.service.report('scenes/a.pix3scene');
    await h.service.tick();
    await h.service.tick();
    expect(h.batches).toEqual([]);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(true);
    expect(h.logger.warn).not.toHaveBeenCalled();

    h.advance(UNREADABLE_NOTICE_MS);
    await h.service.tick();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('File not readable: scenes/a.pix3scene')
    );
    expect(appState.project.coauthoring.unreadablePaths).toEqual(['scenes/a.pix3scene']);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(true);

    h.storage.files.set('scenes/a.pix3scene', SCENE('fixed'));
    await h.service.tick();
    await h.service.tick();
    expect(h.batches).toEqual([['scenes/a.pix3scene']]);
    expect(appState.project.coauthoring.unreadablePaths).toEqual([]);
  });

  it('a broken write restored to the loaded bytes clears pending + unreadable (no reload)', async () => {
    const h = createService();
    const path = 'scenes/a.pix3scene';
    const good = SCENE('loaded');
    h.storage.files.set(path, good);
    await h.diskState.recordRead(path, good, good); // (1) the editor loaded hash H
    const diskChanges = vi.fn();
    h.diskState.subscribe(diskChanges);

    // (2) An external writer replaces it with invalid YAML: pending, then "not readable".
    h.storage.files.set(path, 'root: [\n  - id: broken');
    h.service.report(path);
    await h.service.tick();
    await h.service.tick();
    h.advance(UNREADABLE_NOTICE_MS);
    await h.service.tick();
    expect(appState.project.coauthoring.unreadablePaths).toEqual([path]);
    expect(h.diskState.isPendingExternal(path)).toBe(true);

    // (3) It restores exactly the previous bytes — and nothing reports it (no new push; the
    // barrier's syncNow skips a path whose hash is already known). The retry loop must re-read.
    h.storage.files.set(path, good);
    diskChanges.mockClear();
    await h.service.tick();
    await h.service.tick();
    expect(h.diskState.isPendingExternal(path)).toBe(false);
    expect(appState.project.coauthoring.unreadablePaths).toEqual([]);
    expect(appState.project.coauthoring.pendingExternalPaths).toEqual([]);
    expect(diskChanges).toHaveBeenCalled(); // AutosaveService's cue to run a held save
    expect(h.batches).toEqual([]); // the graph already is H: not reloaded
    expect(h.service.isPending(path)).toBe(false);
  });

  it('keeps re-reading a file past its "not readable" notice without a new report', async () => {
    const h = createService();
    // Real timers this time (the loop must schedule its own re-reads), fast interval.
    h.service.configureForTests({ stabilityIntervalMs: 5 });
    const path = 'scenes/a.pix3scene';
    const good = SCENE('loaded');
    h.storage.files.set(path, good);
    await h.diskState.recordRead(path, good, good);
    h.storage.files.set(path, 'root: [\n  - id: broken');
    h.service.report(path);
    await vi.waitFor(() => expect(h.diskState.isPendingExternal(path)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 30));
    h.advance(UNREADABLE_NOTICE_MS);
    await vi.waitFor(() => expect(appState.project.coauthoring.unreadablePaths).toEqual([path]));

    h.storage.files.set(path, good);
    await vi.waitFor(() => expect(h.diskState.isPendingExternal(path)).toBe(false), {
      timeout: 3_000,
    });
    expect(appState.project.coauthoring.unreadablePaths).toEqual([]);
    expect(h.batches).toEqual([]);
    h.service.dispose();
  });

  it('keeps a version the loader rejected pending and retries it', async () => {
    const h = createService();
    h.storage.files.set('scenes/a.pix3scene', SCENE('a'));
    h.failOnce(['scenes/a.pix3scene']);
    h.service.report('scenes/a.pix3scene');
    await h.service.tick();
    await h.service.tick();
    expect(h.batches).toHaveLength(1);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(true);

    await h.service.tick(); // retry
    expect(h.batches).toHaveLength(2);
    expect(h.diskState.isPendingExternal('scenes/a.pix3scene')).toBe(false);
  });

  it('during play: detects, marks stale, delivers when play stops', async () => {
    const h = createService();
    h.service.configureForTests({ stabilityIntervalMs: 1 });
    appState.ui.isPlaying = true;
    h.storage.files.set('scenes/a.pix3scene', SCENE('a'));
    h.service.report('scenes/a.pix3scene');
    await h.service.tick();
    await h.service.tick();
    expect(h.batches).toEqual([]);
    expect(appState.project.coauthoring.stale).toBe(true);

    appState.ui.isPlaying = false;
    await vi.waitFor(() => expect(h.batches).toEqual([['scenes/a.pix3scene']]));
    expect(appState.project.coauthoring.stale).toBe(false);
    h.service.dispose();
  });

  it('ignores .pix3/ bookkeeping', async () => {
    const h = createService();
    h.service.report('.pix3/recovery/x.pix3scene');
    expect(h.service.isPending('.pix3/recovery/x.pix3scene')).toBe(false);
    expect(h.diskState.getPendingExternalPaths()).toEqual([]);
  });
});
