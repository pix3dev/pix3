import { Vector2 } from 'three';
import { Camera3D } from '../nodes/3D/Camera3D';
import type { Camera2D } from '../nodes/2D/Camera2D';
import { NodeBase } from '../nodes/NodeBase';
import { Collision2DService } from './Collision2DService';
import { Physics2DService } from './Physics2DService';
import { NetworkService } from '../net/NetworkService';
import { NetworkNodeBinder } from './NetworkNodeBinder';
import { GameTime } from './GameTime';
import { GameCommandRegistry } from './GameCommands';
import { JuiceApi } from './JuiceApi';
import { TweenApi } from './TweenApi';
import { AudioApi } from './AudioApi';
import { CutsceneApi } from './CutsceneApi';
import type { InputService } from './InputService';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ECSService } from './ECSService';
import type { ResourceManager } from './ResourceManager';
import type { SceneRaycastHit } from './raycast';
import { LocalizationService } from './localization/LocalizationService';
/** Options for {@link SceneService.flash}. */
export interface FlashOptions {
    /** CSS color of the flash overlay (default `#ffffff`). */
    color?: string;
    /** Peak opacity 0..1 the overlay snaps to before fading (default `1`). */
    intensity?: number;
    /** Fade-out duration in seconds (default `0.2`). */
    durationSec?: number;
}
export type ViewportOrientation = 'portrait' | 'landscape';
export interface ViewportInfo {
    width: number;
    height: number;
    orientation: ViewportOrientation;
    aspect: number;
}
export type ViewportChangeListener = (info: ViewportInfo) => void;
export interface FrameProfilerActivity {
    readonly label: string;
    readonly selfTimeMs: number;
    readonly totalTimeMs?: number;
}
/**
 * Delegate interface implemented by SceneRunner to expose scene internals
 * without creating circular dependencies.
 */
export interface SceneServiceDelegate {
    getActiveCameraNode(): Camera3D | null;
    getActiveCamera2DNode(): Camera2D | null;
    getInputService(): InputService;
    getUICamera(): import('three').Camera | null;
    getLogicalCameraSize(): {
        width: number;
        height: number;
    };
    setActiveCameraNode(camera: Camera3D | null): void;
    findNodeById(id: string): NodeBase | null;
    getRootNodes(): NodeBase[];
    getAudioService(): AudioService;
    getLocalizationService?(): LocalizationService | null;
    getAssetLoader(): AssetLoader;
    getResourceManager(): ResourceManager;
    getECSService(): ECSService | null;
    getGameTime(): GameTime;
    /**
     * The runner's current frame number, used to stamp the command journal
     * ({@link SceneService.commands}). Optional so a delegate stub in a test can
     * skip it; the registry then stamps `0`.
     */
    getFrameNumber?(): number;
    raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
    reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void;
    /**
     * Read a `.pix3scene` by res:// path, parse it, and swap the running scene to
     * it. Resolves once the new scene's loop is ticking. Must NOT register the
     * graph in the shared SceneManager — the runner owns it exclusively.
     */
    loadAndStartScene(path: string): Promise<void>;
    /**
     * Spawn a prefab scene into the running graph (see SceneService.instantiate).
     *
     * `instanceId` overrides the runner's own `spawn:<n>` counter. Replication needs it: passing
     * `net:<netId>` makes every client derive identical child ids for the same entity, which is what
     * lets a spawned child be addressed as `(rootNetId, childPath)` (plan decision D6).
     */
    instantiatePrefab?(path: string, parent?: NodeBase | null, instanceId?: string): Promise<NodeBase>;
}
/** Options for {@link SceneService.changeScene}. */
export interface ChangeSceneOptions {
    /** Visual transition. Default `'fade'`. */
    transition?: 'fade' | 'none';
    /** Fade-out and fade-in duration, EACH, in seconds. Default `0.3`. Ignored for `'none'`. */
    durationSec?: number;
    /** Fired at full black, after the new scene's loop has started, before the fade-in. */
    onLoaded?: () => void;
}
/**
 * SceneService - Provides runtime scene control APIs to game scripts.
 *
 * Injected into nodes and scripts by SceneRunner. Scripts access it via
 * `this.node?.scene` or the `scene` property on the Script base class.
 *
 * Example usage in a script:
 *
 * ```ts
 * // Switch active camera immediately
 * this.scene?.setActiveCamera('camera-node-id');
 *
 * // Switch with fade transition
 * this.scene?.switchCameraWithFade('camera-b-id', 0.5, 0.5, () => {
 *   console.log('Camera switch complete');
 * });
 *
 * // Manual fade control
 * this.scene?.fadeToBlack(0.5, () => {
 *   // do stuff at black screen
 *   this.scene?.fadeFromBlack(0.5);
 * });
 *
 * // Switch to another scene file with a fade transition
 * await this.scene?.changeScene('res://src/assets/scenes/main.pix3scene', {
 *   transition: 'fade',
 *   durationSec: 0.3,
 * });
 * ```
 */
