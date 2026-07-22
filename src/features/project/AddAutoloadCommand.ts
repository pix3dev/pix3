import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { AddAutoloadOperation, type AddAutoloadParams } from './AddAutoloadOperation';

const SINGLETON_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class AddAutoloadCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.add-autoload',
    title: 'Add Autoload',
    description: 'Add an autoload singleton script',
    keywords: ['project', 'autoload', 'singleton'],
  };

  constructor(private readonly params: AddAutoloadParams) {
    super();
  }

  async preconditions(context: CommandContext): Promise<CommandPreconditionResult> {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened to manage autoloads.',
        scope: 'project',
      };
    }

    const singleton = this.params.singleton.trim();
    if (!SINGLETON_NAME_REGEX.test(singleton)) {
      return {
        canExecute: false,
        reason:
          'Singleton name must start with a letter/underscore and contain only letters, digits, underscores.',
        scope: 'project',
      };
    }

    const manifest = context.state.project.manifest;
    if (manifest?.autoloads.some(entry => entry.singleton === singleton)) {
      return {
        canExecute: false,
        reason: `Autoload singleton "${singleton}" already exists.`,
        scope: 'project',
      };
    }

    const scriptPath = this.params.scriptPath.trim();
    if (!scriptPath) {
      return {
        canExecute: false,
        reason: 'Script path is required.',
        scope: 'project',
      };
    }

    const fs = context.container.getService<FileSystemAPIService>(
      context.container.getOrCreateToken(FileSystemAPIService)
    );
    try {
      await fs.getFileHandle(scriptPath);
    } catch {
      return {
        canExecute: false,
        reason: `Script not found: ${scriptPath}`,
        scope: 'project',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new AddAutoloadOperation({
        scriptPath: this.params.scriptPath.trim(),
        singleton: this.params.singleton.trim(),
        enabled: this.params.enabled,
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
