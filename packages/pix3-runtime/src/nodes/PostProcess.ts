import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
import { defineProperty } from '../fw/property-schema';

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
export const AO_MODES = ['inherit', 'off', 'baked', 'realtime', 'adaptive'] as const;
export type AOMode = (typeof AO_MODES)[number];
/** Modes a project-level default may take (everything except `inherit`). */
export const PROJECT_AO_MODES = ['off', 'baked', 'realtime', 'adaptive'] as const;
/** Resolved AO mode (after `inherit`/`adaptive` are decided) — what the renderer acts on. */
export type ResolvedAOMode = 'off' | 'baked' | 'realtime';

/**
 * Project-tier AO default (the top of the cascade). A scene's PostProcess node
 * set to `inherit` resolves to this. Stored on `globalThis` (like the runtime's
 * other config sinks) so the editor can push it from the project manifest
 * without threading it through every render call. Defaults to `baked`.
 */
const PROJECT_AO_MODE_KEY = '__PIX3_PROJECT_AO_MODE__';

export function setProjectAODefault(mode: string): void {
  (globalThis as Record<string, unknown>)[PROJECT_AO_MODE_KEY] = normalizeProjectAODefault(mode);
}

export function getProjectAODefault(): Exclude<AOMode, 'inherit'> {
  const raw = (globalThis as Record<string, unknown>)[PROJECT_AO_MODE_KEY];
  return normalizeProjectAODefault(raw);
}

function normalizeProjectAODefault(value: unknown): Exclude<AOMode, 'inherit'> {
  const mode = typeof value === 'string' ? value.toLowerCase() : '';
  return (PROJECT_AO_MODES as readonly string[]).includes(mode)
    ? (mode as Exclude<AOMode, 'inherit'>)
    : 'baked';
}

export const POST_PROCESS_DEFAULTS = {
  affect2D: true,
  bloomEnabled: true,
  bloomIntensity: 1,
  bloomThreshold: 0.9,
  bloomSmoothing: 0.025,
  bloomRadius: 0.85,
  vignetteEnabled: false,
  vignetteOffset: 0.35,
  vignetteDarkness: 0.5,
  chromaticAberrationEnabled: false,
  chromaticAberrationOffset: 0.002,
  aoMode: 'inherit' as AOMode,
  ssaoIntensity: 2.5,
  ssaoRadius: 0.25,
  lutEnabled: false,
  lutSrc: '',
  lutIntensity: 1,
} as const;

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
  vignette: { enabled: boolean; offset: number; darkness: number };
  chromaticAberration: { enabled: boolean; offset: number };
  /** Screen-space AO on the 3D band (realtime alternative to baked AO). */
  ssao: { enabled: boolean; intensity: number; radius: number };
  lut: { enabled: boolean; src: string; intensity: number };
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
export class PostProcess extends NodeBase {
  private affect2DValue: boolean;
  private bloomEnabledValue: boolean;
  private bloomIntensityValue: number;
  private bloomThresholdValue: number;
  private bloomSmoothingValue: number;
  private bloomRadiusValue: number;
  private vignetteEnabledValue: boolean;
  private vignetteOffsetValue: number;
  private vignetteDarknessValue: number;
  private chromaticAberrationEnabledValue: boolean;
  private chromaticAberrationOffsetValue: number;
  private aoModeValue: AOMode;
  private ssaoIntensityValue: number;
  private ssaoRadiusValue: number;
  private lutEnabledValue: boolean;
  private lutSrcValue: string;
  private lutIntensityValue: number;

