import { injectable } from '@/fw/di';

export interface DialogExpandableSection {
  title: string;
  items: readonly string[];
  maxHeightPx?: number;
}

export interface DialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  secondaryLabel?: string;
  cancelLabel?: string;
  isDangerous?: boolean;
  secondaryIsDangerous?: boolean;
  requiredInputLabel?: string;
  requiredInputValue?: string;
  requiredInputPlaceholder?: string;
  disclaimer?: string;
  expandableSection?: DialogExpandableSection;
}

export interface DialogInstance {
  id: string;
  options: DialogOptions;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  confirmValue: unknown;
  cancelValue: unknown;
  secondaryValue?: unknown;
}

@injectable()
export class DialogService {
  private dialogs = new Map<string, DialogInstance>();
  private nextId = 0;
  private listeners = new Set<(dialogs: DialogInstance[]) => void>();

  /**
   * Show a confirmation dialog and return a promise that resolves to true if confirmed, false if cancelled.
   */
  public async showConfirmation(options: DialogOptions): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = `dialog-${this.nextId++}`;
      const instance: DialogInstance = {
        id,
        options: {
          confirmLabel: 'Confirm',
          cancelLabel: 'Cancel',
          isDangerous: false,
          ...options,
        },
        resolve: (result: unknown) => {
          this.dialogs.delete(id);
          this.notifyListeners();
          resolve(Boolean(result));
        },
        reject: (error: Error) => {
          this.dialogs.delete(id);
          this.notifyListeners();
          reject(error);
        },
        confirmValue: true,
        cancelValue: false,
      };

      this.dialogs.set(id, instance);
      this.notifyListeners();
    });
  }

  /**
   * Show a 3-way confirmation dialog.
   * Returns: 'confirm' | 'secondary' | 'cancel'
   */
  public async showChoice(
    options: DialogOptions & { secondaryLabel: string }
  ): Promise<'confirm' | 'secondary' | 'cancel'> {
    return new Promise((resolve, reject) => {
      const id = `dialog-${this.nextId++}`;
      const instance: DialogInstance = {
        id,
        options: {
          confirmLabel: 'Confirm',
          cancelLabel: 'Cancel',
          isDangerous: false,
          secondaryIsDangerous: false,
          ...options,
        },
        resolve: (result: unknown) => {
          this.dialogs.delete(id);
          this.notifyListeners();
          if (result === 'secondary') {
            resolve('secondary');
          } else if (result === 'confirm') {
            resolve('confirm');
          } else {
            resolve('cancel');
          }
        },
        reject: (error: Error) => {
          this.dialogs.delete(id);
          this.notifyListeners();
          reject(error);
        },
        confirmValue: 'confirm',
        secondaryValue: 'secondary',
        cancelValue: 'cancel',
      };

      this.dialogs.set(id, instance);
      this.notifyListeners();
    });
  }

  /**
   * Get all active dialogs for rendering
   */
  public getDialogs(): DialogInstance[] {
    return Array.from(this.dialogs.values());
  }

  /**
   * Subscribe to dialog changes
   */
  public subscribe(listener: (dialogs: DialogInstance[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Confirm a dialog by ID
   */
  public confirm(id: string): void {
    const instance = this.dialogs.get(id);
    if (instance) {
      instance.resolve(instance.confirmValue);
    }
  }

  /**
   * Cancel a dialog by ID
   */
  public cancel(id: string): void {
    const instance = this.dialogs.get(id);
    if (instance) {
      instance.resolve(instance.cancelValue);
    }
  }

  public secondary(id: string): void {
    const instance = this.dialogs.get(id);
    if (instance) {
      instance.resolve(instance.secondaryValue ?? instance.cancelValue);
    }
  }

  private notifyListeners(): void {
    const dialogs = this.getDialogs();
    for (const listener of this.listeners) {
      listener(dialogs);
    }
  }

  public dispose(): void {
    this.dialogs.clear();
    this.listeners.clear();
  }
}
