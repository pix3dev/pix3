import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { PublishToLibraryService } from '@/services/library/PublishToLibraryService';

export interface PublishToStoreCommandParams {
  /** Node to publish; defaults to the primary selection. */
  nodeId?: string;
  /** Pre-supplied name/tags (e.g. from a dialog); prompted interactively when omitted. */
  name?: string;
  tags?: string[];
  /** Store taxonomy path (`ui/buttons`); can be assigned later in the inspector. */
  categoryPath?: string;
}

/**
 * Packs the selected node into the curated Asset Store as a **draft** — publishing it is a
 * separate, gated step (name/category/license/preview/description/tags). Store writes are
 * admin-only and enforced by the server; the precondition just keeps the affordance out of a
 * normal user's way. Like {@link PublishToLibraryCommand} this does not touch the scene
 * (`didMutate: false`), so it stays off the undo stack — an upload is undone by deleting or
 * unlisting the item, not by rewinding editor history (plan §2.6).
 */
export class PublishToStoreCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'library.publish-node-to-store',
    title: 'Publish to Store…',
    description: 'Pack the selected node into the curated Pix3 Store as a draft item',
    keywords: ['library', 'store', 'publish', 'admin', 'prefab'],
    menuPath: 'edit',
    addToMenu: true,
    menuOrder: 91,
  };

  private readonly params: PublishToStoreCommandParams;

  constructor(params: PublishToStoreCommandParams = {}) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;
    if (!state.auth.user?.is_admin) {
      return { canExecute: false, reason: 'Store publishing is admin-only', scope: 'service' };
    }
    if (!state.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    if (!this.resolveNodeId(context)) {
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
    const defaultName = node?.name ?? 'Store Item';

    const name =
      this.params.name ?? window.prompt('Publish to Store — item name:', defaultName)?.trim();
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
      await publisher.publishNode({
        nodeId,
        name,
        tags,
        category: this.params.categoryPath,
        target: 'store',
      });
    } catch (error) {
      console.error('[PublishToStoreCommand] Failed to publish item:', error);
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
