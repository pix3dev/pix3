import { HalfFloatType, Vector2, type WebGLRenderer, type Scene, type Camera } from 'three';
// Type-only imports are erased at compile time — the heavy `postprocessing`
// module is pulled in exclusively via the dynamic import in `load()`, so scenes
// without a PostProcess node never download it.
import type {
  EffectComposer,
  RenderPass,
  EffectPass,
  ClearPass,
  BloomEffect,
  VignetteEffect,
  ChromaticAberrationEffect,
} from 'postprocessing';
import type { PostProcessConfig } from '../nodes/PostProcess';

type PostprocessingModule = typeof import('postprocessing');

let modulePromise: Promise<PostprocessingModule> | null = null;

/** Shared, idempotent loader for the `postprocessing` module (code-split). */
function loadPostprocessing(): Promise<PostprocessingModule> {
  if (!modulePromise) {
    modulePromise = import('postprocessing');
  }
  return modulePromise;
}

/**
 * Owns the `EffectComposer` for a single renderer and (re)builds it from a
 * {@link PostProcessConfig}. Renders the 3D band and — when `affect2D` is on —
 * the 2D content band into one buffer, then applies the merged effect stack.
 *
 * Passes are only rebuilt when the *structure* changes (which effects are on,
 * bloom's kernel params, the LUT source, or the cameras). Per-frame animated
 * scalars (bloom intensity, vignette offset/darkness, CA offset) are written
 * straight to the live effects — cheap uniform updates, no reallocation — so a
 * keyframe track animating `bloomIntensity` costs nothing structural.
 *
 * Loading is async (dynamic import); until {@link isReady} returns true the
 * caller must fall back to its plain render path.
 */
export class PostProcessingPipeline {
  private readonly renderer: WebGLRenderer;
  private pp: PostprocessingModule | null = null;
  private loadingStarted = false;

  private composer: EffectComposer | null = null;
  private render3DPass: RenderPass | null = null;
  private clearDepthPass: ClearPass | null = null;
  private render2DPass: RenderPass | null = null;
  private effectPass: EffectPass | null = null;

  private bloom: BloomEffect | null = null;
  private vignette: VignetteEffect | null = null;
  private chromaticAberration: ChromaticAberrationEffect | null = null;
  private readonly caOffset = new Vector2();

