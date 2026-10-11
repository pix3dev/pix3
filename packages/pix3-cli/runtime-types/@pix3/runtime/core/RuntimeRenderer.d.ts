import { WebGLRenderer, Scene, Camera } from 'three';
export interface RuntimeRendererOptions {
    antialias?: boolean;
    pixelRatio?: number;
    clearColor?: string;
    shadows?: boolean;
}
export interface RuntimeRendererStatsSnapshot {
    readonly calls: number;
    readonly triangles: number;
    readonly points: number;
    readonly lines: number;
    readonly geometries: number;
    readonly textures: number;
    /**
     * Linked WebGL programs (`renderer.info.programs.length`). Tracked because
     * linking a *new* program blocks the main thread synchronously — measured at
     * 50-76 ms inside `gl.getProgramInfoLog` the first time a material is drawn —
     * so a count that grows mid-gameplay predicts a stall the frame-time series
     * can only show after the fact. Read via three's own `info`; nothing here
     * patches the WebGL prototypes.
     */
    readonly programs: number;
}
export declare class RuntimeRenderer {
    private renderer;
    private canvas;
    private resizeObserver;
    constructor(options?: RuntimeRendererOptions);
    get domElement(): HTMLCanvasElement;
    /** The underlying three.js renderer — needed to build a post-processing
     * `EffectComposer` (see {@link ./PostProcessingPipeline}). */
    getWebGLRenderer(): WebGLRenderer;
    attachToDocument(containerId?: string): void;
    /**
     * Mount the canvas into `container`. Re-entrant on purpose: calling it again with a different
     * element MOVES the live canvas (and with it the WebGL context, so the running game survives the
     * move) instead of leaving a second, orphaned observer behind. The editor uses that to hand a
     * running game between the Studio Game tab and the Vibe stage without restarting it.
     */
    attach(container: HTMLElement): void;
    resize(): void;
    render(scene: Scene, camera: Camera): void;
    beginStatsFrame(): void;
    getStatsSnapshot(): RuntimeRendererStatsSnapshot;
    setAutoClear(autoClear: boolean): void;
    clear(): void;
    clearDepth(): void;
    dispose(): void;
}
