/**
 * Offscreen 3/4-view screenshotter for the Model Lab review loop. NOT a DI service — the
 * {@link import('./Model3DGenService').Model3DGenService} constructs one per job (so it can catch a
 * WebGL-unavailable environment and degrade to "reviews disabled") and disposes it in `finally`.
 *
 * It owns a {@link WebGLRenderer} on a DETACHED canvas (never added to the DOM), a scene with studio
 * lighting mirroring the panel's, and a perspective camera framed the same way GLB thumbnails are.
 *
 * TRAP: the panel adds the pipeline's `THREE.Group` to its OWN scene, and an Object3D has exactly one
 * parent. So {@link renderThreeQuarter} screenshots a `group.clone()` (which shares geometry/material
 * refs — fine for a read-only render), never the original. The clone is removed after rendering and
 * dropped; its geometries/materials are still owned by the original in the panel, so they are NEVER
 * disposed here. {@link dispose} only tears down resources this renderer created (the renderer itself).
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { framePerspectiveCameraToObject } from '@/services/assets/GltfBlobLoader';

const DEFAULT_SIZE = 512;

export class ModelPreviewRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;

  constructor() {
    if (typeof document === 'undefined') {
      throw new Error('Offscreen model rendering requires a browser document context.');
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
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;

    this.scene = new Scene();
    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const hemisphere = new HemisphereLight(0xf7fbff, 0x2a3138, 1.1);
    hemisphere.position.set(0, 1, 0);
    this.scene.add(hemisphere);
    const keyLight = new DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(4, 7, 5);
    this.scene.add(keyLight);

    this.camera = new PerspectiveCamera(35, 1, 0.01, 1000);
  }

  /**
   * Render a CLONE of `group` from a canonical 3/4 view and return a PNG data URL. The original is
   * never reparented or mutated. Throws if the read-back fails.
   */
  renderThreeQuarter(group: Group, size: number = DEFAULT_SIZE): string {
    const clone = group.clone();
    this.scene.add(clone);
    try {
      clone.updateMatrixWorld(true);
      this.camera.aspect = 1;
      this.camera.updateProjectionMatrix();
      // Positions the camera for a 3/4 view and points it at (0, focusTargetY, 0) internally.
      framePerspectiveCameraToObject(this.camera, clone);
      this.renderer.setSize(size, size, false);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL('image/png');
    } finally {
      this.scene.remove(clone);
    }
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.scene.clear();
  }
}
