/**
 * Holds the library item currently selected in the Library document so the Inspector can render
 * its details while the Library tab is focused. This is UI-adjacent selection state (like the
 * scene selection bridge), kept out of `appState` because the item payload is not UI state — the
 * Inspector subscribes here and reads `appState.tabs` to decide whether the Library tab is active.
 */

import { injectable } from '@/fw/di';
import type { LibraryItem } from './library-types';
import type { LibrarySourceConfig } from './library-sources';

export interface LibrarySelection {
  readonly item: LibraryItem;
  readonly source: LibrarySourceConfig;
}

@injectable()
export class LibrarySelectionService {
  private selection: LibrarySelection | null = null;
  private readonly listeners = new Set<() => void>();

  getSelection(): LibrarySelection | null {
    return this.selection;
  }

  setSelection(selection: LibrarySelection | null): void {
    if (this.selection?.item.manifest.id === selection?.item.manifest.id) {
      // Same item — still refresh so re-selecting after an edit re-reads the manifest.
      this.selection = selection;
      this.notify();
      return;
    }
    this.selection = selection;
    this.notify();
  }

  clear(): void {
    if (!this.selection) {
      return;
    }
    this.selection = null;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors.
      }
    }
  }
}
