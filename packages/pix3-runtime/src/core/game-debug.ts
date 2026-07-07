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

/**
 * Well-known global key for the **live runtime scene root** (a THREE.Object3D).
 *
 * `SceneRunner` runs the game on an isolated *clone* of the scene in its own
 * `THREE.Scene` — separate from the editor's authoring graph. Tooling that wants
 * to inspect the *actually running* objects (spawned sprites, instanced meshes,
 * falling clusters) must walk this root, not the authored scene graph. Stored on
 * `globalThis` so it bridges across runtime module instances.
 */
export const RUNTIME_SCENE_GLOBAL_KEY = '__PIX3_RUNTIME_SCENE__';

type RuntimeSceneGlobal = Record<string, object | null | undefined>;

/**
 * Register (or clear, with `null`) the live runtime scene root. Called by
 * `SceneRunner` on scene start/stop. Dev tooling reads it via
 * {@link getRuntimeSceneRoot}.
 */
export function registerRuntimeSceneRoot(root: object | null): void {
  const store = globalThis as unknown as RuntimeSceneGlobal;
  store[RUNTIME_SCENE_GLOBAL_KEY] = root ?? undefined;
}

/** The live runtime scene root (THREE.Object3D) if a scene is running, else null. */
export function getRuntimeSceneRoot(): object | null {
  const store = globalThis as unknown as RuntimeSceneGlobal;
  return store[RUNTIME_SCENE_GLOBAL_KEY] ?? null;
}

/**
 * Applies an inspector/debug property edit to the *running clone* by node id.
 * Returns `true` when the property was found and applied on a live node.
 *
 * `SceneRunner` runs the game on an isolated clone (see {@link getRuntimeSceneRoot}),
 * so property edits made through the editor's mutation gateway only touch the
 * authored graph. To make edits hot-reload into the running scene without a
 * restart, `SceneRunner` registers a sink here on scene start (and clears it on
 * stop); the editor's `UpdateObjectPropertyOperation` and the debug bridge push
 * edits through it while playing. Stored on `globalThis` so it bridges runtime
 * module copies, matching the other globals in this module.
 */
export type RuntimeLivePropertySink = (
  nodeId: string,
  propertyPath: string,
  value: unknown
) => boolean;

export const RUNTIME_PROPERTY_SINK_GLOBAL_KEY = '__PIX3_RUNTIME_PROPERTY_SINK__';

type RuntimePropertySinkGlobal = Record<string, RuntimeLivePropertySink | null | undefined>;

/**
 * Register (or clear, with `null`) the live property sink. Called by
 * `SceneRunner` on scene start/stop.
 */
export function registerRuntimeLivePropertySink(sink: RuntimeLivePropertySink | null): void {
  const store = globalThis as unknown as RuntimePropertySinkGlobal;
  store[RUNTIME_PROPERTY_SINK_GLOBAL_KEY] = sink ?? undefined;
}

/** The registered live property sink, if a scene is running, else null. */
export function getRuntimeLivePropertySink(): RuntimeLivePropertySink | null {
  const store = globalThis as unknown as RuntimePropertySinkGlobal;
  return store[RUNTIME_PROPERTY_SINK_GLOBAL_KEY] ?? null;
}

/**
 * Collider/line-segment buffers for visualising physics colliders. Mirrors the
 * shape returned by Rapier's `World.debugRender()`: a flat list of line-segment
 * endpoints (`vertices`, 3 floats per point, 2 points per segment) and optional
 * per-vertex RGBA `colors` (4 floats per point).
 */
export interface PhysicsDebugBuffers {
  vertices: Float32Array | number[];
  colors?: Float32Array | number[];
}

/** A pull-based source the editor calls each frame to draw collider wireframes. */
export type PhysicsDebugSource = () => PhysicsDebugBuffers | null;

/**
 * Well-known global key for the **live physics-debug source**. Physics lives in
 * the game (e.g. a Rapier `World`), opaque to the editor; a game registers a
 * pull function here so dev tooling can read collider geometry on demand without
 * a per-frame JSON round-trip. Stored on `globalThis` to bridge module copies.
 */
export const PHYSICS_DEBUG_GLOBAL_KEY = '__PIX3_PHYSICS_DEBUG__';

type PhysicsDebugGlobal = Record<string, PhysicsDebugSource | null | undefined>;

/**
 * Register (or clear, with `null`) the live physics-debug source. A game calls
 * this from its runner's start/detach (typically wrapping `world.debugRender()`).
 * Returns a disposer that clears it.
 */
export function registerPhysicsDebugSource(source: PhysicsDebugSource | null): () => void {
  const store = globalThis as unknown as PhysicsDebugGlobal;
  store[PHYSICS_DEBUG_GLOBAL_KEY] = source ?? undefined;
  return () => {
    if (store[PHYSICS_DEBUG_GLOBAL_KEY] === source) {
      delete store[PHYSICS_DEBUG_GLOBAL_KEY];
    }
  };
}

/** The registered physics-debug source, if any. Call it to pull current buffers. */
export function getPhysicsDebugSource(): PhysicsDebugSource | null {
  const store = globalThis as unknown as PhysicsDebugGlobal;
  return store[PHYSICS_DEBUG_GLOBAL_KEY] ?? null;
}

/**
 * Well-known global key for the **collider-debug visibility flag**. The editor's
 * collider toggle writes it; the runtime's `SceneRunner` reads it every frame to
 * decide whether to draw the physics wireframe overlay (pulling geometry from
 * the registered {@link PhysicsDebugSource}). Stored on `globalThis` so it
 * bridges module copies — the editor, in-editor user scripts, and the running
 * game may each resolve a separate copy of this module.
 */
export const PHYSICS_DEBUG_ENABLED_KEY = '__PIX3_PHYSICS_DEBUG_ENABLED__';

type PhysicsDebugEnabledGlobal = Record<string, boolean | undefined>;

/** Enable or disable collider wireframe rendering in the runtime. */
export function setPhysicsDebugEnabled(enabled: boolean): void {
  const store = globalThis as unknown as PhysicsDebugEnabledGlobal;
  store[PHYSICS_DEBUG_ENABLED_KEY] = enabled;
}

/** Whether collider wireframe rendering is currently enabled (defaults to false). */
export function isPhysicsDebugEnabled(): boolean {
  const store = globalThis as unknown as PhysicsDebugEnabledGlobal;
  return store[PHYSICS_DEBUG_ENABLED_KEY] === true;
}
