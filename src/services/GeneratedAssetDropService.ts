import { inject, injectable } from '@/fw/di';
import { GenerationHistoryService } from './GenerationHistoryService';
import { ProjectStorageService } from './ProjectStorageService';
import { SaveGeneratedAssetDialogService } from './SaveGeneratedAssetDialogService';
import { getGenerationDragData } from '@/ui/shared/asset-drag-drop';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;

const extForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'image/webp'
      ? 'webp'
      : mimeType === 'image/gif'
        ? 'gif'
        : 'png';

/**
 * Handles dropping an Sprite Editor generation-history entry onto a project location
 * (Asset Browser tree or Asset Preview panel). Parses the drag payload, loads the blob from
 * {@link GenerationHistoryService}, prompts for a file name via
 * {@link SaveGeneratedAssetDialogService}, then writes the image into the target folder.
 */
@injectable()
export class GeneratedAssetDropService {
  @inject(GenerationHistoryService)
  private readonly history!: GenerationHistoryService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(SaveGeneratedAssetDialogService)
  private readonly dialog!: SaveGeneratedAssetDialogService;

  /**
   * @returns the project-relative path the file was saved to, or `null` if the drag carried no
   * generation, the record was missing, or the user cancelled the save dialog.
   */
  async handleDrop(
    dataTransfer: DataTransfer | null,
    targetDirectory: string
  ): Promise<string | null> {
    const payload = getGenerationDragData(dataTransfer);
    if (!payload) {
      return null;
    }

    const record = await this.history.get(payload.id);
    if (!record) {
      console.warn('[GeneratedAssetDrop] Generation record not found', payload.id);
      return null;
    }

    const directory = normalizeDirectory(targetDirectory);
    const suggestedName = ensureImageExt(
      payload.suggestedName?.trim() || 'generated',
      record.mimeType
    );

    const previewUrl = URL.createObjectURL(record.blob);
    try {
      const result = await this.dialog.showDialog({
        suggestedName,
        targetDirectory: directory,
        previewUrl,
        width: record.width,
        height: record.height,
      });
      if (!result) {
        return null;
      }

      const relativePath = joinPath(
        directory,
        ensureImageExt(normalizeRelativePath(result.fileName), record.mimeType)
      );
      if (!relativePath) {
        return null;
      }

      await this.ensureParentDirectory(relativePath);
      const buffer = await record.blob.arrayBuffer();
      await this.storage.writeBinaryFile(relativePath, buffer);
      return relativePath;
    } catch (error) {
      console.error('[GeneratedAssetDrop] Failed to save dropped generation', error);
      return null;
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    segments.pop();
    let accumulated = '';
    for (const segment of segments) {
      if (!segment || segment === '.') {
        continue;
      }
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      try {
        await this.storage.createDirectory(accumulated);
      } catch {
        // Directory likely already exists.
      }
    }
  }
}

const normalizeDirectory = (path: string): string => {
  const normalized = normalizeRelativePath(path);
  return normalized || '.';
};

const normalizeRelativePath = (path: string): string =>
  path
    .trim()
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const joinPath = (directory: string, fileName: string): string => {
  const cleanDir = directory === '.' ? '' : directory;
  const cleanName = fileName.replace(/^\/+/, '');
  if (!cleanName) {
    return '';
  }
  return cleanDir ? `${cleanDir}/${cleanName}` : cleanName;
};

const ensureImageExt = (path: string, mimeType: string): string => {
  if (!path) {
    return path;
  }
  return IMAGE_EXT_RE.test(path) ? path : `${path}.${extForMime(mimeType)}`;
};
