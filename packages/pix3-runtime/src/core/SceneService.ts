import { Camera3D } from '../nodes/3D/Camera3D';
import { NodeBase } from '../nodes/NodeBase';
import { LAYER_3D } from '../constants';
import { GameTime } from './GameTime';
import { JuiceApi } from './JuiceApi';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ECSService } from './ECSService';
import type { ResourceManager } from './ResourceManager';
import type { SceneRaycastHit } from './raycast';

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
  getUICamera(): import('three').Camera | null;
  getLogicalCameraSize(): { width: number; height: number };
  setActiveCameraNode(camera: Camera3D | null): void;
  findNodeById(id: string): NodeBase | null;
  getRootNodes(): NodeBase[];
  getAudioService(): AudioService;
  getAssetLoader(): AssetLoader;
  getResourceManager(): ResourceManager;
  getECSService(): ECSService | null;
  getGameTime(): GameTime;
  raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
  reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void;
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
 * ```
 */
export class SceneService {
  private delegate: SceneServiceDelegate | null = null;
  private fadeOverlay: HTMLDivElement | null = null;
  private fadeAnimationId: number | null = null;
  private flashOverlay: HTMLDivElement | null = null;
  private flashAnimationId: number | null = null;
  private juiceApi: JuiceApi | null = null;
  /** Inert fallback used when no scene is running (editor previews, etc.). */
  private fallbackGameTime: GameTime | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private readonly viewportListeners = new Set<ViewportChangeListener>();

  /**
   * Called by SceneRunner to provide access to scene internals.
   */
  setDelegate(delegate: SceneServiceDelegate | null): void {
    this.delegate = delegate;
  }

  /**
   * Called by SceneRunner to associate the canvas (used for fade overlay positioning).
   */
  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  /**
   * Clean up the overlay and cancel any in-progress fade.
   */
  dispose(): void {
    this.cancelFade();
    this.cancelFlash();
    this.fadeOverlay?.remove();
    this.fadeOverlay = null;
    this.flashOverlay?.remove();
    this.flashOverlay = null;
    this.canvas = null;
    this.delegate = null;
    this.viewportListeners.clear();
  }

  // ── Time scale & juice ────────────────────────────────────────────────────

  /**
   * Global time-scale controller for hitstop / slow-motion (P0.3). Scales the
   * per-frame delta fed to all gameplay. Example: `this.scene.time.hitstop(80)`.
   * Falls back to an inert controller when no scene is running.
   */
  get time(): GameTime {
    const fromDelegate = this.delegate?.getGameTime();
    if (fromDelegate) {
      return fromDelegate;
    }
    if (!this.fallbackGameTime) {
      this.fallbackGameTime = new GameTime();
    }
    return this.fallbackGameTime;
  }

  /**
   * Fire-and-forget juice primitives — `shake` / `punchScale` / `popIn` /
   * `flash`. Same effects as the `core:*` behavior presets. Example:
   * `this.scene.juice.shake('camera', { amplitude: 12 })`.
   */
  get juice(): JuiceApi {
    if (!this.juiceApi) {
      this.juiceApi = new JuiceApi(this);
    }
    return this.juiceApi;
  }

  // ── Camera control ──────────────────────────────────────────────────────────

  /**
   * Immediately set the active 3D camera by node ID.
   * The specified Camera3D node becomes the primary rendering camera.
   */
  setActiveCamera(nodeId: string): void {
    if (!this.delegate) {
      console.warn('[SceneService] setActiveCamera: no scene delegate.');
      return;
    }
    const node = this.delegate.findNodeById(nodeId);
    if (!node) {
      console.warn(`[SceneService] setActiveCamera: node "${nodeId}" not found.`);
      return;
    }
    if (!(node instanceof Camera3D)) {
      console.warn(`[SceneService] setActiveCamera: node "${nodeId}" is not a Camera3D.`);
      return;
    }
    node.camera.layers.disableAll();
    node.camera.layers.enable(LAYER_3D);
    this.delegate.setActiveCameraNode(node);
  }

  /**
   * Returns the currently active Camera3D node, or null if none is set.
   *
   * Example usage in a script:
   * ```ts
   * const cam = this.scene?.getActiveCamera();
   * if (cam) cam.fov = 75;
   * ```
   */
  getActiveCamera(): Camera3D | null {
    return this.delegate?.getActiveCameraNode() ?? null;
  }

  // ── Node addressing ───────────────────────────────────────────────────────
  //
  // Unified scene-wide node lookup for scripts. Prefer `findNode()` which
  // resolves a query as an id, a name, or a slash-separated path of names.

  /** Root nodes of the running scene. */
  getRootNodes(): NodeBase[] {
    return this.delegate?.getRootNodes() ?? [];
  }

  /** Find a node anywhere in the scene by its unique id. */
  findNodeById(id: string): NodeBase | null {
    return this.delegate?.findNodeById(id) ?? null;
  }

  /** Find the first node anywhere in the scene whose name matches. */
  findNodeByName(name: string): NodeBase | null {
    for (const root of this.getRootNodes()) {
      const match = root.findByName(name);
      if (match) {
        return match;
      }
    }
    return null;
  }

  /**
   * Resolve a slash-separated path of node names from the scene roots
   * (e.g. `"UI/Panel/Title"`). The first segment matches a root node.
   */
  findNodeByPath(path: string): NodeBase | null {
    const segments = path
      .split('/')
      .map(segment => segment.trim())
      .filter(segment => segment.length > 0);
    if (segments.length === 0) {
      return null;
    }

    const [first, ...rest] = segments;
    const rootMatch = this.getRootNodes().find(root => root.name === first) ?? null;
    if (!rootMatch) {
      return null;
    }
    return rest.length === 0 ? rootMatch : rootMatch.findByPath(rest.join('/'));
  }

  /**
   * Unified node lookup: resolves a query that is a node id, a node name, or a
   * slash-separated path of names. This is the recommended way for scripts to
   * reference other nodes.
   */
  findNode(query: string): NodeBase | null {
    if (query.includes('/')) {
      return this.findNodeByPath(query);
    }
    return this.findNodeById(query) ?? this.findNodeByName(query);
  }

  /**
   * Returns the internal orthographic camera used for 2D UI rendering.
   */
  getUICamera(): import('three').Camera | null {
    return this.delegate?.getUICamera() ?? null;
  }

  getAudioService(): AudioService | null {
    return this.delegate?.getAudioService() ?? null;
  }

  getAssetLoader(): AssetLoader | null {
    return this.delegate?.getAssetLoader() ?? null;
  }

  getResourceManager(): ResourceManager | null {
    return this.delegate?.getResourceManager() ?? null;
  }

  getECSService(): ECSService | null {
    return this.delegate?.getECSService() ?? null;
  }

  raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null {
    return this.delegate?.raycastViewport(normalizedX, normalizedY) ?? null;
  }

  reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void {
    this.delegate?.reportFrameProfilerActivities(activities);
  }

  // ── Viewport APIs ───────────────────────────────────────────────────────────

  setViewportSize(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
    const nextHeight = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;

    if (this.viewportWidth === nextWidth && this.viewportHeight === nextHeight) {
      return;
    }

    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;

    const info = this.getViewportInfo();
    for (const listener of this.viewportListeners) {
      listener(info);
    }
  }

  getViewportInfo(): ViewportInfo {
    const dimensions = this.resolveViewportDimensions();
    const orientation: ViewportOrientation =
      dimensions.width >= dimensions.height ? 'landscape' : 'portrait';

    return {
      width: dimensions.width,
      height: dimensions.height,
      orientation,
      aspect: dimensions.height > 0 ? dimensions.width / dimensions.height : 1,
    };
  }

  getViewportSize(): { width: number; height: number } {
    const info = this.getViewportInfo();
    return { width: info.width, height: info.height };
  }

  getLogicalCameraSize(): { width: number; height: number } {
    return this.delegate?.getLogicalCameraSize() ?? this.getViewportSize();
  }

  getOrientation(): ViewportOrientation {
    return this.getViewportInfo().orientation;
  }

  isPortrait(): boolean {
    return this.getOrientation() === 'portrait';
  }

  isLandscape(): boolean {
    return this.getOrientation() === 'landscape';
  }

  onViewportChanged(listener: ViewportChangeListener): () => void {
    this.viewportListeners.add(listener);
    listener(this.getViewportInfo());

    return () => {
      this.viewportListeners.delete(listener);
    };
  }

  /**
   * Switch to a different camera with a fade-to-black transition.
   * Timeline: fadeOut → (camera switch at black) → fadeIn.
   *
   * @param nodeId          ID of the Camera3D node to switch to
   * @param fadeOutDuration Duration of the fade-to-black in seconds (default 0.5)
   * @param fadeInDuration  Duration of the fade-from-black in seconds (default 0.5)
   * @param onComplete      Optional callback fired after the fade-in completes
   */
  switchCameraWithFade(
    nodeId: string,
    fadeOutDuration: number = 0.5,
    fadeInDuration: number = 0.5,
    onComplete?: () => void
  ): void {
    this.fadeToBlack(fadeOutDuration, () => {
      this.setActiveCamera(nodeId);
      this.fadeFromBlack(fadeInDuration, onComplete);
    });
  }

  // ── Screen fades ────────────────────────────────────────────────────────────

  /**
   * Fade the screen to black over the given duration in seconds.
   * Overlaps any existing fade.
   */
  fadeToBlack(duration: number, onComplete?: () => void): void {
    this.ensureFadeOverlay();
    if (!this.fadeOverlay) return;
    const currentOpacity = parseFloat(this.fadeOverlay.style.opacity ?? '0');
    this.cancelFade();
    this.animateFade(currentOpacity, 1, duration, onComplete);
  }

  /**
   * Fade the screen from black over the given duration in seconds.
   * Overlaps any existing fade.
   */
  fadeFromBlack(duration: number, onComplete?: () => void): void {
    this.ensureFadeOverlay();
    if (!this.fadeOverlay) return;
    const currentOpacity = parseFloat(this.fadeOverlay.style.opacity ?? '1');
    this.cancelFade();
    this.animateFade(currentOpacity, 0, duration, onComplete);
  }

  /**
   * Instantly set the screen overlay opacity (0 = transparent, 1 = fully black).
   * Useful for snapping to a specific fade state without animation.
   */
  setFadeOpacity(opacity: number): void {
    this.ensureFadeOverlay();
    if (!this.fadeOverlay) return;
    this.cancelFade();
    this.fadeOverlay.style.opacity = String(Math.max(0, Math.min(1, opacity)));
  }

  // ── Impact flash ──────────────────────────────────────────────────────────

  /**
   * Full-screen impact flash: snap a colored overlay to `intensity`, then fade
   * it to transparent over `durationSec`. Uses a dedicated overlay independent
   * of the fade-to-black one, so a flash never cancels a camera-transition
   * fade. Runs on real (wall-clock) time, so it still plays while the game is
   * frozen by a hitstop — exactly what an impact needs.
   */
  flash(options: FlashOptions = {}): void {
    const color =
      typeof options.color === 'string' && options.color.trim() ? options.color.trim() : '#ffffff';
    const intensity = Math.max(0, Math.min(1, options.intensity ?? 1));
    const durationSec = Math.max(0, options.durationSec ?? 0.2);

    this.ensureFlashOverlay();
    const overlay = this.flashOverlay;
    if (!overlay) {
      return;
    }

    this.cancelFlash();
    overlay.style.background = color;

    if (intensity <= 0) {
      overlay.style.opacity = '0';
      return;
    }

    overlay.style.opacity = String(intensity);

    const durationMs = durationSec * 1000;
    if (durationMs === 0) {
      overlay.style.opacity = '0';
      return;
    }

    const startTime = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - startTime) / durationMs, 1);
      overlay.style.opacity = String(intensity * (1 - t));
      if (t < 1) {
        this.flashAnimationId = requestAnimationFrame(step);
      } else {
        this.flashAnimationId = null;
      }
    };
    this.flashAnimationId = requestAnimationFrame(step);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private ensureFlashOverlay(): void {
    if (this.flashOverlay) {
      return;
    }

    const parent = this.canvas?.parentElement;
    if (!parent) {
      console.warn('[SceneService] Cannot create flash overlay: canvas has no parent element.');
      return;
    }

    const parentStyle = getComputedStyle(parent);
    if (parentStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    this.flashOverlay = document.createElement('div');
    this.flashOverlay.style.cssText = [
      'position: absolute',
      'inset: 0',
      'background: #ffffff',
      'opacity: 0',
      'pointer-events: none',
      // Above the fade-to-black overlay (9999) so an impact flash reads on top.
      'z-index: 10000',
    ].join('; ');

    parent.appendChild(this.flashOverlay);
  }

  private cancelFlash(): void {
    if (this.flashAnimationId !== null) {
      cancelAnimationFrame(this.flashAnimationId);
      this.flashAnimationId = null;
    }
  }

  private ensureFadeOverlay(): void {
    if (this.fadeOverlay) return;

    const parent = this.canvas?.parentElement;
    if (!parent) {
      console.warn('[SceneService] Cannot create fade overlay: canvas has no parent element.');
      return;
    }

    // Ensure the parent has a positioning context so `position: absolute` works
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    this.fadeOverlay = document.createElement('div');
    this.fadeOverlay.style.cssText = [
      'position: absolute',
      'inset: 0',
      'background: #000000',
      'opacity: 0',
      'pointer-events: none',
      'z-index: 9999',
    ].join('; ');

    parent.appendChild(this.fadeOverlay);
  }

  private cancelFade(): void {
    if (this.fadeAnimationId !== null) {
      cancelAnimationFrame(this.fadeAnimationId);
      this.fadeAnimationId = null;
    }
  }

  private animateFade(from: number, to: number, duration: number, onComplete?: () => void): void {
    if (!this.fadeOverlay) return;
    const overlay = this.fadeOverlay;
    const durationMs = Math.max(0, duration * 1000);

    if (durationMs === 0) {
      overlay.style.opacity = String(to);
      onComplete?.();
      return;
    }

    const startTime = performance.now();

    const step = (now: number): void => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / durationMs, 1);
      // Simple linear interpolation; easing can be added here if desired
      overlay.style.opacity = String(from + (to - from) * t);

      if (t < 1) {
        this.fadeAnimationId = requestAnimationFrame(step);
      } else {
        this.fadeAnimationId = null;
        onComplete?.();
      }
    };

    this.fadeAnimationId = requestAnimationFrame(step);
  }

  private resolveViewportDimensions(): { width: number; height: number } {
    if (this.viewportWidth > 0 && this.viewportHeight > 0) {
      return {
        width: this.viewportWidth,
        height: this.viewportHeight,
      };
    }

    const canvasWidth = this.canvas?.width ?? 0;
    const canvasHeight = this.canvas?.height ?? 0;
    if (canvasWidth > 0 && canvasHeight > 0) {
      return {
        width: canvasWidth,
        height: canvasHeight,
      };
    }

    if (typeof window !== 'undefined') {
      const devicePixelRatio = Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1;
      const width = Math.max(0, Math.round(window.innerWidth * devicePixelRatio));
      const height = Math.max(0, Math.round(window.innerHeight * devicePixelRatio));
      return { width, height };
    }

    return { width: 0, height: 0 };
  }
}