  constructor(props: PostProcessProps) {
    super({ ...props, type: 'PostProcess' });
    // A configuration node — it holds no children and has no transform meaning.
    this.isContainer = false;

    const d = POST_PROCESS_DEFAULTS;
    const p = this.properties;
    this.affect2DValue = asBool(props.affect2D ?? p.affect2D, d.affect2D);
    this.bloomEnabledValue = asBool(props.bloomEnabled ?? p.bloomEnabled, d.bloomEnabled);
    this.bloomIntensityValue = asNum(props.bloomIntensity ?? p.bloomIntensity, d.bloomIntensity, 0);
    this.bloomThresholdValue = asNum(props.bloomThreshold ?? p.bloomThreshold, d.bloomThreshold, 0);
    this.bloomSmoothingValue = asNum(props.bloomSmoothing ?? p.bloomSmoothing, d.bloomSmoothing, 0);
    this.bloomRadiusValue = asNum(props.bloomRadius ?? p.bloomRadius, d.bloomRadius, 0);
    this.vignetteEnabledValue = asBool(props.vignetteEnabled ?? p.vignetteEnabled, d.vignetteEnabled);
    this.vignetteOffsetValue = asNum(props.vignetteOffset ?? p.vignetteOffset, d.vignetteOffset, 0);
    this.vignetteDarknessValue = asNum(
      props.vignetteDarkness ?? p.vignetteDarkness,
      d.vignetteDarkness,
      0
    );
    this.chromaticAberrationEnabledValue = asBool(
      props.chromaticAberrationEnabled ?? p.chromaticAberrationEnabled,
      d.chromaticAberrationEnabled
    );
    this.chromaticAberrationOffsetValue = asNum(
      props.chromaticAberrationOffset ?? p.chromaticAberrationOffset,
      d.chromaticAberrationOffset,
      0
    );
    this.aoModeValue = normalizeAOMode(props.aoMode ?? p.aoMode ?? d.aoMode);
    this.ssaoIntensityValue = asNum(props.ssaoIntensity ?? p.ssaoIntensity, d.ssaoIntensity, 0);
    this.ssaoRadiusValue = asNum(props.ssaoRadius ?? p.ssaoRadius, d.ssaoRadius, 0);
    this.lutEnabledValue = asBool(props.lutEnabled ?? p.lutEnabled, d.lutEnabled);
    this.lutSrcValue = asStr(props.lutSrc ?? p.lutSrc, d.lutSrc);
    this.lutIntensityValue = asNum(props.lutIntensity ?? p.lutIntensity, d.lutIntensity, 0);
  }

  get treeIcon(): string {
    return 'sparkles';
  }

  // ── Accessors (read by the pipeline / schema; setters clamp/validate) ───────

  get affect2D(): boolean {
    return this.affect2DValue;
  }
  set affect2D(value: boolean) {
    this.affect2DValue = Boolean(value);
  }

  get bloomEnabled(): boolean {
    return this.bloomEnabledValue;
  }
  set bloomEnabled(value: boolean) {
    this.bloomEnabledValue = Boolean(value);
  }

  get bloomIntensity(): number {
    return this.bloomIntensityValue;
  }
  set bloomIntensity(value: number) {
    this.bloomIntensityValue = clampMin(value, 0, this.bloomIntensityValue);
  }

  get bloomThreshold(): number {
    return this.bloomThresholdValue;
  }
  set bloomThreshold(value: number) {
    this.bloomThresholdValue = clampMin(value, 0, this.bloomThresholdValue);
  }

  get bloomSmoothing(): number {
    return this.bloomSmoothingValue;
  }
  set bloomSmoothing(value: number) {
    this.bloomSmoothingValue = clampMin(value, 0, this.bloomSmoothingValue);
  }

  get bloomRadius(): number {
    return this.bloomRadiusValue;
  }
  set bloomRadius(value: number) {
    this.bloomRadiusValue = clampMin(value, 0, this.bloomRadiusValue);
  }

  get vignetteEnabled(): boolean {
    return this.vignetteEnabledValue;
  }
  set vignetteEnabled(value: boolean) {
    this.vignetteEnabledValue = Boolean(value);
  }

  get vignetteOffset(): number {
    return this.vignetteOffsetValue;
  }
  set vignetteOffset(value: number) {
    this.vignetteOffsetValue = clampMin(value, 0, this.vignetteOffsetValue);
  }

  get vignetteDarkness(): number {
    return this.vignetteDarknessValue;
  }
  set vignetteDarkness(value: number) {
    this.vignetteDarknessValue = clampMin(value, 0, this.vignetteDarknessValue);
  }

  get chromaticAberrationEnabled(): boolean {
    return this.chromaticAberrationEnabledValue;
  }
  set chromaticAberrationEnabled(value: boolean) {
    this.chromaticAberrationEnabledValue = Boolean(value);
  }

  get chromaticAberrationOffset(): number {
    return this.chromaticAberrationOffsetValue;
  }
  set chromaticAberrationOffset(value: number) {
    this.chromaticAberrationOffsetValue = clampMin(value, 0, this.chromaticAberrationOffsetValue);
  }

  get aoMode(): AOMode {
    return this.aoModeValue;
  }
  set aoMode(value: string) {
    this.aoModeValue = normalizeAOMode(value);
  }

