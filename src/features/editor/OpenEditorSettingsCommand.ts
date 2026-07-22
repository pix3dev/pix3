import { inject } from '@/fw/di';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

export class OpenEditorSettingsCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-settings',
    title: 'Editor Settings',
    description: 'Open the editor settings modal',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 95,
    keywords: ['editor', 'settings', 'preferences'],
  };

  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.editorSettingsService.showSettings();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
