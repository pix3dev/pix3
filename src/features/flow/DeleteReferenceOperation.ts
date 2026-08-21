import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FlowReferencesService,
  type FlowReferenceIndexEntry,
} from '@/services/flow/FlowReferencesService';

export interface DeleteReferenceParams {
  /** Project-relative path of the file to delete, e.g. `references/mood-1.png`. */
  readonly path: string;
  /**
   * Whether the file's bytes are captured for undo. `false` is the honest degradation for a file
   * too large to hold in a closure — the command asked the user first (see
   * `DeleteReferenceCommand`), so this is a choice they made, not a silent loss.
   */
  readonly captureUndo: boolean;
}

/**
 * Delete one file from the references column, undoably.
 *
 * The undo closure holds the file's bytes plus its `references/index.json` entry, because both have
 * to come back: a restored picture with no index entry loses the role and the caption that said
 * what it was for. Hundreds of KB in a closure is a fair price for making a destructive button in
 * the UI reversible — which is the whole reason a user-facing delete goes through the
 * Command/Operation gateway while the agent's own `fs_delete` does not (design §3.6).
 *
 * When `captureUndo` is false the deletion happens with **no history entry at all**, rather than a
 * commit whose undo does nothing. A no-op entry would swallow the user's next Ctrl+Z and hide the
 * real undoable action behind it, which is a worse lie than having no entry — and the user has
 * already been told in as many words that this delete cannot be undone.
 */
export class DeleteReferenceOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'flow.delete-reference',
    title: 'Delete Reference',
    description: 'Delete a file from the idea-stage references column',
    tags: ['flow', 'references', 'project'],
  };

  constructor(private readonly params: DeleteReferenceParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const references = context.container.getService<FlowReferencesService>(
      context.container.getOrCreateToken(FlowReferencesService)
    );

    const path = this.params.path;
    const fileName = path.split('/').pop() ?? path;

    let bytes: ArrayBuffer | null = null;
    if (this.params.captureUndo) {
      try {
        bytes = await (await storage.readBlob(path)).arrayBuffer();
      } catch {
        // Nothing to delete (or nothing readable): report no mutation rather than delete blind,
        // since a delete we cannot undo is exactly what the size gate exists to make explicit.
        return { didMutate: false };
      }
    }

    // Read before deleting: the entry is the only record of the role and the caption.
    const entry = await references.readIndexEntry(fileName);

    const remove = async (): Promise<void> => {
      await storage.deleteEntry(path);
      await references.removeEntry(fileName);
    };

    await remove();

    if (!bytes) {
      return { didMutate: true };
    }

    const restoredBytes = bytes;
    const restoredEntry: FlowReferenceIndexEntry | null = entry;
    return {
      didMutate: true,
      commit: {
        label: `Delete ${fileName}`,
        undo: async () => {
          await storage.writeBinaryFile(path, restoredBytes);
          if (restoredEntry) {
            await references.upsert(fileName, restoredEntry);
          }
        },
        redo: async () => {
          await remove();
        },
      },
    };
  }
}
