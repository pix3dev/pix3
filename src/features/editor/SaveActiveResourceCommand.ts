import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { EditorTabService } from '@/services/EditorTabService';

export class SaveActiveResourceCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.save-active-resource',
    title: 'Save',
    description: 'Save the active scene, animation, or code document',
    keywords: ['save', 'scene', 'animation', 'code', 'tab'],
    menuPath: 'file',
    keybinding: 'Mod+S',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 10,
  };

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;

    if (state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before saving resources',
        scope: 'project',
        recoverable: true,
      };
    }

    const activeTab = state.tabs.tabs.find(tab => tab.id === state.tabs.activeTabId);
    if (!activeTab) {
      return {
        canExecute: false,
        reason: 'An active scene, animation, or code tab is required to save',
        scope: 'service',
      };
    }

    if (
      state.project.backend === 'cloud' &&
      activeTab.type !== 'code' &&
      activeTab.type !== 'game'
    ) {
      return {
        canExecute: false,
        reason: 'Cloud scene and animation resources are synchronized automatically.',
        scope: 'external',
        recoverable: true,
      };
    }

    if (activeTab.type !== 'scene' && activeTab.type !== 'animation' && activeTab.type !== 'code') {
      return {
        canExecute: false,
        reason: 'The active tab does not support saving',
        scope: 'service',
        recoverable: true,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const editorTabService = context.container.getService<EditorTabService>(
      context.container.getOrCreateToken(EditorTabService)
    );
    await editorTabService.saveActiveTab();
    return { didMutate: true, payload: undefined };
  }
}
