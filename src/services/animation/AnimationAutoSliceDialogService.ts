import { injectable } from '@/fw/di';

export interface AnimationAutoSliceDialogParams {
  texturePath: string;
  /**
   * What the slice is being performed for — an animation clip name when the animation editor asks,
   * the image name when the Sprite Editor's "Slice…" action asks. Shown under {@link contextCaption}.
   */
  contextLabel: string;
  /** Caption above {@link contextLabel}. Defaults to `Active clip`. */
  contextCaption?: string;
  /** Sentence describing what confirming does. Defaults to the animation-clip wording. */
  confirmNote?: string;
  /** Confirm button label. Defaults to `Slice Frames`. */
  confirmLabel?: string;
  /** Cancel button label. Defaults to `Keep Without Slicing`. */
  cancelLabel?: string;
  defaultColumns?: number;
  defaultRows?: number;
}

export interface AnimationAutoSliceDialogResult {
  columns: number;
  rows: number;
}

export interface AnimationAutoSliceDialogInstance {
  id: string;
  params: AnimationAutoSliceDialogParams;
  resolve: (result: AnimationAutoSliceDialogResult | null) => void;
}

@injectable()
export class AnimationAutoSliceDialogService {
  private activeDialog: AnimationAutoSliceDialogInstance | null = null;
  private listeners = new Set<(activeDialog: AnimationAutoSliceDialogInstance | null) => void>();
  private nextId = 0;

  async showDialog(
    params: AnimationAutoSliceDialogParams
  ): Promise<AnimationAutoSliceDialogResult | null> {
    if (this.activeDialog) {
      return null;
    }

    return new Promise(resolve => {
      const id = `animation-auto-slice-${this.nextId++}`;
      this.activeDialog = {
        id,
        params,
        resolve: (result: AnimationAutoSliceDialogResult | null) => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve(result);
        },
      };

      this.notifyListeners();
    });
  }

  confirm(dialogId: string, result: AnimationAutoSliceDialogResult): void {
    if (this.activeDialog?.id !== dialogId) {
      return;
    }

    this.activeDialog.resolve(result);
  }

  cancel(dialogId: string): void {
    if (this.activeDialog?.id !== dialogId) {
      return;
    }

    this.activeDialog.resolve(null);
  }

  subscribe(listener: (activeDialog: AnimationAutoSliceDialogInstance | null) => void): () => void {
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
