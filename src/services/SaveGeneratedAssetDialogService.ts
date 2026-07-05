import { injectable } from '@/fw/di';

export interface SaveGeneratedAssetDialogParams {
  /** Suggested file name (with extension) to pre-fill the input. */
  suggestedName: string;
  /** Project-relative directory the file will be written into (`.` = project root). */
  targetDirectory: string;
  /** Object URL of the image being saved, shown as a preview thumbnail. */
  previewUrl: string;
  /** Natural image dimensions, shown as metadata when known. */
  width?: number;
  height?: number;
}

export interface SaveGeneratedAssetDialogResult {
  /** File name (may contain a relative sub-path) the user confirmed. */
  fileName: string;
}

export interface SaveGeneratedAssetDialogInstance {
  id: string;
  params: SaveGeneratedAssetDialogParams;
  resolve: (result: SaveGeneratedAssetDialogResult | null) => void;
}

/**
 * Tracks the single active "Save generated image" dialog and exposes a Promise-based API,
 * mirroring {@link AssetImportDialogService}. Used when an Asset Generator history entry is
 * dropped onto the Asset Browser or Asset Preview panel — the drop handler resolves the target
 * folder and this dialog collects the file name before the blob is written to disk.
 */
@injectable()
export class SaveGeneratedAssetDialogService {
  private activeDialog: SaveGeneratedAssetDialogInstance | null = null;
  private listeners = new Set<(activeDialog: SaveGeneratedAssetDialogInstance | null) => void>();
  private nextId = 0;

  async showDialog(
    params: SaveGeneratedAssetDialogParams
  ): Promise<SaveGeneratedAssetDialogResult | null> {
    if (this.activeDialog) {
      return null;
    }

    return new Promise(resolve => {
      const id = `save-asset-${this.nextId++}`;
      this.activeDialog = {
        id,
        params,
        resolve: (result: SaveGeneratedAssetDialogResult | null) => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve(result);
        },
      };

      this.notifyListeners();
    });
  }

  confirm(dialogId: string, result: SaveGeneratedAssetDialogResult): void {
    if (this.activeDialog?.id !== dialogId) {
      return;
    }
    this.activeDialog.resolve(result);
  }

  cancel(dialogId: string): void {
    if (this.activeDialog?.id !== dialogId) {
      return;
    }
    this.activeDialog.resolve(null);
  }

  subscribe(listener: (activeDialog: SaveGeneratedAssetDialogInstance | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.activeDialog);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.activeDialog = null;
    this.listeners.clear();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.activeDialog);
    }
  }
}
