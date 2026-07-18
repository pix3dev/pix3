import { inject } from '@/fw/di';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';
import { LayoutManagerService } from '@/core/LayoutManager';
import { LoggingService } from '@/services/LoggingService';
import { ProjectDiagnosticsService } from '@/services/ProjectDiagnosticsService';

/**
 * Type-checks every project script and reports the results — with
 * `file:line:column` — in the Logs panel, then brings that panel to the front.
 * Surfaces type errors (e.g. assigning to the read-only `position`) that esbuild
 * never reports and that Monaco otherwise only shows for the open file.
 */
export class CheckScriptsCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scripts.check',
    title: 'Check Scripts for Errors',
    description:
      'Type-check all project scripts and list any errors (with file and line) in the Logs panel',
    keywords: ['script', 'check', 'type', 'error', 'diagnostics', 'lint', 'problems'],
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 110,
  };

  @inject(ProjectDiagnosticsService)
  private readonly diagnostics!: ProjectDiagnosticsService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  async execute(): Promise<CommandExecutionResult<void>> {
    // The Logs panel is where results land — reveal it first so the user sees
    // the "Checking…" line and the results as they arrive (Monaco may need to
    // load on the first run).
    this.layoutManager.focusPanel('logs');
    this.logger.info('Checking project scripts for errors…');
    await this.diagnostics.checkProject();

    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
