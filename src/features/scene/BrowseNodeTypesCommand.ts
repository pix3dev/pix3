import { inject } from '@/fw/di';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { NodeRegistry } from '@/services/scene/NodeRegistry';
import { NodeTypePickerService } from '@/services/editor/NodeTypePickerService';

/**
 * Searchable picker over every registered node type, then creates the chosen one.
 *
 * The Create menu lists node types in groups, which is fast once you know the name but useless
 * when you don't — so the searchable picker keeps a home at the bottom of that menu (and, being a
 * command, in the palette too). The actual creation goes through the type's own Create command
 * from `NodeRegistry`, so undo/redo behave exactly as they do for the menu rows above it.
 */
export class BrowseNodeTypesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.browse-node-types',
    title: 'Browse All Nodes…',
    description: 'Search every node type and create the one you pick',
    menuPath: 'create',
    addToMenu: true,
    menuOrder: 900,
    keywords: ['create', 'node', 'browse', 'search', 'picker', 'all', 'type'],
  };

  @inject(NodeTypePickerService)
  private readonly nodeTypePickerService!: NodeTypePickerService;

  @inject(NodeRegistry)
  private readonly nodeRegistry!: NodeRegistry;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  async execute(): Promise<CommandExecutionResult<void>> {
    const nodeTypeId = await this.nodeTypePickerService.showPicker();
    if (!nodeTypeId) {
      return { didMutate: false, payload: undefined };
    }

    const command = this.nodeRegistry.createCommand(nodeTypeId);
    if (!command) {
      console.error('[BrowseNodeTypesCommand] Unknown node type:', nodeTypeId);
      return { didMutate: false, payload: undefined };
    }

    // The picked type's own command owns the mutation and its undo entry, so this one reports no
    // mutation of its own — otherwise the history would show two steps for one creation.
    await this.commandDispatcher.execute(command);
    return { didMutate: false, payload: undefined };
  }
}
