import { inject } from '@/fw/di';
import { EditorTabService } from '@/services/EditorTabService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

/**
 * Opens the in-editor AI agent chat as an editor tab. Opening an editor is not an undoable state
 * change, so this returns `didMutate: false` and never creates an Operation.
 */
export class OpenAgentChatCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-agent-chat',
    title: 'Agent Chat',
    description: 'Open the AI agent chat to inspect and edit the project with natural language',
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 11,
    keybinding: 'Mod+Shift+A',
    keywords: ['ai', 'agent', 'chat', 'assistant', 'llm', 'copilot'],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.editorTabService.focusOrOpenAgentChat();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
