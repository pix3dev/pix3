import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * Reveal the Generate panel (AI image generation: references, prompt, model and
 * history). Revealing a panel is not an undoable state change, so this returns
 * `didMutate: false` and never creates an Operation.
 *
 * Also the target of the Sprite Editor's `Generate…` toolbar action — §9.8's
 * mitigation for the prompt → result loop now spanning two docks.
 */
export class OpenGeneratePanelCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-generate-panel',
    title: 'Generate',
    description: 'Open the Generate panel to create images with AI',
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 51,
    keywords: ['generate', 'ai', 'image', 'sprite', 'prompt', 'texture', 'panel'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.revealGeneratePanel();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
