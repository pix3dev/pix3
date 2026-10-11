import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
/**
 * Default configuration for a freshly created {@link PostProcess} node. Bloom is
 * on by default so a newly-added node has a visible effect; the rest are opt-in.
 */
/**
 * Ambient-occlusion mode for the scene (the "scene" tier of the AO cascade).
 * `baked` uses per-mesh baked aoMaps (cheap, mobile); `realtime` uses SSAO
 * (desktop-grade, no bake); `adaptive` picks realtime on capable devices and
 * baked otherwise; `off` disables AO. When realtime wins, baked maps are
 * suppressed at render time so the two don't stack.
 */
export declare const AO_MODES: readonly ["inherit", "off", "baked", "realtime", "adaptive"];
export type AOMode = (typeof AO_MODES)[number];
/** Modes a project-level default may take (everything except `inherit`). */
export declare const PROJECT_AO_MODES: readonly ["off", "baked", "realtime", "adaptive"];
/** Resolved AO mode (after `inherit`/`adaptive` are decided) — what the renderer acts on. */
export type ResolvedAOMode = 'off' | 'baked' | 'realtime';
export declare function setProjectAODefault(mode: string): void;
export declare function getProjectAODefault(): Exclude<AOMode, 'inherit'>;
export declare const POST_PROCESS_DEFAULTS: {
    readonly affect2D: true;
    readonly bloomEnabled: true;
    readonly bloomIntensity: 1;
    readonly bloomThreshold: 0.9;
    readonly bloomSmoothing: 0.025;
    readonly bloomRadius: 0.85;
    readonly vignetteEnabled: false;
    readonly vignetteOffset: 0.35;
    readonly vignetteDarkness: 0.5;
    readonly chromaticAberrationEnabled: false;
    readonly chromaticAberrationOffset: 0.002;
    readonly aoMode: AOMode;
    readonly ssaoIntensity: 2.5;
    readonly ssaoRadius: 0.25;
    readonly lutEnabled: false;
    readonly lutSrc: "";
    readonly lutIntensity: 1;
};
export interface PostProcessProps extends Omit<NodeBaseProps, 'type'> {
    affect2D?: boolean;
    bloomEnabled?: boolean;
    bloomIntensity?: number;
    bloomThreshold?: number;
    bloomSmoothing?: number;
    bloomRadius?: number;
    vignetteEnabled?: boolean;
    vignetteOffset?: number;
    vignetteDarkness?: number;
    chromaticAberrationEnabled?: boolean;
    chromaticAberrationOffset?: number;
    aoMode?: string;
    ssaoIntensity?: number;
    ssaoRadius?: number;
    lutEnabled?: boolean;
    lutSrc?: string;
    lutIntensity?: number;
}
/** Structured, plain-object view of the post config consumed by the pipeline. */
export interface PostProcessConfig {
    affect2D: boolean;
    bloom: {
        enabled: boolean;
        intensity: number;
        threshold: number;
        smoothing: number;
        radius: number;
    };
    vignette: {
        enabled: boolean;
        offset: number;
        darkness: number;
    };
    chromaticAberration: {
        enabled: boolean;
        offset: number;
    };
    /** Screen-space AO on the 3D band (realtime alternative to baked AO). */
    ssao: {
        enabled: boolean;
        intensity: number;
        radius: number;
    };
    lut: {
        enabled: boolean;
        src: string;
        intensity: number;
    };
}
/**
 * Godot-`WorldEnvironment`-style configuration node describing the screen
 * post-processing stack for the scene. It renders nothing itself — a single
 * instance anywhere in the graph is picked up by the renderer, which builds an
 * `EffectComposer` from this config (see {@link ../core/PostProcessingPipeline}).
 *
 * Every knob is a flat scalar exposed through the property schema, so the
 * keyframe timeline can animate e.g. `bloomIntensity` with no animation code —
 * a "bloom flash" is three keys on one property. Effects apply to the whole
 * composited frame (3D + 2D content) by default; the 2D overlay band
 * ({@link ../nodes/2D/CanvasLayer2D}) always stays clean above the stack.
 */
export declare class PostProcess extends NodeBase {
    private affect2DValue;
    private bloomEnabledValue;
    private bloomIntensityValue;
    private bloomThresholdValue;
    private bloomSmoothingValue;
    private bloomRadiusValue;
    private vignetteEnabledValue;
    private vignetteOffsetValue;
    private vignetteDarknessValue;
    private chromaticAberrationEnabledValue;
    private chromaticAberrationOffsetValue;
    private aoModeValue;
    private ssaoIntensityValue;
    private ssaoRadiusValue;
    private lutEnabledValue;
    private lutSrcValue;
    private lutIntensityValue;
    constructor(props: PostProcessProps);
    get treeIcon(): string;
    get affect2D(): boolean;
    set affect2D(value: boolean);
    get bloomEnabled(): boolean;
    set bloomEnabled(value: boolean);
    get bloomIntensity(): number;
    set bloomIntensity(value: number);
    get bloomThreshold(): number;
    set bloomThreshold(value: number);
    get bloomSmoothing(): number;
    set bloomSmoothing(value: number);
    get bloomRadius(): number;
    set bloomRadius(value: number);
    get vignetteEnabled(): boolean;
    set vignetteEnabled(value: boolean);
    get vignetteOffset(): number;
    set vignetteOffset(value: number);
    get vignetteDarkness(): number;
    set vignetteDarkness(value: number);
    get chromaticAberrationEnabled(): boolean;
    set chromaticAberrationEnabled(value: boolean);
    get chromaticAberrationOffset(): number;
    set chromaticAberrationOffset(value: number);
    get aoMode(): AOMode;
    set aoMode(value: string);
    /**
     * Resolve the node's AO mode to a concrete one the renderer acts on:
     * `inherit` → the project default (top of the cascade), then `adaptive` →
     * realtime/baked by device capability.
     */
    getResolvedAOMode(): ResolvedAOMode;
    get ssaoIntensity(): number;
    set ssaoIntensity(value: number);
    get ssaoRadius(): number;
    set ssaoRadius(value: number);
    get lutEnabled(): boolean;
    set lutEnabled(value: boolean);
    get lutSrc(): string;
    set lutSrc(value: string);
    get lutIntensity(): number;
    set lutIntensity(value: number);
    /** True when at least one effect is enabled — the renderer only builds a
     * composer when this is true, otherwise it uses the plain two-pass path. */
    isActive(): boolean;
    /** Structured snapshot the pipeline reads each frame to sync effect uniforms. */
    getConfig(): PostProcessConfig;
    /**
     * Authored configuration as a plain object for scene serialization. Keys match
     * the loader's expected property names one-to-one.
     */
    serializeConfig(): Record<string, unknown>;
    static getPropertySchema(): PropertySchema;
}
/** True for modes whose SSAO params (intensity/radius) are relevant. */
export declare function aoModeUsesSSAO(mode: AOMode): boolean;
/**
 * Cheap device-capability heuristic for `adaptive` AO: realtime SSAO on
 * desktop-class devices (fine pointer + enough CPU threads), baked otherwise.
 * Conservative on anything that looks like a phone/tablet to protect the
 * per-frame budget of mobile playables.
 */
export declare function isHighEndDevice(): boolean;
