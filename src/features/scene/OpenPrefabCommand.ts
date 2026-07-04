import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { EditorTabService } from '@/services/EditorTabService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { selectObject } from '@/features/selection/SelectObjectCommand';

export interface OpenPrefabCommandParams {
  /** res:// path to the prefab (.pix3scene) file to open in its own tab. */
  prefabPath: string;
  /**
   * Optional local id of a node inside the prefab to select once it is open.
   * Silently ignored if no matching node exists (e.g. the node lives in a
   * deeper nested instance whose ids are minted at instance time).
   */
  focusLocalId?: string;
}

/**
 * Opens a prefab's source `.pix3scene` file in its own scene tab so its structure
 * can be edited. This is not an undoable scene mutation (it only opens a tab), so
 * it is a plain command with no operation — mirroring LoadSceneCommand.
 */
export class OpenPrefabCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.open-prefab',
    title: 'Open Prefab',
    description: 'Open the source prefab of an instance in its own scene tab',
    keywords: ['prefab', 'open', 'edit', 'instance', 'source'],
  };

  private readonly params: OpenPrefabCommandParams;

  constructor(params: OpenPrefabCommandParams) {
    super();
    this.params = params;
  }

  preconditions(): CommandPreconditionResult {
    if (!this.params.prefabPath) {
      return { canExecute: false, reason: 'No prefab path provided', scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const editorTabService = context.container.getService<EditorTabService>(
      context.container.getOrCreateToken(EditorTabService)
    );

    await editorTabService.focusOrOpenScene(this.params.prefabPath);

    if (this.params.focusLocalId) {
      const sceneManager = context.container.getService<SceneManager>(
        context.container.getOrCreateToken(SceneManager)
      );
      // Use the scene that focusOrOpenScene just activated (tracked in appState).
      // The runtime SceneManager.activeSceneId only updates on a fresh load, not
      // when an already-open prefab tab is re-focused, so getActiveSceneGraph()
      // can lag and point at the wrong scene.
      const activeSceneId = context.state.scenes.activeSceneId;
      const sceneGraph = activeSceneId ? sceneManager.getSceneGraph(activeSceneId) : null;
      const node = sceneGraph?.nodeMap.get(this.params.focusLocalId);
      if (node) {
        const dispatcher = context.container.getService<CommandDispatcher>(
          context.container.getOrCreateToken(CommandDispatcher)
        );
        await dispatcher.execute(selectObject(node.nodeId));
      }
    }

    return { didMutate: false, payload: undefined };
  }
}
