import { SceneManager } from '@pix3/runtime';
import {
  NON_HUMAN_OPERATION_TAG,
  type Operation,
  type OperationContext,
  type OperationInvokeResult,
  type OperationMetadata,
} from '@/core/Operation';
import { ProtectedSetService } from '@/services/project/coauthoring/ProtectedSetService';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { recordHumanOperation } from '@/services/project/external-merge/protected-set';
import {
  diffSceneDocuments,
  toMergeDoc,
} from '@/services/project/external-merge/human-operation-diff';
import { installSceneGraph } from '@/features/scene/scene-graph-swap';

export interface RestoreRecoveryVersionOperationParams {
  readonly sceneId: string;
  /** `res://` path of the scene. */
  readonly filePath: string;
  /** The journal version's content (`RecoveryJournalService.readVersion`). */
  readonly content: string;
  /** For the history label, e.g. the version's time. */
  readonly label?: string;
}

/**
 * "Restore my version before the agent's changes" — plan §5 C3: the linear Ctrl+Z that a reload
 * from disk cleared is replaced by the recovery journal, and restoring a journal version is itself
 * an ordinary undoable operation.
 *
 * Restoring is a human decision about every value it changes, so the difference between the
 * current graph and the restored version is recorded into `P` as ONE human operation (one gen):
 * an agent that keeps writing its stale file cannot silently take the restored values back.
 * Undo swaps the previous graph instance back and restores the previous `P`; redo the reverse.
 * The scene is left dirty — autosave writes it (through the pre-write check).
 */
export class RestoreRecoveryVersionOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.restore-recovery-version',
    title: 'Restore My Version',
    description: 'Restore a version of the scene from the recovery journal',
    affectsNodeStructure: true,
    // Recorded into P explicitly below; the diff-based recorder must not see it as well.
    tags: [NON_HUMAN_OPERATION_TAG],
  };

  constructor(private readonly params: RestoreRecoveryVersionOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const { sceneId, filePath, content } = this.params;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const protectedSets = container.getService<ProtectedSetService>(
      container.getOrCreateToken(ProtectedSetService)
    );
    const before = sceneManager.getSceneGraph(sceneId);
    if (!before) throw new Error(`Scene graph not found: ${sceneId}`);
    const path = toProjectPath(filePath);

    const after = await sceneManager.parseScene(content, { filePath });
    const ops = diffSceneDocuments(
      toMergeDoc(sceneManager.serializeSceneDocument(before)),
      toMergeDoc(sceneManager.serializeSceneDocument(after))
    );
    if (ops.length === 0) {
      return { didMutate: false };
    }
    const setBefore = protectedSets.get(path);
    const setAfter = recordHumanOperation(setBefore, ops);

    const apply = (graph: typeof before, set: typeof setBefore) => {
      installSceneGraph(state, sceneManager, sceneId, graph);
      protectedSets.set(path, set);
    };
    apply(after, setAfter);

    return {
      didMutate: true,
      commit: {
        label: this.params.label ? `Restore version: ${this.params.label}` : 'Restore my version',
        beforeSnapshot: context.snapshot,
        undo: () => apply(before, setBefore),
        redo: () => apply(after, setAfter),
      },
    };
  }
}
