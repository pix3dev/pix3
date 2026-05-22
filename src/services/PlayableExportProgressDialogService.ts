import { injectable } from '@/fw/di';

export interface PlayableExportProgressDialogOptions {
  readonly title: string;
  readonly message: string;
}

export interface PlayableExportProgressDialogInstance extends PlayableExportProgressDialogOptions {
  readonly id: string;
}

@injectable()
export class PlayableExportProgressDialogService {
  private activeDialog: PlayableExportProgressDialogInstance | null = null;
  private listeners = new Set<(dialog: PlayableExportProgressDialogInstance | null) => void>();
  private nextId = 0;

  showDialog(options: PlayableExportProgressDialogOptions): void {
    const id = this.activeDialog?.id ?? `playable-export-progress-${this.nextId++}`;
    this.activeDialog = {
      id,
      ...options,
    };
    this.notifyListeners();
  }

  close(): void {
    if (!this.activeDialog) {
      return;
    }

    this.activeDialog = null;
    this.notifyListeners();
  }

  subscribe(
    listener: (dialog: PlayableExportProgressDialogInstance | null) => void
  ): () => void {
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