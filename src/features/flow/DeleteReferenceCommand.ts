import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { DialogService } from '@/services/editor/DialogService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { REFERENCES_DIR } from '@/services/flow/FlowReferencesService';
import { DeleteReferenceOperation } from './DeleteReferenceOperation';

export interface DeleteReferenceCommandParams {
  /** Project-relative path under `references/`. */
  readonly path: string;
}

/**
 * Biggest file whose bytes are kept in an undo closure. Above it the delete is still offered, but
 * only after the user is told it cannot be undone — holding tens of megabytes in the history stack
 * to make one deletion reversible trades a real memory cost for a rare convenience.
 */
export const UNDOABLE_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Delete one file from the idea-stage references column.
 *
 * Only `references/**` is deletable here: `design/source/**` is what the user attached to their
 * first prompt (the panel never writes there, so it never deletes there either), and the pinned
 * design document has no delete affordance at all.
 */
export class DeleteReferenceCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'flow.delete-reference',
    title: 'Delete Reference',
    description: 'Delete a file from the idea-stage references column',
    keywords: ['flow', 'reference', 'delete'],
  };

  constructor(private readonly params: DeleteReferenceCommandParams) {
    super();
  }

  async preconditions(context: CommandContext): Promise<CommandPreconditionResult> {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'A project must be open to delete a reference.',
        scope: 'project',
      };
    }
    if (!this.params.path.startsWith(`${REFERENCES_DIR}/`)) {
      return {
        canExecute: false,
        reason: `Only files under ${REFERENCES_DIR}/ can be deleted from the references column.`,
        scope: 'project',
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const sizeBytes = await readSizeBytes(storage, this.params.path);
    const captureUndo = sizeBytes === null || sizeBytes <= UNDOABLE_REFERENCE_MAX_BYTES;

    if (!captureUndo) {
      const dialogs = context.container.getService<DialogService>(
        context.container.getOrCreateToken(DialogService)
      );
      const confirmed = await dialogs.showConfirmation({
        title: 'Delete without undo?',
        message: `${this.params.path} is too large to keep in the undo history. Deleting it cannot be undone.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Keep it',
        isDangerous: true,
      });
      if (!confirmed) {
        return { didMutate: false, payload: undefined };
      }
    }

    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new DeleteReferenceOperation({ path: this.params.path, captureUndo })
    );
    // A non-undoable delete pushes nothing, so `pushed` is false while the file is gone. Report the
    // mutation from what was actually asked for, or the caller reads a successful delete as a no-op.
    return { didMutate: pushed || !captureUndo, payload: undefined };
  }
}

/** Byte size from the parent directory listing — cheaper than reading the file to measure it. */
const readSizeBytes = async (
  storage: ProjectStorageService,
  path: string
): Promise<number | null> => {
  const segments = path.split('/');
  const name = segments.pop() ?? path;
  try {
    const entries = await storage.listDirectory(segments.join('/') || '.');
    return entries.find(entry => entry.name === name)?.size ?? null;
  } catch {
    return null;
  }
};
