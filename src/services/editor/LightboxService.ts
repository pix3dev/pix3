import { injectable } from '@/fw/di';

/** What the lightbox knows how to show. `other` is the honest "no preview" case. */
export type LightboxItemKind = 'image' | 'markdown' | 'text' | 'other';

/**
 * One thing the lightbox can show full-screen.
 *
 * The caller OWNS `url`: the overlay never creates an object URL and never revokes one, because the
 * panels that open it already keep a diff-revoked blob cache and a second owner would double-free.
 */
export interface LightboxItem {
  readonly kind: LightboxItemKind;
  /** Shown in the overlay's header — a file name, not a sentence. */
  readonly title: string;
  /** Image source (object URL or same-origin path). Required for `image`. */
  readonly url?: string;
  /** Contents for `markdown` / `text`. */
  readonly text?: string;
  /** Project-relative path, when this item is a project file — shown under the title. */
  readonly path?: string;
  /** Byte size, when known — the only useful thing to say about an `other`. */
  readonly sizeBytes?: number;
  readonly mimeType?: string;
}

/** The open request the host element renders, or `null` when the overlay is closed. */
export interface LightboxState {
  readonly items: readonly LightboxItem[];
  readonly index: number;
}

/**
 * Full-screen viewer shared by the references column and the chat (design §3.7).
 *
 * One overlay, not one per surface: "show me that bigger" is the same need whether the picture came
 * from an agent reply or from the file list, and two overlays would be two sets of zoom/keyboard/
 * focus bugs. The host element (`<pix3-lightbox>`) subscribes here and is appended to
 * `document.body` by whoever imports it — deliberately NOT nested in a shell, since every panel in
 * the way clips with `overflow: hidden`.
 *
 * `open` takes a LIST and an index rather than a single item so the arrow keys have somewhere to go:
 * a moodboard is looked at by flipping through it.
 */
@injectable()
export class LightboxService {
  private state: LightboxState | null = null;
  private readonly listeners = new Set<(state: LightboxState | null) => void>();

  open(items: readonly LightboxItem[], index = 0): void {
    if (items.length === 0) {
      return;
    }
    const clamped = Math.min(Math.max(index, 0), items.length - 1);
    this.state = { items, index: clamped };
    this.notify();
  }

  /** Move within the open list; ignored when nothing is open. Wraps around both ends. */
  step(delta: number): void {
    if (!this.state || this.state.items.length === 0) {
      return;
    }
    const count = this.state.items.length;
    const next = (((this.state.index + delta) % count) + count) % count;
    this.state = { items: this.state.items, index: next };
    this.notify();
  }

  close(): void {
    if (!this.state) {
      return;
    }
    this.state = null;
    this.notify();
  }

  get current(): LightboxState | null {
    return this.state;
  }

  /** Subscribe to open/close/step. Fires immediately with the current state. */
  subscribe(listener: (state: LightboxState | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }
}
