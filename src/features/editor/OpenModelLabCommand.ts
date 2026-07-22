import { inject } from '@/fw/di';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

/**
 * Opens Model Lab as an editor tab (main-menu entry point). Model Lab is where 3D assets and
 * scenes are generated from references via the staged AI pipeline. Opening an editor is not an
 * undoable state change, so this returns `didMutate: false` and never creates an Operation.
 */
export class OpenModelLabCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-model-lab',
    title: 'Model Lab',
    description: 'Open Model Lab to generate 3D models and scenes',
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 11,
    keywords: [
      'model',
      'model lab',
      '3d',
      'glb',
      'gltf',
      'mesh',
      'generate',
      'scene',
      'level',
      'asset',
    ],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.editorTabService.focusOrOpenModelLab();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
