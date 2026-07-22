import { inject } from '@/fw/di';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

/**
 * Opens the Sprite Editor as an empty editor tab (main-menu entry point). The Sprite Editor is where
 * images are edited (crop, background removal, rotate/flip, resize) and AI-generated. Opening an
 * editor is not an undoable state change, so this returns `didMutate: false` and never creates an
 * Operation.
 */
export class OpenSpriteEditorCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-sprite-editor',
    title: 'Sprite Editor',
    description: 'Open the sprite editor to edit or generate images',
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 10,
    // Keep legacy "asset generator" terms so command-palette muscle memory keeps working.
    keywords: [
      'sprite',
      'sprite editor',
      'image',
      'edit',
      'ai',
      'generate',
      'asset generator',
      'asset',
      'texture',
      'nano banana',
      'background removal',
    ],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.editorTabService.focusOrOpenSpriteEditor();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
