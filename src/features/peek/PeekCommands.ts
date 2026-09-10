import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { PeekService } from '@/services/viewport/PeekService';

import { SetPeekVisibilityOperation, type PeekAction } from './SetPeekVisibilityOperation';

/**
 * Shared body for the four Peek commands.
 *
 * `operations.invoke` (not `invokeAndPush`) is the deliberate choice — see
 * {@link SetPeekVisibilityOperation} for why the mask stays out of undo.
 */
abstract class PeekCommandBase extends CommandBase<void, void> {
  protected abstract readonly action: PeekAction;

  constructor(private readonly nodeIds: readonly string[] = []) {
    super();
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const result = await operations.invoke(
      new SetPeekVisibilityOperation({ action: this.action, nodeIds: this.nodeIds })
    );
    return { didMutate: result.didMutate, payload: undefined };
  }
}

export class PeekHideCommand extends PeekCommandBase {
  protected readonly action = 'hide' as const;

  readonly metadata: CommandMetadata = {
    id: 'viewport.peek-hide',
    title: 'Peek: Hide Branch',
    description: 'Hide a branch in this editor session only — the scene file is not touched',
    keywords: ['peek', 'hide', 'visibility', 'branch'],
  };
}

export class PeekShowCommand extends PeekCommandBase {
  protected readonly action = 'show' as const;

  readonly metadata: CommandMetadata = {
    id: 'viewport.peek-show',
    title: 'Peek: Reveal Branch',
    description: 'Reveal a branch this session had Peek-hidden',
    keywords: ['peek', 'show', 'reveal', 'visibility', 'branch'],
  };
}

export class PeekSoloCommand extends PeekCommandBase {
  protected readonly action = 'solo' as const;

  readonly metadata: CommandMetadata = {
    id: 'viewport.peek-solo',
    title: 'Peek: Solo Branch',
    description: 'Fade every other branch back so one is easy to look at',
    keywords: ['peek', 'solo', 'isolate', 'visibility', 'branch'],
  };
}

/**
 * The exit. In the menu (unlike the other three, which need a branch to act on and are driven from
 * the strip) so a session that got itself into a masked state can always get out — the "stuck in
 * isolation mode" complaint Illustrator answered with a breadcrumb.
 */
export class PeekShowAllCommand extends PeekCommandBase {
  protected readonly action = 'show_all' as const;

  readonly metadata: CommandMetadata = {
    id: 'viewport.peek-show-all',
    title: 'Peek: Show All',
    description: 'Clear this session’s Peek mask — reveal every branch again',
    keywords: ['peek', 'show all', 'reveal', 'visibility', 'unhide'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 23,
  };

  preconditions(context: CommandContext) {
    const peek = context.container.getService<PeekService>(
      context.container.getOrCreateToken(PeekService)
    );
    const snapshot = peek.getSnapshot();
    return { canExecute: snapshot.hiddenCount > 0 || snapshot.soloActive };
  }
}
