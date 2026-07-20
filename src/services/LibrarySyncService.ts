/**
 * Two-way sync of the personal ("user"-scope) Asset Library with the cloud (collab-server).
 *
 * Model: **local-first mirror.** OPFS/IndexedDB is the working copy and stays fully usable
 * offline; the cloud is a per-user backup that lets the library follow the user across devices.
 * Reconciliation is last-write-wins keyed by the stable manifest `id` and an epoch-ms timestamp
 * (`updatedAt` for edits, a tombstone `deletedAt` for deletions). Deletions on both sides use
 * tombstones so a delete on one device propagates instead of the item resurrecting from the peer.
 *
 * Triggers (all debounced/coalesced): sign-in, every local put/delete, and window focus /
 * tab-visible (a cheap pull that avoids waking a background tab on a timer). {@link syncNow}
 * is the manual "Sync now" affordance. Never mutates `appState`; exposes its own observable
 * state like {@link CloudProjectService}.
 */

import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import * as ApiClient from './ApiClient';
import { AssetLibraryService } from './AssetLibraryService';
import type { LibraryBundle, LibraryItemManifest } from './library/library-types';

export type LibrarySyncStatus = 'disabled' | 'idle' | 'syncing' | 'error';

export interface LibrarySyncState {
  /** `disabled` when signed-out or OPFS unsupported; otherwise the last sync outcome. */
  readonly status: LibrarySyncStatus;
  /** Epoch millis of the last successful reconcile, or null if never. */
  readonly lastSyncedAt: number | null;
  /** Human-readable error from the last failed sync (status `error`). */
  readonly error: string | null;
}

const SYNC_DEBOUNCE_MS = 800;

@injectable()
export class LibrarySyncService {
  @inject(AssetLibraryService)
  private readonly library!: AssetLibraryService;

  private state: LibrarySyncState = { status: 'disabled', lastSyncedAt: null, error: null };
  private readonly listeners = new Set<(state: LibrarySyncState) => void>();

  private initialized = false;
  private running = false;
  private rerunRequested = false;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly disposers: Array<() => void> = [];

  /** Wire triggers and run an initial sync if already signed in. Idempotent. */
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    let wasAuthenticated = appState.auth.isAuthenticated;
    this.setStatus(wasAuthenticated && this.library.isUserScopeSupported() ? 'idle' : 'disabled');

    const authDispose = subscribe(appState.auth, () => {
      const isAuthenticated = appState.auth.isAuthenticated;
      if (isAuthenticated === wasAuthenticated) {
        return;
      }
      wasAuthenticated = isAuthenticated;
      if (isAuthenticated) {
        this.scheduleSync();
      } else {
        this.setState({ status: 'disabled', lastSyncedAt: null, error: null });
      }
    });
    this.disposers.push(authDispose);

    // Local put/delete → push. Ignored while a sync is running (those writes are our own pulls).
    this.disposers.push(
      this.library.subscribe(() => {
        if (!this.running) {
          this.scheduleSync();
        }
      })
    );

