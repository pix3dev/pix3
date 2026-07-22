import { inject, injectLazy, type LazyService } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { DialogService, type DialogExpandableSection } from '@/services/editor/DialogService';
import { LoggingService } from '@/services/core/LoggingService';
import { PlayableExportDialogService } from '@/services/export/PlayableExportDialogService';
import { PlayableExportProgressDialogService } from '@/services/export/PlayableExportProgressDialogService';
import type {
  PlayableHtmlBuildService,
  PlayableHtmlBuildArtifact,
  PlayableHtmlBundleSizeReport,
} from '@/services/export/PlayableHtmlBuildService';

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

  @injectLazy(() =>
    import('@/services/export/PlayableHtmlBuildService').then(m => m.PlayableHtmlBuildService)
  )
  private readonly playableHtmlBuildService!: LazyService<PlayableHtmlBuildService>;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(PlayableExportDialogService)
  private readonly playableExportDialogService!: PlayableExportDialogService;

  @inject(PlayableExportProgressDialogService)
  private readonly playableExportProgressDialogService!: PlayableExportProgressDialogService;

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

      const artifact = await this.buildPlayableHtmlWithProgress(context, {
        title: projectName,
        entryScenePath,
      });

      const allWarnings = [...artifact.warnings, ...artifact.bundleWarnings];
      for (const warning of allWarnings) {
        this.loggingService.warn(`[Playable Export] ${warning}`);
      }

      // The file picker must be opened from a live user gesture. Building the
      // bundle is asynchronous and consumes the original command's transient
      // activation, so we surface a "Save File" confirmation once the bundle
      // is ready and only invoke `showSaveFilePicker` from within that click's
      // microtask continuation, where the gesture is still valid.
      const readyToSave = await this.dialogService.showConfirmation({
        title: 'Playable HTML Ready',
        message: this.buildReadyMessage(artifact),
        expandableSection: this.buildEmbeddedAssetsSection(artifact.sizeReport),
        confirmLabel: 'Save File',
        cancelLabel: 'Cancel',
      });

      if (!readyToSave) {
        this.loggingService.info('[Playable Export] Export cancelled before saving');
        return { didMutate: false, payload: undefined };
      }

      const suggestedName = this.toSuggestedFileName(projectName);
      const deliveryMethod = await this.deliverHtmlArtifact(artifact.html, suggestedName);

      if (deliveryMethod === 'cancelled') {
        this.loggingService.info('[Playable Export] Export cancelled during file selection');
        return { didMutate: false, payload: undefined };
      }

      const elapsedMs = Date.now() - startTime;

      this.loggingService.info('[Playable Export] Export completed', {
        deliveryMethod,
        entryScenePath: artifact.entryScenePath,
        scenes: artifact.sceneCount,
        assets: artifact.assetCount,
        files: artifact.fileCount,
        sizeReport: artifact.sizeReport,
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

  private async buildPlayableHtmlWithProgress(
    context: CommandContext,
    options: {
      title: string;
      entryScenePath: string;
    }
  ): Promise<PlayableHtmlBuildArtifact> {
    this.playableExportProgressDialogService.showDialog({
      title: 'Building Playable HTML',
      message: 'Bundling scripts and embedding project assets into a single HTML file.',
    });
    await this.waitForProgressDialogPaint();

    try {
      const playableHtmlBuildService = await this.playableHtmlBuildService();
      return await playableHtmlBuildService.buildPlayableHtml(context, options);
    } finally {
      this.playableExportProgressDialogService.close();
    }
  }

  private async waitForProgressDialogPaint(): Promise<void> {
    await new Promise<void>(resolve => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
        return;
      }

      window.setTimeout(() => resolve(), 0);
    });
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

  private buildReadyMessage(artifact: PlayableHtmlBuildArtifact): string {
    const warnings = [...artifact.warnings, ...artifact.bundleWarnings];
    const warningSection =
      warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}`
        : '';

    return (
      `Your standalone playable HTML bundle is built and ready to save.\n\n` +
      `Entry scene: ${artifact.entryScenePath || '(auto-selected)'}\n` +
      `Scenes: ${artifact.sceneCount}, Assets: ${artifact.assetCount}, Generated files: ${artifact.fileCount}` +
      this.buildBundleSizeReportSection(artifact.sizeReport) +
      warningSection +
      `\n\nClick "Save File" to choose where to write the .html file.`
    );
  }

  private buildSuccessMessage(
    artifact: PlayableHtmlBuildArtifact,
    deliveryMethod: Exclude<HtmlDeliveryMethod, 'cancelled'>,
    elapsedMs: number
  ): string {
    const deliveryLine =
      deliveryMethod === 'saved'
        ? 'Saved via the browser file picker.'
        : 'Downloaded via the browser download flow.';

    return (
      `Standalone playable export complete.\n\n` +
      `${deliveryLine}\n` +
      `Entry scene: ${artifact.entryScenePath || '(auto-selected)'}\n` +
      `Scenes: ${artifact.sceneCount}, Assets: ${artifact.assetCount}, Generated files: ${artifact.fileCount}\n` +
      `Completed in ${(elapsedMs / 1000).toFixed(2)}s.`
    );
  }

  private buildBundleSizeReportSection(report: PlayableHtmlBundleSizeReport): string {
    const lines = this.buildBundleSizeSummaryLines(report);
    if (lines.length === 0) {
      return '';
    }

    return `\n\nBundle size report:\n${lines.join('\n')}`;
  }

  private buildBundleSizeSummaryLines(report: PlayableHtmlBundleSizeReport): string[] {
    return [
      `  Output HTML: ${this.formatBytes(report.outputHtmlBytes)} (${report.outputHtmlBytes} bytes)`,
      `  Embedded assets (raw): ${this.formatBytes(report.rawAssetsBytes)} (${this.formatPercent(report.rawAssetsBytes, report.outputHtmlBytes)} of output)`,
      `  Embedded assets (base64 payload): ${this.formatBytes(report.base64AssetsBytes)} (${this.formatPercent(report.base64AssetsBytes, report.outputHtmlBytes)} of output)`,
      `  Base64 expansion overhead: +${this.formatBytes(report.base64ExpansionBytes)} (${this.formatPercent(report.base64ExpansionBytes, report.outputHtmlBytes)} of output)`,
      `  JS/HTML + metadata wrapper: ${this.formatBytes(report.codeAndWrapperBytes)} (${this.formatPercent(report.codeAndWrapperBytes, report.outputHtmlBytes)} of output)`,
    ];
  }

  private buildEmbeddedAssetsSection(
    report: PlayableHtmlBundleSizeReport
  ): DialogExpandableSection | undefined {
    if (report.assetEntries.length === 0) {
      return undefined;
    }

    return {
      title: 'Embedded assets by source size',
      items: report.assetEntries.map(
        entry =>
          `${entry.path}: ${this.formatBytes(entry.rawBytes)} raw -> ${this.formatBytes(entry.base64Bytes)} base64`
      ),
      maxHeightPx: 260,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KiB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  private formatPercent(part: number, whole: number): string {
    if (whole <= 0) {
      return '0.00%';
    }

    return `${((part / whole) * 100).toFixed(2)}%`;
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
