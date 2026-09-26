/**
 * End-to-end harness of the co-authoring merge path for specs (never imported by editor code):
 * REAL scene loader/saver, REAL operations (property edit, delete, save, reload, accept, restore),
 * REAL protected-set recorder, journal, disk state, acks and merge log — over an in-memory project
 * folder that a fake "agent" writes to.
 */
import { vi } from 'vitest';
import {
  AssetLoader,
  AudioService,
  ResourceManager,
  SceneLoader,
  SceneManager,
  SceneSaver,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';
import { parse } from 'yaml';
import type {
  Operation,
  OperationCommit,
  OperationContext,
  OperationInvokeOptions,
  OperationInvokeResult,
} from '@/core/Operation';
import { NON_HUMAN_OPERATION_TAG } from '@/core/Operation';
import type { Command } from '@/core/command';
import { appState } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { ResourceManager as EditorResourceManager } from '@/services/assets/ResourceManager';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import { DeleteObjectOperation } from '@/features/scene/DeleteObjectOperation';
import {
  SaveSceneOperation,
  type SaveSceneOperationResult,
} from '@/features/scene/SaveSceneOperation';
import { SceneDiskStateService } from './SceneDiskStateService';
import { RecoveryJournalService } from './RecoveryJournalService';
import { ProtectedSetService } from './ProtectedSetService';
import { ExternalChangeService } from './ExternalChangeService';
import { ExternalMergeService } from './ExternalMergeService';
import { AckService } from './AckService';
import { MergeLogService, type MergeLogLine } from './MergeLogService';
import { MemoryRecoveryFallbackStore } from './recovery-fallback-store';
import { MemoryStorage, wire } from './memory-storage.spec-helper';
import { ACK_FILE, MERGE_LOG_FILE } from './coauthoring-paths';
import { readDiskVersion } from './disk-version';

export const SCENE_ID = 'scene-1';
export const SCENE_PATH = 'scenes/main.pix3scene';
export const SCENE_RES = `res://${SCENE_PATH}`;

/** The fixture as the agent writes it: `A.position` / `B.name` / `C` are parameters. */
export function agentScene(
  options: { ax?: number; ay?: number; bName?: string; withC?: boolean; dupId?: boolean } = {}
): string {
  const { ax = 10, ay = 20, bName = 'B', withC = true, dupId = false } = options;
  return `version: 1.0.0
root:
  - id: root2d
    type: Node2D
    name: Root
    children:
      - id: a
        type: ColorRect2D
        name: A
        properties:
          transform:
            position: [${ax}, ${ay}]
      - id: ${dupId ? 'a' : 'b'}
        type: Node2D
        name: ${bName}
${
  withC
    ? `      - id: c
        type: Node2D
        name: C
`
    : ''
}`;
}

class NoFilesResourceManager extends ResourceManager {
  constructor() {
    super('/');
  }
  override async readText(resource: string): Promise<string> {
    throw new Error(`no resource ${resource}`);
  }
}

export class HarnessStorage extends MemoryStorage {
  async getLastModified(): Promise<number | null> {
    return 1;
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** The OperationService surface the co-authoring code uses, with a real undo/redo stack. */
export class FakeOperations {
  readonly undoStack: OperationCommit[] = [];
  readonly redoStack: OperationCommit[] = [];
  readonly listeners = new Set<(event: OperationEvent) => void>();

  constructor(private readonly context: () => OperationContext) {}

  get history() {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  addListener(listener: (event: OperationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OperationEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private origin(op: Operation, options: OperationInvokeOptions) {
    return op.metadata.tags?.includes(NON_HUMAN_OPERATION_TAG)
      ? ('external' as const)
      : (options.origin ?? 'user');
  }

  async invoke<T extends OperationInvokeResult>(
    op: Operation<T>,
    options: OperationInvokeOptions = {}
  ): Promise<T> {
    this.emit({ type: 'operation:invoked', metadata: op.metadata, timestamp: 0 });
    const result = await op.perform(this.context());
    this.emit({
      type: 'operation:completed',
      metadata: op.metadata,
      didMutate: result.didMutate,
      pushedToHistory: false,
      origin: this.origin(op, options),
      timestamp: 0,
    });
    await settle();
    return result;
  }

  async invokeAndPush(op: Operation, options: OperationInvokeOptions = {}): Promise<boolean> {
    this.emit({ type: 'operation:invoked', metadata: op.metadata, timestamp: 0 });
    const result = await op.perform(this.context());
    const pushed = result.didMutate && result.commit !== undefined;
    if (pushed) {
      this.undoStack.push(result.commit!);
      this.redoStack.length = 0;
    }
    this.emit({
      type: 'operation:completed',
      metadata: op.metadata,
      didMutate: result.didMutate,
      pushedToHistory: pushed,
      origin: this.origin(op, options),
      timestamp: 0,
    });
    await settle();
    return pushed;
  }

  async undo(): Promise<boolean> {
    const commit = this.undoStack.pop();
    if (!commit) return false;
    await commit.undo();
    this.redoStack.push(commit);
    this.emit({ type: 'operation:undone', entry: {} as never, timestamp: 0 });
    await settle();
    return true;
  }

  async redo(): Promise<boolean> {
    const commit = this.redoStack.pop();
    if (!commit) return false;
    await commit.redo();
    this.undoStack.push(commit);
    this.emit({ type: 'operation:redone', entry: {} as never, timestamp: 0 });
    await settle();
    return true;
  }

  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

export interface MergeHarness {
  readonly storage: HarnessStorage;
  readonly sceneManager: SceneManager;
  readonly operations: FakeOperations;
  readonly diskState: SceneDiskStateService;
  readonly journal: RecoveryJournalService;
  readonly protectedSets: ProtectedSetService;
  readonly externalChanges: ExternalChangeService;
  readonly merge: ExternalMergeService;
  readonly acks: AckService;
  readonly mergeLog: MergeLogService;
  readonly logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  setOwner(owner: boolean): void;
  /** A human edit of A's position (through the real property operation, recorded into P). */
  humanMoveA(x: number, y?: number): Promise<void>;
  humanDelete(nodeId: string): Promise<void>;
  /** What autosave does: the real save operation, off history. */
  autosave(): Promise<SaveSceneOperationResult>;
  /** The fake agent writes `text` to the scene file (as raw bytes). */
  agentWrites(text: string | Uint8Array): void;
  /** Drive the real stabilisation window until the batch is delivered. */
  settleExternal(): Promise<void>;
  /** The live node's value. */
  positionOfA(): [number, number];
  nameOf(nodeId: string): string | null;
  has(nodeId: string): boolean;
  /** The scene file on disk, parsed. */
  diskDoc(): Record<string, unknown>;
  diskPositionOfA(): [number, number] | null;
  diskHash(): Promise<string>;
  mergeLines(): MergeLogLine[];
  ackFile(): { acks: Array<{ path: string; sha256: string; at: string }> } | null;
  dispatch(command: Command<unknown, unknown>): Promise<boolean>;
}

export interface HarnessOptions {
  /** Share a project folder with a previous harness (an editor restart). */
  readonly storage?: HarnessStorage;
  /** Initial disk content (default: {@link agentScene} defaults). */
  readonly initialText?: string;
}

export async function createMergeHarness(options: HarnessOptions = {}): Promise<MergeHarness> {
  appState.project.status = 'ready';
  appState.project.id = 'p1';
  appState.project.backend = 'local';

  const storage = options.storage ?? new HarnessStorage();
  if (!options.storage) {
    storage.files.set(SCENE_PATH, options.initialText ?? agentScene());
  }

  const resources = new NoFilesResourceManager();
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  const loader = new SceneLoader(
    new AssetLoader(resources, new AudioService()),
    registry,
    resources
  );
  const sceneManager = new SceneManager(loader, new SceneSaver());

  let owner = true;
  const ownership = { isOwner: () => owner, subscribe: () => () => undefined };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const diskState = new SceneDiskStateService();
  const journal = wire(new RecoveryJournalService(), { storage });
  journal.setFallbackStore(new MemoryRecoveryFallbackStore());
  let clock = Date.parse('2026-09-26T10:00:00Z');
  journal.setClock(() => (clock += 1000));
  const protectedSets = wire(new ProtectedSetService(), { storage, ownership });
  protectedSets.setSceneSource(sceneManager);
  const fileWatch = {
    setLastKnownHash: vi.fn(),
    setLastKnownModifiedTime: vi.fn(),
    isPushMode: () => false,
    watch: vi.fn(),
    unwatch: vi.fn(),
  };
  const acks = wire(new AckService(), { storage, ownership, fileWatch });
  const mergeLog = wire(new MergeLogService(), { storage, ownership });
  const viewport = new Proxy({}, { get: () => vi.fn() });
  const externalChanges = wire(new ExternalChangeService(), {
    storage,
    diskState,
    logger,
    journal: { reset: vi.fn() },
  });
  externalChanges.configureForTests({ stabilityIntervalMs: 1e9 });

  let operations: FakeOperations;
  const services = new Map<unknown, unknown>([
    [SceneManager, sceneManager],
    [ScriptRegistry, registry],
    [ViewportRendererService, viewport],
    [ProjectStorageService, storage],
    [LoggingService, logger],
    [FileWatchService, fileWatch],
    [SceneDiskStateService, diskState],
    [RecoveryJournalService, journal],
    [ProtectedSetService, protectedSets],
    [ExternalChangeService, externalChanges],
    [ResourceManager, resources],
    [EditorResourceManager, resources],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    hasService: (token: unknown) => services.has(token) || token === OperationService,
    getService: <T>(token: unknown): T => {
      if (token === OperationService) return operations as T;
      if (!services.has(token)) throw new Error(`Unexpected token ${String(token)}`);
      return services.get(token) as T;
    },
  };
  const context = (): OperationContext =>
    ({
      state: appState,
      snapshot: structuredClone({
        selection: { nodeIds: [], primaryNodeId: null },
        scenes: { activeSceneId: SCENE_ID, descriptors: {} },
      }),
      container: container as unknown as OperationContext['container'],
      requestedAt: Date.now(),
    }) as unknown as OperationContext;
  operations = new FakeOperations(context);
  operations.addListener(event => protectedSets.handleOperationEvent(event));

  const dispatch = async (command: Command<unknown, unknown>): Promise<boolean> => {
    const pre = await command.preconditions?.(context());
    if (pre && !pre.canExecute) return false;
    const result = await command.execute(context());
    return result.didMutate;
  };

  const merge = wire(new ExternalMergeService(), {
    storage,
    sceneManager,
    operations,
    dispatcher: { execute: dispatch },
    logger,
    ownership,
    protectedSets,
    diskState,
    journal,
    acks,
    mergeLog,
  });
  externalChanges.onExternalBatch(paths => merge.handleBatch(paths));

  // "LoadSceneCommand": raw bytes → graph; the bytes' hash and text are what the editor read.
  appState.scenes.activeSceneId = SCENE_ID;
  appState.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: SCENE_RES,
    name: 'Main',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
  await protectedSets.load();
  const loaded = (await readDiskVersion(storage, SCENE_PATH))!;
  const graph = await sceneManager.parseScene(loaded.text, { filePath: SCENE_RES });
  sceneManager.setActiveSceneGraph(SCENE_ID, graph);
  await diskState.recordRead(SCENE_PATH, loaded.bytes, loaded.text);

  const node = (id: string) => sceneManager.getSceneGraph(SCENE_ID)?.nodeMap.get(id) ?? null;
  const diskDoc = () => parse(storage.files.get(SCENE_PATH) ?? '') as Record<string, unknown>;

  return {
    storage,
    sceneManager,
    operations,
    diskState,
    journal,
    protectedSets,
    externalChanges,
    merge,
    acks,
    mergeLog,
    logger,
    setOwner: value => {
      owner = value;
      appState.project.coauthoring.isOwner = value;
    },
    humanMoveA: async (x, y = 20) => {
      await operations.invokeAndPush(
        new UpdateObjectPropertyOperation({
          nodeId: 'a',
          propertyPath: 'position',
          value: { x, y },
        })
      );
    },
    humanDelete: async nodeId => {
      await operations.invokeAndPush(new DeleteObjectOperation({ nodeIds: [nodeId] }));
    },
    autosave: () =>
      operations.invoke<SaveSceneOperationResult>(
        new SaveSceneOperation({ sceneId: SCENE_ID, quiet: true }),
        { origin: 'system' }
      ),
    agentWrites: text => {
      if (typeof text === 'string') {
        storage.files.set(SCENE_PATH, text);
        storage.bytes.delete(SCENE_PATH);
      } else {
        storage.setBytes(SCENE_PATH, text);
      }
    },
    settleExternal: async () => {
      externalChanges.report(SCENE_RES);
      for (let i = 0; i < 6 && externalChanges.isPending(SCENE_PATH); i++) {
        await externalChanges.tick();
      }
    },
    positionOfA: () => {
      const a = node('a') as unknown as { position: { x: number; y: number } };
      return [a.position.x, a.position.y];
    },
    nameOf: id => node(id)?.name ?? null,
    has: id => node(id) !== null,
    diskDoc,
    diskPositionOfA: () => {
      const root = (diskDoc().root as Array<{ children?: Array<Record<string, unknown>> }>)[0];
      const a = root.children?.find(c => c.id === 'a') as
        | { properties?: { transform?: { position?: [number, number] } } }
        | undefined;
      return a?.properties?.transform?.position ?? null;
    },
    diskHash: async () => (await readDiskVersion(storage, SCENE_PATH))!.hash,
    mergeLines: () =>
      (storage.files.get(MERGE_LOG_FILE) ?? '')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l) as MergeLogLine),
    ackFile: () => {
      const text = storage.files.get(ACK_FILE);
      return text
        ? (JSON.parse(text) as { acks: Array<{ path: string; sha256: string; at: string }> })
        : null;
    },
    dispatch,
  };
}
