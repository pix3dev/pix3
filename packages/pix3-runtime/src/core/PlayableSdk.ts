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

export type PlayableOrientation = 'portrait' | 'landscape';

export interface PlayableViewport {
  readonly width: number;
  readonly height: number;
  readonly orientation: PlayableOrientation;
}

type GameEndListener = () => void;
type ResizeListener = (viewport: PlayableViewport) => void;

interface MraidLike {
  open?: (url: string) => void;
  addEventListener?: (event: string, listener: () => void) => void;
}

/** ironSource/Unity DAPI: `openStoreUrl()` opens the network-configured URL. */
interface DapiLike {
  openStoreUrl?: () => void;
  addEventListener?: (event: string, listener: () => void) => void;
}

let adapter: PlayableAdapter | null = null;
let defaultStoreUrl = '';
let gameEnded = false;
const gameEndListeners = new Set<GameEndListener>();
const resizeListeners = new Set<ResizeListener>();
let resizeHooksInstalled = false;

function readViewport(): PlayableViewport {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const height = typeof window !== 'undefined' ? window.innerHeight : 0;
  return {
    width,
    height,
    orientation: width >= height ? 'landscape' : 'portrait',
  };
}

function notifyResizeListeners(): void {
  const viewport = readViewport();
  for (const listener of resizeListeners) {
    try {
      listener(viewport);
    } catch (error) {
      console.warn('[PlayableSdk] resize listener failed:', error);
    }
  }
}

/**
 * Lazily wires window + ad-network resize signals the first time somebody
 * subscribes. MRAID emits `sizeChange`, DAPI emits `adResized`; both are
 * forwarded through the same listener set as plain window resizes.
 */
function ensureResizeHooks(): void {
  if (resizeHooksInstalled || typeof window === 'undefined') {
    return;
  }
  resizeHooksInstalled = true;

  window.addEventListener('resize', notifyResizeListeners);
  window.addEventListener('orientationchange', notifyResizeListeners);

  const mraid = (globalThis as { mraid?: MraidLike }).mraid;
  mraid?.addEventListener?.('sizeChange', notifyResizeListeners);

  const dapi = (globalThis as { dapi?: DapiLike }).dapi;
  dapi?.addEventListener?.('adResized', notifyResizeListeners);
}

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
   * `dapi.openStoreUrl` (ironSource/Unity; uses the network-configured URL) →
   * `mraid.open` when present → `window.open`.
   */
  openStore(url?: string): void {
    const targetUrl = (url ?? '').trim() || defaultStoreUrl;

    if (adapter?.openStore) {
      if (!targetUrl) {
        console.warn('[PlayableSdk] openStore called without a store URL.');
        return;
      }
      adapter.openStore(targetUrl);
      return;
    }

    const dapi = (globalThis as { dapi?: DapiLike }).dapi;
    if (dapi?.openStoreUrl) {
      // DAPI ignores the URL argument — the network config decides the target.
      dapi.openStoreUrl();
      return;
    }

    if (!targetUrl) {
      console.warn('[PlayableSdk] openStore called without a store URL.');
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

  /** Current viewport size + orientation (playable-ad safe). */
  getViewport(): PlayableViewport {
    return readViewport();
  },

  getOrientation(): PlayableOrientation {
    return readViewport().orientation;
  },

  /**
   * Subscribe to viewport changes (window resize/orientation plus MRAID
   * `sizeChange` / DAPI `adResized`); returns an unsubscribe function.
   */
  onResize(listener: ResizeListener): () => void {
    ensureResizeHooks();
    resizeListeners.add(listener);
    return () => resizeListeners.delete(listener);
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
