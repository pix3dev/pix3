import { SceneManager } from './SceneManager';
import { RuntimeRenderer } from './RuntimeRenderer';
import { type FrameProfilerActivity } from './SceneService';
import type { NetworkService } from '../net/NetworkService';
import { AudioService, type ActiveAudioPlaybackSnapshot } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { type ProjectFontFaceSpec } from './ProjectFontLoader';
import { Camera3D } from '../nodes/3D/Camera3D';
import { NodeBase } from '../nodes/NodeBase';
import { type Batch2DStats } from './batch-2d';
import type { LocalizationConfig } from './localization/localization-types';
import type { RuntimeRendererStatsSnapshot } from './RuntimeRenderer';
import { type ResolvedRuntimeTimeConfig, type RuntimeTimeConfig } from './runtime-time';
/** The frame source of {@link SceneRunner}'s loop — `requestAnimationFrame`'s contract. */
export interface RunnerFrameScheduler {
    request(callback: (timestampMs: number) => void): number;
    cancel(handle: number): void;
}
/**
 * Per-frame stats handed to `subscribeFrameStats` listeners.
 *
 * Two payload tiers. The timing fields (`dt`, `logicMs`, `renderMs`, ...) are
 * exact for the frame they describe — FPS / frame-time history is the whole
 * point of the Profiler. The heavier payloads are refreshed on a cadence
 * instead (see {@link FRAME_SAMPLE_HEAVY_REFRESH_MS}): between refreshes a
 * sample carries the SAME object / array reference as the previous one, so a
 * consumer may compare references to skip work that cannot have changed.
 */
