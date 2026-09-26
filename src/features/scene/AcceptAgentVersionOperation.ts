import { stringify } from 'yaml';
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
import { acceptAgentVersion } from '@/services/project/external-merge/protected-set';
import {
  mergeExternalVersion,
  type MergeConflict,
} from '@/services/project/external-merge/merge-external-version';
import { parseSceneText } from '@/services/project/external-merge/scene-doc';
import { toMergeDoc } from '@/services/project/external-merge/human-operation-diff';
import { getEditorTypeResolver } from '@/services/project/external-merge/editor-type-resolver';
import { installSceneGraph } from '@/features/scene/scene-graph-swap';

export interface AcceptAgentVersionOperationParams {
  readonly sceneId: string;
  /** `res://` path of the scene. */
  readonly filePath: string;
  /** The agent's version `A` the conflicts came from (its text as read from disk). */
  readonly externalText: string;
  /** The conflicts to resolve in the agent's favour (one, or all of the banner's). */
  readonly conflicts: readonly MergeConflict[];
}

/**
 * "Accept agent's version" — plan §4.3, exit 1 from the protected set `P`, as an ordinary
 * undoable operation.
 *
 * `acceptAgentVersion(P, conflicts)` releases exactly the entries those conflicts reported (at the
 * generation they saw — an entry edited again since stays protected), and the scene becomes the
 * merge of the agent's version `A` against the RELEASED set: released values come from `A`, every
 * value still in `P` (other conflicts, edits made after the merge) stays the human's. Re-running
 * the merge instead of patching values one by one covers every conflict kind with one rule —
 * property, moved node, restored/resurrected node, deleted ancestor — through the same engine
 * that produced the conflict.
 *
 * The result is installed as a new graph instance; undo swaps the previous instance back (not
 * disposed) and restores the previous `P`, redo the reverse, so every other history entry keeps
 * pointing at live nodes. Not a human edit of those values: tagged non-human, nothing goes into
 * `P`. The scene is left dirty — autosave writes it.
 */
export class AcceptAgentVersionOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.accept-agent-version',
    title: "Accept Agent's Version",
    description: 'Take the external version of the conflicting properties',
    affectsNodeStructure: true,
    tags: [NON_HUMAN_OPERATION_TAG],
  };

  constructor(private readonly params: AcceptAgentVersionOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const { sceneId, filePath, externalText, conflicts } = this.params;
    if (conflicts.length === 0) return { didMutate: false };
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const protectedSets = container.getService<ProtectedSetService>(
      container.getOrCreateToken(ProtectedSetService)
    );
    const before = sceneManager.getSceneGraph(sceneId);
    if (!before) throw new Error(`Scene graph not found: ${sceneId}`);
    const path = toProjectPath(filePath);

    const setBefore = protectedSets.get(path);
    const setAfter = acceptAgentVersion(setBefore, conflicts);
    const result = mergeExternalVersion({
      editorVersion: toMergeDoc(sceneManager.serializeSceneDocument(before)),
      externalVersion: parseSceneText(externalText),
      protectedSet: setAfter,
      file: path,
      typeResolver: getEditorTypeResolver(),
    });
    if (!result.merged) {
      throw new Error(
        `The agent's version of ${path} cannot be applied: ${result.conflicts[0]?.message}`
      );
    }
    const after = await sceneManager.parseScene(stringify(result.merged), { filePath });

    const apply = (graph: typeof before, set: typeof setBefore) => {
      installSceneGraph(state, sceneManager, sceneId, graph);
      protectedSets.set(path, set);
    };
    apply(after, setAfter);

    return {
      didMutate: true,
      commit: {
        label: conflicts.length === 1 ? "Accept agent's value" : "Accept agent's version",
        beforeSnapshot: context.snapshot,
        undo: () => apply(before, setBefore),
        redo: () => apply(after, setAfter),
      },
    };
  }
}
