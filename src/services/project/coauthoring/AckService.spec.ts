import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { FileWatchService } from '@/services/project/FileWatchService';
import { AckService, parseAckFile } from './AckService';
import { ACK_FILE } from './coauthoring-paths';
import { MemoryStorage, wire } from './memory-storage.spec-helper';

beforeEach(() => {
  resetAppState();
});

describe('AckService', () => {
  it('parses `.pix3/ack.json` leniently (malformed = no acks, paths normalised)', () => {
    expect(parseAckFile('{')).toEqual([]);
    expect(parseAckFile('{"acks": 5}')).toEqual([]);
    expect(
      parseAckFile(
        JSON.stringify({ acks: [{ path: 'res://scenes/a.pix3scene', sha256: 'AB' }, { path: 1 }] })
      )
    ).toEqual([{ path: 'scenes/a.pix3scene', sha256: 'ab', at: '' }]);
  });

  it('watches the one `.pix3/` file explicitly: pushed changes refresh, others under .pix3 do not', async () => {
    appState.project.status = 'ready';
    appState.project.id = 'w1';
    appState.project.backend = 'workspace';
    const storage = new MemoryStorage();
    const fileWatch = new FileWatchService();
    fileWatch.setPushMode(true);
    const acks = wire(new AckService(), {
      storage,
      ownership: { isOwner: () => true },
      fileWatch,
    });
    const changed = vi.fn();
    acks.subscribe(changed);
    acks.initialize();
    await acks.refresh();
    expect(acks.current()).toEqual([]);

    storage.files.set(ACK_FILE, JSON.stringify({ acks: [{ path: 'a.pix3scene', sha256: 'h' }] }));
    expect(fileWatch.notifyExternalChange('.pix3/protected.json')).toBe(false);
    expect(fileWatch.notifyExternalChange(ACK_FILE)).toBe(true);
    await acks.refresh();
    expect(acks.current().map(a => a.sha256)).toEqual(['h']);
    expect(changed).toHaveBeenCalled();
    expect(await acks.acksFor('res://a.pix3scene')).toEqual(['h']);
    acks.dispose();
    fileWatch.dispose();
  });
});
