/**
 * The curated Asset Store scope (`store`) — a read-mostly mirror of the collab server's public
 * catalog, with admin-only writes.
 *
 * Two sources, one scope: the server index is merged over {@link BuiltinLibraryProvider}'s static
 * `public/library/` pack (matched by `manifest.id`, server wins). The pack is the offline fallback
 * and the seed for the catalog, not a source of its own — every item this provider emits is
 * re-stamped with `scope: 'store'`. A failing/unreachable server is therefore NOT an error: it
 * degrades to the fallback pack silently, because "no network" must still show a usable store.
 *
 * Caching is a one-way pull (in-memory index + {@link refresh}); unlike the personal library there
 * is no two-way sync to run, since the server is the only writer of a store item.
 */

import * as ApiClient from '@/services/cloud/ApiClient';
import { BuiltinLibraryProvider } from '@/services/library/BuiltinLibraryProvider';
import { normalizeBundlePath } from '@/services/library/library-path-remap';
import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryProvider,
  StoreCategory,
  StoreItemStatus,
} from '@/services/library/library-types';

/** Admin metadata edit. `manifestPatch` is shallow-merged into the stored manifest. */
export interface StoreItemMetaPatch {
  status?: StoreItemStatus;
  /** `null` clears the category (item then only shows under the aggregate). */
  categoryPath?: string | null;
  featured?: boolean;
  manifestPatch?: Partial<LibraryItemManifest>;
}

/** Shape-check the server manifest before trusting it as a {@link LibraryItemManifest}. */
function toManifest(raw: Record<string, unknown> | null): LibraryItemManifest | null {
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.files)) {
    return null;
  }
  // Only the fields the UI indexes by are checked; the server owns the rest of the shape.
  return raw as unknown as LibraryItemManifest;
}

export class StoreLibraryProvider implements LibraryProvider {
  readonly scope = 'store' as const;

  private readonly listeners = new Set<() => void>();

  private indexPromise: Promise<LibraryItem[]> | null = null;
  private categoriesPromise: Promise<StoreCategory[]> | null = null;
  /** Ids the server served in the last index load — the rest came from the fallback pack. */
  private serverIds = new Set<string>();

  constructor(private readonly fallback: BuiltinLibraryProvider = new BuiltinLibraryProvider()) {}

  isSupported(): boolean {
    return typeof fetch !== 'undefined';
  }

  list(): Promise<LibraryItem[]> {
    if (!this.indexPromise) {
      this.indexPromise = this.loadIndex();
    }
    return this.indexPromise;
  }

  /** Drop the cached index and pull it again (panel open / window focus / after a write). */
  async refresh(): Promise<LibraryItem[]> {
    this.invalidate();
    const items = await this.list();
    this.notify();
    return items;
  }

  async getBundle(id: string): Promise<LibraryBundle | null> {
    const bundle = await this.fetchServerBundle(id);
    if (bundle) {
      // Fire-and-forget popularity ping: one per materialized bundle, never per file. The catch
      // is attached inline on purpose — a detached rejection fails the whole test run.
      ApiClient.pingStoreDownload(id).catch(() => {});
      return bundle;
    }
    return this.fallback.getBundle(id);
  }

  async getPreviewUrl(id: string): Promise<string | null> {
    const items = await this.list();
    if (!this.serverIds.has(id)) {
      return this.fallback.getPreviewUrl(id);
    }
    const preview = items.find(item => item.manifest.id === id)?.manifest.preview;
    return preview ? ApiClient.storeFileUrl(id, normalizeBundlePath(preview)) : null;
  }

  // -- Admin writes ------------------------------------------------------------
  // Every write invalidates the index and notifies, so the aggregate in AssetLibraryService and
  // the panel refresh from the server rather than from a locally-guessed state.

