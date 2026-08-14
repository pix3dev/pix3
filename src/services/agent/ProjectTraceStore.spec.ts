import { describe, expect, it, vi } from 'vitest';
import {
  ProjectReportStore,
  ProjectRoutineStore,
  ProjectTraceStore,
  type TraceProjectStorage,
} from './ProjectTraceStore';
import { REPORT_DIRECTORY } from './game-run-protocol';
import { ROUTINE_DIRECTORY } from './game-routines';
import {
  serializeTrace,
  traceFilePath,
  TRACE_DIRECTORY,
  TRACE_FORMAT_VERSION,
  type GameInputTrace,
} from './game-traces';
import type { FileDescriptor } from '@/services/project/FileSystemAPIService';

/** A minimal in-memory stand-in for the project's file services. */
const makeStorage = (files: Record<string, string> = {}) => {
  const directories = new Set<string>();
  const storage = {
    files,
    directories,
    readTextFile: vi.fn(async (path: string) => {
      const text = files[path];
      if (text === undefined) {
        throw Object.assign(new Error(`Failed to read file at ${path}`), { code: 'not-found' });
      }
      return text;
    }),
    writeTextFile: vi.fn(async (path: string, contents: string) => {
      files[path] = contents;
    }),
    createDirectory: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    deleteEntry: vi.fn(async (path: string) => {
      if (files[path] === undefined) {
        throw Object.assign(new Error(`Failed to delete ${path}`), { code: 'not-found' });
      }
      delete files[path];
    }),
    listDirectory: vi.fn(async (path: string): Promise<FileDescriptor[]> => {
      // A directory nothing created does not exist — the case both stores must read as
      // "nothing stored yet" rather than as a failure.
      if (!directories.has(path)) {
        throw Object.assign(new Error(`Directory not found: ${path}`), { code: 'not-found' });
      }
      return Object.keys(files)
        .filter(file => file.startsWith(`${path}/`))
        .map(file => ({ name: file.slice(path.length + 1), kind: 'file' as const, path: file }));
    }),
  };
  return storage;
};

const makeTrace = (name = 'demo'): GameInputTrace => ({
  formatVersion: TRACE_FORMAT_VERSION,
  name,
  recordedAt: '2026-01-01T00:00:00.000Z',
  env: {
    seed: 7,
    fixedDeltaSec: 1 / 60,
    ticksPerFrame: 1,
    runtimeVersion: '1.0.0',
    viewport: { width: 800, height: 600 },
    sceneId: 'main',
  },
  events: [{ frame: 3, kind: 'key', phase: 'down', code: 'ArrowLeft' }],
  outcome: { kind: 'until', channel: 'until', index: 0, frame: 12, gameTimeMs: 200 },
  metrics: { frames: 12, gameTimeMs: 200, newErrors: 0 },
});

describe('ProjectTraceStore', () => {
  it('writes a trace to the normalized project path and reads it back', async () => {
    const storage = makeStorage();
    const store = new ProjectTraceStore(storage as unknown as TraceProjectStorage);
    const path = traceFilePath('snake eats');

    await store.save(path, makeTrace('snake eats'));

    expect(path).toBe(`${TRACE_DIRECTORY}/snake-eats.trace.json`);
    expect(Object.keys(storage.files)).toEqual([path]);
    // The parent directory is created first: writeTextFile does not make one, so
    // the first recording in a project without design/tests/ would fail.
    expect(storage.createDirectory).toHaveBeenCalledWith(TRACE_DIRECTORY);
    const loaded = await store.load(path);
    expect(loaded?.name).toBe('snake eats');
    expect(loaded?.events).toEqual([{ frame: 3, kind: 'key', phase: 'down', code: 'ArrowLeft' }]);
  });

  it('treats a missing trace as absent rather than as a failure', async () => {
    const store = new ProjectTraceStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.load(`${TRACE_DIRECTORY}/nope.trace.json`)).resolves.toBeNull();
  });

  it('reports a real read failure instead of swallowing it as "no trace"', async () => {
    const storage = makeStorage();
    storage.readTextFile.mockRejectedValueOnce(
      Object.assign(new Error('The user denied permission'), { code: 'permission-denied' })
    );
    const store = new ProjectTraceStore(storage as unknown as TraceProjectStorage);
    await expect(store.load(`${TRACE_DIRECTORY}/x.trace.json`)).rejects.toThrow(
      /Could not read trace .*denied permission/
    );
  });

  it('refuses a corrupt trace with an explanation instead of crashing', async () => {
    const path = `${TRACE_DIRECTORY}/broken.trace.json`;
    const store = new ProjectTraceStore(
      makeStorage({ [path]: '{ "formatVersion": 1, ' }) as unknown as TraceProjectStorage
    );
    await expect(store.load(path)).rejects.toThrow(/is unreadable: Not valid JSON/);
  });

  it('refuses a trace written by a newer format', async () => {
    const path = `${TRACE_DIRECTORY}/future.trace.json`;
    const future = { ...makeTrace(), formatVersion: TRACE_FORMAT_VERSION + 1 };
    const store = new ProjectTraceStore(
      makeStorage({ [path]: serializeTrace(future) }) as unknown as TraceProjectStorage
    );
    await expect(store.load(path)).rejects.toThrow(/format v2.*Re-record it/s);
  });

  it('lists the project traces and ignores everything else in the directory', async () => {
    const storage = makeStorage({
      [`${TRACE_DIRECTORY}/b.trace.json`]: serializeTrace(makeTrace('b')),
      [`${TRACE_DIRECTORY}/a.trace.json`]: serializeTrace(makeTrace('a')),
      [`${TRACE_DIRECTORY}/notes.md`]: '# not a trace',
    });
    storage.directories.add(TRACE_DIRECTORY);
    const store = new ProjectTraceStore(storage as unknown as TraceProjectStorage);
    await expect(store.list()).resolves.toEqual([
      `${TRACE_DIRECTORY}/a.trace.json`,
      `${TRACE_DIRECTORY}/b.trace.json`,
    ]);
  });

  it('lists nothing when the project has never recorded a trace', async () => {
    const store = new ProjectTraceStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.list()).resolves.toEqual([]);
  });
});