  /**
   * Resolve the node's AO mode to a concrete one the renderer acts on:
   * `inherit` → the project default (top of the cascade), then `adaptive` →
   * realtime/baked by device capability.
   */
  getResolvedAOMode(): ResolvedAOMode {
    const mode: Exclude<AOMode, 'inherit'> =
      this.aoModeValue === 'inherit' ? getProjectAODefault() : this.aoModeValue;
    if (mode === 'adaptive') {
      return isHighEndDevice() ? 'realtime' : 'baked';
    }
    return mode;
  }

  get ssaoIntensity(): number {
    return this.ssaoIntensityValue;
  }
  set ssaoIntensity(value: number) {
    this.ssaoIntensityValue = clampMin(value, 0, this.ssaoIntensityValue);
  }

  get ssaoRadius(): number {
    return this.ssaoRadiusValue;
  }
  set ssaoRadius(value: number) {
    this.ssaoRadiusValue = clampMin(value, 0, this.ssaoRadiusValue);
  }

  get lutEnabled(): boolean {
    return this.lutEnabledValue;
  }
  set lutEnabled(value: boolean) {
    this.lutEnabledValue = Boolean(value);
  }

  get lutSrc(): string {
    return this.lutSrcValue;
  }
  set lutSrc(value: string) {
    this.lutSrcValue = typeof value === 'string' ? value : '';
  }

  get lutIntensity(): number {
    return this.lutIntensityValue;
  }
  set lutIntensity(value: number) {
    this.lutIntensityValue = clamp01(value, this.lutIntensityValue);
  }

  /** True when at least one effect is enabled — the renderer only builds a
   * composer when this is true, otherwise it uses the plain two-pass path. */
  isActive(): boolean {
    return (
      this.bloomEnabledValue ||
      this.vignetteEnabledValue ||
      this.chromaticAberrationEnabledValue ||
      this.getResolvedAOMode() === 'realtime' ||
      (this.lutEnabledValue && this.lutSrcValue.length > 0)
    );
  }

  /** Structured snapshot the pipeline reads each frame to sync effect uniforms. */
  getConfig(): PostProcessConfig {
    return {
      affect2D: this.affect2DValue,
      bloom: {
        enabled: this.bloomEnabledValue,
        intensity: this.bloomIntensityValue,
        threshold: this.bloomThresholdValue,
        smoothing: this.bloomSmoothingValue,
        radius: this.bloomRadiusValue,
      },
      vignette: {
        enabled: this.vignetteEnabledValue,
        offset: this.vignetteOffsetValue,
        darkness: this.vignetteDarknessValue,
      },
      chromaticAberration: {
        enabled: this.chromaticAberrationEnabledValue,
        offset: this.chromaticAberrationOffsetValue,
      },
      ssao: {
        enabled: this.getResolvedAOMode() === 'realtime',
        intensity: this.ssaoIntensityValue,
        radius: this.ssaoRadiusValue,
      },
      lut: {
        enabled: this.lutEnabledValue,
        src: this.lutSrcValue,
        intensity: this.lutIntensityValue,
      },
    };
  }

  /**
   * Authored configuration as a plain object for scene serialization. Keys match
   * the loader's expected property names one-to-one.
   */
  serializeConfig(): Record<string, unknown> {
    return {
      affect2D: this.affect2DValue,
      bloomEnabled: this.bloomEnabledValue,
      bloomIntensity: this.bloomIntensityValue,
      bloomThreshold: this.bloomThresholdValue,
      bloomSmoothing: this.bloomSmoothingValue,
      bloomRadius: this.bloomRadiusValue,
      vignetteEnabled: this.vignetteEnabledValue,
      vignetteOffset: this.vignetteOffsetValue,
      vignetteDarkness: this.vignetteDarknessValue,
      chromaticAberrationEnabled: this.chromaticAberrationEnabledValue,
      chromaticAberrationOffset: this.chromaticAberrationOffsetValue,
      aoMode: this.aoModeValue,
      ssaoIntensity: this.ssaoIntensityValue,
      ssaoRadius: this.ssaoRadiusValue,
      lutEnabled: this.lutEnabledValue,
      lutSrc: this.lutSrcValue,
      lutIntensity: this.lutIntensityValue,
    };
  }

