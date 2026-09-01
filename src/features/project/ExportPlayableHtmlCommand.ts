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
import { ProjectBuildService } from '@/services/export/ProjectBuildService';
import {
  PlayableExportDialogService,
  type PlayableExportDialogResult,
} from '@/services/export/PlayableExportDialogService';
import { PlayableExportProgressDialogService } from '@/services/export/PlayableExportProgressDialogService';
import type {
  PlayableHtmlBuildService,
  PlayableHtmlBuildArtifact,
  PlayableHtmlBundleSizeReport,
} from '@/services/export/PlayableHtmlBuildService';
import {
  buildAssetProvenanceItems,
  buildInclusionSummaryLines,
  formatExportBytes,
  summarizeInclusionReasons,
} from '@/services/export/export-report';

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

  @inject(ProjectBuildService)
  private readonly projectBuildService!: ProjectBuildService;

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

    // Export builds from the scenes on disk (see ProjectBuildService.collectScenePaths),
    // so we intentionally do NOT require a scene to be loaded here — otherwise the command
    // would be disabled on the Project Home tab, which loads no scene. Whether the project
    // actually contains any scene is validated at execute time via disk discovery.
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const startTime = Date.now();
    const projectName = context.state.project.projectName ?? 'Project';

    this.loggingService.info(`[Playable Export] Starting export for "${projectName}"`);

    try {
      const selection = await this.promptForEntryScenePath(context);
      if (!selection) {
        this.loggingService.info('[Playable Export] Export cancelled during scene selection');
        return { didMutate: false, payload: undefined };
      }

      const artifact = await this.buildPlayableHtmlWithProgress(context, {
        title: projectName,
        entryScenePath: selection.scenePath,
        compress: selection.compress,
        compressImages: selection.compressImages,
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
        expandableSection: this.buildEmbeddedAssetsSection(artifact),
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
      compress: boolean;
      compressImages: boolean;
    }
  ): Promise<PlayableHtmlBuildArtifact> {
    this.playableExportProgressDialogService.showDialog({
      title: 'Building Playable HTML',
      message: options.compress
        ? 'Bundling scripts, embedding project assets, and compressing the bundle into a single HTML file.'
        : 'Bundling scripts and embedding project assets into a single HTML file.',
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

  private async promptForEntryScenePath(
    context: CommandContext
  ): Promise<PlayableExportDialogResult | null> {
    // Reuse the build service's scene resolution so the picker offers exactly the scenes
    // that will be bundled — loaded descriptors when any are open, disk discovery otherwise
    // (e.g. when launched from the Project Home tab with no scene loaded).
    const collected = await this.projectBuildService.collectScenePaths(context);
    const uniqueScenePaths = Array.from(
      new Set(
        collected.map(path => this.normalizeResourcePath(path)).filter(path => path.length > 0)
      )
    ).sort((left, right) => left.localeCompare(right));

    if (uniqueScenePaths.length === 0) {
      await this.dialogService.showConfirmation({
        title: 'No Scenes to Export',
        message:
          'This project has no scenes to export.\n\n' +
          'Create at least one scene before exporting a playable HTML bundle.',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      return null;
    }

    const initialSelection = this.resolveInitialSceneSelection(context, uniqueScenePaths);

    return await this.playableExportDialogService.showDialog({
      scenePaths: uniqueScenePaths,
      selectedScenePath: initialSelection,
      offerCompression: true,
      // Only the single-file HTML base64s its art into the file being budgeted; the zip ships real
      // image files, where a `.png` name holding WebP bytes would be a lie on disk.
      offerImageCompression: true,
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
      this.buildInclusionReportSection(artifact) +
      warningSection +
      `\n\nClick "Save File" to choose where to write the .html file.`
    );
  }

  /**
   * Why the bundle weighs what it does, grouped by what pulled each asset in.
   * A fat `Whole directory pulled in by a dynamic path` row is the usual
   * explanation for a surprising bundle size, and it points straight at the
   * `excludeGlobs` entry that would fix it.
   */
  private buildInclusionReportSection(artifact: PlayableHtmlBuildArtifact): string {
    const rows = summarizeInclusionReasons(artifact.reachability, artifact.sizeReport.assetEntries);
    if (rows.length === 0) {
      return '';
    }

    return `\n\nAssets included by reason:\n${buildInclusionSummaryLines(rows).join('\n')}`;
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
    const compressed = report.compressedBundleBytes > 0;
    // With compression the file no longer *contains* the asset base64 as text, so the
    // asset lines describe the input and are measured against the bundle they went
    // into, not against the (much smaller) output file.
    const reference = compressed
      ? report.outputHtmlBytes + report.compressionSavedBytes
      : report.outputHtmlBytes;

    const lines = [
      `  Output HTML: ${this.formatBytes(report.outputHtmlBytes)} (${report.outputHtmlBytes} bytes)`,
    ];

    if (compressed) {
      lines.push(
        `  Bundle: ${this.formatBytes(report.uncompressedBundleBytes)} -> ${this.formatBytes(report.compressedBundleBytes)} gzip (embedded as base64)`,
        `  Saved by compression: ${this.formatBytes(report.compressionSavedBytes)} (${this.formatPercent(report.compressionSavedBytes, reference)} of the uncompressed file)`
      );
    }

    lines.push(
      `  Embedded assets (raw): ${this.formatBytes(report.rawAssetsBytes)} (${this.formatPercent(report.rawAssetsBytes, reference)} of ${compressed ? 'the uncompressed file' : 'output'})`,
      `  Embedded assets (base64 payload): ${this.formatBytes(report.base64AssetsBytes)} (${this.formatPercent(report.base64AssetsBytes, reference)} of ${compressed ? 'the uncompressed file' : 'output'})`,
      `  Base64 expansion overhead: +${this.formatBytes(report.base64ExpansionBytes)} (${this.formatPercent(report.base64ExpansionBytes, reference)} of ${compressed ? 'the uncompressed file' : 'output'})`,
      `  JS/HTML + metadata wrapper: ${this.formatBytes(report.codeAndWrapperBytes)} (${this.formatPercent(report.codeAndWrapperBytes, reference)} of ${compressed ? 'the uncompressed file' : 'output'})`
    );

    if (report.strippedModulePaths.length > 0) {
      lines.push(
        `  Runtime modules left out (unused): ${report.strippedModulePaths.length}` +
          ` (${report.strippedModulePaths.slice(0, 3).join(', ')}${report.strippedModulePaths.length > 3 ? ', …' : ''})`
      );
    }

    return lines;
  }

  private buildEmbeddedAssetsSection(
    artifact: PlayableHtmlBuildArtifact
  ): DialogExpandableSection | undefined {
    const entries = artifact.sizeReport.assetEntries;
    if (entries.length === 0) {
      return undefined;
    }

    return {
      title: 'Embedded assets by source size',
      // Biggest-first, each line naming what referenced it — so a heavy asset can
      // be traced to the scene, script or glob responsible without a rebuild.
      items: buildAssetProvenanceItems(
        entries,
        artifact.reachability,
        entry =>
          `${this.formatBytes(entry.rawBytes)} raw -> ${this.formatBytes(entry.base64Bytes)} base64`
      ),
      maxHeightPx: 260,
    };
  }

  private formatBytes(bytes: number): string {
    return formatExportBytes(bytes);
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
