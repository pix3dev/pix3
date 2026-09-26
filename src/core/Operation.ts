import {
  createCommandContext,
  snapshotState,
  type CommandContext as CommandContextType,
} from '@/core/command';
import { ServiceContainer } from '@/fw/di';
import { appState, getAppStateSnapshot, type AppState, type AppStateSnapshot } from '@/state';

export type OperationContext = CommandContextType;

export interface OperationMetadata {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly affectsNodeStructure?: boolean;
  readonly tags?: readonly string[];
  readonly coalesceKey?: string;
}

export interface OperationCommit {
  readonly label?: string;
  readonly beforeSnapshot?: AppStateSnapshot;
  readonly afterSnapshot?: AppStateSnapshot;
  undo(): Promise<void> | void;
  redo(): Promise<void> | void;
}

export interface OperationInvokeResult {
  readonly didMutate: boolean;
  readonly commit?: OperationCommit;
}

/**
 * Who asked for an operation — read by the co-authoring recorder
 * (`src/services/project/coauthoring/ProtectedSetService.ts`): only `user` operations that reach
 * history are recorded as human edits into the protected set `P`. `external` = applying a version
 * that came from disk (reload / merge); `system` = editor machinery that is neither (restoring a
 * snapshot, bookkeeping). Omitted = `user`.
 */
export type OperationOrigin = 'user' | 'external' | 'system';

/**
 * Metadata tag of an operation that is never a human edit whatever its origin (e.g. a reload from
 * disk). Equivalent to invoking it with `origin: 'external'`.
 */
export const NON_HUMAN_OPERATION_TAG = 'non-human';

export interface OperationInvokeOptions {
  readonly context?: Partial<OperationContext>;
  /** See {@link OperationOrigin}; defaults to `user`. */
  readonly origin?: OperationOrigin;
  readonly label?: string;
  readonly coalesceKey?: string;
  readonly beforeSnapshot?: AppStateSnapshot;
  readonly afterSnapshot?: AppStateSnapshot;
}

export interface Operation<TInvokeResult extends OperationInvokeResult = OperationInvokeResult> {
  readonly metadata: OperationMetadata;
  perform(context: OperationContext): TInvokeResult | Promise<TInvokeResult>;
}

export abstract class OperationBase<
  TInvokeResult extends OperationInvokeResult = OperationInvokeResult,
> implements Operation<TInvokeResult>
{
  abstract readonly metadata: OperationMetadata;

  abstract perform(context: OperationContext): TInvokeResult | Promise<TInvokeResult>;
}

export const createOperationContext = (
  state: AppState = appState,
  snapshot: AppStateSnapshot = getAppStateSnapshot(),
  container: ServiceContainer = ServiceContainer.getInstance()
): OperationContext => createCommandContext(state, snapshot, container);

export const snapshotOperationState = (state: AppState): AppStateSnapshot => snapshotState(state);
