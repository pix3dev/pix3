import { type WebGLRenderer, type Scene, type Camera } from 'three';
import type { PostProcessConfig } from '../nodes/PostProcess';
type PostprocessingModule = typeof import('postprocessing');
type PostprocessingModuleLoader = () => Promise<PostprocessingModule>;
/**
 * Overrides how the `postprocessing` module is obtained.
 *
 * The default is the code-split `import('postprocessing')`, which is right for
 * hosts whose bundler can fetch a chunk (the editor, a Vite project build). A
 * **single-file playable export** cannot: there is no chunk to fetch and no
 * import map to resolve the bare specifier, so the dynamic import used to reject
 * and post-processing silently never turned on. Those builds instead generate a
 * module that imports `postprocessing` statically and registers it here — the
 * same arrangement as `setSpineModuleLoader`, and the reason a project without a
 * `PostProcess` node still ships none of it.
 */
export declare function setPostprocessingModuleLoader(loader: PostprocessingModuleLoader): void;
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
export declare class PostProcessingPipeline {
    private readonly renderer;
    private pp;
    private loadingStarted;
    private composer;
    private render3DPass;
    private normalPass;
    private depthDownsampling;
    private ssaoPass;
    private clearDepthPass;
    private render2DPass;
    private effectPass;
    private bloom;
    private vignette;
    private chromaticAberration;
    private ssao;
    private readonly caOffset;
    private structuralSignature;
    private lastCamera3D;
    private lastOrthoCamera;
    private width;
    private height;
    private readonly sizeScratch;
    constructor(renderer: WebGLRenderer);
    /** Kick off the (idempotent) module load. Safe to call every frame. */
    ensureLoading(): void;
    /** True once the module is loaded and the composer can render synchronously. */
    isReady(): boolean;
    /**
     * Match the composer's render targets to the renderer's current size. The
     * renderer is the single source of truth — sizing from a caller-supplied
     * value risks a mismatch (composer RT smaller than the drawing buffer), which
     * makes the post-processed image cover only part of the canvas. `getSize`
     * returns CSS pixels; `EffectComposer.setSize` re-applies the pixel ratio for
     * the render targets, matching the drawing buffer exactly. Guarded so it only
     * reallocates targets when the size actually changes.
     */
    private syncSizeFromRenderer;
    /**
     * Render the composited, post-processed frame to the canvas. Requires
     * {@link isReady}. `scene` is the shared scene; band separation is by camera
     * layer mask (3D on the perspective camera, 2D content on the ortho camera).
     */
    render(scene: Scene, camera3D: Camera | null, orthoCamera: Camera, config: PostProcessConfig): void;
    /** (Re)build passes if structure changed, then push live scalars. */
    private sync;
    /** Effects/cameras that force a pass rebuild when they change. */
    private computeSignature;
    private rebuild;
    /** Per-frame uniform writes for animatable scalars (no reallocation). */
    private applyLiveValues;
    private disposeEffects;
    dispose(): void;
}
export {};
