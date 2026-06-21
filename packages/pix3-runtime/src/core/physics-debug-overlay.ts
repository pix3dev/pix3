import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Scene,
  type Camera,
} from 'three';
import { getPhysicsDebugSource, type PhysicsDebugBuffers } from './game-debug';
import type { RuntimeRenderer } from './RuntimeRenderer';

/** Solid colour used when a source provides positions but no per-vertex colours. */
const FALLBACK_COLLIDER_COLOR = 0x00e0a4;

/**
 * Minimum per-channel brightness for collider wireframes. Engines render
 * sleeping/inactive bodies near-black, which vanishes over a dark scene; this
 * floor keeps every collider readable while preserving the awake/asleep contrast.
 */
const COLLIDER_COLOR_FLOOR = 0.3;

/**
 * Renders physics collider wireframes over the running scene.
 *
 * Physics lives in the game (e.g. a Rapier `World`), opaque to the runtime; a
 * game publishes its collider line-segment buffers through
 * `registerPhysicsDebugSource`. This overlay pulls those buffers each frame and
 * draws them as world-space `LineSegments`, layered on top of the 3D pass.
 *
 * Buffer layout mirrors Rapier's `World.debugRender()`: `vertices` is 3 floats
 * per point (2 points per segment); optional `colors` is 4 floats (RGBA) per
 * point. Lines draw with depth testing disabled so every collider stays visible
 * even when occluded by geometry — the whole point of a debug overlay.
 *
 * Attributes are reused frame-to-frame and only reallocated when the collider
 * set grows, so the steady state is a cheap re-upload rather than per-frame GC.
 */
export class PhysicsDebugOverlay {
  private readonly geometry = new BufferGeometry();
  private readonly material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly lines = new LineSegments(this.geometry, this.material);
  private readonly overlayScene = new Scene();
  private positionAttr: Float32BufferAttribute | null = null;
  private colorAttr: Float32BufferAttribute | null = null;

  constructor() {
    this.overlayScene.background = null;
    // Bounds are never computed for this dynamic geometry; skip culling.
    this.lines.frustumCulled = false;
    // Debug geometry must never participate in raycasting/picking.
    this.lines.raycast = () => {};
    this.overlayScene.add(this.lines);
  }

  /**
   * Pull the latest collider buffers and upload them to the GPU. Returns true
   * when there is geometry to draw this frame.
   */
  private sync(): boolean {
    const source = getPhysicsDebugSource();
    if (!source) {
      return false;
    }

    let buffers: PhysicsDebugBuffers | null;
    try {
      buffers = source();
    } catch {
      return false;
    }
    if (!buffers?.vertices) {
      return false;
    }

    const vertices = buffers.vertices;
    const floatCount = vertices.length;
    if (floatCount < 6) {
      this.geometry.setDrawRange(0, 0);
      return false;
    }

    if (!this.positionAttr || this.positionAttr.array.length < floatCount) {
      this.positionAttr = new Float32BufferAttribute(new Float32Array(floatCount), 3);
      this.positionAttr.setUsage(DynamicDrawUsage);
      this.geometry.setAttribute('position', this.positionAttr);
    }
    (this.positionAttr.array as Float32Array).set(vertices);
    this.positionAttr.needsUpdate = true;

    const pointCount = Math.floor(floatCount / 3);
    this.geometry.setDrawRange(0, pointCount);

    const colors = buffers.colors;
    const hasColors = !!colors && colors.length >= pointCount * 4;
    if (hasColors && colors) {
      if (!this.colorAttr || this.colorAttr.array.length < colors.length) {
        this.colorAttr = new Float32BufferAttribute(new Float32Array(colors.length), 4);
        this.colorAttr.setUsage(DynamicDrawUsage);
        this.geometry.setAttribute('color', this.colorAttr);
      }
      // Lift RGB toward a visible floor. Physics engines (e.g. Rapier) draw
      // sleeping/inactive bodies in a near-black colour, which is invisible over
      // a dark scene — making it look like those colliders are missing entirely.
      // The affine `floor + (1-floor)*c` keeps bright (awake) colliders bright
      // while raising dark (sleeping) ones to a readable grey, preserving the
      // awake/asleep contrast. Alpha is passed through untouched.
      const dst = this.colorAttr.array as Float32Array;
      const floatCountC = pointCount * 4;
      for (let i = 0; i < floatCountC; i += 4) {
        dst[i] = COLLIDER_COLOR_FLOOR + (1 - COLLIDER_COLOR_FLOOR) * colors[i];
        dst[i + 1] = COLLIDER_COLOR_FLOOR + (1 - COLLIDER_COLOR_FLOOR) * colors[i + 1];
        dst[i + 2] = COLLIDER_COLOR_FLOOR + (1 - COLLIDER_COLOR_FLOOR) * colors[i + 2];
        dst[i + 3] = colors[i + 3];
      }
      this.colorAttr.needsUpdate = true;
    }
    if (this.material.vertexColors !== hasColors) {
      this.material.vertexColors = hasColors;
      if (!hasColors) {
        this.material.color.set(FALLBACK_COLLIDER_COLOR);
      }
      this.material.needsUpdate = true;
    }

    return true;
  }

  /** Draw the overlay if a source is registered and producing geometry. */
  render(renderer: RuntimeRenderer, camera: Camera): void {
    if (!this.sync()) {
      return;
    }
    renderer.render(this.overlayScene, camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
