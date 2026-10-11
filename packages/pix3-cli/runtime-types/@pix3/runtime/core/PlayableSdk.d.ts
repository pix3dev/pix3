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
/** Install a network-specific adapter (MRAID/DAPI wrappers, test doubles). */
export declare function setPlayableAdapter(next: PlayableAdapter | null): void;
/** Configure the store URL used when `openStore()` is called without one. */
export declare function setDefaultStoreUrl(url: string): void;
export declare const playable: {
    /**
     * Open the app-store page (the CTA action). Resolution order: explicit URL
     * argument → configured default URL. Delivery: installed adapter →
     * `dapi.openStoreUrl` (ironSource/Unity; uses the network-configured URL) →
     * `mraid.open` when present → `window.open`.
     */
    openStore(url?: string): void;
    /** Current viewport size + orientation (playable-ad safe). */
    getViewport(): PlayableViewport;
    getOrientation(): PlayableOrientation;
    /**
     * Subscribe to viewport changes (window resize/orientation plus MRAID
     * `sizeChange` / DAPI `adResized`); returns an unsubscribe function.
     */
    onResize(listener: ResizeListener): () => void;
    /** Report that the playable session is over (end screen reached). */
    gameEnd(): void;
    hasGameEnded(): boolean;
    /** Subscribe to `gameEnd`; returns an unsubscribe function. */
    onGameEnd(listener: GameEndListener): () => void;
    /** Reset session state (used when a scene restarts). */
    reset(): void;
};
export {};
