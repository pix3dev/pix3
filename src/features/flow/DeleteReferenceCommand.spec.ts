import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { createCommandContext, snapshotState } from '@/core/command';
import type { OperationCommit, OperationInvokeResult } from '@/core/Operation';
import { OperationService } from '@/services/core/OperationService';
import { DialogService } from '@/services/editor/DialogService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FLOW_REFERENCES_INDEX_PATH,
  FlowReferencesService,
} from '@/services/flow/FlowReferencesService';
import { DeleteReferenceCommand, UNDOABLE_REFERENCE_MAX_BYTES } from './DeleteReferenceCommand';
import { DeleteReferenceOperation } from './DeleteReferenceOperation';

/** Storage double holding one references folder, sized so the undo gate can be exercised. */
class StorageStub {
  readonly blobs = new Map<string, Blob>();
  readonly texts = new Map<string, string>();
  /** Reported size, so a "large" file can be declared without allocating megabytes. */
  size = 1024;

  listDirectory = vi.fn(async (path: string) => {
    const prefix = path === '.' ? '' : `${path}/`;
    return [...this.blobs.keys(), ...this.texts.keys()]
      .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map(file => ({
        name: file.slice(prefix.length),
        kind: 'file' as const,
        path: file,
        size: this.size,
      }));
  });

  readBlob = vi.fn(async (path: string) => {
    const blob = this.blobs.get(path);
    if (!blob) {
      throw new Error(`missing ${path}`);
    }
    return blob;
  });

  readTextFile = vi.fn(async (path: string) => {
    const text = this.texts.get(path);
    if (text === undefined) {
      throw new Error(`missing ${path}`);
    }
    return text;
  });

  writeTextFile = vi.fn(async (path: string, contents: string) => {
    this.texts.set(path, contents);
  });

  writeBinaryFile = vi.fn(async (path: string, data: ArrayBuffer) => {
    this.blobs.set(path, new Blob([data]));
  });

  deleteEntry = vi.fn(async (path: string) => {
    this.blobs.delete(path);
    this.texts.delete(path);
  });

  createDirectory = vi.fn(async () => undefined);
  getLastModified = vi.fn(async () => null);
}

class DialogStub {
  answer = true;
  showConfirmation = vi.fn(async () => this.answer);
}

/** Captures the commit instead of pushing it, so undo/redo can be driven directly. */
class OperationServiceStub {
  commit: OperationCommit | null = null;
  invokeAndPush = vi.fn(async (operation: { perform(context: unknown): unknown }) => {
    const result = (await operation.perform(
      createCommandContext(appState, snapshotState(appState), ServiceContainer.getInstance())
    )) as OperationInvokeResult;
    this.commit = result.commit ?? null;
    return result.didMutate && Boolean(result.commit);
  });
}

let storage: StorageStub;
let dialogs: DialogStub;
let operations: OperationServiceStub;

/**
 * Register a ready-made instance. The container only takes constructors, so each call wraps the
 * instance in a FRESH anonymous class — a new implementation is what makes `addService` drop the
 * cached singleton, which is how every test in this file gets its own stubs.
 */
const register = (type: Parameters<ServiceContainer['getOrCreateToken']>[0], instance: object) => {
  const container = ServiceContainer.getInstance();
  const wrapper = class {
    constructor() {
      return instance;
    }
  };
  container.addService(
    container.getOrCreateToken(type),
    wrapper as Parameters<ServiceContainer['addService']>[1],
    'singleton'
  );
};

beforeEach(() => {
  resetAppState();
  appState.project.status = 'ready';
  appState.project.id = 'project-1';
  storage = new StorageStub();
  dialogs = new DialogStub();
  operations = new OperationServiceStub();
  const references = new FlowReferencesService();
  Object.defineProperty(references, 'storage', { value: storage, configurable: true });
  register(ProjectStorageService, storage);
  register(DialogService, dialogs);
  register(OperationService, operations);
  register(FlowReferencesService, references);
});

afterEach(() => {
  resetAppState();
});

const context = () =>
  createCommandContext(appState, snapshotState(appState), ServiceContainer.getInstance());

describe('DeleteReferenceCommand', () => {
  it('refuses anything outside references/', async () => {
    const command = new DeleteReferenceCommand({ path: 'design/source/brief.md' });

    const result = await command.preconditions(context());

    expect(result.canExecute).toBe(false);
  });

  it('deletes the file and its index entry, and undo restores both', async () => {
    storage.blobs.set('references/mood-1.png', new Blob(['pixels']));
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({
        'mood-1.png': { origin: 'agent', role: 'style-candidate', caption: 'flat vector' },
        'keep.png': { origin: 'user' },
      })
    );

    const didMutate = await new DeleteReferenceCommand({
      path: 'references/mood-1.png',
    }).execute(context());

    expect(didMutate.didMutate).toBe(true);
    expect(storage.blobs.has('references/mood-1.png')).toBe(false);
    expect(JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}')).toEqual({
      'keep.png': { origin: 'user' },
    });
    // No dialog: a small file is undoable, so there is nothing to warn about.
    expect(dialogs.showConfirmation).not.toHaveBeenCalled();

    await operations.commit?.undo();

    expect(await (await storage.readBlob('references/mood-1.png')).text()).toBe('pixels');
    expect(JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}')).toEqual({
      'keep.png': { origin: 'user' },
      'mood-1.png': { origin: 'agent', role: 'style-candidate', caption: 'flat vector' },
    });
  });

  it('asks before a delete it cannot undo, and pushes no history entry for it', async () => {
    storage.blobs.set('references/huge.psd', new Blob(['x']));
    storage.size = UNDOABLE_REFERENCE_MAX_BYTES + 1;

    const result = await new DeleteReferenceCommand({ path: 'references/huge.psd' }).execute(
      context()
    );

    expect(dialogs.showConfirmation).toHaveBeenCalledTimes(1);
    expect(storage.blobs.has('references/huge.psd')).toBe(false);
    // The bytes were never read into a closure — that is the whole point of the gate.
    expect(storage.readBlob).not.toHaveBeenCalled();
    expect(operations.commit).toBeNull();
    // Reported as a mutation even though nothing was pushed: the file really is gone, and the
    // caller refreshes its list off this answer.
    expect(result.didMutate).toBe(true);
  });

  it('keeps the file when the warning is declined', async () => {
    storage.blobs.set('references/huge.psd', new Blob(['x']));
    storage.size = UNDOABLE_REFERENCE_MAX_BYTES + 1;
    dialogs.answer = false;

    const result = await new DeleteReferenceCommand({ path: 'references/huge.psd' }).execute(
      context()
    );

    expect(result.didMutate).toBe(false);
    expect(storage.blobs.has('references/huge.psd')).toBe(true);
    expect(operations.invokeAndPush).not.toHaveBeenCalled();
  });
});

describe('DeleteReferenceOperation', () => {
  it('reports no mutation when the file cannot be read', async () => {
    const result = await new DeleteReferenceOperation({
      path: 'references/gone.png',
      captureUndo: true,
    }).perform(context());

    expect(result.didMutate).toBe(false);
    expect(storage.deleteEntry).not.toHaveBeenCalled();
  });

  it('redo deletes again after an undo', async () => {
    storage.blobs.set('references/mood-1.png', new Blob(['pixels']));

    const result = await new DeleteReferenceOperation({
      path: 'references/mood-1.png',
      captureUndo: true,
    }).perform(context());
    await result.commit?.undo();
    await result.commit?.redo();

    expect(storage.blobs.has('references/mood-1.png')).toBe(false);
  });
});
