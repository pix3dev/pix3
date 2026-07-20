import { injectable } from '@/fw/di';
import type { ShaderEffectTarget } from '@pix3/runtime';

export interface EffectPickerInstance {
  id: string;
  /** Effect type ids already attached — hidden from the picker (one-per-type). */
  excludeTypes: string[];
  /**
   * Material family of the host stack — the picker lists only effects that
   * support it. Omitted keeps the legacy (unfiltered) behavior.
   */
  target?: ShaderEffectTarget;
  resolve: (result: string | null) => void;
  reject: (error: Error) => void;
}

/**
 * Modal picker for attaching a shader effect to a mesh — mirrors
 * {@link BehaviorPickerService}. `showPicker` resolves to the chosen effect id
 * (e.g. `core:dissolve`) or null if cancelled.
 */
@injectable()
export class EffectPickerService {
  private pickers = new Map<string, EffectPickerInstance>();
  private nextId = 0;
  private listeners = new Set<(pickers: EffectPickerInstance[]) => void>();

  public async showPicker(
    excludeTypes: string[] = [],
    target?: ShaderEffectTarget
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const id = `effect-picker-${this.nextId++}`;
      const instance: EffectPickerInstance = {
        id,
        excludeTypes,
        target,
        resolve: (result: string | null) => {
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

  public getPickers(): EffectPickerInstance[] {
    return Array.from(this.pickers.values());
  }

  public subscribe(listener: (pickers: EffectPickerInstance[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public select(pickerId: string, effectType: string): void {
    this.pickers.get(pickerId)?.resolve(effectType);
  }

  public cancel(pickerId: string): void {
    this.pickers.get(pickerId)?.resolve(null);
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
