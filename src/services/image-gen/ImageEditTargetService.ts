import { injectable } from '@/fw/di';

/**
 * An image the Generate panel produced, handed to whatever surface is currently
 * editing pixels. Carries the prompt so the receiving editor can seed its save
 * name the way an in-shell generation used to.
 */
export interface GeneratedImagePayload {
  readonly blob: Blob;
  readonly mimeType: string;
  /** Prompt that produced the image; `''` when it has none (a re-used crop bake). */
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * What the Generate panel is allowed to know about the editor it is bound to.
 * Deliberately data-only — the panel never reaches into a component (§9.8, the
 * `AnimationEditorService` precedent).
 */
export interface ImageEditTargetSnapshot {
  /** Editor-tab id of the shell that owns the canvas. */
  readonly targetId: string;
  /** Short human label for the "apply to" affordance — `ex0059.png`, `walk.pix3anim`. */
  readonly label: string;
  /** Project path of the resource the editor is bound to, or null for an unsaved canvas. */
  readonly resourcePath: string | null;
  /**
   * Texture file the canvas currently stands in for on behalf of an animation frame
   * (§9.5), or null when it edits a bare image. C7 turns this into "apply to current
   * frame"; C6b only reports it so the panel can say what would happen.
   */
  readonly boundFrameTexturePath: string | null;
  /**
   * Whether the target can write a generated image back into the bound frame.
   * False until C7 lands `replaceFrameTexture` — until then applying to a
   * frame-bound canvas would silently vanish on the next frame click.
   */
  readonly acceptsFrameWriteBack: boolean;
}

/**
 * Implemented by an editor that owns a raster canvas (today: the Sprite Editor
 * shell). Registered with {@link ImageEditTargetService} while its tab is active.
 */
export interface ImageEditTarget {
  getImageEditSnapshot(): ImageEditTargetSnapshot;
  /** Fires whenever {@link getImageEditSnapshot} would return something different. */
  subscribeImageEditTarget(listener: () => void): () => void;
  /** Make `image` the target's working image. */
  applyGeneratedImage(image: GeneratedImagePayload): void;
}

export interface ImageEditTargetContextSnapshot {
  readonly target: ImageEditTarget | null;
  readonly targetSnapshot: ImageEditTargetSnapshot | null;
}

type ImageEditTargetListener = (snapshot: ImageEditTargetContextSnapshot) => void;

/**
 * Mediates between the dockable Generate panel and whatever image editor is
 * active, so neither holds a reference to the other. Shaped after
 * `AnimationEditorService` (§9.3): an active-target reference plus a listener set,
 * letting a panel in a completely different dock render UI for the active
 * document.
 *
 * With no target registered the Generate panel still generates — it just offers to
 * save the result into the project instead of pushing it onto a canvas.
 */
@injectable()
export class ImageEditTargetService {
  private activeTarget: ImageEditTarget | null = null;
  private listeners = new Set<ImageEditTargetListener>();
  /** Unsubscribes from the *current* target's own change notifications. */
  private disposeTargetSubscription: (() => void) | null = null;

  getActiveTarget(): ImageEditTarget | null {
    return this.activeTarget;
  }

  getSnapshot(): ImageEditTargetContextSnapshot {
    return {
      target: this.activeTarget,
      targetSnapshot: this.activeTarget?.getImageEditSnapshot() ?? null,
    };
  }

  setActiveTarget(target: ImageEditTarget | null): void {
    if (target === this.activeTarget) {
      return;
    }

    this.disposeTargetSubscription?.();
    this.disposeTargetSubscription = null;
    this.activeTarget = target;
    // Re-broadcast the target's own changes (frame selection, rebind) so the
    // panel's "apply to" affordance never goes stale.
    this.disposeTargetSubscription =
      target?.subscribeImageEditTarget(() => this.notifyListeners()) ?? null;
    this.notifyListeners();
  }

  /**
   * Deregister `target`, but only if it is still the active one. Two shells can be
   * open at once and Golden Layout tears the old one down *after* the new one
   * registers, so an unconditional clear would blank a live binding.
   */
  clearActiveTarget(target: ImageEditTarget): void {
    if (this.activeTarget === target) {
      this.setActiveTarget(null);
    }
  }

  /** Push a generated image at the active target. Returns false when there is none. */
  applyGeneratedImage(image: GeneratedImagePayload): boolean {
    const target = this.activeTarget;
    if (!target) {
      return false;
    }
    target.applyGeneratedImage(image);
    return true;
  }

  subscribe(listener: ImageEditTargetListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposeTargetSubscription?.();
    this.disposeTargetSubscription = null;
    this.listeners.clear();
    this.activeTarget = null;
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
