/**
 * Facade over the Asset Library providers (store / user / team). Aggregates their item
 * lists, maintains an in-memory search index, and routes bundle reads/writes to the owning
 * provider. UI panels inject this and never touch providers directly.
 *
 * Item data is intentionally NOT kept in `appState` — like the scene graph, items are not
 * UI state. Panels subscribe to this service for change notifications; only UI-only filter
 * state (query/type/scope/selection) lives in `appState.ui`.
 */

import { injectable } from '@/fw/di';
import { LocalLibraryProvider } from '@/services/library/LocalLibraryProvider';
import {
  StoreLibraryProvider,
  type StoreItemMetaPatch,
} from '@/services/library/StoreLibraryProvider';
import {
  filterItems,
  collectTags,
  uniqueSlug,
  type LibraryFilter,
} from '@/services/library/library-search';
import type { StoreSeedResult } from '@/services/library/store-seed';
import type {
  LibraryBundle,
  LibraryItem,
  LibraryProvider,
  LibraryScope,
  StoreCategory,
} from '@/services/library/library-types';

@injectable()
export class AssetLibraryService {
  /** The builtin pack is not registered on its own — it is the store provider's offline fallback. */
  private readonly store = new StoreLibraryProvider();
  private readonly local = new LocalLibraryProvider();
  private readonly providers: readonly LibraryProvider[] = [this.store, this.local];

  private readonly listeners = new Set<() => void>();
  private readonly providerUnsubscribes: Array<() => void> = [];

  private cache: LibraryItem[] | null = null;
  private cachePromise: Promise<LibraryItem[]> | null = null;

  constructor() {
    for (const provider of this.providers) {
      const unsubscribe = provider.subscribe?.(() => {
        this.invalidate();
        this.notify();
      });
      if (unsubscribe) {
        this.providerUnsubscribes.push(unsubscribe);
      }
    }
  }

  /** All items across supported providers, cached until a write invalidates the cache. */
  async getItems(force = false): Promise<LibraryItem[]> {
    if (force) {
      this.invalidate();
    }
    if (this.cache) {
      return this.cache;
    }
    if (!this.cachePromise) {
      this.cachePromise = this.loadItems();
    }
    return this.cachePromise;
  }

  /** Filtered view of the aggregate (substring/token search + type/scope/tag filters). */
  async search(filter: LibraryFilter): Promise<LibraryItem[]> {
    const items = await this.getItems();
    return filterItems(items, filter);
  }

  /** Distinct tags across all items, for the tag-filter UI. */
  async getAllTags(): Promise<string[]> {
    return collectTags(await this.getItems());
  }

  /** Look up a single item by id (from cache; refreshes if the cache is empty). */
  async getItem(id: string): Promise<LibraryItem | null> {
    const items = await this.getItems();
    return items.find(item => item.manifest.id === id) ?? null;
  }

  /** Fetch the full bundle (manifest + file blobs) for an item, routed to its provider. */
  async getItemBundle(id: string): Promise<LibraryBundle | null> {
    const item = await this.getItem(id);
    if (item) {
      const provider = this.providerForScope(item.scope);
      const bundle = await provider?.getBundle(id);
      if (bundle) {
        return bundle;
      }
    }
    // Fallback: probe providers directly (cache may be stale).
    for (const provider of this.providers) {
      if (!provider.isSupported()) {
        continue;
      }
      const bundle = await provider.getBundle(id);
      if (bundle) {
        return bundle;
      }
    }
    return null;
  }

  /** Thumbnail URL for an item, or null when it has no preview. Routed to the provider. */
  async getPreviewUrl(item: LibraryItem): Promise<string | null> {
    const provider = this.providerForScope(item.scope);
    return (await provider?.getPreviewUrl?.(item.manifest.id)) ?? null;
  }

  /**
   * Save a bundle into the personal (user) library. The provider stamps `updatedAt` and
   * normalizes the file list; the returned item reflects what was stored.
   */
  async putUserItem(bundle: LibraryBundle): Promise<LibraryItem> {
    if (!this.local.isSupported()) {
      throw new Error('The personal library requires IndexedDB and OPFS support.');
    }
    const item = await this.local.put(bundle);
    this.invalidate();
    this.notify();
    return item;
  }

  /** Suggest a slug unique among currently-known items (avoids insert-folder collisions). */
  async suggestSlug(name: string): Promise<string> {
    const items = await this.getItems();
    const taken = new Set(items.map(item => item.manifest.slug));
    return uniqueSlug(name, taken);
  }

