import { beforeEach, describe, expect, it } from 'vitest';
import { appState, resetAppState } from '@/state';
import {
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MAX_VERSIONS,
  RecoveryJournalService,
  formatStamp,
  parseVersionFileName,
  selectPruned,
  type RecoveryRecord,
} from './RecoveryJournalService';
import { MemoryRecoveryFallbackStore } from './recovery-fallback-store';
import { MemoryStorage, wire } from './memory-storage.spec-helper';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T10:00:00.000Z');

function createJournal(storage = new MemoryStorage()) {
  const journal = wire(new RecoveryJournalService(), { storage });
  const fallback = new MemoryRecoveryFallbackStore();
  journal.setFallbackStore(fallback);
  let now = T0;
  journal.setClock(() => now);
  return {
    journal,
    storage,
    fallback,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

beforeEach(() => {
  resetAppState();
  appState.project.id = 'project-1';
});

describe('RecoveryJournalService', () => {
  it('writes versions under .pix3/recovery/<encoded path>/<stamp>-<hash8>.pix3scene', async () => {
    const { journal, storage } = createJournal();
    const record = await journal.recordVersion('res://scenes/level 1.pix3scene', 'root: []\n');

    expect(record?.location).toBe('disk');
    const [path] = [...storage.files.keys()];
    expect(path).toMatch(
      /^\.pix3\/recovery\/scenes%2Flevel%201\.pix3scene\/2026-09-26T10-00-00-000Z-[0-9a-f]{8}\.pix3scene$/
    );
    expect(storage.files.get(path)).toBe('root: []\n');
    expect(await journal.readVersion(record!)).toBe('root: []\n');
  });

  it('stores consecutive identical versions of a scene once', async () => {
    const { journal, storage, setNow } = createJournal();
    await journal.recordVersion('scenes/a.pix3scene', 'v1');
    setNow(T0 + 1000);
    expect(await journal.recordVersion('scenes/a.pix3scene', 'v1')).toBeNull();
    setNow(T0 + 2000);
    await journal.recordVersion('scenes/a.pix3scene', 'v2');
    expect(storage.files.size).toBe(2);
    expect((await journal.listVersions('scenes/a.pix3scene')).map(r => r.createdAt)).toEqual([
      T0 + 2000,
      T0,
    ]);
  });

  it('prunes to the ring on write: count bound, and age bound except the newest per scene', async () => {
    const { journal, storage, setNow } = createJournal();
    // An old version of another scene: older than 7 days but its newest — it survives.
    setNow(T0 - 10 * DAY);
    await journal.recordVersion('scenes/old.pix3scene', 'old-only');
    await journal.recordVersion('scenes/a.pix3scene', 'a-ancient');
    setNow(T0 - 9 * DAY);
    await journal.recordVersion('scenes/a.pix3scene', 'a-old');
    setNow(T0);
    await journal.recordVersion('scenes/a.pix3scene', 'a-new');

    const a = await journal.listVersions('scenes/a.pix3scene');
    expect(a).toHaveLength(1);
    expect(await journal.readVersion(a[0])).toBe('a-new');
    expect(await journal.listVersions('scenes/old.pix3scene')).toHaveLength(1);
    expect(storage.files.size).toBe(2);
  });

  it('picks the ring victims: beyond 200 versions or older than 7 days', () => {
    const records: RecoveryRecord[] = Array.from({ length: RECOVERY_MAX_VERSIONS + 5 }, (_, i) => ({
      scenePath: 'scenes/a.pix3scene',
      createdAt: T0 - i * 1000,
      hash8: i.toString(16).padStart(8, '0'),
      location: 'disk' as const,
      ref: `r${i}`,
    }));
    records.push({
      scenePath: 'scenes/b.pix3scene',
      createdAt: T0 - RECOVERY_MAX_AGE_MS - 1,
      hash8: 'bbbbbbbb',
      location: 'disk',
      ref: 'b-newest',
    });
    const pruned = selectPruned(records, T0).map(r => r.ref);
    expect(pruned).toHaveLength(6);
    expect(pruned).toContain('b-newest'); // beyond the count bound, age protection does not apply
    expect(pruned).not.toContain('r0');
  });

  it('falls back to browser storage when .pix3/ cannot be written', async () => {
    const storage = new MemoryStorage();
    storage.failWrites.add('.pix3/');
    const { journal, fallback } = createJournal(storage);

    const record = await journal.recordVersion('scenes/a.pix3scene', 'manual version');
    expect(record?.location).toBe('fallback');
    expect(storage.files.size).toBe(0);
    const stored = await fallback.list('project-1');
    expect(stored.map(r => r.content)).toEqual(['manual version']);
    expect(await journal.readVersion(record!)).toBe('manual version');
  });

  it('uses the fallback for a cloud project (never uploads the journal)', async () => {
    const storage = new MemoryStorage();
    storage.backend = 'cloud';
    const { journal } = createJournal(storage);
    expect((await journal.recordVersion('scenes/a.pix3scene', 'x'))?.location).toBe('fallback');
    expect(storage.files.size).toBe(0);
  });

  it('stamps round-trip through the file name', () => {
    const name = `${formatStamp(T0 + 123)}-deadbeef.pix3scene`;
    expect(parseVersionFileName(name)).toEqual({ createdAt: T0 + 123, hash8: 'deadbeef' });
    expect(parseVersionFileName('notes.txt')).toBeNull();
  });
});
