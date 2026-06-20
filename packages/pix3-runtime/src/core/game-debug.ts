/**
 * Standardised debug-provider contract for games built on the Pix3 runtime.
 *
 * A game (anything that runs on this runtime — in the editor or as an exported
 * build) may expose an optional debug surface so external tooling can inspect
 * and drive its runtime systems: the editor's debug bridge
 * (`window.__PIX3_DEBUG__.game`), Chrome DevTools, an MCP client, or a manual
 * console session.
 *
 * The engine-level bridge already covers generic state (scene graph, nodes,
 * selection, play mode, errors). This contract is for the *game-specific* parts
 * that the engine can't know about — droppable items, physics bodies, custom
 * ECS state — kept behind one stable, typed interface so the same tooling works
 * across every game on the runtime.
 *
 * Everything a provider returns MUST be JSON-serialisable (the consumer sends it
 * across an `evaluate_script` boundary). Return plain DTOs, not live Three.js or
 * physics objects.
 */

/** A JSON-serialisable overview of game state. */
export type GameDebugSnapshot = Record<string, unknown>;

export interface GameDebugProvider {
  /** Stable game identifier, e.g. `'deepcore'`. */
  name: string;
  /** Provider schema version, bumped on breaking shape changes. */
  version?: number;
  /** One-shot high-level overview: counts, aggregate state. */
  snapshot?(): GameDebugSnapshot;
  /** Named, parameterised read queries, e.g. `inspect('droppables')`. */
  inspect?(query: string, args?: unknown): unknown;
  /** Named imperative actions for reproduction/repair, e.g. `action('wakeAll')`. */
  action?(name: string, args?: unknown): unknown;
}

/**
 * Well-known global key. The provider is stored on `globalThis` (not module
 * state) so it bridges across runtime module instances — e.g. when in-editor
 * user scripts resolve `@pix3/runtime` through the editor's import map rather
 * than the same module copy as the consumer.
 */
export const GAME_DEBUG_GLOBAL_KEY = '__PIX3_GAME_DEBUG__';

type GameDebugGlobal = Record<string, GameDebugProvider | undefined>;

/**
 * Register the active game's debug provider. Last registration wins.
 * Returns a disposer that clears it — call it from your runner's
 * `onDetach`/`dispose`. Typically guarded behind the game's own dev flag.
 */
export function registerGameDebug(provider: GameDebugProvider): () => void {
  const store = globalThis as unknown as GameDebugGlobal;
  store[GAME_DEBUG_GLOBAL_KEY] = provider;
  return () => {
    if (store[GAME_DEBUG_GLOBAL_KEY] === provider) {
      delete store[GAME_DEBUG_GLOBAL_KEY];
    }
  };
}

/** Read the currently-registered game debug provider, if any. */
export function getGameDebug(): GameDebugProvider | null {
  const store = globalThis as unknown as GameDebugGlobal;
  return store[GAME_DEBUG_GLOBAL_KEY] ?? null;
}
