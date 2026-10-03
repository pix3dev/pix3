import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { appState, getAppStateSnapshot, resetAppState } from '@/state';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SaveAsSceneOperation } from './SaveAsSceneOperation';

const SCENE_ID = 'scene-1';
const ORIGINAL_PATH = 'res://scenes/original.pix3scene';
const SAVED_PATH = 'res://scenes/saved.pix3scene';
const YAML = 'version: 1.0.0\nroot: []\n';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(destination: 'path' | 'project-handle' | 'external-handle') {
  const writeStarted = deferred();
  const finishWrite = deferred();
  const write = vi.fn(async () => {
    writeStarted.resolve();
    await finishWrite.promise;
  });
  const storage = { writeTextFile: write, getLastModified: vi.fn(async () => 123) };
  const writable = { write, close: vi.fn(async () => undefined) };
  const handle = {
    name: 'saved.pix3scene',
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => ({ lastModified: 123 })),
  } as unknown as FileSystemFileHandle;
  const services = new Map<unknown, unknown>([
    [SceneManager, { getSceneGraph: () => ({}), serializeScene: () => YAML }],
    [FileSystemAPIService, { resolveHandleToResourcePath: vi.fn(async () => SAVED_PATH) }],
    [ProjectStorageService, storage],
    [FileWatchService, { setLastKnownModifiedTime: vi.fn() }],
    [LoggingService, { info: vi.fn() }],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) throw new Error(`Unexpected token ${String(token)}`);
      return services.get(token) as T;
    },
  };
  appState.scenes.activeSceneId = SCENE_ID;
  appState.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: ORIGINAL_PATH,
    name: 'Original',
    version: '1.0.0',
    isDirty: true,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const save = () =>
    new SaveAsSceneOperation({
      filePath: SAVED_PATH,
      fileHandle: destination === 'path' ? undefined : handle,
      isHandleInProject: destination === 'project-handle',
    }).perform({
      state: appState,
      snapshot: getAppStateSnapshot(),
      container: container as unknown as OperationContext['container'],
      requestedAt: Date.now(),
    });

  return { save, write, writeStarted, finishWrite, handle, writable };
}

beforeEach(resetAppState);
afterEach(resetAppState);

describe('SaveAsSceneOperation', () => {
  describe.each(['path', 'project-handle'] as const)('saving through %s', destination => {
    it('clears dirty only once the unchanged scene has been written', async () => {
      const h = createHarness(destination);
      const saving = h.save();
      await h.writeStarted.promise;
      expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
      expect(appState.scenes.descriptors[SCENE_ID].filePath).toBe(ORIGINAL_PATH);

      h.finishWrite.resolve();
      const result = await saving;
      expect(result.didMutate).toBe(true);
      expect(appState.scenes.descriptors[SCENE_ID]).toMatchObject({
        filePath: SAVED_PATH,
        isDirty: false,
        lastSavedAt: expect.any(Number),
        lastModifiedTime: 123,
      });
      expect(h.write).toHaveBeenCalledWith(
        ...(destination === 'path' ? [SAVED_PATH, YAML] : [YAML])
      );
      if (destination === 'project-handle') {
        expect(appState.scenes.descriptors[SCENE_ID].fileHandle).toBe(h.handle);
        expect(h.writable.close).toHaveBeenCalledOnce();
      }

      await result.commit!.undo();
      expect(appState.scenes.descriptors[SCENE_ID].filePath).toBe(ORIGINAL_PATH);
      expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
      await result.commit!.redo();
      expect(appState.scenes.descriptors[SCENE_ID].filePath).toBe(SAVED_PATH);
      expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(false);
    });

    it('preserves edits made during the write, including when the save is redone', async () => {
      const h = createHarness(destination);
      const saving = h.save();
      await h.writeStarted.promise;
      // A completed editor operation changes the graph after serialization.
      appState.scenes.nodeDataChangeSignal += 1;
      appState.scenes.descriptors[SCENE_ID].isDirty = true;
      h.finishWrite.resolve();

      const result = await saving;
      expect(appState.scenes.descriptors[SCENE_ID].filePath).toBe(SAVED_PATH);
      expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
      expect(result.commit!.afterSnapshot!.scenes.descriptors[SCENE_ID].isDirty).toBe(true);

      await result.commit!.undo();
      await result.commit!.redo();
      expect(appState.scenes.descriptors[SCENE_ID].filePath).toBe(SAVED_PATH);
      expect(appState.scenes.descriptors[SCENE_ID].isDirty).toBe(true);
    });
  });

  it('leaves the project descriptor unchanged for an external export', async () => {
    const h = createHarness('external-handle');
    const before = getAppStateSnapshot().scenes.descriptors[SCENE_ID];
    const saving = h.save();
    await h.writeStarted.promise;
    h.finishWrite.resolve();
    await saving;

    expect(appState.scenes.descriptors[SCENE_ID]).toEqual(before);
    expect(h.write).toHaveBeenCalledWith(YAML);
    expect(h.writable.close).toHaveBeenCalledOnce();
  });
});
