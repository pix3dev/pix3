import { injectable, inject } from '@/fw/di';
import { appState, getAppStateSnapshot } from '@/state';
import { ServiceContainer } from '@/fw/di';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import {
  createCommandContext,
  type Command,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';

const READ_ONLY_ALLOWED_COMMANDS = new Set([
  'scene.load',
  'scene.reload',
  'scene.select-object',
  'scene.open-prefab',
  'project.open-settings',
  'project.open-in-ide',
  'editor.open-settings',
  'game.open-popout',
  'history.undo',
  'history.redo',
]);

const READ_ONLY_ALLOWED_PREFIXES = ['viewport.', 'game.', 'editor.'];

/**
 * CommandDispatcher executes commands with proper lifecycle management.
 * It creates appropriate context, checks preconditions, and invokes command execution.
 */
@injectable()
export class CommandDispatcher {
  @inject(CommandRegistry)
  private readonly commandRegistry!: CommandRegistry;

  constructor() {}

  /**
   * Execute a command by its ID.
   * @param commandId The ID of the command to execute
   * @returns True if command executed successfully, false if not found or preconditions blocked it
   */
  async executeById(commandId: string): Promise<boolean> {
    const command = this.commandRegistry.getCommand(commandId);
    if (!command) {
      console.error(`[CommandDispatcher] Command not found: ${commandId}`);
      return false;
    }
    return this.execute(command);
  }

  /**
   * Execute a command. First checks preconditions, then invokes execute.
   * @param command The command to execute
   * @returns True if command executed successfully, false if preconditions blocked it
   */
  async execute<TExecutePayload = void, TUndoPayload = void>(
    command: Command<TExecutePayload, TUndoPayload>
  ): Promise<boolean> {
    const context = this.createContext();

    // Check preconditions
    const preconditionsResult = await this.checkPreconditions(command, context);
    if (!preconditionsResult.canExecute) {
      console.warn(
        `[CommandDispatcher] Command preconditions blocked: ${command.metadata.id}`,
        preconditionsResult
      );
      return false;
    }

    if (
      appState.collaboration.isReadOnly &&
      !READ_ONLY_ALLOWED_COMMANDS.has(command.metadata.id) &&
      !READ_ONLY_ALLOWED_PREFIXES.some(prefix => command.metadata.id.startsWith(prefix))
    ) {
      console.warn(`[CommandDispatcher] Read-only mode blocked command: ${command.metadata.id}`);
      return false;
    }

    // Execute command
    try {
      const result = await command.execute(context);
      return result.didMutate;
    } catch (error) {
      console.error(`[CommandDispatcher] Command execution failed: ${command.metadata.id}`, error);
      throw error;
    }
  }

  /**
   * Create a command context with current app state and service container.
   */
  private createContext(): CommandContext {
    return createCommandContext(appState, getAppStateSnapshot(), ServiceContainer.getInstance());
  }

  /**
   * Check if command preconditions are satisfied.
   */
  private async checkPreconditions(
    command: Command<unknown, unknown>,
    context: CommandContext
  ): Promise<CommandPreconditionResult> {
    if (!command.preconditions) {
      return { canExecute: true };
    }

    try {
      return await Promise.resolve(command.preconditions(context));
    } catch (error) {
      console.error(
        `[CommandDispatcher] Preconditions check failed: ${command.metadata.id}`,
        error
      );
      return { canExecute: false, reason: 'Preconditions check failed', scope: 'service' };
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}

export const resolveCommandDispatcher = (): CommandDispatcher => {
  return ServiceContainer.getInstance().getService(
    ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
  ) as CommandDispatcher;
};
