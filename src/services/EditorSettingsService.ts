import { injectable, inject } from '@/fw/di';
import { OperationService } from '@/services/OperationService';
import {
  UpdateEditorSettingsOperation,
  loadEditorSettings,
} from '@/features/editor/UpdateEditorSettingsOperation';

export type EditorSettingsTab = 'general' | 'ai';

export interface EditorSettingsDialogInstance {
  id: string;
  resolve: () => void;
}

@injectable()
export class EditorSettingsService {
  @inject(OperationService)
  private readonly operationService!: OperationService;

  private activeDialog: EditorSettingsDialogInstance | null = null;
  private listeners = new Set<(activeDialog: EditorSettingsDialogInstance | null) => void>();
  private nextId = 0;
  private initialized = false;
  private initialTab: EditorSettingsTab = 'general';

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const stored = loadEditorSettings();
    if (stored) {
      void this.operationService.invoke(new UpdateEditorSettingsOperation(stored));
    }
  }

  /** The tab the dialog should open on; read once by the dialog in connectedCallback. */
  public getInitialTab(): EditorSettingsTab {
    return this.initialTab;
  }

  public async showSettings(initialTab: EditorSettingsTab = 'general'): Promise<void> {
    if (this.activeDialog) {
      return;
    }

    this.initialTab = initialTab;

    return new Promise(resolve => {
      const id = `editor-settings-${this.nextId++}`;
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

  public subscribe(
    listener: (activeDialog: EditorSettingsDialogInstance | null) => void
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
