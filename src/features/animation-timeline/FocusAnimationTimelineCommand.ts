import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * Brings the Animation timeline panel to the front of its dock stack.
 * Focusing a panel is not an undoable state change.
 */
export class FocusAnimationTimelineCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'animation-timeline.focus',
    title: 'Animation',
    description: 'Focus the keyframe animation timeline panel',
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 40,
    keywords: ['animation', 'timeline', 'keyframe', 'tween', 'panel'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.focusPanel('animation-timeline');
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
