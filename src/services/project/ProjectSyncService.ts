import { injectable } from '@/fw/di';

export interface ProjectSyncDialogInstance {
  id: string;
  resolve: () => void;
}

@injectable()
export class ProjectSyncService {
  private activeDialog: ProjectSyncDialogInstance | null = null;
  private listeners = new Set<(activeDialog: ProjectSyncDialogInstance | null) => void>();
  private nextId = 0;

  public async showDialog(): Promise<void> {
    if (this.activeDialog) {
      return;
    }

    return new Promise(resolve => {
      const id = `project-sync-${this.nextId++}`;
      this.activeDialog = {
        id,
        resolve: () => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve();
        },
      };

      this.notifyListeners();
    });
  }

  public close(): void {
    if (this.activeDialog) {
      this.activeDialog.resolve();
    }
  }

  public subscribe(listener: (activeDialog: ProjectSyncDialogInstance | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.activeDialog);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.activeDialog);
    }
  }

  public dispose(): void {
    this.activeDialog = null;
    this.listeners.clear();
  }
}
