import { inject } from '@/fw/di';
import { EditorTabService } from '@/services/EditorTabService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

/**
 * Opens the AI Asset Generator as an empty editor tab (main-menu entry point). Opening an editor is
 * not an undoable state change, so this returns `didMutate: false` and never creates an Operation.
 */
export class OpenAssetGeneratorCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-asset-generator',
    title: 'Asset Generator',
    description: 'Open the AI asset generator to create or edit images',
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 10,
    keywords: ['ai', 'image', 'generate', 'asset', 'texture', 'nano banana', 'background removal'],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.editorTabService.focusOrOpenAssetGenerator();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
