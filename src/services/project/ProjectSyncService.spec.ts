import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { sha256 } from '@/services/project/external-merge/hash';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';
import { MemoryStorage, wire } from '@/services/project/coauthoring/memory-storage.spec-helper';
import { ProjectSyncService } from './ProjectSyncService';

const SCENE_V1 = 'version: 1.0.0\nroot:\n  - id: n\n    name: One\n';
const SCENE_V2 = 'version: 1.0.0\nroot:\n  - id: n\n    name: Two\n';

function createHarness() {
  const storage = new MemoryStorage();
  const diskState = new SceneDiskStateService();
  const externalChanges = wire(new ExternalChangeService(), {
    storage,
    diskState,
    logger: { warn: vi.fn() },
    journal: { reset: vi.fn() },
  });
  externalChanges.configureForTests({ stabilityIntervalMs: 1 });
  // The editor shell's consumer: "reload" = read the file and remember its hash.
  const reloaded: string[] = [];
  externalChanges.onExternalBatch(async paths => {
    for (const path of paths) {
      reloaded.push(path);
      await diskState.recordRead(path, await storage.readTextFile(path));
    }
  });
  const loader = {
    getCollectedFiles: () => new Map([['scripts/Player.ts', 'export class Player {}']]),
    syncAndBuild: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
  };
  const service = wire(new ProjectSyncService(), {
    storage,
    diskState,
    externalChanges,
    fileWatch: { checkAllNow: vi.fn(async () => undefined) },
    workspaceSession: { rescan: vi.fn(async () => undefined) },
  });
  service.setScriptLoader(loader);

  appState.project.status = 'ready';
  appState.project.id = 'p1';
  appState.scenes.descriptors['s1'] = {
    id: 's1',
    filePath: 'res://scenes/main.pix3scene',
    name: 'Main',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
  return { service, storage, diskState, loader, reloaded };
}

beforeEach(() => {
  resetAppState();
});

describe('ProjectSyncService.syncNow', () => {
  it('reloads an open scene that changed on disk and returns the hashes it now holds', async () => {
    const h = createHarness();
    h.storage.files.set('scenes/main.pix3scene', SCENE_V1);
    h.storage.files.set('scripts/Player.ts', 'export class Player {}');
    await h.diskState.recordRead('scenes/main.pix3scene', SCENE_V1);
    h.storage.files.set('scenes/main.pix3scene', SCENE_V2); // the agent wrote a new version

    const hashes = await h.service.syncNow();

    expect(h.reloaded).toEqual(['scenes/main.pix3scene']);
    expect(hashes).toEqual({ 'scenes/main.pix3scene': await sha256(SCENE_V2) });
    expect(h.loader.ensureReady).toHaveBeenCalled();
    expect(h.loader.syncAndBuild).not.toHaveBeenCalled();
  });

  it('returns immediately when nothing changed; rebuilds scripts that differ from the last build', async () => {
    const h = createHarness();
    h.storage.files.set('scenes/main.pix3scene', SCENE_V1);
    await h.diskState.recordRead('scenes/main.pix3scene', SCENE_V1);
    h.storage.files.set('scripts/Player.ts', 'export class Player { speed = 2 }');

    const hashes = await h.service.syncNow();

    expect(h.reloaded).toEqual([]);
    expect(hashes).toEqual({ 'scenes/main.pix3scene': await sha256(SCENE_V1) });
    expect(h.loader.syncAndBuild).toHaveBeenCalledWith({ force: true });
  });
});
