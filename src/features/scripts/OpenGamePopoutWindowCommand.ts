import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';

export class OpenGamePopoutWindowCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.open-popout-window',
    title: 'Open Game Window',
    description: 'Open or focus the dedicated external game preview window',
    keywords: ['game', 'window', 'popout'],
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 105,
  };

  constructor(private readonly gamePlaySessionService: GamePlaySessionService) {
    super();
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    const wasOpen = this.gamePlaySessionService.isPopoutOpen();
    await this.gamePlaySessionService.openOrFocusPopoutWindow();

    return {
      didMutate: !wasOpen,
      payload: undefined,
    };
  }
}
