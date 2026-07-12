import { injectable } from '@/fw/di';

export interface RemotePreviewDialogInstance {
  readonly id: string;
  close(): void;
}

/**
 * Presentation state holder for the Remote Preview dialog (QR + join link +
 * session status). The dialog reads live session data straight from
 * PreviewHostService; this service only controls dialog visibility, following
 * the PlayableExportDialogService pattern the shell already renders.
 */
@injectable()
export class RemotePreviewDialogService {
  private activeDialog: RemotePreviewDialogInstance | null = null;
  private readonly listeners = new Set<(dialog: RemotePreviewDialogInstance | null) => void>();
  private nextId = 0;

  show(): void {
    if (this.activeDialog) {
      return;
    }

    const id = `remote-preview-${this.nextId++}`;
    this.activeDialog = {
      id,
      close: () => {
        if (this.activeDialog?.id !== id) {
          return;
        }
        this.activeDialog = null;
        this.notifyListeners();
      },
    };
    this.notifyListeners();
  }

  close(dialogId: string): void {
    if (this.activeDialog?.id !== dialogId) {
      return;
    }

    this.activeDialog.close();
  }

  subscribe(listener: (dialog: RemotePreviewDialogInstance | null) => void): () => void {
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
