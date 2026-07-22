import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { appState } from '@/state';

/**
 * Dependencies the 2D navigation machinery borrows from
 * {@link ViewportRendererService}. Scoped to exactly what this collaborator
 * needs: the facade owns the orthographic camera/controls, the viewport-sizing
 * and screen-projection helpers, the 2D frame/gizmo adornments, and the
 * render-loop pause/dirty flags, and passes them in via closures so this object
 * never reaches back into the facade directly. `appState` is a Valtio global and
 * is imported directly, same as every other collaborator.
 */
export interface ViewportNavigationDeps {
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  getOrthographicControls(): OrbitControls | undefined;
  /** World units per one CSS pixel at the current 2D zoom, or null if unavailable. */
  get2DWorldUnitsPerCssPixel(): THREE.Vector2 | null;
  /** Unproject a screen point onto the 2D world plane, or null if unavailable. */
  screenToWorld2D(screenX: number, screenY: number): THREE.Vector3 | null;
  /** Re-thickness the editor 2D frame adornments after a zoom change. */
  sync2DServiceFrameThickness(): void;
  /** Rescale/reposition the 2D selection gizmo handles. */
  refreshGizmoPositions(): void;
  /** Whether a 2D selection overlay is currently active. */
  hasSelectionOverlay(): boolean;
  /** Recenter the 2D camera to the scene's default view (used as restore fallback). */
  reset2DView(): void;
  /** Whether rendering is currently paused because the window lost focus. */
  shouldPauseForWindowFocus(): boolean;
  /** Whether the viewport render loop is paused. */
  isPaused(): boolean;
  /** Mark the viewport dirty so the next render-loop tick paints. */
  markRenderDirty(): void;
}

/**
 * Owns the 2D camera pan/zoom/momentum state-mutation machinery for the editor
 * viewport. Extracted from ViewportRendererService (decomposition step 10/13).
 * Not `@injectable()` — it is an owned collaborator constructed by the facade
 * with borrowed dependencies. The input-gesture half of 2D navigation (wheel /
 * pointer / touch handling) lives in the separate `Navigation2DController`
 * service, which drives these methods through the facade's public delegates.
 */
export class ViewportNavigation {
  // Gesture handling for 2D navigation
  private panVelocity = { x: 0, y: 0 };
  private momentumAnimationId?: number;

  constructor(private readonly deps: ViewportNavigationDeps) {}

  /**
   * Pan the 2D camera by the given delta in screen space.
   * Only active in 2D mode.
   */
  pan2D(deltaX: number, deltaY: number): void {
    const orthographicControls = this.deps.getOrthographicControls();
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicControls || !orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    // Scale delta by current zoom level so pan feels consistent at any zoom.
    const zoomFactor = orthographicCamera.zoom;
    const scaledDeltaX = deltaX / zoomFactor;
    const scaledDeltaY = deltaY / zoomFactor;
    const panScale = 0.5;

    // Translate both camera position and target so it pans instead of rotating.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(orthographicCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(orthographicCamera.quaternion);
    const panOffset = right
      .multiplyScalar(scaledDeltaX * panScale)
      .add(up.multiplyScalar(-scaledDeltaY * panScale));

    orthographicCamera.position.add(panOffset);
    orthographicControls.target.add(panOffset);

    // Track velocity for momentum animation (unused if handled via OS inertia events)
    this.panVelocity.x = scaledDeltaX * 0.5;
    this.panVelocity.y = -scaledDeltaY * 0.5;
  }