  private structuralSignature = '';
  private lastCamera3D: Camera | null = null;
  private lastOrthoCamera: Camera | null = null;
  private width = 0;
  private height = 0;
  private readonly sizeScratch = new Vector2();

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
  }

  /** Kick off the (idempotent) module load. Safe to call every frame. */
  ensureLoading(): void {
    if (this.pp || this.loadingStarted) {
      return;
    }
    this.loadingStarted = true;
    void loadPostprocessing().then(mod => {
      this.pp = mod;
    });
  }

  /** True once the module is loaded and the composer can render synchronously. */
  isReady(): boolean {
    return this.pp !== null;
  }

  /**
   * Match the composer's render targets to the renderer's current size. The
   * renderer is the single source of truth — sizing from a caller-supplied
   * value risks a mismatch (composer RT smaller than the drawing buffer), which
   * makes the post-processed image cover only part of the canvas. `getSize`
   * returns CSS pixels; `EffectComposer.setSize` re-applies the pixel ratio for
   * the render targets, matching the drawing buffer exactly. Guarded so it only
   * reallocates targets when the size actually changes.
   */
  private syncSizeFromRenderer(): void {
    const size = this.renderer.getSize(this.sizeScratch);
    const w = Math.max(1, Math.round(size.width));
    const h = Math.max(1, Math.round(size.height));
    if (w === this.width && h === this.height) {
      return;
    }
    this.width = w;
    this.height = h;
    // `false` = don't touch the canvas CSS; the app owns the renderer's size.
    this.composer?.setSize(w, h, false);
  }

  /**
   * Render the composited, post-processed frame to the canvas. Requires
   * {@link isReady}. `scene` is the shared scene; band separation is by camera
   * layer mask (3D on the perspective camera, 2D content on the ortho camera).
   */
  render(
    scene: Scene,
    camera3D: Camera | null,
    orthoCamera: Camera,
    config: PostProcessConfig
  ): void {
    const pp = this.pp;
    if (!pp) {
      return;
    }

    this.syncSizeFromRenderer();
    this.sync(pp, scene, camera3D, orthoCamera, config);

    // The composer must own the full drawing buffer. A host renderer may have
    // left a partial viewport or an enabled scissor (e.g. the editor viewport's
    // camera-preview inset, or a viewport tracked at a different size than the
    // drawing buffer) — without this reset the whole post-processed frame would
    // render into a sub-rectangle, dropping most of the image.
    const size = this.renderer.getSize(this.sizeScratch);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.width, size.height);

    // No deltaTime — the composer's internal timer supplies it (unused by the
    // current bloom/vignette/CA effects, which are time-independent).
    this.composer?.render();
  }

  /** (Re)build passes if structure changed, then push live scalars. */
  private sync(
    pp: PostprocessingModule,
    scene: Scene,
    camera3D: Camera | null,
    orthoCamera: Camera,
    config: PostProcessConfig
  ): void {
    const signature = this.computeSignature(config, camera3D);
    const cameraChanged = this.lastCamera3D !== camera3D || this.lastOrthoCamera !== orthoCamera;

    if (!this.composer || signature !== this.structuralSignature || cameraChanged) {
      this.rebuild(pp, scene, camera3D, orthoCamera, config);
      this.structuralSignature = signature;
      this.lastCamera3D = camera3D;
      this.lastOrthoCamera = orthoCamera;
    }

    this.applyLiveValues(config);
  }

  /** Effects/cameras that force a pass rebuild when they change. */
  private computeSignature(config: PostProcessConfig, camera3D: Camera | null): string {
    const b = config.bloom;
    const lutActive = config.lut.enabled && config.lut.src.length > 0;
    return [
      camera3D ? '3d' : 'no3d',
      config.affect2D ? '2d' : '2d-',
      b.enabled ? `bloom:${b.threshold}:${b.smoothing}:${b.radius}` : 'bloom-',
      config.vignette.enabled ? 'vig' : 'vig-',
      config.chromaticAberration.enabled ? 'ca' : 'ca-',
      lutActive ? `lut:${config.lut.src}` : 'lut-',
    ].join('|');
  }

  private rebuild(
    pp: PostprocessingModule,
    scene: Scene,
    camera3D: Camera | null,
    orthoCamera: Camera,
    config: PostProcessConfig
  ): void {
    if (!this.composer) {
      this.composer = new pp.EffectComposer(this.renderer, { frameBufferType: HalfFloatType });
      this.composer.setSize(this.width, this.height, false);
    }
    const composer = this.composer;
    composer.removeAllPasses();
    this.disposeEffects();

    // Band 1: the 3D scene (perspective camera, LAYER_3D) — clears the buffer.
    // Absent in pure-2D scenes (no active Camera3D); then the 2D layer is the
    // clearing base band instead (common for 2D playable ads).
    if (camera3D) {
      this.render3DPass = new pp.RenderPass(scene, camera3D);
      composer.addPass(this.render3DPass);
    } else {
      this.render3DPass = null;
    }

    // Band 2: the 2D content layer (ortho camera, LAYER_2D). Composited on top
    // of the 3D band (same buffer) so effects see the whole frame; or — with no
    // 3D band — it becomes the clearing base band. Skipped only when a 3D scene
    // opts 2D out of post (then the caller draws 2D clean after the composer).
    const render2D = config.affect2D || !camera3D;
    if (render2D) {
      const isBaseBand = !this.render3DPass;
      if (!isBaseBand) {
        this.clearDepthPass = new pp.ClearPass(false, true, false);
        composer.addPass(this.clearDepthPass);
      } else {
        this.clearDepthPass = null;
      }

      this.render2DPass = new pp.RenderPass(scene, orthoCamera);
      // Base band clears (color+depth) and paints the scene background; a
      // composited band keeps the 3D color and skips the background.
      this.render2DPass.clearPass.enabled = isBaseBand;
      this.render2DPass.ignoreBackground = !isBaseBand;
      composer.addPass(this.render2DPass);
    } else {
      this.clearDepthPass = null;
      this.render2DPass = null;
    }

    // Effect stack — merged into a single fullscreen pass by `postprocessing`.
    const effectCamera = camera3D ?? orthoCamera;
    const effects = [];
    if (config.bloom.enabled) {
      this.bloom = new pp.BloomEffect({
        mipmapBlur: true,
        intensity: config.bloom.intensity,
        luminanceThreshold: config.bloom.threshold,
        luminanceSmoothing: config.bloom.smoothing,
        radius: config.bloom.radius,
      });
      effects.push(this.bloom);
    }
    if (config.vignette.enabled) {
      this.vignette = new pp.VignetteEffect({
        offset: config.vignette.offset,
        darkness: config.vignette.darkness,
      });
      effects.push(this.vignette);
    }
    if (config.chromaticAberration.enabled) {
      this.caOffset.set(config.chromaticAberration.offset, config.chromaticAberration.offset);
      this.chromaticAberration = new pp.ChromaticAberrationEffect({
        offset: this.caOffset,
        radialModulation: false,
        modulationOffset: 0,
      });
      effects.push(this.chromaticAberration);
    }

    if (effects.length > 0) {
      this.effectPass = new pp.EffectPass(effectCamera, ...effects);
      composer.addPass(this.effectPass);
    } else {
      this.effectPass = null;
    }
  }

  /** Per-frame uniform writes for animatable scalars (no reallocation). */
  private applyLiveValues(config: PostProcessConfig): void {
    if (this.bloom) {
      this.bloom.intensity = config.bloom.intensity;
    }
    if (this.vignette) {
      this.vignette.offset = config.vignette.offset;
      this.vignette.darkness = config.vignette.darkness;
    }
    if (this.chromaticAberration) {
      this.caOffset.set(config.chromaticAberration.offset, config.chromaticAberration.offset);
      this.chromaticAberration.offset = this.caOffset;
    }
  }

  private disposeEffects(): void {
    // The EffectPass owns its effects; disposing it frees the merged material
    // and the individual effects' GPU resources.
    this.effectPass?.dispose();
    this.bloom?.dispose();
    this.vignette?.dispose();
    this.chromaticAberration?.dispose();
    this.effectPass = null;
    this.bloom = null;
    this.vignette = null;
    this.chromaticAberration = null;
  }

  dispose(): void {
    this.disposeEffects();
    this.composer?.dispose();
    this.composer = null;
    this.render3DPass = null;
    this.clearDepthPass = null;
    this.render2DPass = null;
    this.structuralSignature = '';
    this.lastCamera3D = null;
    this.lastOrthoCamera = null;
  }
}
