/**
 * Offscreen multi-viewpoint screenshotter for the Scene lane review loop. The Scene-lane analogue of
 * {@link import('../ModelPreviewRenderer').ModelPreviewRenderer}: NOT a DI service — the
 * {@link import('./Scene3DGenService').Scene3DGenService} constructs one per job (so it can catch a
 * WebGL-unavailable environment and degrade to build+validate-only) and disposes it in `finally`.
 *
 * It owns a {@link WebGLRenderer} on a DETACHED canvas (never added to the DOM), a scene, and studio
 * "fallback" lights so a generated scene with no lights of its own still reads. Each review renders a
 * top-down orthographic view (layout legibility) and a 3/4 perspective view.
 *
 * OWNERSHIP TRAP: an `Object3D` has exactly one parent, so the roots handed in must be parsed
 * SPECIFICALLY for offscreen rendering (a THROWAWAY parse), never the panel's live preview nodes. We
 * reparent them under a temporary wrapper, render, then detach the wrapper — we NEVER dispose their
 * geometries/materials, which are still owned by (and shared through) the AssetLoader cache.
 * {@link dispose} only tears down the renderer this class created.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { framePerspectiveCameraToObject } from '@/services/assets/GltfBlobLoader';

const DEFAULT_SIZE = 512;

/** One rendered viewpoint of the scene. */
export interface SceneRenderView {
  id: string;
  label: string;
  dataUrl: string;
}

export class ScenePreviewRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly perspectiveCamera: PerspectiveCamera;

  constructor() {
    if (typeof document === 'undefined') {
      throw new Error('Offscreen scene rendering requires a browser document context.');
    }

    const canvas = document.createElement('canvas');
    try {
      this.renderer = new WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
    } catch (error) {
      throw new Error(
        `Offscreen WebGL renderer is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x11141a, 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;

    this.scene = new Scene();
    // Fallback studio lights (mirroring ModelPreviewRenderer) so an unlit generated scene still reads.
    this.scene.add(new AmbientLight(0xffffff, 0.5));
    const hemisphere = new HemisphereLight(0xf7fbff, 0x2a3138, 1.0);
    hemisphere.position.set(0, 1, 0);
    this.scene.add(hemisphere);
    const keyLight = new DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(4, 7, 5);
    this.scene.add(keyLight);

    this.perspectiveCamera = new PerspectiveCamera(40, 1, 0.01, 5000);
  }

  /**
   * Render the given (throwaway-parsed) roots from a top-down orthographic view and a 3/4
   * perspective view, returning each as a PNG data URL. The roots are reparented under a temporary
   * wrapper and recentered on the origin for framing, then detached; their geometries/materials are
   * never disposed. Throws if a read-back fails.
   */
  async renderViews(
    rootNodes: readonly Object3D[],
    size: number = DEFAULT_SIZE
  ): Promise<SceneRenderView[]> {
    const wrapper = new Group();
    for (const root of rootNodes) {
      wrapper.add(root);
    }
    this.scene.add(wrapper);

    try {
      wrapper.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(wrapper);
      const center = new Vector3();
      const dimensions = new Vector3();
      const empty = bounds.isEmpty();
      if (empty) {
        center.set(0, 0, 0);
        dimensions.set(1, 1, 1);
      } else {
        bounds.getCenter(center);
        bounds.getSize(dimensions);
      }

      // Recenter content on the origin so both cameras frame it consistently.
      for (const root of rootNodes) {
        root.position.sub(center);
      }
      wrapper.updateMatrixWorld(true);

      this.renderer.setSize(size, size, false);

      const views: SceneRenderView[] = [];
      views.push({
        id: 'top',
        label: 'Top-down',
        dataUrl: this.renderTopDown(dimensions),
      });
      views.push({
        id: 'threeQuarter',
        label: '3/4 view',
        dataUrl: this.renderThreeQuarter(wrapper),
      });
      return views;
    } finally {
      this.scene.remove(wrapper);
    }
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.scene.clear();
  }

  // -- internals -------------------------------------------------------------

  /** Orthographic straight-down shot framed to the content footprint (world X→right, Z→up). */
  private renderTopDown(dimensions: Vector3): string {
    const footprint = Math.max(dimensions.x, dimensions.z, 0.5);
    const half = (footprint * 1.1) / 2;
    const height = Math.max(dimensions.y, 0.5) + footprint + 1;

    const camera = new OrthographicCamera(-half, half, half, -half, 0.01, height * 4 + 10);
    camera.position.set(0, height, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Perspective 3/4 shot framed to the (origin-centered) content. */
  private renderThreeQuarter(target: Object3D): string {
    this.perspectiveCamera.aspect = 1;
    this.perspectiveCamera.updateProjectionMatrix();
    framePerspectiveCameraToObject(this.perspectiveCamera, target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.perspectiveCamera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
