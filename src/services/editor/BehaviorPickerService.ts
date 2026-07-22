import { injectable } from '@/fw/di';
import type { ComponentTypeInfo } from '@pix3/runtime';

export interface ComponentPickerInstance {
  id: string;
  resolve: (result: ComponentTypeInfo | null) => void;
  reject: (error: Error) => void;
}

@injectable()
export class BehaviorPickerService {
  private pickers = new Map<string, ComponentPickerInstance>();
  private nextId = 0;
  private listeners = new Set<(pickers: ComponentPickerInstance[]) => void>();

  /**
   * Show the component picker modal and return a promise that resolves to the selected component or null if cancelled.
   */
  public async showPicker(): Promise<ComponentTypeInfo | null> {
    return new Promise((resolve, reject) => {
      const id = `picker-${this.nextId++}`;
      const instance: ComponentPickerInstance = {
        id,
        resolve: (result: ComponentTypeInfo | null) => {
          this.pickers.delete(id);
          this.notifyListeners();
          resolve(result);
        },
        reject: (error: Error) => {
          this.pickers.delete(id);
          this.notifyListeners();
          reject(error);
        },
      };

      this.pickers.set(id, instance);
      this.notifyListeners();
    });
  }

  /**
   * Get all active pickers for rendering
   */
  public getPickers(): ComponentPickerInstance[] {
    return Array.from(this.pickers.values());
  }

  /**
   * Subscribe to picker changes
   */
  public subscribe(listener: (pickers: ComponentPickerInstance[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Select a component by ID
   */
  public select(pickerId: string, component: ComponentTypeInfo): void {
    const instance = this.pickers.get(pickerId);
    if (instance) {
      instance.resolve(component);
    }
  }

  /**
   * Cancel a picker by ID
   */
  public cancel(pickerId: string): void {
    const instance = this.pickers.get(pickerId);
    if (instance) {
      instance.resolve(null);
    }
  }

  private notifyListeners(): void {
    const pickers = this.getPickers();
    for (const listener of this.listeners) {
      listener(pickers);
    }
  }

  public dispose(): void {
    this.pickers.clear();
    this.listeners.clear();
  }
}
