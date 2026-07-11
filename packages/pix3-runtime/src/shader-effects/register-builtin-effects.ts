/**
 * The four built-in shader effects, ported 1:1 from the original flat `fx*`
 * implementation. Exported as pure data so `ShaderEffectRegistry` can seed them
 * without an import cycle.
 */
import { Color, Vector2 } from 'three';
import type { ShaderEffectTickContext, ShaderEffectTypeInfo, ShaderEffectVector2 } from './shader-effect-types';

/**
 * Dissolve — noise-thresholded `discard` with an emissive glowing edge.
 * Owns the shared value-noise helpers (`pix3Hash`/`pix3Noise`); no other
 * built-in redefines them.
 */
const DISSOLVE: ShaderEffectTypeInfo = {
  id: 'core:dissolve',
  key: 'dissolve',
  displayName: 'Dissolve',
  description: 'Noise-thresholded discard with a glowing edge. Animate Amount 0→1 to dissolve away.',
  category: 'Surface',
  keywords: ['dissolve', 'disintegrate', 'erode', 'discard', 'burn'],
  define: 'PIX3_FX_DISSOLVE',
  fragmentPars: /* glsl */ `
uniform float uPix3DissolveAmount;
uniform float uPix3DissolveScale;
uniform float uPix3DissolveEdgeWidth;
uniform vec3 uPix3DissolveEdgeColor;
float pix3Hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float pix3Noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pix3Hash(i), pix3Hash(i + vec2(1.0, 0.0)), u.x),
             mix(pix3Hash(i + vec2(0.0, 1.0)), pix3Hash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,
  chunks: [
    {
      stage: 'fragment',
      anchor: 'emissivemap_fragment',
      position: 'after',
      glsl: /* glsl */ `
  float pix3N = pix3Noise(vPix3Uv * uPix3DissolveScale)
              - uPix3DissolveAmount * (1.0 + uPix3DissolveEdgeWidth);
  if (pix3N < 0.0) discard;
  totalEmissiveRadiance += uPix3DissolveEdgeColor
    * (1.0 - smoothstep(0.0, max(uPix3DissolveEdgeWidth, 1e-4), pix3N));`,
    },
  ],
  params: [
    {
      key: 'amount',
      type: 'number',
      default: 0,
      uniform: 'uPix3DissolveAmount',
      ui: { label: 'Amount', min: 0, max: 1, step: 0.01, precision: 2, slider: true },
    },
    {
      key: 'scale',
      type: 'number',
      default: 8,
      uniform: 'uPix3DissolveScale',
      ui: { label: 'Noise Scale', min: 0.1, max: 64, step: 0.1, precision: 2 },
    },
    {
      key: 'edgeWidth',
      type: 'number',
      default: 0.05,
      uniform: 'uPix3DissolveEdgeWidth',
      ui: { label: 'Edge Width', min: 0, max: 0.5, step: 0.005, precision: 3 },
    },
    {
      key: 'edgeColor',
      type: 'color',
      default: '#ffae42',
      uniform: 'uPix3DissolveEdgeColor',
      ui: { label: 'Edge Color' },
    },
  ],
  createUniforms: () => ({
    uPix3DissolveAmount: { value: 0 },
    uPix3DissolveScale: { value: 8 },
    uPix3DissolveEdgeWidth: { value: 0.05 },
    uPix3DissolveEdgeColor: { value: new Color('#ffae42').convertSRGBToLinear() },
  }),
};

/** Rim light — fresnel-based emissive rim, brightest at grazing angles. */
const RIM: ShaderEffectTypeInfo = {
  id: 'core:rim',
  key: 'rim',
  displayName: 'Rim Light',
  description: 'Fresnel-based emissive rim glow, strongest at grazing angles.',
  category: 'Surface',
  keywords: ['rim', 'fresnel', 'glow', 'outline', 'edge'],
  define: 'PIX3_FX_RIM',
  fragmentPars: /* glsl */ `
uniform vec3 uPix3RimColor;
uniform float uPix3RimIntensity;
uniform float uPix3RimPower;`,
  chunks: [
    {
      stage: 'fragment',
      anchor: 'emissivemap_fragment',
      position: 'after',
      glsl: /* glsl */ `
  float pix3Fr = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), uPix3RimPower);
  totalEmissiveRadiance += uPix3RimColor * pix3Fr * uPix3RimIntensity;`,
    },
  ],
  params: [
    { key: 'color', type: 'color', default: '#ffffff', uniform: 'uPix3RimColor', ui: { label: 'Color' } },
    {
      key: 'intensity',
      type: 'number',
      default: 1,
      uniform: 'uPix3RimIntensity',
      ui: { label: 'Intensity', min: 0, max: 5, step: 0.05, precision: 2, slider: true },
    },
    {
      key: 'power',
      type: 'number',
      default: 2,
      uniform: 'uPix3RimPower',
      ui: { label: 'Power', min: 0.5, max: 8, step: 0.1, precision: 2 },
    },
  ],
  createUniforms: () => ({
    uPix3RimColor: { value: new Color('#ffffff').convertSRGBToLinear() },
    uPix3RimIntensity: { value: 1 },
    uPix3RimPower: { value: 2 },
  }),
};

/**
 * UV scroll — offsets the albedo map each frame. Play-mode only (the offset is
 * CPU-accumulated in `onTick`); requires a bound `material.map`.
 */
const UV_SCROLL: ShaderEffectTypeInfo = {
  id: 'core:uv-scroll',
  key: 'uvScroll',
  displayName: 'UV Scroll',
  description: 'Scrolls the albedo map over time (play-mode only). Requires an Albedo Map.',
  category: 'Texture',
  keywords: ['uv', 'scroll', 'flow', 'conveyor', 'panner', 'texture'],
  define: 'PIX3_FX_UVSCROLL',
  vertexPars: /* glsl */ `uniform vec2 uPix3UvOffset;`,
  chunks: [
    {
      stage: 'vertex',
      anchor: 'uv_vertex',
      position: 'after',
      glsl: /* glsl */ `
  #if defined( USE_MAP )
    vMapUv += uPix3UvOffset;
  #endif`,
    },
  ],
  params: [
    {
      key: 'speed',
      type: 'vector2',
      default: { x: 0.1, y: 0 },
      ui: { label: 'Speed', step: 0.01, precision: 2, unit: 'uv/s' },
    },
  ],
  createUniforms: () => ({ uPix3UvOffset: { value: new Vector2() } }),
  onTick: (ctx: ShaderEffectTickContext, dt: number) => {
    const offset = ctx.uniforms.uPix3UvOffset?.value as Vector2 | undefined;
    const speed = ctx.params.speed as ShaderEffectVector2 | undefined;
    if (!offset || !speed) {
      return;
    }
    offset.x = (offset.x + speed.x * dt) % 1;
    offset.y = (offset.y + speed.y * dt) % 1;
  },
};

