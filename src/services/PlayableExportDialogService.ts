import { injectable } from '@/fw/di';

export interface PlayableExportDialogOptions {
  readonly scenePaths: readonly string[];
  readonly selectedScenePath: string;
}

export interface PlayableExportDialogInstance extends PlayableExportDialogOptions {
  readonly id: string;
  resolve: (scenePath: string | null) => void;
}

@injectable()
export class PlayableExportDialogService {
  private activeDialog: PlayableExportDialogInstance | null = null;
  private listeners = new Set<(dialog: PlayableExportDialogInstance | null) => void>();
  private nextId = 0;

  async showDialog(options: PlayableExportDialogOptions): Promise<string | null> {
    if (this.activeDialog) {
      return null;
    }

    return new Promise(resolve => {
      const id = `playable-export-${this.nextId++}`;
      this.activeDialog = {
        id,
        ...options,
        resolve: (scenePath: string | null) => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve(scenePath);
        },
      };

      this.notifyListeners();
    });
  }

  confirm(dialogId: string, scenePath: string): void {
    if (!this.activeDialog || this.activeDialog.id !== dialogId) {
      return;
    }

    this.activeDialog.resolve(scenePath);
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