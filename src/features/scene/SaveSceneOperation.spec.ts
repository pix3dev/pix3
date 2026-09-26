import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { appState, resetAppState } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { RecoveryJournalService } from '@/services/project/coauthoring/RecoveryJournalService';
import { ProtectedSetService } from '@/services/project/coauthoring/ProtectedSetService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';
import { MemoryRecoveryFallbackStore } from '@/services/project/coauthoring/recovery-fallback-store';
import { MemoryStorage, wire } from '@/services/project/coauthoring/memory-storage.spec-helper';
import { WorkspaceConflictError } from '@/services/project/workspace/workspace-protocol';
import { sha256 } from '@/services/project/external-merge/hash';
import { SaveSceneOperation } from './SaveSceneOperation';

const SCENE_ID = 'scene-1';
const PATH = 'scenes/main.pix3scene';

class SaveStorage extends MemoryStorage {
  async getLastModified(): Promise<number | null> {
    return 1;
  }
}

function createHarness() {
  let yaml = 'version: 1.0.0\nroot:\n  - id: n\n    name: Edited\n';
  const storage = new SaveStorage();
  const diskState = new SceneDiskStateService();
  const journal = wire(new RecoveryJournalService(), { storage });
  journal.setFallbackStore(new MemoryRecoveryFallbackStore());
  const protectedSets = new ProtectedSetService();
  const externalChanges = { report: vi.fn() };
  const fileWatch = { setLastKnownModifiedTime: vi.fn(), setLastKnownHash: vi.fn() };
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const graph = { rootNodes: [] };
  let onSerialize: () => void = () => undefined;
  const sceneManager = {
    getSceneGraph: () => graph,
    serializeScene: () => {
      onSerialize();
      return yaml;
    },
  };
  const services = new Map<unknown, unknown>([
    [SceneManager, sceneManager],
    [ProjectStorageService, storage],
    [LoggingService, logger],
    [FileWatchService, fileWatch],
    [SceneDiskStateService, diskState],
    [RecoveryJournalService, journal],
    [ProtectedSetService, protectedSets],
    [ExternalChangeService, externalChanges],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    hasService: (token: unknown) => services.has(token),
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) throw new Error(`Unexpected token ${String(token)}`);
      return services.get(token) as T;
    },
  };

  appState.project.id = 'p1';
  appState.scenes.activeSceneId = SCENE_ID;
  appState.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: `res://${PATH}`,
    name: 'Main',
    version: '1.0.0',
    isDirty: true,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
  const save = () =>
    new SaveSceneOperation({ sceneId: SCENE_ID, quiet: true }).perform({
      state: appState,
      snapshot: structuredClone({ scenes: { descriptors: {} } }),
      container: container as unknown as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext);

  return {
    storage,
    diskState,
    protectedSets,
    externalChanges,
    fileWatch,
    save,
    setYaml: (next: string) => {
      yaml = next;
    },
    onSerialize: (fn: () => void) => {
      onSerialize = fn;
    },
  };
}

beforeEach(() => {
  resetAppState();
});

describe('SaveSceneOperation — pre-write check and recovery journal', () => {
  it('writes when the disk still holds the version the editor read, journaling it first', async () => {
    const h = createHarness();
    const original = 'version: 1.0.0\nroot: []\n';
    h.storage.files.set(PATH, original);
    await h.diskState.recordRead(PATH, original);

    const result = await h.save();

    expect(result.outcome).toBe('saved');
    expect(h.storage.writes.map(w => w.path)).toEqual([
      expect.stringMatching(/^\.pix3\/recovery\/scenes%2Fmain\.pix3scene\//),
      PATH,
    ]);
    const hash = await sha256(h.storage.files.get(PATH)!);
    expect(h.diskState.getKnown(PATH)).toMatchObject({ hash, source: 'write', genAtWrite: 0 });
    expect(h.protectedSets.get(PATH).versions).toEqual([{ hash, genAtWrite: 0 }]);
    expect(h.fileWatch.setLastKnownHash).toHaveBeenCalledWith(`res://${PATH}`, hash);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
  });

  it('does not write over an external version: no write, path pending, typed outcome', async () => {
    const h = createHarness();
    await h.diskState.recordRead(PATH, 'version: 1.0.0\nroot: []\n');
    h.storage.files.set(PATH, 'version: 1.0.0\nroot: [] # the agent wrote this\n');

    const result = await h.save();

    expect(result).toEqual({ didMutate: false, outcome: 'external-change' });
    expect(h.storage.writes).toEqual([]);
    expect(h.storage.files.get(PATH)).toContain('the agent wrote this');
    expect(h.externalChanges.report).toHaveBeenCalledWith(PATH);
    expect(h.diskState.isPendingExternal(PATH)).toBe(true);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
  });

  it('maps a workspace If-Match refusal to the same outcome', async () => {
    const h = createHarness();
    h.storage.backend = 'workspace';
    await h.diskState.recordRead(PATH, 'old');
    h.storage.writeTextFile = vi.fn(async (path: string) => {
      if (path.endsWith(PATH)) throw new WorkspaceConflictError(PATH, 'a', 'b');
    });

    const result = await h.save();

    expect(result.outcome).toBe('external-change');
    expect(h.externalChanges.report).toHaveBeenCalledWith(PATH);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
  });

  it('skips the write when the bytes are already on disk', async () => {
    const h = createHarness();
    const same = 'version: 1.0.0\nroot:\n  - id: n\n    name: Edited\n';
    h.storage.files.set(PATH, same);
    await h.diskState.recordRead(PATH, same);

    const result = await h.save();
    expect(result.outcome).toBe('unchanged');
    expect(h.storage.writes).toEqual([]);
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
  });

  it('keeps the scene dirty when an edit lands while the write is in flight', async () => {
    const h = createHarness();
    h.onSerialize(() => {
      queueMicrotask(() => {
        appState.scenes.nodeDataChangeSignal += 1; // an operation completed meanwhile
      });
    });
    const result = await h.save();
    expect(result.outcome).toBe('saved');
    expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
  });
});
