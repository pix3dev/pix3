import { injectable } from '@/fw/di';

export interface PlayableExportDialogOptions {
  readonly scenePaths: readonly string[];
  readonly selectedScenePath: string;
  /**
   * Offer the gzip self-extracting toggle. Only the single-file HTML export does:
   * a zip already deflates its entries, so compressing the bundle inside it would
   * only cost base64 overhead.
   */
  readonly offerCompression?: boolean;
}

export interface PlayableExportDialogResult {
  readonly scenePath: string;
  /** Only meaningful when {@link PlayableExportDialogOptions.offerCompression} was set. */
  readonly compress: boolean;
}

export interface PlayableExportDialogInstance extends PlayableExportDialogOptions {
  readonly id: string;
  resolve: (result: PlayableExportDialogResult | null) => void;
}

@injectable()
export class PlayableExportDialogService {
  private activeDialog: PlayableExportDialogInstance | null = null;
  private listeners = new Set<(dialog: PlayableExportDialogInstance | null) => void>();
  private nextId = 0;

  async showDialog(
    options: PlayableExportDialogOptions
  ): Promise<PlayableExportDialogResult | null> {
    if (this.activeDialog) {
      return null;
    }

    return new Promise(resolve => {
      const id = `playable-export-${this.nextId++}`;
      this.activeDialog = {
        id,
        ...options,
        resolve: (result: PlayableExportDialogResult | null) => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve(result);
        },
      };

      this.notifyListeners();
    });
  }

  confirm(dialogId: string, result: PlayableExportDialogResult): void {
    if (!this.activeDialog || this.activeDialog.id !== dialogId) {
      return;
    }

    this.activeDialog.resolve(result);
  }

  cancel(dialogId: string): void {
    if (!this.activeDialog || this.activeDialog.id !== dialogId) {
      return;
    }

    this.activeDialog.resolve(null);
  }

  subscribe(listener: (dialog: PlayableExportDialogInstance | null) => void): () => void {
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
