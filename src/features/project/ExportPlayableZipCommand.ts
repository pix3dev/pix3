import { inject, injectLazy, type LazyService } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { DialogService } from '@/services/editor/DialogService';
import { LoggingService } from '@/services/core/LoggingService';
import { PlayableExportDialogService } from '@/services/export/PlayableExportDialogService';
import { PlayableExportProgressDialogService } from '@/services/export/PlayableExportProgressDialogService';
import type {
  PlayableHtmlBuildService,
  PlayableZipBuildArtifact,
} from '@/services/export/PlayableHtmlBuildService';

type SaveFilePickerFn = (options?: unknown) => Promise<FileSystemFileHandle>;
type WindowWithSavePicker = Window & {
  showSaveFilePicker?: SaveFilePickerFn;
};

/**
 * Exports the project as an `index.html` + plain asset files packed into a
 * zip archive — the "unpack onto any static host" companion to the
 * single-file playable HTML export (no base64 embedding overhead).
 */
export class ExportPlayableZipCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.export-playable-zip',
    title: 'Export HTML + Assets (Zip)',
    description: 'Build a zip archive with index.html and project assets as separate files',
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 211,
    keywords: ['export', 'zip', 'archive', 'html', 'assets', 'build', 'project'],
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
    const projectName = context.state.project.projectName ?? 'Project';
    this.loggingService.info(`[Playable Zip Export] Starting export for "${projectName}"`);

    try {
      const entryScenePath = await this.promptForEntryScenePath(context);
      if (!entryScenePath) {
        return { didMutate: false, payload: undefined };
      }

      this.playableExportProgressDialogService.showDialog({
        title: 'Building Zip Export',
        message: 'Bundling scripts and packing project assets into a zip archive.',
      });

      let artifact: PlayableZipBuildArtifact;
      try {
        const playableHtmlBuildService = await this.playableHtmlBuildService();
        artifact = await playableHtmlBuildService.buildPlayableZip(context, {
          title: projectName,
          entryScenePath,
        });
      } finally {
        this.playableExportProgressDialogService.close();
      }

      for (const warning of [...artifact.warnings, ...artifact.bundleWarnings]) {
        this.loggingService.warn(`[Playable Zip Export] ${warning}`);
      }

      // showSaveFilePicker needs a live user gesture; the confirmation click
      // provides one after the async build completed.
      const readyToSave = await this.dialogService.showConfirmation({
        title: 'Zip Export Ready',
        message:
          `The archive is built and ready to save.\n\n` +
          `Entry scene: ${artifact.entryScenePath || '(auto-selected)'}\n` +
          `Scenes: ${artifact.sceneCount}, Assets: ${artifact.assetCount}\n` +
          `index.html: ${this.formatBytes(artifact.htmlBytes)}, assets: ${this.formatBytes(artifact.assetBytes)}, ` +
          `zip: ${this.formatBytes(artifact.zipBlob.size)}\n\n` +
          `Unpack it onto any static host and open index.html.`,
        confirmLabel: 'Save File',
        cancelLabel: 'Cancel',
      });

      if (!readyToSave) {
        return { didMutate: false, payload: undefined };
      }

      await this.deliverZip(artifact.zipBlob, this.toSuggestedFileName(projectName));
    } catch (error) {
      this.loggingService.error('[Playable Zip Export] Export failed', error);
      await this.dialogService.showConfirmation({
        title: 'Zip Export Failed',
        message:
          `An error occurred while exporting the zip archive.\n\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      throw error;
    }

    return { didMutate: false, payload: undefined };
  }

  private async promptForEntryScenePath(context: CommandContext): Promise<string | null> {
    const scenePaths = Array.from(
      new Set(
        Object.values(context.state.scenes.descriptors)
          .map(descriptor => (descriptor.filePath ?? '').replace(/^res:\/\//, '').trim())
          .filter(path => path.length > 0)
      )
    ).sort((left, right) => left.localeCompare(right));

    const configured = (context.state.project.manifest?.defaultExportScenePath ?? '').replace(
      /^res:\/\//,
      ''
    );
    const selected =
      configured && scenePaths.includes(configured) ? configured : (scenePaths[0] ?? '');

    return await this.playableExportDialogService.showDialog({
      scenePaths,
      selectedScenePath: selected,
    });
  }

  private async deliverZip(blob: Blob, suggestedName: string): Promise<void> {
    const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;

    if (savePicker) {
      try {
        const handle = await savePicker({
          suggestedName,
          types: [
            {
              description: 'Zip Archives',
              accept: { 'application/zip': ['.zip'] },
            },
          ],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
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

  private toSuggestedFileName(projectName: string): string {
    const normalized = projectName
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    return `${normalized || 'pix3-playable'}.zip`;
  }
}
