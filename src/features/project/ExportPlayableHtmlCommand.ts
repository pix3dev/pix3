import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { DialogService } from '@/services/DialogService';
import { LoggingService } from '@/services/LoggingService';
import { PlayableExportDialogService } from '@/services/PlayableExportDialogService';
import { PlayableHtmlBuildService } from '@/services/PlayableHtmlBuildService';

type SaveFilePickerFn = (options?: unknown) => Promise<FileSystemFileHandle>;
type WindowWithSavePicker = Window & {
  showSaveFilePicker?: SaveFilePickerFn;
};

type HtmlDeliveryMethod = 'saved' | 'downloaded' | 'cancelled';

export class ExportPlayableHtmlCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.export-playable-html',
    title: 'Export Playable HTML',
    description: 'Build and download a standalone playable HTML file for the current project',
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 210,
    keywords: ['export', 'html', 'playable', 'build', 'project'],
  };

  @inject(PlayableHtmlBuildService)
  private readonly playableHtmlBuildService!: PlayableHtmlBuildService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(PlayableExportDialogService)
  private readonly playableExportDialogService!: PlayableExportDialogService;

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

    this.loggingService.info(`[Playable Export] Starting export for "${projectName}"`);

    try {
      const entryScenePath = await this.promptForEntryScenePath(context);
      if (!entryScenePath) {
        this.loggingService.info('[Playable Export] Export cancelled during scene selection');
        return { didMutate: false, payload: undefined };
      }

      const artifact = await this.playableHtmlBuildService.buildPlayableHtml(context, {
        title: projectName,
        entryScenePath,
      });
      const suggestedName = this.toSuggestedFileName(projectName);
      const deliveryMethod = await this.deliverHtmlArtifact(artifact.html, suggestedName);

      if (deliveryMethod === 'cancelled') {
        this.loggingService.info('[Playable Export] Export cancelled during file selection');
        return { didMutate: false, payload: undefined };
      }

      const elapsedMs = Date.now() - startTime;
      const allWarnings = [...artifact.warnings, ...artifact.bundleWarnings];
      for (const warning of allWarnings) {
        this.loggingService.warn(`[Playable Export] ${warning}`);
      }

      this.loggingService.info('[Playable Export] Export completed', {
        deliveryMethod,
        entryScenePath: artifact.entryScenePath,
        scenes: artifact.sceneCount,
        assets: artifact.assetCount,
        files: artifact.fileCount,
        warnings: allWarnings.length,
        durationMs: elapsedMs,
      });

      await this.dialogService.showConfirmation({
        title: 'Playable HTML Exported',
        message: this.buildSuccessMessage(artifact, deliveryMethod, elapsedMs),
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.loggingService.error('[Playable Export] Export failed', error);
      this.loggingService.error(`[Playable Export] Failed after ${(elapsedMs / 1000).toFixed(2)}s`);

      await this.dialogService.showConfirmation({
        title: 'Playable HTML Export Failed',
        message:
          `An error occurred while exporting the playable HTML bundle.\n\n` +
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

  private async promptForEntryScenePath(context: CommandContext): Promise<string | null> {
    const scenePaths = Object.values(context.state.scenes.descriptors)
      .map(descriptor => this.normalizeResourcePath(descriptor.filePath))
      .filter(path => path.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const uniqueScenePaths = Array.from(new Set(scenePaths));
    const initialSelection = this.resolveInitialSceneSelection(context, uniqueScenePaths);

    return await this.playableExportDialogService.showDialog({
      scenePaths: uniqueScenePaths,
      selectedScenePath: initialSelection,
    });
  }

  private async deliverHtmlArtifact(
    html: string,
    suggestedName: string
  ): Promise<HtmlDeliveryMethod> {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;

    if (savePicker) {
      try {
        const handle = await savePicker({
          suggestedName,
          types: [
            {
              description: 'HTML Files',
              accept: { 'text/html': ['.html'] },
            },
          ],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'saved';
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return 'cancelled';
        }
        throw error;
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = suggestedName;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    return 'downloaded';
  }

  private buildSuccessMessage(
    artifact: {
      entryScenePath: string;
      sceneCount: number;
      assetCount: number;
      fileCount: number;
      warnings: readonly string[];
      bundleWarnings: readonly string[];
    },
    deliveryMethod: Exclude<HtmlDeliveryMethod, 'cancelled'>,
    elapsedMs: number
  ): string {
    const warnings = [...artifact.warnings, ...artifact.bundleWarnings];
    const deliveryLine =
      deliveryMethod === 'saved'
        ? 'Saved via the browser file picker.'
        : 'Downloaded via the browser download flow.';
    const warningSection =
      warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}`
        : '';

    return (
      `Standalone playable export is ready.\n\n` +
      `${deliveryLine}\n` +
      `Entry scene: ${artifact.entryScenePath || '(auto-selected)'}\n` +
      `Scenes: ${artifact.sceneCount}, Assets: ${artifact.assetCount}, Generated files: ${artifact.fileCount}\n` +
      `Completed in ${(elapsedMs / 1000).toFixed(2)}s.` +
      warningSection
    );
  }

  private toSuggestedFileName(projectName: string): string {
    const normalized = projectName
      .trim()
      .replace(/\.[Hh][Tt][Mm][Ll]$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    return `${normalized || 'pix3-playable'}.html`;
  }

  private resolveInitialSceneSelection(
    context: CommandContext,
    scenePaths: readonly string[]
  ): string {
    const configuredDefaultScenePath = this.normalizeResourcePath(
      context.state.project.manifest?.defaultExportScenePath ?? ''
    );
    const activeSceneId = context.state.scenes.activeSceneId;
    const activeScenePath = activeSceneId
      ? this.normalizeResourcePath(context.state.scenes.descriptors[activeSceneId]?.filePath ?? '')
      : '';

    if (configuredDefaultScenePath && scenePaths.includes(configuredDefaultScenePath)) {
      return configuredDefaultScenePath;
    }

    if (activeScenePath && scenePaths.includes(activeScenePath)) {
      return activeScenePath;
    }

    return scenePaths[0] ?? '';
  }

  private normalizeResourcePath(path: string): string {
    return path.trim().replace(/^res:\/\//, '');
  }
}