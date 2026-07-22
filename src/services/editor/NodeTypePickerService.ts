import { injectable } from '@/fw/di';

export interface NodeTypePickerInstance {
  id: string;
  resolve: (nodeTypeId: string | null) => void;
}

@injectable()
export class NodeTypePickerService {
  private activePicker: NodeTypePickerInstance | null = null;
  private listeners = new Set<(activePicker: NodeTypePickerInstance | null) => void>();
  private nextId = 0;

  public async showPicker(): Promise<string | null> {
    if (this.activePicker) {
      return null;
    }

    return new Promise(resolve => {
      const id = `node-type-picker-${this.nextId++}`;
      this.activePicker = {
        id,
        resolve: (nodeTypeId: string | null) => {
          this.activePicker = null;
          this.notifyListeners();
          resolve(nodeTypeId);
        },
      };

      this.notifyListeners();
    });
  }

  public select(pickerId: string, nodeTypeId: string): void {
    if (!this.activePicker || this.activePicker.id !== pickerId) {
      return;
    }

    this.activePicker.resolve(nodeTypeId);
  }

  public cancel(pickerId: string): void {
    if (!this.activePicker || this.activePicker.id !== pickerId) {
      return;
    }

    this.activePicker.resolve(null);
  }

  public subscribe(listener: (activePicker: NodeTypePickerInstance | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.activePicker);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.activePicker);
    }
  }

  public dispose(): void {
    this.activePicker = null;
    this.listeners.clear();
  }
}
