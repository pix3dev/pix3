import { injectable } from '@/fw/di';

export interface ProjectSettingsDialogInstance {
  id: string;
  resolve: () => void;
}

@injectable()
export class ProjectSettingsService {
  private activeDialog: ProjectSettingsDialogInstance | null = null;
  private listeners = new Set<(activeDialog: ProjectSettingsDialogInstance | null) => void>();
  private nextId = 0;

  /**
   * Show the project settings dialog.
   */
  public async showSettings(): Promise<void> {
    if (this.activeDialog) {
      return;
    }

    return new Promise(resolve => {
      const id = `project-settings-${this.nextId++}`;
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

  /**
   * Subscribe to changes in active dialogs.
   */
  public subscribe(
    listener: (activeDialog: ProjectSettingsDialogInstance | null) => void
  ): () => void {
    this.listeners.add(listener);
    listener(this.activeDialog);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.activeDialog));
  }

  public dispose(): void {
    this.activeDialog = null;
    this.listeners.clear();
  }
}
