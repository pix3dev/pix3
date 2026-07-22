import { ServiceContainer, injectable } from '@/fw/di';
import {
  HistoryManager,
  type HistoryEntry,
  type HistoryEntryInit,
  type HistoryEntryMetadata,
  type HistorySnapshot,
} from '@/core/HistoryManager';
import {
  createOperationContext,
  snapshotOperationState,
  type Operation,
  type OperationCommit,
  type OperationContext,
  type OperationInvokeOptions,
  type OperationInvokeResult,
  type OperationMetadata,
} from '@/core/Operation';
import { appState, type AppState, type AppStateSnapshot } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { LoggingService } from '@/services/core/LoggingService';
import { CollaborationService } from '@/services/collab/CollaborationService';

export type OperationEvent =
  | {
      readonly type: 'operation:invoked';
      readonly metadata: OperationMetadata;
      readonly timestamp: number;
    }
  | {
      readonly type: 'operation:completed';
      /** True when the operation changed local state. */
      readonly metadata: OperationMetadata;
      readonly didMutate: boolean;
      /** True when the mutation was committed through history and is safe to sync in collaboration. */
      readonly pushedToHistory: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: 'operation:failed';
      readonly metadata: OperationMetadata;
      readonly error: unknown;
      readonly timestamp: number;
    }
  | {
      readonly type: 'history:changed';
      readonly snapshot: HistorySnapshot;
      readonly timestamp: number;
    }
  | {
      readonly type: 'operation:undone';
      readonly entry: HistoryEntry;
      readonly timestamp: number;
    }
  | {
      readonly type: 'operation:redone';
      readonly entry: HistoryEntry;
      readonly timestamp: number;
    };

export type OperationEventListener = (event: OperationEvent) => void;

interface ExecutionResult {
  readonly context: OperationContext;
  readonly metadata: OperationMetadata;
  readonly result: OperationInvokeResult;
}

const READ_ONLY_ALLOWED_OPERATIONS = new Set([
  'scene.select-object',
  'viewport.toggle-grid',
  'viewport.toggle-layer-2d',
  'viewport.toggle-layer-3d',
  'viewport.toggle-lighting',
  'viewport.set-editor-camera-projection',
  'viewport.set-preview-camera',
  'viewport.toggle-ui-flag',
  'scripts.set-play-mode',
  'scripts.set-game-popout-window-open',
  'editor.update-settings',
]);

const NO_SCENE_HISTORY_KEY = '__none__';

@injectable()
export class OperationService {
  private readonly state: AppState;
  private readonly listeners = new Set<OperationEventListener>();
  private readonly logger: LoggingService;

  // Per-scene undo/redo: each scene (tab) keeps its own history stack so undo
  // never operates on another scene's (detached) nodes. `history` always resolves
  // to the active scene's stack; buckets for closed scenes are pruned.
  private readonly histories = new Map<string, HistoryManager>();
  private historyCapacity: number | undefined;
  private readonly seedHistory?: HistoryManager;
  private subscribedHistory: HistoryManager | null = null;
  private disposeHistorySubscription: () => void = () => {};
  private readonly disposeSceneWatch: () => void;

  constructor(historyManager?: HistoryManager, state: AppState = appState) {
    this.state = state;
    this.seedHistory = historyManager;
    this.logger = ServiceContainer.getInstance().getService<LoggingService>(
      ServiceContainer.getInstance().getOrCreateToken(LoggingService)
    );
    // Point the change-subscription at the initial active scene's history.
    this.repointHistory();
    // Follow the active scene: re-point history + drop stacks for closed scenes.
    this.disposeSceneWatch = subscribe(this.state.scenes, () => {
      this.repointHistory();
      this.pruneClosedScenes();
    });
  }

  /** Active scene's undo/redo stack (created on first access for that scene). */
  get history(): HistoryManager {
    const key = this.state.scenes.activeSceneId ?? NO_SCENE_HISTORY_KEY;
    let manager = this.histories.get(key);
    if (!manager) {
      // Reuse the injected/seed manager for the very first bucket so tests and
      // DI wiring that pass a specific HistoryManager keep working.
      manager =
        this.seedHistory && this.histories.size === 0
          ? this.seedHistory
          : new HistoryManager(
              this.historyCapacity != null ? { capacity: this.historyCapacity } : undefined
            );
      this.histories.set(key, manager);
    }
    return manager;
  }