  static override getPropertySchema(): PropertySchema {
    const base = NodeBase.getPropertySchema();

    return {
      nodeType: 'PostProcess',
      extends: 'NodeBase',
      properties: [
        ...base.properties,
        defineProperty('affect2D', 'boolean', {
          ui: {
            label: 'Affect 2D',
            description: 'When on, the 2D content layer also passes through the effect stack',
            group: 'General',
          },
          getValue: node => (node as PostProcess).affect2D,
          setValue: (node, value) => {
            (node as PostProcess).affect2D = Boolean(value);
          },
        }),
        // ── Bloom ────────────────────────────────────────────────────────────
        defineProperty('bloomEnabled', 'boolean', {
          ui: { label: 'Enabled', group: 'Bloom' },
          getValue: node => (node as PostProcess).bloomEnabled,
          setValue: (node, value) => {
            (node as PostProcess).bloomEnabled = Boolean(value);
          },
        }),
        defineProperty('bloomIntensity', 'number', {
          ui: {
            label: 'Intensity',
            description: 'Overall bloom strength (animatable — a flash is 3 keys)',
            group: 'Bloom',
            min: 0,
            step: 0.05,
            precision: 2,
            readOnly: t => !(t as PostProcess).bloomEnabled,
          },
          getValue: node => (node as PostProcess).bloomIntensity,
          setValue: (node, value) => {
            (node as PostProcess).bloomIntensity = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) && Number(value) >= 0 },
        }),
        defineProperty('bloomThreshold', 'number', {
          ui: {
            label: 'Threshold',
            description: 'Luminance below this is not bloomed',
            group: 'Bloom',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as PostProcess).bloomEnabled,
          },
          getValue: node => (node as PostProcess).bloomThreshold,
          setValue: (node, value) => {
            (node as PostProcess).bloomThreshold = Number(value);
          },
        }),
        defineProperty('bloomSmoothing', 'number', {
          ui: {
            label: 'Smoothing',
            group: 'Bloom',
            min: 0,
            max: 1,
            step: 0.005,
            precision: 3,
            readOnly: t => !(t as PostProcess).bloomEnabled,
          },
          getValue: node => (node as PostProcess).bloomSmoothing,
          setValue: (node, value) => {
            (node as PostProcess).bloomSmoothing = Number(value);
          },
        }),
        defineProperty('bloomRadius', 'number', {
          ui: {
            label: 'Radius',
            group: 'Bloom',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as PostProcess).bloomEnabled,
          },
          getValue: node => (node as PostProcess).bloomRadius,
          setValue: (node, value) => {
            (node as PostProcess).bloomRadius = Number(value);
          },
        }),
        // ── Vignette ──────────────────────────────────────────────────────────
        defineProperty('vignetteEnabled', 'boolean', {
          ui: { label: 'Enabled', group: 'Vignette' },
          getValue: node => (node as PostProcess).vignetteEnabled,
          setValue: (node, value) => {
            (node as PostProcess).vignetteEnabled = Boolean(value);
          },
        }),
        defineProperty('vignetteOffset', 'number', {
          ui: {
            label: 'Offset',
            group: 'Vignette',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as PostProcess).vignetteEnabled,
          },
          getValue: node => (node as PostProcess).vignetteOffset,
          setValue: (node, value) => {
            (node as PostProcess).vignetteOffset = Number(value);
          },
        }),
        defineProperty('vignetteDarkness', 'number', {
          ui: {
            label: 'Darkness',
            group: 'Vignette',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as PostProcess).vignetteEnabled,
          },
          getValue: node => (node as PostProcess).vignetteDarkness,
          setValue: (node, value) => {
            (node as PostProcess).vignetteDarkness = Number(value);
          },
        }),
        // ── Chromatic Aberration ──────────────────────────────────────────────
        defineProperty('chromaticAberrationEnabled', 'boolean', {
          ui: { label: 'Enabled', group: 'Chromatic Aberration' },
          getValue: node => (node as PostProcess).chromaticAberrationEnabled,
          setValue: (node, value) => {
            (node as PostProcess).chromaticAberrationEnabled = Boolean(value);
          },
        }),
        defineProperty('chromaticAberrationOffset', 'number', {
          ui: {
            label: 'Offset',
            description: 'RGB channel separation (animatable — a damage pulse)',
            group: 'Chromatic Aberration',
            min: 0,
            max: 0.1,
            step: 0.0005,
            precision: 4,
            readOnly: t => !(t as PostProcess).chromaticAberrationEnabled,
          },
          getValue: node => (node as PostProcess).chromaticAberrationOffset,
          setValue: (node, value) => {
            (node as PostProcess).chromaticAberrationOffset = Number(value);
          },
        }),
        // ── Ambient Occlusion (cascade: scene tier) ───────────────────────────
        defineProperty('aoMode', 'enum', {
          ui: {
            label: 'Mode',
            description:
              'Off · Baked (per-mesh maps, cheap) · Realtime (SSAO, desktop) · Adaptive (by device)',
            group: 'Ambient Occlusion',
            options: [...AO_MODES],
          },
          getValue: node => (node as PostProcess).aoMode,
          setValue: (node, value) => {
            (node as PostProcess).aoMode = String(value);
          },
        }),
        defineProperty('ssaoIntensity', 'number', {
          ui: {
            label: 'SSAO Intensity',
            group: 'Ambient Occlusion',
            min: 0,
            max: 4,
            step: 0.05,
            precision: 2,
            slider: true,
            readOnly: t => !aoModeUsesSSAO((t as PostProcess).aoMode),
          },
          getValue: node => (node as PostProcess).ssaoIntensity,
          setValue: (node, value) => {
            (node as PostProcess).ssaoIntensity = Number(value);
          },
        }),
        defineProperty('ssaoRadius', 'number', {
          ui: {
            label: 'SSAO Radius',
            description: 'Sampling radius (larger = broader, softer occlusion)',
            group: 'Ambient Occlusion',
            min: 0,
            max: 2,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !aoModeUsesSSAO((t as PostProcess).aoMode),
          },
          getValue: node => (node as PostProcess).ssaoRadius,
          setValue: (node, value) => {
            (node as PostProcess).ssaoRadius = Number(value);
          },
        }),
        // ── LUT (color grading) ───────────────────────────────────────────────
        defineProperty('lutEnabled', 'boolean', {
          ui: {
            label: 'Enabled',
            description: 'Color grading via a lookup table (.cube / .3dl)',
            group: 'Color Grading',
          },
          getValue: node => (node as PostProcess).lutEnabled,
          setValue: (node, value) => {
            (node as PostProcess).lutEnabled = Boolean(value);
          },
        }),
        defineProperty('lutSrc', 'string', {
          ui: {
            label: 'LUT',
            description: 'Asset URL of a .cube or .3dl lookup table',
            group: 'Color Grading',
            readOnly: t => !(t as PostProcess).lutEnabled,
          },
          getValue: node => (node as PostProcess).lutSrc,
          setValue: (node, value) => {
            (node as PostProcess).lutSrc = typeof value === 'string' ? value : '';
          },
        }),
        defineProperty('lutIntensity', 'number', {
          ui: {
            label: 'Intensity',
            group: 'Color Grading',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as PostProcess).lutEnabled,
          },
          getValue: node => (node as PostProcess).lutIntensity,
          setValue: (node, value) => {
            (node as PostProcess).lutIntensity = Number(value);
          },
        }),
      ],
      groups: {
        General: { label: 'General', expanded: true },
        Bloom: { label: 'Bloom', expanded: true },
        Vignette: { label: 'Vignette', expanded: false },
        'Chromatic Aberration': { label: 'Chromatic Aberration', expanded: false },
        'Ambient Occlusion': { label: 'Ambient Occlusion', expanded: true },
        'Color Grading': { label: 'Color Grading', expanded: false },
      },
    } as PropertySchema;
  }
}

function normalizeAOMode(value: unknown): AOMode {
  const mode = typeof value === 'string' ? value.toLowerCase() : '';
  return (AO_MODES as readonly string[]).includes(mode) ? (mode as AOMode) : 'baked';
}

/** True for modes whose SSAO params (intensity/radius) are relevant. */
export function aoModeUsesSSAO(mode: AOMode): boolean {
  return mode === 'realtime' || mode === 'adaptive';
}

/**
 * Cheap device-capability heuristic for `adaptive` AO: realtime SSAO on
 * desktop-class devices (fine pointer + enough CPU threads), baked otherwise.
 * Conservative on anything that looks like a phone/tablet to protect the
 * per-frame budget of mobile playables.
 */
export function isHighEndDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };
  // Exclude phones/tablets (the pointer-media heuristic is unreliable — many
  // desktops report `pointer: coarse`), then gate on CPU threads + memory.
  const mobile =
    typeof nav.userAgentData?.mobile === 'boolean'
      ? nav.userAgentData.mobile
      : /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent ?? '');
  if (mobile) {
    return false;
  }
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 4;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 8;
  return cores >= 6 && memory >= 4;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNum(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function clampMin(value: unknown, min: number, current: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : current;
}

function clamp01(value: unknown, current: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return current;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