export declare class SceneService {
    private delegate;
    private fadeOverlay;
    private fadeAnimationId;
    private flashOverlay;
    private flashAnimationId;
    private juiceApi;
    private tweenApi;
    private audioApi;
    private inertLocalization;
    private cutsceneApi;
    private collision2dService;
    private physics2dService;
    /** Scene-scoped named intents; see {@link commands}. Cleared by the runner on stop. */
    private commandRegistry;
    /**
     * The multiplayer session. Owned by the SceneRunner **host** (see plan decision D5), installed via
     * {@link setNetworkService}, and deliberately not tied to the scene: it must survive `changeScene`.
     * Lazily replaced by an offline no-op instance when no host installed one.
     */
    private networkService;
    /** Scene-scoped entity↔node bindings; see {@link netNodes}. Recreated per scene, unlike the session. */
    private networkNodeBinder;
    /** True between {@link handleSceneStarted} and the delegate going away; gates remote spawning. */
    private sceneRunning;
    private readonly scratchPointerUnproject;
    /** Non-null while a {@link changeScene} transition is in flight (re-entrancy guard). */
    private changeScenePromise;
    /** Inert fallback used when no scene is running (editor previews, etc.). */
    private fallbackGameTime;
    private canvas;
    private viewportWidth;
    private viewportHeight;
    private readonly viewportListeners;
    /**
     * Called by SceneRunner to provide access to scene internals.
     */
    setDelegate(delegate: SceneServiceDelegate | null): void;
    /**
     * Called by SceneRunner once the new scene is running and every component has had its `onStart`.
     * The counterpart of the teardown branch in {@link setDelegate}: a snapshot that landed while the
     * scene was still loading left its entities on the binder's pending list, and this is the moment
     * they can finally be instantiated. Without it, a peer's avatar only appears on the next entity
     * change — or never, in a scene that has no networked node of its own to trigger a reconcile.
     */
    handleSceneStarted(): void;
    /**
     * Called by SceneRunner to associate the canvas (used for fade overlay positioning).
     */
    attachCanvas(canvas: HTMLCanvasElement): void;
    /**
     * Clean up the overlay and cancel any in-progress fade.
     */
    dispose(): void;
    /**
     * Global time-scale controller for hitstop / slow-motion (P0.3). Scales the
     * per-frame delta fed to all gameplay. Example: `this.scene.time.hitstop(80)`.
     * Falls back to an inert controller when no scene is running.
     */
    get time(): GameTime;
    /**
     * Fire-and-forget juice primitives — `shake` / `punchScale` / `popIn` /
     * `flash`. Same effects as the `core:*` behavior presets. Example:
     * `this.scene.juice.shake('camera', { amplitude: 12 })`.
     */
    get juice(): JuiceApi;
    /**
     * Godot-style tweens — `this.scene.tween.to(node, { x: 300, opacity: 0 }, { durationSec: 0.4 })`,
     * plus `fadeIn` / `fadeOut` / `crossFade` / `killAll`. Ticked on scaled game time
     * like the rest of the juice, and dropped when the scene stops.
     */
    get tween(): TweenApi;
    /**
     * Advance every running tween. Called by `SceneRunner` each frame with the SCALED
     * delta; deliberately not lazy, so a scene that never tweened pays one null check.
     */
    updateTweens(dt: number): void;
    /**
     * Cancel every tween. Called by `SceneRunner.stop()` next to {@link clearCommands}
     * (and by {@link dispose}) — a tween closure must never outlive its graph.
     */
    clearTweens(): void;
    /**
     * Audio mixer facade — buses (`master`/`music`/`sfx`), snapshots, and
     * one-shot playback by path. Example: `this.scene.audio.play('res://sfx/hit.ogg',
     * { bus: 'sfx', pitchVariation: 0.1 })`. Null-safe when no scene is running.
     */
    get audio(): AudioApi;
    /**
     * Localization service — `tr(key, params)`, `setLocale(locale)`, `trSprite(key)`, `onChange(...)`.
     * Resolves the play-mode instance when a scene is running, else the editor preview instance
     * (globalThis sink), else a null-safe inert instance so `tr` echoes keys instead of throwing.
     * Example: `this.scene.localization.tr('mission.name.2')`.
     */
    get localization(): LocalizationService;
    /**
     * Cutscene Director — play a keyframe clip authored on a node's
     * `core:AnimationPlayer` as a cinematic (letterbox, input lock, skip gesture,
     * one-shot CameraBrain blend override). Example:
     * `await this.scene.cutscene.playCinematic('Intro', { skippableAfter: 2 }).done`.
     */
    get cutscene(): CutsceneApi;
    /**
     * Hard-stop any active cutscene without lazily creating the API. Called by
     * `SceneRunner.stop()` early in teardown so the director's rAF handles, DOM
     * bars, skip listeners and input lock are released while the graph is still
     * live.
     */
    cancelActiveCutscene(): void;
    /**
     * 2D collision queries — `core:Hitbox2D` components register here; gameplay
     * scripts hit-test via `this.scene.collision2d.overlapCircle(x, y, r, 'enemy')`,
     * `overlapPoint`, `overlapRect`, or `raycast(x1, y1, x2, y2, group?)`.
     */
    /**
     * Named game intents — `this.scene.commands.register('start-game', …)` and
     * `this.scene.commands.dispatch('start-game')`. Wire a button's handler to
     * `dispatch` rather than to the method directly: the intent then shows up in
     * `commands.log` with its frame stamp, which is what lets a test prove the
     * binding once and drive the game by intent afterwards.
     *
     * Scene state, like {@link collision2d} and unlike {@link network}: the runner
     * clears it on stop, so the next scene starts with an empty `list()`.
     */
    get commands(): GameCommandRegistry;
    /**
     * Drop every registered command and its journal. Called by
     * `SceneRunner.stop()` after scripts have detached (so an `onDetach` can still
     * dispatch), and deliberately not lazy — a scene that never used commands
     * should not get a registry just because it stopped.
     */
    clearCommands(): void;
    get collision2d(): Collision2DService;
    /**
     * The built-in 2D rigid-body world — `this.scene.physics2d`.
     *
     * Scene state, like {@link collision2d}: constructed on first touch and cleared
     * when the runner stops. A project that never says the word never constructs
     * one, which is also what keeps the solver out of its export (see
     * `strippable-runtime-modules.ts`).
     *
     * Related but different from {@link collision2d}: that one answers *queries*
     * against axis-aligned hitboxes and runs no step; this one simulates. The rule
     * for docs and for choosing: queries only -> Hitbox2D; movement, response,
     * rotation, sensors with enter/exit -> physics2d.
     */
    get physics2d(): Physics2DService;
    /**
     * Advance the physics world, if one was ever constructed. Called by
     * `SceneRunner.runFixedUpdates` next to `ecsService.fixedUpdate`, so physics
     * inherits the fixed step, the per-frame step clamp, and GameTime scaling —
     * hitstop and slow motion dilate the simulation for free.
     */
    stepPhysics2D(dt: number): void;
    /**
     * Collider wireframes for the debug overlay, or `null` when this scene never
     * touched physics. Read by `SceneRunner` each frame while the editor's
     * collider toggle is on — routed through here so the runner never names
     * `Physics2DService` and the export can still strip it.
     */
    buildPhysics2DDebugBuffers(): {
        vertices: Float32Array;
        colors: Float32Array;
    } | null;
    /**
     * Blend physics poses between fixed steps for rendering. No-op when the scene
     * never touched physics. Called once per frame by `SceneRunner`, after the
     * fixed updates and with the same alpha the ECS gets.
     */
    interpolatePhysics2D(alpha: number): void;
    /** Drop every body and collider. Called by `SceneRunner.stop()`. */
    clearPhysics2D(): void;
    /**
     * The multiplayer session — `this.scene.network.connect(...)`, `net.isOnline`, `net.on/emit`,
     * `net.vars`. Every member is offline-safe, so a single-player game may touch it freely: reads
     * return sane defaults and writes are no-ops until something calls `connect()`.
     *
     * Unlike {@link collision2d}, the session is **not** scene state. A host (the runtime bootstrap,
     * the editor's play session, the preview player) constructs one and installs it with
     * {@link setNetworkService}; it then outlives every `changeScene`, because leaving a room just
     * because the game switched levels is exactly the bug D5 exists to prevent. When no host installed
     * one, this getter lazily creates a private, permanently-offline instance so scripts still work.
     */
    get network(): NetworkService;
    /**
     * Installs the host-owned network session. Call once, before the first scene starts; the host keeps
     * ownership and is responsible for `dispose()`. Passing `null` detaches, after which the getter
     * falls back to a fresh offline instance.
     */
    setNetworkService(service: NetworkService | null): void;
    /**
     * Binds replicated entities to scene nodes — `this.scene.netNodes.getNode(netId)`,
     * `getNetId(node)`, `bind(...)`. Unlike {@link network}, this **is** scene state: it instantiates a
     * peer's prefab when its entity enters and frees it when it leaves, so it is recreated per scene.
     * `core:NetworkedNode` and `core:ReplicatedTransform` are the components that drive it.
     */
    get netNodes(): NetworkNodeBinder;
    /**
     * Current pointer position (mouse or touch — unified by InputService) in 2D
     * world/design coordinates (origin center, Y up), or `null` when no scene is
     * running. Unprojects through the live 2D camera, so it stays correct while a
     * `Camera2D` pans/zooms. Godot's `get_global_mouse_position()` equivalent.
     *
     * Reads the **primary** pointer (the oldest one still down; with nothing down,
     * the last hover position) — the single-pointer reading this has always had.
     */
    getPointer2DWorldPosition(target?: Vector2): Vector2 | null;
    /**
     * The same conversion for **one specific finger**, by `pointerId` — the
     * addressed form multi-touch needs: with two fingers on screen the shared
     * position only ever describes one of them, so a game that resolves several
     * contacts (a tapper, a twin-stick) must name the one it means. Returns `null`
     * when that pointer is not down right now; ids come from
     * `input.pointerEvents[].pointerId` / `input.getActivePointers()`.
     *
     * Note a pointer that went down **and up inside the same frame** is already
     * out of the map by the time scripts run, so a tap resolved from a `'down'`
     * frame event should fall back to the un-addressed call.
     */
    getPointer2DWorldPosition(pointerId: number, target?: Vector2): Vector2 | null;
    /**
     * Spawn a prefab `.pix3scene` (exactly one root node) into the running scene
     * — Godot's `instantiate()` + `add_child()`. The subtree gets unique runtime
     * ids, inherits services, and its components `onStart` on the next tick.
     *
     * `parent` may be a node or a node query (id / name / slash-path); default is
     * the first scene root. In 2D the parent decides draw order (tree order).
     * Despawn with `node.dispose()` — it detaches components (firing `onDetach`)
     * and releases resources.
     *
     * ```ts
     * const enemy = await this.scene.instantiate(
     *   'res://src/assets/prefabs/balloon.pix3scene',
     *   { parent: 'enemies' }
     * );
     * enemy.position.set(320, 120, 0);
     * ```
     */
    instantiate(path: string, options?: {
        parent?: NodeBase | string | null;
        instanceId?: string;
    }): Promise<NodeBase>;
    /** The live InputService for the running scene, or null (editor previews). */
    getInputService(): InputService | null;
    /** The canvas the runtime renders into (used for overlay mounting), or null. */
    getCanvas(): HTMLCanvasElement | null;
    /**
     * Immediately set the active 3D camera by node ID.
     * The specified Camera3D node becomes the primary rendering camera.
     */
    setActiveCamera(nodeId: string): void;
    /**
     * Returns the currently active Camera3D node, or null if none is set.
     *
     * Example usage in a script:
     * ```ts
     * const cam = this.scene?.getActiveCamera();
     * if (cam) cam.fov = 75;
     * ```
     */
    getActiveCamera(): Camera3D | null;
    /**
     * Returns the currently active {@link Camera2D} node driving the 2D pass, or
     * null when no 2D camera is present. Used by the juice API to route
     * `shake('camera2d')` and to fall back for `shake('camera')` in pure-2D scenes.
     */
    getActiveCamera2D(): Camera2D | null;
    /** Root nodes of the running scene. */
    getRootNodes(): NodeBase[];
    /** Find a node anywhere in the scene by its unique id. */
    findNodeById(id: string): NodeBase | null;
    /** Find the first node anywhere in the scene whose name matches. */
    findNodeByName(name: string): NodeBase | null;
    /**
     * Resolve a slash-separated path of node names from the scene roots
     * (e.g. `"UI/Panel/Title"`). The first segment matches a root node.
     */
    findNodeByPath(path: string): NodeBase | null;
    /**
     * Unified node lookup: resolves a query that is a node id, a node name, or a
     * slash-separated path of names. This is the recommended way for scripts to
     * reference other nodes.
     */
    findNode(query: string): NodeBase | null;
    /**
     * Returns the internal orthographic camera used for 2D UI rendering.
     */
    getUICamera(): import('three').Camera | null;
    getAudioService(): AudioService | null;
    getAssetLoader(): AssetLoader | null;
    getResourceManager(): ResourceManager | null;
    getECSService(): ECSService | null;
    raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
    reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void;
    setViewportSize(width: number, height: number): void;
    getViewportInfo(): ViewportInfo;
    getViewportSize(): {
        width: number;
        height: number;
    };
    getLogicalCameraSize(): {
        width: number;
        height: number;
    };
    getOrientation(): ViewportOrientation;
    isPortrait(): boolean;
    isLandscape(): boolean;
    onViewportChanged(listener: ViewportChangeListener): () => void;
    /**
     * Switch to a different camera with a fade-to-black transition.
     * Timeline: fadeOut → (camera switch at black) → fadeIn.
     *
     * @param nodeId          ID of the Camera3D node to switch to
     * @param fadeOutDuration Duration of the fade-to-black in seconds (default 0.5)
     * @param fadeInDuration  Duration of the fade-from-black in seconds (default 0.5)
     * @param onComplete      Optional callback fired after the fade-in completes
     */
    switchCameraWithFade(nodeId: string, fadeOutDuration?: number, fadeInDuration?: number, onComplete?: () => void): void;
    /**
     * Swap the running scene to a different `.pix3scene` file, with an optional
     * fade transition. Godot analogue: `get_tree().change_scene_to_file()`.
     *
     * The target file is read fresh from disk/bundle, so it works identically in
     * the editor's play-mode and in exported builds. The old scene keeps running
     * (under the black overlay) until the new scene parses successfully — a
     * missing or invalid file fades back in and rejects instead of stranding a
     * dead black screen. Loading the *saved* file means unsaved edits to the
     * target scene in an open editor tab won't appear until saved.
     *
     * Overlapping calls are ignored (a warning names it) and return the in-flight
     * transition's promise, so a double-clicked PLAY button is harmless.
     *
     * @param path       Target scene path; the `res://` prefix is optional.
     * @param options    {@link ChangeSceneOptions}.
     */
    changeScene(path: string, options?: ChangeSceneOptions): Promise<void>;
    /**
     * Await a fade in one direction. `cancelFade()` (fired when a competing fade
     * starts) drops the pending `onComplete` silently, so a wall-clock fallback
     * guarantees the returned promise still settles — otherwise the
     * {@link changeScene} re-entrancy guard could wedge forever.
     */
    private awaitFade;
    /**
     * Fade the screen to black over the given duration in seconds.
     * Overlaps any existing fade.
     */
    fadeToBlack(duration: number, onComplete?: () => void): void;
    /**
     * Fade the screen from black over the given duration in seconds.
     * Overlaps any existing fade.
     */
    fadeFromBlack(duration: number, onComplete?: () => void): void;
    /**
     * Instantly set the screen overlay opacity (0 = transparent, 1 = fully black).
     * Useful for snapping to a specific fade state without animation.
     */
    setFadeOpacity(opacity: number): void;
    /**
     * Full-screen impact flash: snap a colored overlay to `intensity`, then fade
     * it to transparent over `durationSec`. Uses a dedicated overlay independent
     * of the fade-to-black one, so a flash never cancels a camera-transition
     * fade. Runs on real (wall-clock) time, so it still plays while the game is
     * frozen by a hitstop — exactly what an impact needs.
     */
    flash(options?: FlashOptions): void;
    private ensureFlashOverlay;
    private cancelFlash;
    private ensureFadeOverlay;
    private cancelFade;
    private animateFade;
    private resolveViewportDimensions;
}