    if (typeof window !== 'undefined') {
      const onFocus = () => this.scheduleSync();
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          this.scheduleSync();
        }
      };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisible);
      this.disposers.push(() => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisible);
      });
    }

    if (wasAuthenticated && this.library.isUserScopeSupported()) {
      this.scheduleSync();
    }
  }

  getState(): LibrarySyncState {
    return this.state;
  }

  subscribe(fn: (state: LibrarySyncState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** Manual trigger ("Sync now"): runs immediately, coalescing with any in-flight sync. */
  async syncNow(): Promise<void> {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    await this.runSync();
  }

  dispose(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.listeners.clear();
    this.initialized = false;
  }

  // -- Scheduling ------------------------------------------------------------

  private scheduleSync(): void {
    if (!appState.auth.isAuthenticated || !this.library.isUserScopeSupported()) {
      return;
    }
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      void this.runSync();
    }, SYNC_DEBOUNCE_MS);
  }

  // -- Reconcile -------------------------------------------------------------

  private async runSync(): Promise<void> {
    if (!appState.auth.isAuthenticated || !this.library.isUserScopeSupported()) {
      this.setStatus('disabled');
      return;
    }
    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    this.running = true;
    this.setStatus('syncing');
    let hadError = false;
    try {
      const remote = await ApiClient.getLibraryIndex();
      const remoteById = new Map(remote.items.map(entry => [entry.id, entry]));

      const liveItems = await this.library.listUserItems();
      const liveById = new Map(liveItems.map(item => [item.manifest.id, item]));
      const tombstones = await this.library.listUserTombstones();
      const tombById = new Map(tombstones.map(tomb => [tomb.id, tomb]));

      const ids = new Set<string>([...remoteById.keys(), ...liveById.keys(), ...tombById.keys()]);

      for (const id of ids) {
        try {
          await this.reconcileItem(
            id,
            remoteById.get(id) ?? null,
            liveById.get(id)?.manifest ?? null,
            tombById.get(id)?.deletedAt ?? null
          );
        } catch (error) {
          hadError = true;
          console.warn('[LibrarySyncService] Failed to reconcile item', id, error);
        }
      }

      if (hadError) {
        this.setState({
          status: 'error',
          lastSyncedAt: this.state.lastSyncedAt,
          error: 'Some items failed to sync. They will retry on the next sync.',
        });
      } else {
        this.setState({ status: 'idle', lastSyncedAt: Date.now(), error: null });
      }
    } catch (error) {
      const status = this.classifyError(error);
      this.setState({
        status,
        lastSyncedAt: this.state.lastSyncedAt,
        error: status === 'error' ? this.describeError(error) : null,
      });
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.scheduleSync();
      }
    }
  }

  /**
   * Reconcile one item id. `localTs` is the live manifest's updatedAt or the tombstone's
   * deletedAt; live and deleted are mutually exclusive locally (put clears the tombstone),
   * so at most one of `liveManifest`/`tombstoneAt` is set.
   */
  private async reconcileItem(
    id: string,
    remote: ApiClient.LibraryIndexEntry | null,
    liveManifest: LibraryItemManifest | null,
    tombstoneAt: number | null
  ): Promise<void> {
    const localKind: 'live' | 'deleted' | 'none' = liveManifest
      ? 'live'
      : tombstoneAt !== null
        ? 'deleted'
        : 'none';
    const localTs = liveManifest?.updatedAt ?? tombstoneAt ?? 0;

    const remoteKind: 'live' | 'deleted' | 'none' = !remote
      ? 'none'
      : remote.deleted
        ? 'deleted'
        : 'live';
    const remoteTs = remote?.updatedAt ?? 0;

    // Remote absent: push local state, or drop a moot tombstone the server never knew about.
    if (remoteKind === 'none') {
      if (localKind === 'live') {
        await this.pushItem(id);
      } else if (localKind === 'deleted') {
        await this.library.clearUserTombstone(id);
      }
      return;
    }

    // Local absent: adopt the remote (pull), ignore a remote tombstone (already absent here).
    if (localKind === 'none') {
      if (remoteKind === 'live') {
        await this.pullItem(id, remote!);
      }
      return;
    }

    // Both sides present in some form → last-write-wins.
    if (localTs > remoteTs) {
      if (localKind === 'live') {
        await this.pushItem(id);
      } else {
        await this.pushDelete(id, localTs);
      }
      return;
    }

    // Remote wins (newer or a tie — prefer the already-persisted remote state).
    if (remoteKind === 'live') {
      await this.pullItem(id, remote!);
      await this.library.clearUserTombstone(id);
    } else {
      // Remote deletion wins: remove locally without a new tombstone (server owns it).
      await this.library.removeUserItemFromCloud(id);
      await this.library.clearUserTombstone(id);
    }
  }

  private async pushItem(id: string): Promise<void> {
    const bundle = await this.library.getUserBundle(id);
    if (!bundle) {
      return; // Removed concurrently — a later sync settles it.
    }
    const files = [...bundle.files].map(([path, blob]) => ({ path, blob }));
    await ApiClient.uploadLibraryItem(id, bundle.manifest, files);
  }

  private async pullItem(id: string, entry: ApiClient.LibraryIndexEntry): Promise<void> {
    const manifest = entry.manifest as LibraryItemManifest | null;
    if (!manifest || !Array.isArray(manifest.files)) {
      throw new Error('Remote library item has no manifest');
    }
    const files = new Map<string, Blob>();
    for (const relativePath of manifest.files) {
      const response = await ApiClient.downloadLibraryFile(id, relativePath);
      files.set(relativePath, await response.blob());
    }
    const bundle: LibraryBundle = { manifest, files };
    await this.library.storeUserItemFromCloud(bundle);
  }

  private async pushDelete(id: string, deletedAt: number): Promise<void> {
    await ApiClient.deleteLibraryItem(id, deletedAt);
    await this.library.clearUserTombstone(id);
  }

  // -- State / errors --------------------------------------------------------

  private classifyError(error: unknown): LibrarySyncStatus {
    // A 401 means the session lapsed — treat as signed-out rather than a hard error.
    if (error instanceof ApiClient.ApiClientError && error.status === 401) {
      return 'disabled';
    }
    return 'error';
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Library sync failed.';
  }

  private setStatus(status: LibrarySyncStatus): void {
    this.setState({ ...this.state, status, error: status === 'error' ? this.state.error : null });
  }

  private setState(next: LibrarySyncState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // ignore listener errors
      }
    }
  }
}
