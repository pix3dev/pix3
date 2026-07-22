import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { PublishToLibraryService } from '@/services/library/PublishToLibraryService';

export interface PublishToLibraryCommandParams {
  /** Node to publish; defaults to the primary selection. */
  nodeId?: string;
  /** Pre-supplied name/tags (e.g. from a dialog); prompted interactively when omitted. */
  name?: string;
  tags?: string[];
}

/**
 * Packs the selected node/prefab into the personal Asset Library. This does not mutate the
 * scene (`didMutate: false`) — it is a library-side operation, so it is not on the undo stack.
 * Dependency collection and file copying live in {@link PublishToLibraryService}.
 */
export class PublishToLibraryCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'library.publish-node',
    title: 'Publish to Library',
    description: 'Pack the selected node and its assets into your Asset Library',
    keywords: ['library', 'publish', 'prefab', 'reuse', 'save'],
    menuPath: 'edit',
    addToMenu: true,
    menuOrder: 90,
  };

  private readonly params: PublishToLibraryCommandParams;

  constructor(params: PublishToLibraryCommandParams = {}) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;
    if (!state.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    const nodeId = this.resolveNodeId(context);
    if (!nodeId) {
      return { canExecute: false, reason: 'Select a node to publish', scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const nodeId = this.resolveNodeId(context);
    if (!nodeId) {
      return { didMutate: false, payload: undefined };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const node = sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    const defaultName = node?.name ?? 'Library Item';

    const name =
      this.params.name ?? window.prompt('Publish to Library — item name:', defaultName)?.trim();
    if (!name) {
      return { didMutate: false, payload: undefined };
    }
    const tags =
      this.params.tags ??
      (window.prompt('Tags (comma-separated, optional):', '') ?? '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);

    const publisher = context.container.getService<PublishToLibraryService>(
      context.container.getOrCreateToken(PublishToLibraryService)
    );
    try {
      await publisher.publishNode({ nodeId, name, tags });
    } catch (error) {
      console.error('[PublishToLibraryCommand] Failed to publish item:', error);
    }
    return { didMutate: false, payload: undefined };
  }

  private resolveNodeId(context: CommandContext): string | undefined {
    return (
      this.params.nodeId ??
      context.state.selection.primaryNodeId ??
      context.state.selection.nodeIds[0]
    );
  }
}
