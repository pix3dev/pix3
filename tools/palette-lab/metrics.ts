import { hexToRgb, rgbToHsl, type RgbColor } from '../../src/services/image-gen/image-ops';
import type { PaletteMetrics } from './types';

const parse = (hex: string): RgbColor => {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    throw new Error(`Candidate returned a non-colour: ${JSON.stringify(hex)}`);
  }
  return rgb;
};

const rgbDistance = (a: RgbColor, b: RgbColor): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

/** WCAG 2.x relative luminance (sRGB → linear, Rec. 709 weights). */
const relativeLuminance = (color: RgbColor): number => {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
};

export const contrastRatio = (a: RgbColor, b: RgbColor): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

export const computeMetrics = (palette: readonly string[]): PaletteMetrics => {
  const colors = palette.map(parse);
  const bg = colors[0];
  const accents = colors.slice(1);
  const accentHsl = accents.map(rgbToHsl);

  let minPairwiseRgb = Number.POSITIVE_INFINITY;
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      minPairwiseRgb = Math.min(minPairwiseRgb, rgbDistance(colors[i], colors[j]));
    }
  }

  let hueSpreadDeg = Number.POSITIVE_INFINITY;
  for (let i = 0; i < accentHsl.length; i += 1) {
    for (let j = i + 1; j < accentHsl.length; j += 1) {
      hueSpreadDeg = Math.min(hueSpreadDeg, hueDistance(accentHsl[i].h, accentHsl[j].h));
    }
  }

  return {
    accentMeanL: round(mean(accentHsl.map(c => c.l))),
    accentMinL: round(Math.min(...accentHsl.map(c => c.l))),
    accentMeanS: round(mean(accentHsl.map(c => c.s))),
    minPairwiseRgb: round(Number.isFinite(minPairwiseRgb) ? minPairwiseRgb : 0, 1),
    bgVsPlayerContrast: round(contrastRatio(bg, colors[colors.length - 1]), 2),
    hueSpreadDeg: round(Number.isFinite(hueSpreadDeg) ? hueSpreadDeg : 0, 1),
    bgL: round(rgbToHsl(bg).l),
  };
};