/** Flash tint — blends the final lit colour toward a flat colour (hit flash). */
const FLASH: ShaderEffectTypeInfo = {
  id: 'core:flash',
  key: 'flash',
  displayName: 'Flash Tint',
  description: 'Blends the final lit colour toward a flat colour — a hit / damage flash.',
  category: 'Color',
  keywords: ['flash', 'tint', 'hit', 'damage', 'blink'],
  define: 'PIX3_FX_FLASH',
  fragmentPars: /* glsl */ `
uniform vec3 uPix3FlashColor;
uniform float uPix3FlashAmount;`,
  chunks: [
    {
      stage: 'fragment',
      anchor: 'opaque_fragment',
      position: 'before',
      glsl: /* glsl */ `
  outgoingLight = mix(outgoingLight, uPix3FlashColor, saturate(uPix3FlashAmount));`,
    },
  ],
  params: [
    { key: 'color', type: 'color', default: '#ffffff', uniform: 'uPix3FlashColor', ui: { label: 'Color' } },
    {
      key: 'amount',
      type: 'number',
      default: 0,
      uniform: 'uPix3FlashAmount',
      ui: { label: 'Amount', min: 0, max: 1, step: 0.01, precision: 2, slider: true },
    },
  ],
  createUniforms: () => ({
    uPix3FlashColor: { value: new Color('#ffffff').convertSRGBToLinear() },
    uPix3FlashAmount: { value: 0 },
  }),
};

/** Registration order = default picker order. */
export const BUILTIN_SHADER_EFFECTS: ShaderEffectTypeInfo[] = [DISSOLVE, RIM, UV_SCROLL, FLASH];