  /** Delete an item; only user/team-scope providers support deletion. */
  async deleteItem(item: LibraryItem): Promise<void> {
    const provider = this.providerForScope(item.scope);
    if (!provider?.delete) {
      throw new Error(`Items in the ${item.scope} library cannot be deleted.`);
    }
    await provider.delete(item.manifest.id);
    this.invalidate();
    this.notify();
  }

  /** Whether the personal library can persist items in this environment. */
  isUserScopeSupported(): boolean {
    return this.local.isSupported();
  }

  // -- Cloud sync bridge -----------------------------------------------------
  // Narrow delegates to the user-scope provider for LibrarySyncService. Kept here (not by exposing
  // the provider) so cache invalidation stays centralized; the provider already notifies on write,
  // which invalidates this cache and refreshes the UI.

  /** User-scope items only (excludes builtin), for reconciling against the cloud. */
  async listUserItems(): Promise<LibraryItem[]> {
    if (!this.local.isSupported()) {
      return [];
    }
    return this.local.list();
  }

  /** Materialize a user-scope bundle to push to the cloud. */
  getUserBundle(id: string): Promise<LibraryBundle | null> {
    return this.local.getBundle(id);
  }

  /** Write a bundle pulled from the cloud (manifest timestamps preserved). */
  async storeUserItemFromCloud(bundle: LibraryBundle): Promise<void> {
    await this.local.putRemote(bundle);
  }

  /** Apply a cloud deletion locally without leaving a tombstone (the server owns it). */
  async removeUserItemFromCloud(id: string): Promise<void> {
    await this.local.hardDelete(id);
  }

  /** Pending local deletions awaiting a push to the cloud. */
  listUserTombstones() {
    return this.local.listTombstones();
  }

  /** Drop a tombstone once its deletion has been pushed (or is moot). */
  clearUserTombstone(id: string): Promise<void> {
    return this.local.clearTombstone(id);
  }

  // -- Curated store (admin) -------------------------------------------------
  // Same reasoning as the cloud-sync bridge above: narrow delegates instead of exposing the
  // provider, so cache invalidation and change notification stay in one place. Authorization is
  // the server's job — these calls just fail with 401/403 for a non-admin.

  /** Upload/replace a store bundle. A bundle that fails the publish gate stays a draft. */
  async putStoreItem(bundle: LibraryBundle): Promise<LibraryItem> {
    const item = await this.store.put(bundle);
    this.invalidate();
    this.notify();
    return item;
  }

  /** Hard-delete a store item (row + files); the store keeps no tombstones. */
  async deleteStoreItem(id: string): Promise<void> {
    await this.store.delete(id);
    this.invalidate();
    this.notify();
  }

  /** Edit store-only metadata: status, category, featured, or manifest fields. */
  async patchStoreItemMeta(id: string, patch: StoreItemMetaPatch): Promise<LibraryItem> {
    const item = await this.store.patchMeta(id, patch);
    this.invalidate();
    this.notify();
    return item;
  }

  /**
   * Push the bundled starter pack into the server catalog (admin). Idempotent: pack ids are stable,
   * so a second run replaces the same items and keeps whatever status/category they were given.
   */
  async seedStoreFromBuiltinPack(): Promise<StoreSeedResult> {
    const result = await this.store.seedFromFallbackPack();
    this.invalidate();
    this.notify();
    return result;
  }

  /** Server-curated store taxonomy (flat list, `id` is the full path). Empty when offline. */
  getStoreCategories(): Promise<StoreCategory[]> {
    return this.store.listCategories();
  }

  /** Re-pull the store index (panel open / window focus), bypassing the cached list. */
  async refreshStore(): Promise<void> {
    await this.store.refresh();
    this.invalidate();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    for (const unsubscribe of this.providerUnsubscribes) {
      unsubscribe();
    }
    this.providerUnsubscribes.length = 0;
    this.local.dispose();
  }

  // -- internals -------------------------------------------------------------

  private providerForScope(scope: LibraryScope): LibraryProvider | undefined {
    return this.providers.find(provider => provider.scope === scope);
  }

  private async loadItems(): Promise<LibraryItem[]> {
    const perProvider = await Promise.all(
      this.providers.map(async provider => {
        if (!provider.isSupported()) {
          return [] as LibraryItem[];
        }
        try {
          return await provider.list();
        } catch {
          return [] as LibraryItem[];
        }
      })
    );
    const items = perProvider.flat();
    this.cache = items;
    this.cachePromise = null;
    return items;
  }

  private invalidate(): void {
    this.cache = null;
    this.cachePromise = null;
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