  async put(bundle: LibraryBundle): Promise<LibraryItem> {
    const files = [...bundle.files].map(([path, blob]) => ({
      path: normalizeBundlePath(path),
      blob,
    }));
    const now = Date.now();
    const manifest: LibraryItemManifest = {
      ...bundle.manifest,
      files: files.map(file => file.path),
      createdAt: bundle.manifest.createdAt || now,
      updatedAt: now,
    };

    const response = await ApiClient.uploadStoreItem(manifest.id, manifest, files);
    this.invalidate();
    this.notify();
    // The server decides the effective status (an incomplete bundle stays a draft).
    return { scope: this.scope, manifest: { ...manifest, status: response.status } };
  }

  async delete(id: string): Promise<void> {
    await ApiClient.deleteStoreItem(id);
    this.invalidate();
    this.notify();
  }

  async patchMeta(id: string, patch: StoreItemMetaPatch): Promise<LibraryItem> {
    const { item } = await ApiClient.patchStoreItemMeta(id, {
      status: patch.status,
      categoryPath: patch.categoryPath,
      featured: patch.featured,
      manifestPatch: patch.manifestPatch as Record<string, unknown> | undefined,
    });
    this.invalidate();
    this.notify();

    const manifest = toManifest(item.manifest);
    if (!manifest) {
      throw new Error(`Store item ${id} came back without a usable manifest.`);
    }
    return { scope: this.scope, manifest };
  }

  /** Server taxonomy (flat, `id` is the full path). Cached until the next write. */
  listCategories(): Promise<StoreCategory[]> {
    if (!this.categoriesPromise) {
      this.categoriesPromise = ApiClient.getStoreCategories()
        .then(response => response.categories)
        .catch(() => {
          // Offline: the source config's static categories stay in charge.
          this.categoriesPromise = null;
          return [] as StoreCategory[];
        });
    }
    return this.categoriesPromise;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- internals ---------------------------------------------------------------

  private async loadIndex(): Promise<LibraryItem[]> {
    const fallbackItems = await this.listFallback();

    let serverItems: LibraryItem[];
    try {
      const { items } = await ApiClient.getStoreIndex();
      serverItems = items
        .map(entry => toManifest(entry.manifest))
        .filter((manifest): manifest is LibraryItemManifest => manifest !== null)
        .map(manifest => ({ scope: this.scope, manifest }));
    } catch {
      // Offline / server error: the static pack alone is a valid store, not a failure state.
      this.serverIds = new Set();
      return fallbackItems;
    }

    const merged = new Map<string, LibraryItem>();
    for (const item of fallbackItems) {
      merged.set(item.manifest.id, item);
    }
    for (const item of serverItems) {
      merged.set(item.manifest.id, item);
    }
    this.serverIds = new Set(serverItems.map(item => item.manifest.id));
    return [...merged.values()];
  }

  /** Fallback-pack items, re-scoped to `store` (they render as store content, not a 4th source). */
  private async listFallback(): Promise<LibraryItem[]> {
    if (!this.fallback.isSupported()) {
      return [];
    }
    try {
      const items = await this.fallback.list();
      return items.map(item => ({ scope: this.scope, manifest: item.manifest }));
    } catch {
      return [];
    }
  }

  /** Materialize a server bundle; returns null when the item is not on the server. */
  private async fetchServerBundle(id: string): Promise<LibraryBundle | null> {
    let manifest: LibraryItemManifest | null;
    try {
      const { item } = await ApiClient.getStoreItem(id);
      manifest = toManifest(item.manifest);
    } catch {
      return null;
    }
    if (!manifest) {
      return null;
    }

    const files = new Map<string, Blob>();
    for (const relativePath of manifest.files) {
      const normalized = normalizeBundlePath(relativePath);
      const response = await fetch(ApiClient.storeFileUrl(id, normalized));
      if (!response.ok) {
        return null;
      }
      files.set(normalized, await response.blob());
    }
    return { manifest, files };
  }

  private invalidate(): void {
    this.indexPromise = null;
    this.categoriesPromise = null;
  }

  private notify(): void {
    this.listeners.forEach(listener => {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    });
  }
}
