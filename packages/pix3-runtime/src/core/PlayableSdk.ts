/**
 * Playable SDK shim — the engine-level surface games call for the two staples
 * of playable-ad/prototype builds: opening the store page (CTA) and reporting
 * that the game has ended.
 *
 * In a plain browser build `openStore` falls back to `window.open`; when an ad
 * network runtime exposes `mraid.open` it is preferred automatically. Network
 * adapters (DAPI, AppLovin, etc.) can hook in later via `setPlayableAdapter`
 * without touching game code.
 */

export interface PlayableAdapter {
  openStore?(url: string): void;
  gameEnd?(): void;
}

type GameEndListener = () => void;

interface MraidLike {
  open?: (url: string) => void;
}

let adapter: PlayableAdapter | null = null;
let defaultStoreUrl = '';
let gameEnded = false;
const gameEndListeners = new Set<GameEndListener>();

/** Install a network-specific adapter (MRAID/DAPI wrappers, test doubles). */
export function setPlayableAdapter(next: PlayableAdapter | null): void {
  adapter = next;
}

/** Configure the store URL used when `openStore()` is called without one. */
export function setDefaultStoreUrl(url: string): void {
  defaultStoreUrl = typeof url === 'string' ? url.trim() : '';
}

export const playable = {
  /**
   * Open the app-store page (the CTA action). Resolution order: explicit URL
   * argument → configured default URL. Delivery: installed adapter →
   * `mraid.open` when present → `window.open`.
   */
  openStore(url?: string): void {
    const targetUrl = (url ?? '').trim() || defaultStoreUrl;
    if (!targetUrl) {
      console.warn('[PlayableSdk] openStore called without a store URL.');
      return;
    }

    if (adapter?.openStore) {
      adapter.openStore(targetUrl);
      return;
    }

    const mraid = (globalThis as { mraid?: MraidLike }).mraid;
    if (mraid?.open) {
      mraid.open(targetUrl);
      return;
    }

    if (typeof window !== 'undefined') {
      window.open(targetUrl, '_blank', 'noopener');
    }
  },

  /** Report that the playable session is over (end screen reached). */
  gameEnd(): void {
    if (gameEnded) {
      return;
    }
    gameEnded = true;
    adapter?.gameEnd?.();
    for (const listener of gameEndListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[PlayableSdk] gameEnd listener failed:', error);
      }
    }
  },

  hasGameEnded(): boolean {
    return gameEnded;
  },

  /** Subscribe to `gameEnd`; returns an unsubscribe function. */
  onGameEnd(listener: GameEndListener): () => void {
    gameEndListeners.add(listener);
    return () => gameEndListeners.delete(listener);
  },

  /** Reset session state (used when a scene restarts). */
  reset(): void {
    gameEnded = false;
  },
};
