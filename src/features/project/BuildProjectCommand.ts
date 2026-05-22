import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { ProjectBuildService } from '@/services/ProjectBuildService';
import { DialogService } from '@/services/DialogService';
import { LoggingService } from '@/services/LoggingService';

export class BuildProjectCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.build-runtime',
    title: 'Build Runtime Project',
    description: 'Generate a runnable pix3-runtime project in the opened workspace',
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 200,
    keywords: ['build', 'runtime', 'export', 'project'],
  };

  @inject(ProjectBuildService)
  private readonly projectBuildService!: ProjectBuildService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened',
        scope: 'project',
      };
    }

    const hasScenes = Object.keys(context.state.scenes.descriptors).length > 0;
    if (!hasScenes) {
      return {
        canExecute: false,
        reason: 'At least one loaded scene is required',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const startTime = Date.now();
    const projectName = context.state.project.projectName ?? 'Project';

    this.loggingService.info(`[Runtime Build] Starting build for "${projectName}"`);
    this.loggingService.info(`[Runtime Build] Project status: ${context.state.project.status}`);
    const sceneCount = Object.keys(context.state.scenes.descriptors).length;
    this.loggingService.info(`[Runtime Build] Scenes to export: ${sceneCount}`);

    try {
      this.loggingService.debug('[Runtime Build] Invoking build service');
      const result = await this.projectBuildService.buildFromTemplates(context);

      const elapsedMs = Date.now() - startTime;

      this.loggingService.info('[Runtime Build] ✓ Scaffolding generated successfully');
      this.loggingService.info(`[Runtime Build] Build Statistics:`, {
        writtenFiles: result.writtenFiles,
        createdDirectories: result.createdDirectories,
        scenes: result.sceneCount,
        assets: result.assetCount,
        packageJsonUpdated: result.packageJsonUpdated,
        durationMs: elapsedMs,
      });
      this.loggingService.info(
        `[Runtime Build] Generated ${result.writtenFiles} file(s) in ${result.createdDirectories} directory(ies)`
      );
      this.loggingService.info(`[Runtime Build] Completed in ${(elapsedMs / 1000).toFixed(2)}s`);
      this.loggingService.info(
        `[Runtime Build] Next: Run 'yalc add @pix3/runtime', then 'npm install', then 'npm run dev' or 'npm run build' in the generated project`
      );

      await this.dialogService.showConfirmation({
        title: 'Runtime Project Ready',
        message:
          `✓ Generated ${result.writtenFiles} file(s) across ${result.createdDirectories} director(ies).\n` +
          `Scenes: ${result.sceneCount}, Assets: ${result.assetCount}.\n` +
          `Completed in ${(elapsedMs / 1000).toFixed(2)}s.\n\n` +
          'Next steps:\n1) yalc add @pix3/runtime\n2) npm install\n3) npm run dev (or npm run build)',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.loggingService.error('[Runtime Build] ✗ Build failed', error);
      this.loggingService.error(`[Runtime Build] Failed after ${(elapsedMs / 1000).toFixed(2)}s`);

      await this.dialogService.showConfirmation({
        title: 'Build Failed',
        message:
          `An error occurred while building the runtime project.\n\n` +
          `Check the Logs tab for details.\n\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });

      throw error;
    }

    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