export interface SceneRunnerFrameSample {
    readonly dt: number;
    readonly elapsedTime: number;
    readonly frameNumber: number;
    readonly logicMs: number;
    readonly renderMs: number;
    /**
     * WORK time only — literally `logicMs + renderMs`. **This is NOT the frame
     * duration**; `dt` is. Conflating the two is the bug this field's doc comment
     * exists to prevent: a Profiler that showed `Frame 16.7 ms` next to a
     * `logic 0.3 + render 1.1` breakdown made hours of a real 50-90 ms hitch hunt
     * useless, because it never said that the other ~15 ms was not the game's
     * work at all (the main thread was idle; frames were simply delivered late).
     * Kept under its original name for compatibility — read {@link unaccountedMs}
     * and {@link rafLatenessMs} to find out where a frame actually went.
     */
    readonly totalFrameMs: number;
    /**
     * `max(0, dt*1000 - (logicMs + renderMs))` — wall-clock time inside this frame
     * that the runner did not spend on its own logic or paint: browser compositing,
     * GC, another tab's work, a synchronous shader-program link, or just an idle
     * main thread waiting on a late vsync. When this dominates a long frame, the
     * honest readout is "the game was not the bottleneck".
     *
     * In non-realtime time modes `dt` is the *authored* `fixedDeltaSec` rather than
     * wall clock, so this number describes the simulated frame, not the real one.
     */
    readonly unaccountedMs: number;
    /**
     * `performance.now()` at the rAF callback's entry minus the rAF timestamp the
     * browser handed that callback: how late the frame was delivered, before the
     * runner did anything at all. A large value next to small `logicMs`/`renderMs`
     * is the signature of "not us" — the frame was already late when we got it.
     *
     * `0` for ticks not driven by rAF (manual `stepFrames`, the paint-once call
     * after `startScene`), and identical for every tick of one animation frame in
     * `fixed` mode, since the whole batch shares one callback.
     */
    readonly rafLatenessMs: number;
    /** Draw-call / memory counters; refreshed on the heavy cadence, shared between refreshes. */
    readonly rendererStats: RuntimeRendererStatsSnapshot;
    /** This frame's `FrameProfiler` reports (exact per frame); absent when nothing reported. */
    readonly profilerActivities?: readonly FrameProfilerActivity[];
    /**
     * Active audio playbacks; absent when nothing is playing. Rebuilt the frame the
     * active set changes (so even a one-frame sound is seen) and on the heavy
     * cadence (to advance `elapsedMs`); otherwise the previous array is reused.
     */
    readonly activeAudioPlaybacks?: readonly ActiveAudioPlaybackSnapshot[];
}
type SceneRunnerFrameListener = (sample: SceneRunnerFrameSample) => void;
export declare class SceneRunner {
    private readonly sceneManager;
    private readonly renderer;
    private readonly assetLoader;
    private readonly inputService;
    private readonly sceneService;
    private readonly ecsService;
    private readonly audioService;
    private readonly resourceManager;
    private readonly clock;
    /** Global time-scale controller (hitstop / slow-mo); scales gameplay dt. */
    private readonly gameTime;
    /** True while the mixer is in the slow-mo `'muffled'` snapshot (edge-triggered). */
    private audioMuffled;
    private readonly raycaster;
    private readonly raycastPointer;
    private animationFrameId;
    /** Where the realtime/fixed loop gets its frames (rAF unless the host swaps it). */
    private frameScheduler;
    private isRunning;
    private fixedTimeAccumulator;
    private elapsedTime;
    private frameNumber;
    /** Frame-driver contract (§5.1). Owned here; hosts only forward values in. */
    private timeConfig;
    /** Ticks executed since the last paint — drives `renderEveryNTicks`. */
    private ticksSinceRender;
    /** True for the duration of {@link runOneTick} — reentrancy guard for `stepFrames`. */
    private inTick;
    /** True while the master bus is silenced because the mode is not `'realtime'`. */
    private audioSilenced;
    /** Master volume captured when silencing, restored when the mode returns to realtime. */
    private masterVolumeBeforeSilence;
    private scene;
    private activeCamera;
    /** Highest-priority visible Camera2D driving the 2D ortho pass (null = identity). */
    private activeCamera2D;
    private readonly scratchShake2D;
    private orthographicCamera;
    /** Fixed overlay camera for CanvasLayer2D content (identity, LAYER_2D_OVERLAY,
     * never Camera2D-driven); rendered after post-processing. */
    private overlayCamera;
    /** True this frame when the scene contains a CanvasLayer2D boundary — gates
     * the extra overlay render/raycast passes. */
    private overlay2DActive;
    private viewportSize;
    /** Canvas CSS size maintained by a ResizeObserver so the render loop never
     * queries `clientWidth`/`clientHeight` per frame — those force a synchronous
     * reflow of the host document whenever anything invalidated layout that frame
     * (in-editor that's practically every frame while HUD panels update). */
    private canvasCssSize;
    private canvasSizeObserver;
    private observedCanvas;
    /** Adaptive logical camera dimensions computed from viewportBaseSize + viewport aspect. */
    private logicalCameraSize;
    private readonly rootLayoutAuthoredSize;
    private readonly frameListeners;
    /**
     * How late the browser delivered the animation frame currently being run —
     * see {@link SceneRunnerFrameSample.rafLatenessMs}. Sampled once in
     * {@link tick} (before any frame work) and read by every tick of that frame.
     */
    private currentRafLatenessMs;
    private currentFrameProfilerActivities;
    /** Heavy-payload cache for frame samples; see {@link SceneRunnerFrameSample}. */
    private lastHeavySampleAtMs;
    private cachedRendererStats;
    private cachedAudioPlaybacks;
    private cachedAudioRevision;
    /** Lazily created collider wireframe overlay (only while physics debug is on). */
    private physicsDebugOverlay;
    /** Separate instance: the 2D solver's wireframe uses the orthographic camera. */
    private physics2DDebugOverlay;
    /** Lazily created direction-axis gizmo overlay (only while axes debug is on). */
    private directionAxesOverlay;
    /** Lazily created post-processing composer (only while a PostProcess node is
     * active). Null when no effects are enabled — then the plain two-pass path runs. */
    private postFx;
    /** Phase-3 2D quad batcher (only while enabled). Rebuilt from a fresh scene. */
    private batch2D;
    private batch2DEnabled;
    /** Play-mode localization: its own instance so a game `setLocale` never leaks
     *  into the editor preview. Created in `runGraph`, torn down in `stop()`. */
    private localization;
    /** The active-localization pointer that was live before we started (the editor
     *  preview instance in-editor, or null in exports) — restored on `stop()`. */
    private previousActiveLocalization;
    private localizationUnsub;
    /** The project's web fonts (`ProjectManifest.fonts`), injected by the host before
     *  `startScene`; null = nothing to register. */
    private projectFonts;
    /** Config injected by the host before `startScene` (from the project manifest);
     *  null = no localization block ⇒ an inert default instance. */
    private localizationConfig;
    /** Locale to seed the play instance with (editor's current preview locale), so
     *  "preview ru → Play" starts in ru; null ⇒ config's `defaultLocale`. */
    private seedLocale;
    /**
     * Reused per-frame collector for the render-order walk → batcher input. The
     * entries are pooled too (overwritten in place, truncated only when the mesh
     * count shrinks): `Batch2DSystem.update` reads them synchronously and retains
     * only `entry.mesh`, never the entry object, so recycling is safe. Before
     * this, a fresh `{mesh, order, overlay, visible}` was allocated per 2D mesh
     * per frame — several hundred objects a frame in SkyDefender.
     */
    private readonly ordered2DBuffer;
    private ordered2DCount;
    /** Sink for `assign2DRenderOrder`; a field so the closure is not re-created per frame. */
    private readonly collectOrdered2D;
    constructor(sceneManager: SceneManager, renderer: RuntimeRenderer, audioService: AudioService, assetLoader: AssetLoader, rootLayoutAuthoredSize?: {
        width: number;
        height: number;
    });
    /**
     * Install the host-owned multiplayer session, reachable from scripts as
     * `this.scene.network`. The host constructs it (plan decision D5: the three
     * SceneRunner bootstraps), keeps ownership, and disposes it — the runner only
     * hands it to the SceneService, where it survives every `changeScene`.
     * Nothing auto-connects; a session starts only when something calls
     * `network.connect(...)`.
     */
    setNetworkService(service: NetworkService | null): void;
    /**
     * Enable/disable the Phase-3 2D quad batcher for this runner. Set before
     * `startScene`. When off, the 2D pass is byte-identical to the pre-batching
     * path (source meshes render individually).
     */
    setBatching2DEnabled(enabled: boolean): void;
    /** Current batcher stats for the last frame, or null when batching is off. */
    getBatch2DStats(): Batch2DStats | null;
    /**
     * The web fonts this project ships (`ProjectManifest.fonts`), registered before the first
     * frame. Without them a scene naming a family gets a system substitute — the caption paints
     * at a different width in a different face, which is the gap between a generated UI kit's
     * preview and the game.
     */
    setProjectFonts(fonts: readonly ProjectFontFaceSpec[] | null): void;
    /**
     * Configure play-mode localization. Call before `startScene`. `config` comes
     * from the project manifest's `localization` block (null = no localization);
     * `seedLocale` is the editor's current preview locale so play starts in it
     * (omit in exports to start in `config.defaultLocale`). The generated export
     * bootstrap instead `await`s `setLocale(defaultLocale)` before start (no seed).
     */
    setLocalizationConfig(config: LocalizationConfig | null, seedLocale?: string | null): void;
    /**
     * Start running a specific scene.
     * Clears the current scene, loads the new one, and starts the loop.
     */
    private runtimeGraph;
    startScene(sceneId: string): Promise<void>;
    /**
     * Read a `.pix3scene` by path (res:// prefix optional), parse it, and swap the
     * running scene to it. Used by `SceneService.changeScene`. Parsing goes
     * through `sceneManager.parseScene`, which is a pure passthrough — it does NOT
     * register the graph in the (editor-shared) SceneManager, so the target lives
     * only in this runner's `runtimeGraph`. Throws (leaving the old scene running)
     * if the file is missing or the YAML is invalid.
     */
    loadAndStartScene(path: string): Promise<void>;
    /**
     * True when a {@link stop} landed while this start was still loading its graph — in which case the
     * freshly parsed graph is thrown away here instead of being run.
     *
     * Without this a stop is silently undone by the very start it interrupted: both entry points await
     * a clone before `runGraph` can install it, and `runGraph` unconditionally puts the runner back on
     * the rAF loop. In the editor that left an invisible second game ticking (scripts, physics and
     * audio included) behind the visible one whenever a host swap restarted play mid-load.
     */
    private abandonIfStopped;
    /** Monotonic id source for runtime-spawned prefab instances. */
    private spawnCounter;
    /**
     * Spawn a prefab scene into the RUNNING graph (Godot `instantiate()` +
     * `add_child()` in one call). The subtree gets unique runtime ids, inherits
     * `input`/`scene` from the parent (so component `onStart` fires on the next
     * tick), and honors `initiallyVisible`. Default parent is the first scene
     * root node; despawn with `node.dispose()`.
     */
    instantiatePrefab(path: string, parent?: NodeBase | null, instanceIdOverride?: string): Promise<NodeBase>;
    /**
     * Take exclusive ownership of `graph` and run it, stopping whatever ran
     * before. The graph MUST be runner-private (a fresh clone or a fresh parse) —
     * it is disposed on the next `stop()`, so never pass a graph still registered
     * in the SceneManager or referenced by the editor. Async only for the seed
     * locale table load (see {@link setupLocalization}); everything else is
     * synchronous, and the scene is running by the time the promise resolves.
     */
    private runGraph;
    /**
     * Stand up the play-mode {@link LocalizationService}: configure it from the
     * injected manifest block (or an inert `en` default), point it at the runtime
     * ResourceManager for lazy table loads, stash the previously-active pointer
     * (the editor preview instance), activate this one, and subscribe live
     * re-render. Seeds the editor's preview locale so "preview ru → Play" starts
     * in ru; the seed table load is awaited so the first frame already renders
     * translated (no key→text flash — critical when a paused/background session
     * freezes on the first frame).
     */
    private setupLocalization;
    /** Tear down play-mode localization and restore the editor preview pointer.
     *  Safe to call when localization was never set up (all guards are null-safe). */
    private teardownLocalization;
    private isPaused;
    /**
     * Bumped by every {@link stop}, so a start that is still awaiting its graph can tell that its
     * session was ended underneath it (see {@link abandonIfStopped}).
     */
    private stopEpoch;
    stop(): void;
    /**
     * Drive the loop from another frame source than `requestAnimationFrame` (or `null` for rAF).
     * A host that must keep a game stepping where rAF does not fire — the editor in a hidden tab
     * while an agent runs it — passes a scheduler with the same contract: `request(cb)` calls `cb`
     * once with a timestamp, `cancel(handle)` withdraws it. A frame already armed moves over.
     */
    setFrameScheduler(scheduler: RunnerFrameScheduler | null): void;
    pause(): void;
    resume(): void;
    /** True while the loop is halted by {@link pause} (focus loss / host request). */
    get paused(): boolean;
    /** True while a scene is loaded and the loop is (or can be) ticking. */
    get running(): boolean;
    /**
     * Paint one frame synchronously without advancing game time. For screenshot
     * capture: the WebGL drawing buffer is cleared after compositing
     * (`preserveDrawingBuffer` is off), so pixels must be read in the same task as
     * a render — and a paused / hidden runner has no rAF loop painting at all.
     * Returns false when nothing is running (nothing to paint).
     */
    renderOnce(): boolean;
    /**
     * Look up a node of the *running clone* by its authored nodeId (ids survive the
     * serialize→parse clone one-to-one). For automation/inspection tooling — the
     * returned node is live; do not mutate it outside the property-sink path.
     */
    getLiveNodeById(id: string): NodeBase | null;
    /** Root nodes of the running clone (empty when nothing is running). */
    getLiveRootNodes(): readonly NodeBase[];
    /**
     * The `Camera3D` node the 3D pass is currently rendering through, or null when
     * the scene has none. For automation asking "can the camera see anything" — the
     * answer has to come from the runner rather than from the first Camera3D in the
     * tree, because a script can swap the active one at any time
     * (`SceneService.setActiveCameraNode`) and the swapped-out camera is still a
     * perfectly ordinary node sitting in the graph.
     */
    getActiveCamera3D(): Camera3D | null;
    /**
     * Case-insensitive exact-name lookup over the running clone (first match in
     * forward DFS order, same order as `findNodeById`). Convenience for automation
     * that targets nodes the way a user talks about them ("PlayButton") rather than
     * by id. See `findLiveNodesByName` when the caller must detect duplicates.
     */
    findLiveNodeByName(name: string): NodeBase | null;
    /**
     * Every node of the running clone whose name matches, in forward DFS order, capped at `limit`.
     * Callers that resolve a user- or agent-supplied name use this to notice that the name is
     * ambiguous instead of silently acting on one of several nodes.
     */
    findLiveNodesByName(name: string, limit?: number): NodeBase[];
    /**
     * Project a live node's world position to canvas backing-store pixels — where
     * a synthetic pointer event must land to hit that node. Exact inverse of the
     * pointer→world mapping the runtime's own hit-tests use (`Node2D.pointerToWorld`):
     * 2D nodes go through the Camera2D-driven ortho camera (pan/zoom-correct),
     * overlay-band (CanvasLayer2D) nodes use the identity logical mapping, and 3D
     * nodes project through the active perspective camera. Null when nothing is
     * running, the canvas has no size yet, or the point is unprojectable.
     */
    projectNodeToCanvas(node: NodeBase): {
        x: number;
        y: number;
    } | null;
    /**
     * Project a 2D world point (the same coordinate space node `position`
     * properties use) to canvas backing-store pixels. `overlay: true` selects the
     * fixed CanvasLayer2D mapping (identity camera) instead of the Camera2D view.
     */
    projectWorldPointToCanvas(x: number, y: number, opts?: {
        overlay?: boolean;
    }): {
        x: number;
        y: number;
    } | null;
    private static readonly scratchProject;
    private canvasBackingSize;
    /** True when the node or an ancestor is a CanvasLayer2D (fixed overlay band). */
    private isInOverlayBand;
    /**
     * Replace the frame-driver contract (§5.1). Validation runs before any state
     * is touched, so a rejected config leaves the previous mode intact. Takes
     * effect from the next tick; the fixed-step accumulator and the
     * `renderEveryNTicks` counter are reset so a mid-run switch never inherits a
     * partial step from the mode it left.
     *
     * @throws TypeError on an unknown mode, RangeError on `fixedDeltaSec <= 0`.
     */
    setTimeMode(config: RuntimeTimeConfig): void;
    /** The active frame-driver contract, fully resolved (a copy — safe to keep). */
    getTimeMode(): Readonly<ResolvedRuntimeTimeConfig>;
    /**
     * Run `count` ticks synchronously. Only meaningful in `'manual'` mode — any
     * other mode returns 0 with a warning, because the rAF loop is already the
     * source of ticks and interleaving a manual batch with it would double-step.
     *
     * Returns the number of ticks actually executed: a paused runner returns 0, a
     * call made from inside a tick (a frame listener, a script) returns 0, and a
     * tick that throws past {@link updateGameLogicSafe} ends the batch early.
     */
    stepFrames(count?: number): number;
    /**
     * Silence / restore the master bus on a time-mode change. Edge-triggered (same
     * pattern as the slow-mo muffle above): only a state change touches the mixer,
     * never a per-tick write. The pre-mute volume is remembered rather than assumed
     * to be 1, so a game that authored its own master level gets it back.
     */
    private applyTimeModeAudio;
    /** Arm the next animation frame unless the runner is stopped, paused, manual, or already armed. */
    private scheduleNextFrame;
    /**
     * The rAF driver. Decides *how many* ticks this animation frame is worth and
     * with what dt; {@link runOneTick} is the frame body itself.
     *
     * `rafTimestampMs` is the timestamp `requestAnimationFrame` passes its callback
     * (the frame's nominal start). It is absent on the direct calls this class makes
     * itself (start / resume), which is exactly why those report zero lateness.
     */
    private tick;
    /**
     * One frame of game time: input, fixed updates, ECS, node/script update, and
     * (when the `renderEveryNTicks` counter comes due) a paint. `rawDt` is the
     * delta the driver decided on — wall-clock in realtime, `fixedDeltaSec`
     * otherwise; {@link GameTime} scales it into the gameplay dt on top.
     *
     * Frame listeners are notified on **every** tick, rendered or not: observation
     * must not thin out under a speed-up, since running faster is exactly when the
     * observer is needed. A tick that skipped its paint reports `renderMs: 0`
     * (nothing was submitted), so `totalFrameMs` equals `logicMs` for it and
     * summing `renderMs` across a batch still gives the batch's real paint cost.
     */
    private runOneTick;
    private runFrameBody;
    subscribeFrameStats(listener: SceneRunnerFrameListener): () => void;
    /** De-duped last error surfaced from the per-frame game-logic pass. */
    private lastTickErrorMessage;
    /**
     * Run the per-frame node tick with a hard error boundary. Individual script
     * hooks already isolate themselves (NodeBase.runComponentHook), so this is the
     * belt-and-braces guard for anything else that throws in the update pass — a
     * single throw must never prevent `requestAnimationFrame` from rescheduling
     * and freezing the game. Duplicate consecutive messages are reported once.
     */
    private updateGameLogicSafe;
    /**
     * Keep {@link canvasCssSize} in sync with the canvas's CSS box. Re-observes
     * when the host swaps the canvas element. The observer fires once immediately
     * on `observe()`, so the fallback clientWidth read in {@link render} only
     * happens for the first frame(s) after (re)attach.
     */
    private observeCanvasSize;
    private updateNodes;
    private render;
    /**
     * Draw per-node local-axis gizmos for one layer (debug-only). Gated on the
     * global axes flag the editor's toggle writes; lazily builds the overlay on
     * first use so scenes that never enable it pay nothing. `camera` must be the
     * one the matching content pass used so world-space endpoints line up.
     */
    private renderDirectionAxes;
    /** Draw the 2D content band over the current color buffer (clear depth, keep
     * color, don't repaint the scene background). Shared by both render paths. */
    private renderScene2D;
    /**
     * Godot's "Visible Collision Shapes" for the built-in 2D solver, drawn over the
     * 2D band with the orthographic camera.
     *
     * Distinct from the 3D overlay above it, which draws whatever a *game*
     * published through `registerPhysicsDebugSource` (typically a Rapier world) and
     * needs a 3D camera. A 2D collider lives in design pixels and would land
     * nowhere useful projected through one.
     */
    private renderPhysics2DDebug;
    /** Draw the fixed-HUD overlay band (LAYER_2D_OVERLAY, identity overlay camera)
     * clean over everything — post-processed or plain. Mirrors renderScene2D. */
    private renderOverlay2D;
    /** Last-applied baked-AO suppression state (avoids re-walking every frame). */
    private lastAOSuppress;
    /**
     * AO-mode cascade: resolve the scene's AO mode from its PostProcess node and
     * suppress (or restore) baked aoMaps on all GeometryMesh nodes. Non-baked
     * modes (realtime SSAO / off) suppress baked so it doesn't stack with SSAO.
     * Only re-walks the graph when the decision changes.
     */
    private applyAOModeSuppression;
    /** First active PostProcess node in the running graph, or null. */
    private findActivePostProcessNode;
    private findActiveCamera;
    private findNodeById;
    /**
     * Hot-reload a single property edit onto the *running clone* (P0.5). The clone
     * is an isolated serialize→parse copy of the authored graph, so `nodeId`s match
     * one-to-one; we apply the edit through the same property-schema `setValue`
     * mechanism the loader uses, then mirror the 2D authored-rect capture / anchored
     * reflow that the editor's `UpdateObjectPropertyOperation` performs, so anchored
     * layout does not revert the change on the next frame. Returns `true` when the
     * property was found and applied. The next render (every frame) shows the change.
     */
    applyLivePropertyUpdate(nodeId: string, propertyPath: string, value: unknown): boolean;
    /**
     * Mirrors {@link UpdateObjectPropertyOperation}'s `afterNodePropertyApplied`
     * for the running clone: re-capture the authored layout rect for
     * position/size edits and reflow anchored children of resized containers so
     * the per-frame anchored layout keeps the edited value instead of reverting.
     */
    private afterLivePropertyApplied;
    private captureAnchoredDescendantRects;
    private bindSceneServiceDelegate;
    private reportFrameProfilerActivities;
    /**
     * The runner's own normalized copy of this frame's reports — built fresh by
     * {@link normalizeFrameProfilerActivities} on every report and replaced (never
     * mutated) afterwards, so the reporter cannot reach into it and no defensive
     * per-entry copy is needed. The `.map(spread)` that used to live here doubled
     * the allocation for nothing.
     */
    private getFrameProfilerActivitiesSnapshot;
    private getRendererStatsSample;
    /**
     * Rebuilt when the active set changed since the last sample (revision bump —
     * so a sound that lives a single frame still reaches the Profiler's audio
     * registry) or on the heavy cadence (to advance `elapsedMs`); otherwise the
     * cached list is handed out again by reference.
     */
    private getActiveAudioPlaybackSnapshot;
    private normalizeFrameProfilerActivities;
    private normalizeFrameProfilerValue;
    private runFixedUpdates;
    private flushInstancedNodes;
    private raycastViewport;
    private raycastWithCamera;
    private resolveNodeFromObject;
    /**
     * True only if the object and every ancestor up to the scene root are visible.
     * Mirrors how WebGLRenderer skips an invisible subtree, which Raycaster does not.
     */
    private isObjectVisibleInHierarchy;
    private updateBillboardSprites;
    /**
     * Remove editor-only annotation nodes (`editorOnly: true` — labels, guides,
     * design notes) from a play-mode graph. They render while authoring in the
     * editor viewport but never enter a running scene — and since exported games
     * run scenes through this same runner, they never ship either.
     */
    private stripEditorOnly;
    private isEditorOnly;
    /**
     * Node ids the editor's Peek mask hides, or null when nothing is masked.
     *
     * Handed in from outside because the mask lives nowhere a scene can carry it: `hiddenByEditor` is
     * not serialized, and a play graph is a serialize→parse clone of the authored one, so the flags
     * on the authored nodes cannot reach it. Kept on the runner (not applied once and forgotten) so
     * every restart re-applies it — in Flow the stage restarts after each agent turn, and a mask that
     * silently evaporated there would read as the agent un-hiding things.
     */
    private editorPeekMask;
    /**
     * Tell this runner which nodes the author has Peek-hidden in the editor.
     *
     * Editor-only: exported games never call it (the mask does not live in any file), and it does not
     * touch `visible` / `properties.visible`, so it cannot be mistaken for authored state.
     * Applied immediately when a scene is already running, and on every subsequent start/restart.
     */
    setEditorPeekMask(nodeIds: Iterable<string> | null): void;
    /**
     * Stamp {@link editorPeekMask} onto a freshly built runtime graph.
     *
     * Every node is visited and assigned (rather than only the masked ones being set) so a mask that
     * shrank clears the flags a previous mask left on a re-used graph.
     */
    private applyEditorPeekMask;
    private applyInitialVisibility;
    private readInitialVisibility;
    private toBooleanLike;
    private reflowRoot2DNodes;
    private stopAudioPlayers;
    private detachScripts;
    private notifyFrameListeners;
}
export {};
