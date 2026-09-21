/**
 * PERCEPTUAL-FIRST accent picker.
 *
 * The shipped pipeline ranks accent boxes by `saturation · brightness · coverage^0.35`, and on a
 * neon reference that multiplier is exactly what lets a large *dark* saturated region (the purple
 * board, the navy gutter) beat a small *bright* one (a gold "+25", the cyan ball). It also gets its
 * accent colours out of median-cut boxes, which average bright and dim pixels of one hue into a
 * muddy mid-tone.
 *
 * This candidate does neither:
 *
 *   1. Every sampled pixel is scored on its own — OKLab chroma × OKLab-lightness fitness — with
 *      no coverage term at all. Dark pixels score ≈ 0 no matter how many there are.
 *   2. Accents are found as *hue modes*: 10° hue bins are ranked by the mean fitness of their
 *      brightest meaningful mass (top 25 %, never fewer than the speck floor). Coverage is used
 *      only to reject bins under 0.3 % of the sampled pixels and to break score ties.
 *   3. The colour reported for a mode is the average of the fittest 40 % of pixels within ±14° of
 *      the bin — the neon itself, not the neon blended with its shadow.
 *   4. Picked modes claim everything within 28° of hue, so the next pick is a different colour;
 *      every returned colour is ≥ 24 RGB from every other and ≥ 48 from the ground.
 *   5. The ground is the shipped rule: most-covering swatch of a 16-box quantization, with the
 *      phone-mockup correction (a near-black device frame yields to the heaviest lit, tinted dark).
 *
 * Deterministic and pure: fixed sampling stride, every sort breaks ties on index, no randomness.
 * Uses only `image-ops` exports plus helpers in this file.
 */
import {
  hslToRgb,
  quantizePixels,
  rgbToHex,
  rgbToHsl,
  type ImagePixels,
  type PaletteSwatch,
  type RgbColor,
} from '../../../src/services/image-gen/image-ops';
import type { CandidateMeta } from '../types';

export const meta: CandidateMeta = {
  name: 'perceptual',
  description:
    'Per-pixel OKLab chroma×lightness fitness, hue-mode seeking (10° bins, ≥28° apart), coverage only as speck floor / tie-break; ground = shipped mockup-aware rule.',
};

// ---- constants -----------------------------------------------------------------------------------

const PALETTE_SIZE = 5;
const ACCENT_SLOTS = PALETTE_SIZE - 1;

/** Sampling: enough pixels for stable per-hue statistics, walked with a fixed stride. */
const MAX_SAMPLES = 40000;
const ALPHA_THRESHOLD = 8;

/** Ground (copied semantics from the shipped `pickBackground`). */
const GROUND_QUANTIZE_BOXES = 16;
const NEAR_BLACK_LIGHTNESS = 0.06;
const GROUND_MIN_LIGHTNESS = 0.06;
const GROUND_MAX_LIGHTNESS = 0.35;
const GROUND_MIN_SATURATION = 0.15;

/** Accent gate: perceptually lit (OKLab), not near-white, and actually chromatic. */
const ACCENT_MIN_OKLAB_L = 0.42;
const ACCENT_MIN_HSL_L = 0.3;
const ACCENT_MAX_HSL_L = 0.94;
const ACCENT_MIN_CHROMA = 0.06;
/** Largest OKLab chroma reachable inside sRGB (pure blue) — normalises chroma to 0..1. */
const SRGB_MAX_CHROMA = 0.32;
/** Lightness-fitness ramp (OKLab L): 0 at the floor, 1 from the ceiling up. */
const LIGHTNESS_RAMP_LOW = 0.4;
const LIGHTNESS_RAMP_HIGH = 0.7;

/** Hue-mode search. */
const HUE_BIN_DEG = 10;
const HUE_BIN_COUNT = 360 / HUE_BIN_DEG;
/** ± half-window around a bin centre that feeds the bin's score and its representative colour. */
const HUE_WINDOW_DEG = 14;
/** A picked mode claims this much hue on either side, so consecutive picks are distinct colours. */
const ACCENT_HUE_SPACING = 28;
/** Share of *all* sampled opaque pixels under which a hue is a speck, not a colour. */
const SPECK_SHARE = 0.003;
/** Share of a window's pixels (by fitness) that defines "its brightest meaningful mass". */
const SCORE_TOP_SHARE = 0.25;
/** Share of a window's pixels (by fitness) averaged into the representative colour. */
const REPRESENTATIVE_TOP_SHARE = 0.3;

