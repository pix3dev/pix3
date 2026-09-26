import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { sha256 } from '@/services/project/external-merge/hash';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import {
  ExternalChangeService,
  UNREADABLE_NOTICE_MS,
} from '@/services/project/coauthoring/ExternalChangeService';
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
  const manifest = {
    hash: null as string | null,
    getLoadedManifestHash: () => manifest.hash,
    reloadProjectManifest: vi.fn(async () => {
      manifest.hash = await sha256(await storage.readTextFile('pix3project.yaml'));
    }),
  };
  service.setManifestSource(manifest);

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
  return { service, storage, diskState, loader, manifest, reloaded, externalChanges };
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

  it('clears a pending unreadable scene whose disk bytes went back to the loaded version', async () => {
    const h = createHarness();
    let now = 1_000_000;
    h.externalChanges.configureForTests({ now: () => now });
    const path = 'scenes/main.pix3scene';
    h.storage.files.set(path, SCENE_V1);
    await h.diskState.recordRead(path, SCENE_V1);
    h.storage.files.set(path, 'root: [\n  - id: broken'); // a broken external write
    h.externalChanges.report(path);
    await vi.waitFor(() => expect(h.externalChanges.isPending(path)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    now += UNREADABLE_NOTICE_MS;
    await vi.waitFor(() => expect(appState.project.coauthoring.unreadablePaths).toEqual([path]));

    h.storage.files.set(path, SCENE_V1); // …restored to exactly the loaded bytes
    const hashes = await h.service.syncNow();

    expect(hashes).toEqual({ [path]: await sha256(SCENE_V1) });
    expect(h.diskState.isPendingExternal(path)).toBe(false);
    expect(appState.project.coauthoring.unreadablePaths).toEqual([]);
    expect(h.reloaded).toEqual([]);
    h.externalChanges.dispose();
  });
});

/** A consumer game laid out like DeepCore: scenes and every module under `src/**`. */
async function consumerHarness() {
  const h = createHarness();
  const scene = 'src/assets/scenes/x.pix3scene';
  const sources: Record<string, string> = {
    'src/scripts/Runner.ts': "import { Chunk } from '../world/Chunk';\nexport class Runner {}",
    'src/scripts/styles/hud.css': '.hud { color: red }',
    'src/world/Chunk.ts': 'export class Chunk {}',
    'src/generated/resource-catalog.ts': 'export const catalog = {};',
  };
  for (const [path, text] of Object.entries(sources)) h.storage.files.set(path, text);
  h.storage.files.set(scene, SCENE_V1);
  h.storage.files.set('pix3project.yaml', 'version: 1.0.0\n');
  await h.diskState.recordRead(scene, SCENE_V1);
  h.manifest.hash = await sha256('version: 1.0.0\n');
  delete appState.scenes.descriptors['s1'];
  appState.scenes.descriptors['x'] = {
    id: 'x',
    filePath: `res://${scene}`,
    name: 'X',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
  // What the last build read: entry sources AND the modules the bundle pulled in, with the
  // hash recorded at read time.
  const built = new Map(Object.entries(sources));
  const recorded = new Map<string, string>();
  for (const [path, text] of built) recorded.set(path, await sha256(text));
  const loader = {
    getCollectedFiles: () => built,
    getCollectedFileHashes: () => recorded,
    syncAndBuild: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
  };
  h.service.setScriptLoader(loader);
  return { ...h, loader, scene, sources, recorded };
}

describe('ProjectSyncService barrier revision', () => {
  it('builtScriptHashes returns every build input (bundled modules too) without reading any', async () => {
    const h = await consumerHarness();
    h.storage.reads.length = 0;

    const hashes = await h.service.builtScriptHashes();

    expect(hashes).toEqual(Object.fromEntries(h.recorded));
    expect(Object.keys(hashes)).toContain('src/world/Chunk.ts');
    expect(h.storage.reads).toEqual([]);
  });

  it('builtScriptHashes falls back to the hash of the built text when nothing was recorded', async () => {
    const h = createHarness();
    const hashes = await h.service.builtScriptHashes();
    expect(hashes).toEqual({ 'scripts/Player.ts': await sha256('export class Player {}') });
  });

  it('the revision holds the unchanged open scene at any path, every build input and the manifest', async () => {
    const h = await consumerHarness();

    const revision = await h.service.barrierRevision();

    expect(revision.problems).toEqual([]);
    expect(revision.loaded).toEqual({
      ...Object.fromEntries(h.recorded),
      [h.scene]: await sha256(SCENE_V1),
      'pix3project.yaml': await sha256('version: 1.0.0\n'),
    });
    expect(h.reloaded).toEqual([]);
    expect(h.manifest.reloadProjectManifest).not.toHaveBeenCalled();
  });

  it('an open scene with no recorded version is re-read and included', async () => {
    const h = await consumerHarness();
    h.diskState.forget(h.scene);

    const revision = await h.service.barrierRevision();

    expect(h.reloaded).toEqual([h.scene]);
    expect(revision.loaded[h.scene]).toBe(await sha256(SCENE_V1));
    expect(revision.problems).toEqual([]);
  });

  it('re-reads pix3project.yaml when the disk holds another version', async () => {
    const h = await consumerHarness();
    h.storage.files.set('pix3project.yaml', 'version: 1.0.0\nprojectType: 3d\n');

    const revision = await h.service.barrierRevision();

    expect(h.manifest.reloadProjectManifest).toHaveBeenCalledTimes(1);
    expect(revision.loaded['pix3project.yaml']).toBe(
      await sha256('version: 1.0.0\nprojectType: 3d\n')
    );
  });

  it('reports no project instead of an empty revision', async () => {
    const h = createHarness();
    appState.project.status = 'idle';
    const revision = await h.service.barrierRevision();
    expect(revision.loaded).toEqual({});
    expect(revision.problems).toEqual([
      { file: null, message: expect.stringContaining('No project') },
    ]);
  });

  it('workspace: judges the build against the manifest hashes, no file reads', async () => {
    const h = await consumerHarness();
    h.storage.backend = 'workspace';
    for (const [path, text] of Object.entries(h.sources)) {
      h.storage.manifestHashes.set(path, await sha256(text));
    }
    h.storage.manifestHashes.set('pix3project.yaml', await sha256('version: 1.0.0\n'));
    h.storage.manifestHashes.set(h.scene, await sha256(SCENE_V1));
    h.storage.reads.length = 0;

    await h.service.barrierRevision();
    expect(h.loader.syncAndBuild).not.toHaveBeenCalled();
    // Everything is answered from the manifest and the hashes recorded at build/load time.
    expect(h.storage.reads).toEqual([]);

    // A bundled module outside the script directories changed on disk: rebuild before answering.
    h.storage.files.set('src/world/Chunk.ts', 'export class Chunk { size = 16 }');
    h.storage.manifestHashes.set(
      'src/world/Chunk.ts',
      await sha256('export class Chunk { size = 16 }')
    );
    await h.service.barrierRevision();
    expect(h.loader.syncAndBuild).toHaveBeenCalledWith({ force: true });
  });
});
