import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { DialogService } from '@/services/editor/DialogService';
import { AgentKitService } from '@/services/project/agent-kit/AgentKitService';

/**
 * File → Install Agent Kit…: the editor's `pix3 kit --update` for the open project (a local folder
 * or a `pix3 serve` workspace) — AGENTS.md, CLAUDE.md, `.claude/skills/pix3-*`, `.mcp.json` when a
 * published CLI version can be pinned, `.gitignore`, `metadata.agentKit` — then the "Continue in
 * your agent" screen. Same ownership rules as the CLI: a file edited since the kit wrote it, or a
 * project's own AGENTS.md / CLAUDE.md, is never overwritten. Writes project files, not an
 * undoable scene edit, so it asks first.
 */
export class InstallAgentKitCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.install-agent-kit',
    title: 'Install Agent Kit…',
    description:
      'Write the Pix3 agent kit (AGENTS.md, skills, MCP config) so Claude Code, Codex or another agent can work on this project',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 330,
    keywords: ['agent', 'kit', 'claude', 'codex', 'mcp', 'agents.md', 'external'],
  };

  @inject(AgentKitService)
  private readonly agentKitService!: AgentKitService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    const availability = this.agentKitService.availability(context.state.project);
    return availability.ok
      ? { canExecute: true }
      : { canExecute: false, reason: availability.reason, scope: 'project', recoverable: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Install Agent Kit',
      message:
        'Write the Pix3 agent kit into this project: AGENTS.md, CLAUDE.md, .claude/skills/pix3-*, ' +
        '.mcp.json and a .gitignore entry. Files you have edited, and an AGENTS.md or CLAUDE.md ' +
        'of your own, are never overwritten.',
      confirmLabel: 'Install',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) {
      return { didMutate: false, payload: undefined };
    }
    try {
      await this.agentKitService.installAndShow({ update: true });
    } catch (error) {
      await this.dialogService.showConfirmation({
        title: 'Agent Kit Not Written',
        message: error instanceof Error ? error.message : String(error),
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    }
    return { didMutate: false, payload: undefined };
  }
}