  /** Ensure the history:changed subscription tracks the active scene's stack. */
  private repointHistory(): void {
    const manager = this.history;
    if (manager === this.subscribedHistory) {
      return;
    }
    this.disposeHistorySubscription();
    this.subscribedHistory = manager;
    this.disposeHistorySubscription = manager.subscribe(snapshot => {
      this.emit({
        type: 'history:changed',
        snapshot,
        timestamp: Date.now(),
      });
    });
  }

  /** Discard undo/redo stacks for scenes that are no longer open (frees the undo
   *  closures, which retain node subtrees). Never drops the active scene. */
  private pruneClosedScenes(): void {
    const activeKey = this.state.scenes.activeSceneId ?? NO_SCENE_HISTORY_KEY;
    for (const key of [...this.histories.keys()]) {
      if (key === activeKey) {
        continue;
      }
      if (key === NO_SCENE_HISTORY_KEY || !this.state.scenes.descriptors[key]) {
        this.histories.get(key)?.clear();
        this.histories.delete(key);
      }
    }
  }

  dispose(): void {
    this.disposeHistorySubscription();
    this.disposeSceneWatch?.();
    for (const manager of this.histories.values()) {
      manager.clear();
    }
    this.histories.clear();
    this.listeners.clear();
  }

  addListener(listener: OperationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async invoke<TInvokeResult extends OperationInvokeResult>(
    operation: Operation<TInvokeResult>,
    options: OperationInvokeOptions = {}
  ): Promise<TInvokeResult> {
    this.ensureWritable(operation.metadata.id);
    const execution = await this.executeOperation(operation, options);
    this.completeOperation(
      execution.metadata,
      execution.context.state,
      execution.result.didMutate,
      false
    );
    return execution.result as TInvokeResult;
  }

  async invokeAndPush<TInvokeResult extends OperationInvokeResult>(
    operation: Operation<TInvokeResult>,
    options: OperationInvokeOptions = {}
  ): Promise<boolean> {
    this.ensureWritable(operation.metadata.id);
    this.repointHistory();
    this.logger.debug('invokeAndPush: Starting operation', {
      operationId: operation.metadata.id,
      operationTitle: operation.metadata.title,
    });

    const execution = await this.executeOperation(operation, options);
    let pushed = false;
    try {
      if (execution.result.didMutate && execution.result.commit) {
        this.logger.debug('invokeAndPush: Operation mutated, pushing to history', {
          operationId: execution.metadata.id,
          commitLabel: execution.result.commit.label,
          coalesceKey: options.coalesceKey ?? execution.metadata.coalesceKey,
        });
        this.pushToHistory(execution.metadata, execution.result.commit, options);
        execution.context.state.operations.lastUndoableCommandId = execution.metadata.id;
        pushed = true;
        this.logger.debug('invokeAndPush: Successfully pushed to history', {
          operationId: execution.metadata.id,
          canUndo: this.history.canUndo,
          canRedo: this.history.canRedo,
        });
      } else {
        this.logger.debug('invokeAndPush: Operation did not mutate or has no commit', {
          operationId: execution.metadata.id,
          didMutate: execution.result.didMutate,
          hasCommit: !!execution.result.commit,
        });
      }
    } finally {
      this.completeOperation(
        execution.metadata,
        execution.context.state,
        execution.result.didMutate,
        pushed
      );
    }

    return pushed;
  }

  async undo(): Promise<boolean> {
    this.ensureWritable('history.undo');
    this.repointHistory();
    // Route through Y.UndoManager when collaboration is active
    const collabUndone = this.tryCollabUndo();
    if (collabUndone !== null) {
      return collabUndone;
    }

    if (!this.history.canUndo) {
      return false;
    }

    const snapshot = this.history.snapshot();
    const entry = snapshot.undoEntries[snapshot.undoEntries.length - 1];

    if (!entry) {
      return false;
    }

    this.state.operations.isExecuting = true;

    try {
      const undone = await this.history.undo();
      if (undone) {
        this.state.scenes.nodeDataChangeSignal = this.state.scenes.nodeDataChangeSignal + 1;
        this.emit({ type: 'operation:undone', entry, timestamp: Date.now() });
        const nextSnapshot = this.history.snapshot();
        const nextUndoEntry = nextSnapshot.undoEntries[nextSnapshot.undoEntries.length - 1] ?? null;
        this.state.operations.lastUndoableCommandId = nextUndoEntry?.metadata.commandId ?? null;
        this.state.operations.lastCommandId = entry.metadata.commandId ?? null;
      }
      return undone;
    } finally {
      this.state.operations.isExecuting = false;
    }
  }

  async redo(): Promise<boolean> {
    this.ensureWritable('history.redo');
    this.repointHistory();
    // Route through Y.UndoManager when collaboration is active
    const collabRedone = this.tryCollabRedo();
    if (collabRedone !== null) {
      return collabRedone;
    }

    if (!this.history.canRedo) {
      return false;
    }

    const snapshot = this.history.snapshot();
    const entry = snapshot.redoEntries[snapshot.redoEntries.length - 1];

    if (!entry) {
      return false;
    }

    this.state.operations.isExecuting = true;

    try {
      const redone = await this.history.redo();
      if (redone) {
        this.state.scenes.nodeDataChangeSignal = this.state.scenes.nodeDataChangeSignal + 1;
        this.emit({ type: 'operation:redone', entry, timestamp: Date.now() });
        const nextSnapshot = this.history.snapshot();
        const nextUndoEntry = nextSnapshot.undoEntries[nextSnapshot.undoEntries.length - 1] ?? null;
        this.state.operations.lastUndoableCommandId = nextUndoEntry?.metadata.commandId ?? null;
        this.state.operations.lastCommandId = entry.metadata.commandId ?? null;
      }
      return redone;
    } finally {
      this.state.operations.isExecuting = false;
    }
  }

  clearHistory(): void {
    this.history.clear();
    this.state.operations.lastUndoableCommandId = null;
  }

  setHistoryCapacity(capacity: number): void {
    this.historyCapacity = Math.max(1, capacity);
    for (const manager of this.histories.values()) {
      manager.setCapacity(capacity);
    }
  }

  /**
   * Try to undo via Y.UndoManager if collaboration is active.
   * Returns null if collab is not active (fallback to local history).
   */
  private tryCollabUndo(): boolean | null {
    try {
      const container = ServiceContainer.getInstance();
      const token = container.getOrCreateToken(CollaborationService);
      const collabService = container.getService<CollaborationService>(token);
      if (collabService?.isConnected()) {
        const um = collabService.getUndoManager();
        if (um && um.undoStack.length > 0) {
          um.undo();
          this.state.scenes.nodeDataChangeSignal++;
          return true;
        }
        return false;
      }
    } catch {
      // CollaborationService not registered, fall through to local history
    }
    return null;
  }

  /**
   * Try to redo via Y.UndoManager if collaboration is active.
   * Returns null if collab is not active (fallback to local history).
   */
  private tryCollabRedo(): boolean | null {
    try {
      const container = ServiceContainer.getInstance();
      const token = container.getOrCreateToken(CollaborationService);
      const collabService = container.getService<CollaborationService>(token);
      if (collabService?.isConnected()) {
        const um = collabService.getUndoManager();
        if (um && um.redoStack.length > 0) {
          um.redo();
          this.state.scenes.nodeDataChangeSignal++;
          return true;
        }
        return false;
      }
    } catch {
      // CollaborationService not registered, fall through to local history
    }
    return null;
  }

  private async executeOperation<TInvokeResult extends OperationInvokeResult>(
    operation: Operation<TInvokeResult>,
    options: OperationInvokeOptions
  ): Promise<ExecutionResult> {
    const context = this.resolveContext(options.context);
    const metadata = operation.metadata;
    this.beginOperation(metadata, context.state);

    try {
      const result = await operation.perform(context);
      const normalized = this.normalizeInvokeResult(result, options);
      return { context, metadata, result: normalized as OperationInvokeResult };
    } catch (error) {
      this.failOperation(metadata, context.state, error);
      throw error;
    }
  }

  private normalizeInvokeResult(
    result: OperationInvokeResult,
    options: OperationInvokeOptions
  ): OperationInvokeResult {
    if (!result.commit) {
      return result;
    }

    const label = options.label ?? result.commit.label;

    const normalizedCommit: OperationCommit = {
      ...result.commit,
      label: label ?? result.commit.label,
      beforeSnapshot: options.beforeSnapshot ?? result.commit.beforeSnapshot,
      afterSnapshot: options.afterSnapshot ?? result.commit.afterSnapshot,
    };

    return {
      ...result,
      commit: normalizedCommit,
    };
  }

  private pushToHistory(
    metadata: OperationMetadata,
    commit: OperationCommit,
    options: OperationInvokeOptions
  ): void {
    const label = commit.label ?? options.label ?? metadata.title;

    const entryMetadata: HistoryEntryMetadata = {
      commandId: metadata.id,
      label: label ?? metadata.title,
      description: metadata.description,
      coalesceKey: options.coalesceKey ?? metadata.coalesceKey,
      tags: metadata.tags,
    };

    const entryInit: HistoryEntryInit = {
      metadata: entryMetadata,
      undo: commit.undo,
      redo: commit.redo,
      beforeSnapshot: commit.beforeSnapshot,
      afterSnapshot: commit.afterSnapshot,
    };

    const coalesceKey = entryInit.metadata.coalesceKey;

    if (coalesceKey) {
      const currentUndoEntries = this.history.snapshot().undoEntries;
      const previous = currentUndoEntries[currentUndoEntries.length - 1];
      if (previous?.metadata.coalesceKey === coalesceKey) {
        this.logger.debug('pushToHistory: Coalescing operation with previous', {
          operationId: metadata.id,
          coalesceKey,
          previousCommandId: previous.metadata.commandId,
        });
        this.history.replaceLast(entryInit);
        return;
      }
    }

    this.logger.debug('pushToHistory: Pushing new history entry', {
      operationId: metadata.id,
      label: entryMetadata.label,
      coalesceKey,
      hasUndo: !!commit.undo,
      hasRedo: !!commit.redo,
    });

    this.history.push(entryInit);
  }

  private resolveContext(partial?: Partial<OperationContext>): OperationContext {
    if (!partial) {
      return createOperationContext(
        this.state,
        snapshotOperationState(this.state),
        ServiceContainer.getInstance()
      );
    }

    const state = (partial.state as AppState | undefined) ?? this.state;
    const snapshot: AppStateSnapshot =
      (partial.snapshot as AppStateSnapshot | undefined) ?? snapshotOperationState(state);
    const container = partial.container ?? ServiceContainer.getInstance();
    const requestedAt = partial.requestedAt ?? Date.now();

    return {
      state,
      snapshot,
      container,
      requestedAt,
    };
  }

  private beginOperation(metadata: OperationMetadata, state: AppState): void {
    this.logger.debug('beginOperation: Starting', {
      operationId: metadata.id,
      operationTitle: metadata.title,
      pendingCount: state.operations.pendingCommandCount + 1,
    });
    state.operations.pendingCommandCount = Math.max(0, state.operations.pendingCommandCount + 1);
    state.operations.isExecuting = true;
    state.operations.lastCommandId = metadata.id;
    this.emit({ type: 'operation:invoked', metadata, timestamp: Date.now() });
  }

  private completeOperation(
    metadata: OperationMetadata,
    state: AppState,
    didMutate: boolean,
    pushedToHistory: boolean
  ): void {
    this.logger.debug('completeOperation: Finishing', {
      operationId: metadata.id,
      operationTitle: metadata.title,
      didMutate,
      pushedToHistory,
      pendingCount: Math.max(0, state.operations.pendingCommandCount - 1),
    });
    state.operations.pendingCommandCount = Math.max(0, state.operations.pendingCommandCount - 1);
    state.operations.isExecuting = state.operations.pendingCommandCount > 0;
    if (didMutate) {
      state.operations.lastCommandId = metadata.id;
      state.scenes.nodeDataChangeSignal = state.scenes.nodeDataChangeSignal + 1;
    }
    if (pushedToHistory) {
      state.operations.lastUndoableCommandId = metadata.id;
    }
    this.emit({
      type: 'operation:completed',
      metadata,
      didMutate,
      pushedToHistory,
      timestamp: Date.now(),
    });
  }

  private failOperation(metadata: OperationMetadata, state: AppState, error: unknown): void {
    this.logger.error('failOperation: Operation failed', {
      operationId: metadata.id,
      operationTitle: metadata.title,
      error,
      pendingCount: Math.max(0, state.operations.pendingCommandCount - 1),
    });
    state.operations.pendingCommandCount = Math.max(0, state.operations.pendingCommandCount - 1);
    state.operations.isExecuting = state.operations.pendingCommandCount > 0;
    this.emit({ type: 'operation:failed', metadata, error, timestamp: Date.now() });
  }

  private emit(event: OperationEvent): void {
    if (!this.listeners.size) {
      return;
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private ensureWritable(actionId: string): void {
    if (!appState.collaboration.isReadOnly || READ_ONLY_ALLOWED_OPERATIONS.has(actionId)) {
      return;
    }

    throw new Error(`Read-only collaboration mode blocks "${actionId}".`);
  }
}