const ROUTINE_JSON = JSON.stringify({
  name: 'mute-music',
  description: 'Mute the music.',
  scope: 'scenes/menu.pix3scene',
  uses: ['music-toggle'],
  steps: [{ type: 'command', name: 'settings.toggle-music' }],
  expect: [{ kind: 'signal', name: 'toggled', node: 'music-toggle' }],
});

describe('ProjectRoutineStore', () => {
  it('reads a routine by bare name', async () => {
    const store = new ProjectRoutineStore(
      makeStorage({
        [`${ROUTINE_DIRECTORY}/mute-music.json`]: ROUTINE_JSON,
      }) as unknown as TraceProjectStorage
    );
    const routine = await store.load('mute-music');
    expect(routine?.name).toBe('mute-music');
    expect(routine?.expect).toHaveLength(1);
  });

  it('answers null for a routine that is not there, so the caller can list what is', async () => {
    const store = new ProjectRoutineStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.load('nope')).resolves.toBeNull();
  });

  it('refuses a routine it cannot understand instead of running half of it', async () => {
    const store = new ProjectRoutineStore(
      makeStorage({
        [`${ROUTINE_DIRECTORY}/broken.json`]: '{"name":"broken"}',
      }) as unknown as TraceProjectStorage
    );
    await expect(store.load('broken')).rejects.toThrow(/unreadable/);
  });

  it('loads the library and reports broken files without losing the good ones', async () => {
    const storage = makeStorage({
      [`${ROUTINE_DIRECTORY}/mute-music.json`]: ROUTINE_JSON,
      [`${ROUTINE_DIRECTORY}/broken.json`]: '{oops',
      [`${ROUTINE_DIRECTORY}/notes.md`]: '# not a routine',
    });
    storage.directories.add(ROUTINE_DIRECTORY);
    const store = new ProjectRoutineStore(storage as unknown as TraceProjectStorage);

    const { routines, broken } = await store.loadAll();
    expect(routines.map(routine => routine.name)).toEqual(['mute-music']);
    expect(broken).toEqual([
      {
        path: `${ROUTINE_DIRECTORY}/broken.json`,
        error: expect.stringContaining('not valid JSON'),
      },
    ]);
  });

  it('reads a project with no routines directory as an empty library', async () => {
    const store = new ProjectRoutineStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.loadAll()).resolves.toEqual({ routines: [], broken: [] });
  });
});

describe('ProjectReportStore', () => {
  it('writes under design/tests/reports/ and creates the directory first', async () => {
    const storage = makeStorage();
    const store = new ProjectReportStore(storage as unknown as TraceProjectStorage);

    await store.save('0001-run-pass-f5.json', '{"formatVersion":1}');

    expect(storage.createDirectory).toHaveBeenCalledWith(REPORT_DIRECTORY);
    expect(Object.keys(storage.files)).toEqual([`${REPORT_DIRECTORY}/0001-run-pass-f5.json`]);
  });

  it('lists NAMES only, and only the .json ones', async () => {
    // Names, not paths: both the counter in the next file name and the rotation plan
    // are computed from what this returns.
    const storage = makeStorage({
      [`${REPORT_DIRECTORY}/0002-monkey-fail-f9.json`]: '{}',
      [`${REPORT_DIRECTORY}/0001-run-pass-f5.json`]: '{}',
      [`${REPORT_DIRECTORY}/notes.md`]: '# not a report',
    });
    storage.directories.add(REPORT_DIRECTORY);
    const store = new ProjectReportStore(storage as unknown as TraceProjectStorage);

    await expect(store.list()).resolves.toEqual([
      '0001-run-pass-f5.json',
      '0002-monkey-fail-f9.json',
    ]);
  });

  it('reads a project whose first run is happening right now as an empty directory', async () => {
    const store = new ProjectReportStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('treats a report that is already gone as deleted, not as a failed rotation', async () => {
    // Rotation deletes by name from a listing that is milliseconds old; a concurrent
    // editor removing one first must not turn a successful save into a failed artifact.
    const store = new ProjectReportStore(makeStorage() as unknown as TraceProjectStorage);
    await expect(store.delete('0001-run-pass-f5.json')).resolves.toBeUndefined();
  });

  it('reports a real delete failure instead of swallowing it', async () => {
    const storage = makeStorage({ [`${REPORT_DIRECTORY}/0001-run-pass-f5.json`]: '{}' });
    storage.deleteEntry.mockRejectedValueOnce(
      Object.assign(new Error('The user denied permission'), { code: 'permission-denied' })
    );
    const store = new ProjectReportStore(storage as unknown as TraceProjectStorage);
    await expect(store.delete('0001-run-pass-f5.json')).rejects.toThrow(
      /Could not delete .*denied permission/
    );
  });
});