  /**
   * Pan the 2D camera by a drag delta in CSS pixels.
   * This path keeps direct-manipulation panning aligned with the pointer/finger.
   */
  pan2DByDrag(deltaX: number, deltaY: number): void {
    const orthographicControls = this.deps.getOrthographicControls();
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicControls || !orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    const worldUnitsPerCssPixel = this.deps.get2DWorldUnitsPerCssPixel();
    if (!worldUnitsPerCssPixel) {
      return;
    }

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(orthographicCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(orthographicCamera.quaternion);
    const panOffset = right
      .multiplyScalar(deltaX * worldUnitsPerCssPixel.x)
      .add(up.multiplyScalar(-deltaY * worldUnitsPerCssPixel.y));

    orthographicCamera.position.add(panOffset);
    orthographicControls.target.add(panOffset);
    this.panVelocity.x = panOffset.x;
    this.panVelocity.y = panOffset.y;
  }

  /**
   * Zoom the 2D camera by the given factor (multiplied into current zoom).
   * Only active in 2D mode.
   */
  zoom2D(factor: number): void {
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    const newZoom = Math.max(0.1, orthographicCamera.zoom * factor);
    orthographicCamera.zoom = newZoom;
    orthographicCamera.updateProjectionMatrix();
    this.deps.sync2DServiceFrameThickness();

    // Rescale overlay handles to maintain constant screen-space size.
    if (this.deps.hasSelectionOverlay()) {
      this.deps.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  zoom2DAroundPoint(factor: number, screenX: number, screenY: number): void {
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    const anchorBeforeZoom = this.deps.screenToWorld2D(screenX, screenY);
    if (!anchorBeforeZoom) {
      this.zoom2D(factor);
      return;
    }

    const newZoom = Math.max(0.1, orthographicCamera.zoom * factor);
    orthographicCamera.zoom = newZoom;
    orthographicCamera.updateProjectionMatrix();

    const anchorAfterZoom = this.deps.screenToWorld2D(screenX, screenY);
    if (anchorAfterZoom) {
      const anchorDelta = anchorBeforeZoom.sub(anchorAfterZoom);
      orthographicCamera.position.add(anchorDelta);
      this.deps.getOrthographicControls()?.target.add(anchorDelta);
    }

    this.deps.sync2DServiceFrameThickness();
    if (this.deps.hasSelectionOverlay()) {
      this.deps.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  /**
   * Get current 2D zoom level.
   */
  getZoom2D(): number {
    return this.deps.getOrthographicCamera()?.zoom ?? 1;
  }

  /**
   * Set 2D zoom level directly.
   */
  setZoom2D(zoom: number): void {
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicCamera) {
      return;
    }
    const clampedZoom = Math.max(0.1, zoom);
    orthographicCamera.zoom = clampedZoom;
    orthographicCamera.updateProjectionMatrix();
    this.deps.sync2DServiceFrameThickness();

    // Rescale overlay handles to maintain constant screen-space size.
    if (this.deps.hasSelectionOverlay()) {
      this.deps.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  resolve2DAssetDropPosition(screenX: number, screenY: number): THREE.Vector2 | null {
    const worldPoint = this.deps.screenToWorld2D(screenX, screenY);
    if (!worldPoint) {
      return null;
    }

    return new THREE.Vector2(worldPoint.x, worldPoint.y);
  }

  /**
   * Save current 2D camera state to app state for persistence.
   */
  saveZoomToState(): void {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) return;

    const orthographicCamera = this.deps.getOrthographicCamera();
    const orthographicControls = this.deps.getOrthographicControls();
    if (!orthographicCamera || !orthographicControls) {
      return;
    }

    appState.scenes.navigation2DCameraStates[sceneId] = {
      position: {
        x: orthographicCamera.position.x,
        y: orthographicCamera.position.y,
        z: orthographicCamera.position.z,
      },
      target: {
        x: orthographicControls.target.x,
        y: orthographicControls.target.y,
        z: orthographicControls.target.z,
      },
      zoom: this.getZoom2D(),
    };
  }

  /**
   * Restore 2D camera state from app state.
   */
  restoreZoomFromState(): void {
    const sceneId = appState.scenes.activeSceneId;
    const orthographicCamera = this.deps.getOrthographicCamera();
    const orthographicControls = this.deps.getOrthographicControls();
    if (!sceneId || !orthographicCamera || !orthographicControls) return;

    const cameraState = appState.scenes.navigation2DCameraStates[sceneId];
    if (!cameraState) {
      this.deps.reset2DView();
      return;
    }

    orthographicCamera.position.set(
      cameraState.position.x,
      cameraState.position.y,
      cameraState.position.z
    );
    orthographicControls.target.set(
      cameraState.target.x,
      cameraState.target.y,
      cameraState.target.z
    );

    if (typeof cameraState.zoom === 'number') {
      this.setZoom2D(cameraState.zoom);
      return;
    }

    this.deps.sync2DServiceFrameThickness();
    if (this.deps.hasSelectionOverlay()) {
      this.deps.refreshGizmoPositions();
    }
  }

  /**
   * Zero out the tracked pan velocity (used when a framing/reset op cancels any
   * in-flight fling before snapping the camera to a new position).
   */
  resetPanVelocity(): void {
    this.panVelocity.x = 0;
    this.panVelocity.y = 0;
  }

  /**
   * Start pan momentum animation. Called after gesture ends.
   * Applies exponential damping to pan velocity over ~500ms.
   */
  startPanMomentum(): void {
    if (this.deps.shouldPauseForWindowFocus()) {
      return;
    }

    if (this.momentumAnimationId) {
      cancelAnimationFrame(this.momentumAnimationId);
    }

    const frictionFactor = 0.95; // Per frame decay (5% loss per frame at 60fps ≈ 500ms total)
    const minVelocity = 0.001; // Below this, stop animating

    const animate = () => {
      if (this.deps.isPaused() || this.deps.shouldPauseForWindowFocus()) {
        this.momentumAnimationId = undefined;
        return;
      }

      // Check if velocity is negligible
      const speed = Math.sqrt(
        this.panVelocity.x * this.panVelocity.x + this.panVelocity.y * this.panVelocity.y
      );

      if (speed < minVelocity) {
        // Save zoom when momentum animation ends
        this.saveZoomToState();
        this.momentumAnimationId = undefined;
        return;
      }

      // Apply pan with current velocity (no new delta)
      const orthographicControls = this.deps.getOrthographicControls();
      if (orthographicControls && appState.ui.navigationMode === '2d') {
        orthographicControls.target.x += this.panVelocity.x;
        orthographicControls.target.y += this.panVelocity.y;
        this.deps.markRenderDirty();
      }

      // Decay velocity
      this.panVelocity.x *= frictionFactor;
      this.panVelocity.y *= frictionFactor;

      // Queue next frame
      this.momentumAnimationId = requestAnimationFrame(animate);
    };

    // Start animation
    this.momentumAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Cancel any ongoing pan momentum animation.
   */
  cancelPanMomentum(): void {
    if (this.momentumAnimationId) {
      cancelAnimationFrame(this.momentumAnimationId);
      this.momentumAnimationId = undefined;
    }
  }
}