/** Separation rules the whole palette must satisfy. */
const PALETTE_MIN_SEPARATION = 24;
const BACKGROUND_MERGE_DISTANCE = 48;

/**
 * Absolute HSL lightness targets tried, in order, to invent missing accents from the strongest one.
 * Absolute rather than relative: a +0.2 step from an already-light gold lands on cream, which is a
 * fifth white, not a fifth colour. A deep-but-lit variant first, then a lighter one.
 */
const VARIANT_LIGHTNESS_TARGETS: readonly number[] = [0.5, 0.66, 0.42, 0.8, 0.58, 0.36];
/** Invented colours are pinned this saturated so they still glow rather than fade to pastel. */
const VARIANT_MIN_SATURATION = 0.8;

/**
 * The player slot goes to the strongest accent unless the runner-up pops this much harder against
 * the ground (WCAG contrast ratio). On a mid-purple mockup magenta out-scores cyan on chroma, but
 * the cyan ball is what reads as "the player" on that ground.
 */
const PLAYER_CONTRAST_SWAP_RATIO = 1.25;

// ---- small maths ----------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

const rgbDistance = (a: RgbColor, b: RgbColor): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

interface OklabColor {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

const srgbChannelToLinear = (channel: number): number => {
  const c = clamp(channel, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** sRGB → OKLab (Björn Ottosson's matrices). L is 0..1, chroma = hypot(a, b). */
const rgbToOklab = (color: RgbColor): OklabColor => {
  const r = srgbChannelToLinear(color.r);
  const g = srgbChannelToLinear(color.g);
  const b = srgbChannelToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};

// ---- ground -----------------------------------------------------------------------------------------

/** Shipped rule: heaviest swatch, unless it is the device frame — then the heaviest lit, tinted dark. */
const pickGround = (swatches: readonly PaletteSwatch[]): RgbColor => {
  const heaviest = (entries: readonly PaletteSwatch[]): PaletteSwatch =>
    entries.reduce((best, entry) => (entry.weight > best.weight ? entry : best));
  const top = heaviest(swatches);
  if (rgbToHsl(top.color).l >= NEAR_BLACK_LIGHTNESS) {
    return top.color;
  }
  const grounds = swatches.filter(entry => {
    const { s, l } = rgbToHsl(entry.color);
    return l >= GROUND_MIN_LIGHTNESS && l <= GROUND_MAX_LIGHTNESS && s >= GROUND_MIN_SATURATION;
  });
  return grounds.length > 0 ? heaviest(grounds).color : top.color;
};

// ---- per-pixel accent samples -------------------------------------------------------------------

interface AccentSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** HSL hue, degrees 0..360. */
  readonly hue: number;
  /** Chroma × lightness fitness, 0..1 — no coverage term anywhere. */
  readonly fitness: number;
  /** Sample order, for stable tie-breaks. */
  readonly index: number;
}

interface SampledAccents {
  readonly samples: AccentSample[];
  /** Every opaque pixel that was visited, gate or not — the denominator for the speck floor. */
  readonly sampledOpaque: number;
}

const accentFitness = (color: RgbColor): { hue: number; fitness: number } | null => {
  const { h, s, l } = rgbToHsl(color);
  if (l < ACCENT_MIN_HSL_L || l > ACCENT_MAX_HSL_L) {
    return null;
  }
  const lab = rgbToOklab(color);
  const chroma = Math.hypot(lab.a, lab.b);
  if (lab.L < ACCENT_MIN_OKLAB_L || chroma < ACCENT_MIN_CHROMA) {
    return null;
  }
  // Geometric mean of chroma in a uniform space and saturation relative to the hue's own gamut:
  // OKLab chroma alone under-rates cyan/green next to magenta, HSL saturation alone over-rates
  // dark pure colours. The lightness ramp is what keeps a big dark saturated region at ≈ 0.
  const colourfulness = Math.sqrt(clamp(chroma / SRGB_MAX_CHROMA, 0, 1) * s);
  const lit = smoothstep(LIGHTNESS_RAMP_LOW, LIGHTNESS_RAMP_HIGH, lab.L);
  return { hue: h, fitness: colourfulness * lit };
};

const sampleAccents = (pixels: ImagePixels): SampledAccents => {
  const total = pixels.width * pixels.height;
  const samples: AccentSample[] = [];
  let sampledOpaque = 0;
  if (total <= 0) {
    return { samples, sampledOpaque };
  }
  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  for (let index = 0; index < total; index += stride) {
    const offset = index * 4;
    if (pixels.data[offset + 3] <= ALPHA_THRESHOLD) {
      continue;
    }
    sampledOpaque += 1;
    const color: RgbColor = {
      r: pixels.data[offset],
      g: pixels.data[offset + 1],
      b: pixels.data[offset + 2],
    };
    const scored = accentFitness(color);
    if (!scored || scored.fitness <= 0) {
      continue;
    }
    samples.push({
      r: color.r,
      g: color.g,
      b: color.b,
      hue: scored.hue,
      fitness: scored.fitness,
      index: samples.length,
    });
  }
  return { samples, sampledOpaque };
};

// ---- hue-mode seeking -----------------------------------------------------------------------------

const byFitnessDesc = (a: AccentSample, b: AccentSample): number =>
  b.fitness - a.fitness || a.index - b.index;

const windowAround = (
  samples: readonly AccentSample[],
  centreHue: number,
  halfWidth: number
): AccentSample[] => samples.filter(sample => hueDistance(sample.hue, centreHue) <= halfWidth);

const meanOfTop = (sortedDesc: readonly AccentSample[], count: number): number => {
  const n = Math.min(sortedDesc.length, Math.max(1, count));
  let sum = 0;
  for (let index = 0; index < n; index += 1) {
    sum += sortedDesc[index].fitness;
  }
  return sum / n;
};

const averageColor = (sortedDesc: readonly AccentSample[], count: number): RgbColor => {
  const n = Math.min(sortedDesc.length, Math.max(1, count));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let index = 0; index < n; index += 1) {
    r += sortedDesc[index].r;
    g += sortedDesc[index].g;
    b += sortedDesc[index].b;
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
};

interface HueMode {
  readonly color: RgbColor;
  readonly hue: number;
  /** Pixels the mode claimed — coverage, kept only for ordering the middle slots. */
  readonly coverage: number;
  readonly order: number;
}

interface BinScore {
  readonly bin: number;
  readonly score: number;
  readonly count: number;
}

/**
 * Greedy mode seeking over hue. Each round ranks every 10° bin by the mean fitness of the brightest
 * meaningful mass in its ±14° window (top 25 %, never fewer than the speck floor), takes the best,
 * reports its representative colour, and claims every remaining sample within
 * {@link ACCENT_HUE_SPACING} of that colour's hue. Coverage decides nothing but speck rejection
 * and ties.
 */
const seekHueModes = (
  sampled: SampledAccents,
  ground: RgbColor,
  wanted: number
): HueMode[] => {
  const minCount = Math.max(1, Math.ceil(sampled.sampledOpaque * SPECK_SHARE));
  let remaining = sampled.samples.slice();
  const modes: HueMode[] = [];
  const chosen: RgbColor[] = [ground];

  while (modes.length < wanted && remaining.length >= minCount) {
    const scores: BinScore[] = [];
    for (let bin = 0; bin < HUE_BIN_COUNT; bin += 1) {
      const centre = bin * HUE_BIN_DEG + HUE_BIN_DEG / 2;
      const window = windowAround(remaining, centre, HUE_WINDOW_DEG);
      if (window.length < minCount) {
        continue;
      }
      window.sort(byFitnessDesc);
      const topCount = Math.max(minCount, Math.ceil(window.length * SCORE_TOP_SHARE));
      scores.push({ bin, score: meanOfTop(window, topCount), count: window.length });
    }
    if (scores.length === 0) {
      break;
    }
    scores.sort((a, b) => b.score - a.score || b.count - a.count || a.bin - b.bin);
    const best = scores[0];
    const centre = best.bin * HUE_BIN_DEG + HUE_BIN_DEG / 2;
    const window = windowAround(remaining, centre, HUE_WINDOW_DEG).sort(byFitnessDesc);
    const representative = averageColor(
      window,
      Math.max(minCount, Math.ceil(window.length * REPRESENTATIVE_TOP_SHARE))
    );
    const hue = rgbToHsl(representative).h;

    // Claim the whole hue neighbourhood whether or not the colour is admitted — a rejected mode must
    // not be re-found next round with the same pixels.
    const claimed = remaining.filter(sample => hueDistance(sample.hue, hue) < ACCENT_HUE_SPACING);
    remaining = remaining.filter(sample => hueDistance(sample.hue, hue) >= ACCENT_HUE_SPACING);
    // Also drop the window itself in case the representative's hue drifted away from the bin centre.
    remaining = remaining.filter(sample => hueDistance(sample.hue, centre) > HUE_WINDOW_DEG);

    const separated =
      rgbDistance(representative, ground) >= BACKGROUND_MERGE_DISTANCE &&
      chosen.every(picked => rgbDistance(representative, picked) >= PALETTE_MIN_SEPARATION) &&
      modes.every(mode => hueDistance(mode.hue, hue) >= ACCENT_HUE_SPACING);
    if (!separated) {
      continue;
    }
    chosen.push(representative);
    modes.push({ color: representative, hue, coverage: claimed.length, order: modes.length });
  }
  return modes;
};

// ---- filling & ordering --------------------------------------------------------------------------

/** Lightness variants of `source` (HSL) that keep every separation rule; used to fill missing slots. */
const inventVariants = (
  source: RgbColor,
  chosen: readonly RgbColor[],
  needed: number
): RgbColor[] => {
  const out: RgbColor[] = [];
  const base = rgbToHsl(source);
  for (const target of VARIANT_LIGHTNESS_TARGETS) {
    if (out.length >= needed) {
      break;
    }
    const variant = hslToRgb({
      h: base.h,
      s: Math.max(base.s, VARIANT_MIN_SATURATION),
      l: target,
    });
    const all = [...chosen, ...out];
    // An invented colour must earn its slot: the full merge distance from everything, not just the
    // palette minimum — otherwise a target that brackets the source yields a near-twin of it.
    if (all.every(picked => rgbDistance(variant, picked) >= BACKGROUND_MERGE_DISTANCE)) {
      out.push(variant);
    }
  }
  return out;
};

/** Last resort for an image with no colour at all: a fixed grey/white ramp that still separates. */
const emergencyFill = (ground: RgbColor, chosen: readonly RgbColor[], needed: number): RgbColor[] => {
  const out: RgbColor[] = [];
  for (let l = 0.92; l >= 0.3 && out.length < needed; l -= 0.12) {
    const grey = hslToRgb({ h: 0, s: 0, l });
    const all = [...chosen, ...out];
    if (
      rgbDistance(grey, ground) >= PALETTE_MIN_SEPARATION &&
      all.every(picked => rgbDistance(grey, picked) >= PALETTE_MIN_SEPARATION)
    ) {
      out.push(grey);
    }
  }
  return out;
};

/** WCAG 2.x relative luminance (sRGB → linear, Rec. 709 weights). */
const relativeLuminance = (color: RgbColor): number =>
  0.2126 * srgbChannelToLinear(color.r) +
  0.7152 * srgbChannelToLinear(color.g) +
  0.0722 * srgbChannelToLinear(color.b);

const contrastRatio = (a: RgbColor, b: RgbColor): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Strongest accent first, unless the runner-up pops {@link PLAYER_CONTRAST_SWAP_RATIO}× harder
 * against the ground — then the two swap, so the player slot is the colour that actually reads.
 */
const orderPlayerHazard = (modes: readonly HueMode[], ground: RgbColor): HueMode[] => {
  if (modes.length < 2) {
    return modes.slice();
  }
  const [first, second, ...rest] = modes;
  const swap =
    contrastRatio(second.color, ground) >=
    contrastRatio(first.color, ground) * PLAYER_CONTRAST_SWAP_RATIO;
  return swap ? [second, first, ...rest] : [first, second, ...rest];
};

export function pick(pixels: ImagePixels): string[] {
  const swatches = quantizePixels(pixels, GROUND_QUANTIZE_BOXES, {});
  const ground: RgbColor = swatches.length > 0 ? pickGround(swatches) : { r: 16, g: 16, b: 32 };

  const sampled = sampleAccents(pixels);
  const modes = orderPlayerHazard(seekHueModes(sampled, ground, ACCENT_SLOTS), ground);

  // Role order: strongest → player (last), second → hazard (n-2), the rest → middle by coverage.
  const [player, hazard, ...middle] = modes;
  middle.sort((a, b) => b.coverage - a.coverage || a.order - b.order);
  const measured: RgbColor[] = [...middle.map(m => m.color)];
  if (hazard) measured.push(hazard.color);
  if (player) measured.push(player.color);

  const accents: RgbColor[] = measured.slice();
  const missing = (): number => ACCENT_SLOTS - accents.length;
  if (missing() > 0) {
    const source = player?.color ?? ground;
    // Invented colours are the least "real", so they go in front (middle slots), keeping the
    // measured player/hazard at the end.
    accents.unshift(...inventVariants(source, [ground, ...accents], missing()));
  }
  if (missing() > 0) {
    accents.unshift(...emergencyFill(ground, [ground, ...accents], missing()));
  }

  return [ground, ...accents.slice(0, ACCENT_SLOTS)].map(rgbToHex);
}
