import { injectable } from '@/fw/di';

export interface AssetImportDialogParams {
  /** Project-relative directory the imported files will be copied into (`.` = project root). */
  targetDirectory: string;
}

export interface AssetImportDialogResult {
  /** Project-relative paths of the files that were imported. */
  importedPaths: string[];
}

export interface AssetImportDialogInstance {
  id: string;
  params: AssetImportDialogParams;
  resolve: (result: AssetImportDialogResult | null) => void;
}

/**
 * Tracks the single active "Import assets" dialog and exposes a Promise-based API,
 * mirroring {@link AnimationAutoSliceDialogService}. The dialog component performs
 * the actual file copy and reports the imported paths back via {@link confirm}.
 */
@injectable()
export class AssetImportDialogService {
  private activeDialog: AssetImportDialogInstance | null = null;
  private listeners = new Set<(activeDialog: AssetImportDialogInstance | null) => void>();
  private nextId = 0;

  async showDialog(params: AssetImportDialogParams): Promise<AssetImportDialogResult | null> {
    if (this.activeDialog) {
      return null;
    }

    return new Promise(resolve => {
      const id = `asset-import-${this.nextId++}`;
      this.activeDialog = {
        id,
        params,
        resolve: (result: AssetImportDialogResult | null) => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve(result);
        },
      };

      this.notifyListeners();
    });
  }

  confirm(dialogId: string, result: AssetImportDialogResult): void {
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

  subscribe(listener: (activeDialog: AssetImportDialogInstance | null) => void): () => void {
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
