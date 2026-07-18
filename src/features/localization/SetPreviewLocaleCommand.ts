import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { SetPreviewLocaleOperation } from './SetPreviewLocaleOperation';

export interface SetPreviewLocaleCommandParams {
  locale: string;
}

/** Change the editor preview locale (viewport shows that locale's translations). */
export class SetPreviewLocaleCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.set-preview-locale',
    title: 'Set Preview Locale',
    description: 'Change the locale previewed in the editor viewport',
    keywords: ['localization', 'locale', 'translation', 'preview', 'i18n'],
    addToMenu: false,
  };

  constructor(private readonly params: SetPreviewLocaleCommandParams) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.params.locale) {
      return { canExecute: false, reason: 'A locale id is required' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new SetPreviewLocaleOperation({ locale: this.params.locale })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
