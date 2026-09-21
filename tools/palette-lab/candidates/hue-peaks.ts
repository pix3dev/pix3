/**
 * Candidate: HUE HISTOGRAM PEAKS.
 *
 * The shipped picker clusters colourful pixels in RGB (median cut) and ranks the boxes by
 * `S · brightness · coverage^0.35`. On a synthwave / neon reference that loses twice: a large shaded
 * body (the purple board, the lit room behind the phone) forms a big *dark* box that outranks the
 * thin bright rim of the very same hue, and a small neon highlight is averaged into a muddy mean.
 *
 * Here the accents are found in HUE space instead:
 *
 *   1. Vivid pixels (S ≥ 0.25, 0.2 ≤ L ≤ 0.95) vote into a 36-bin circular hue histogram, weighted
 *      by HSL chroma — so a grey-ish pixel of a hue barely counts and a saturated one counts fully.
 *   2. Every populated bin above a noise floor is a candidate peak (iteration 1 used a watershed over
 *      the smoothed histogram; it swallowed thin neon rims sitting on the flank of a big shaded body
 *      of a neighbouring hue — the cyan next to a blue board, the hot pink next to a purple sky).
 *   3. Each bin's *representative* is not the mean: hue is the chroma-weighted circular mean of its
 *      own pixels, lightness the {@link REPRESENTATIVE_L_PERCENTILE}th percentile clamped to a lit
 *      window and saturation the median — the neon highlight of the hue, not its shaded body.
 *   4. Candidates are ranked by the representative's own chroma·L × (Σ chroma·L of the bin)^0.25,
 *      scaled down when the hue is the ground's own; bins closer than {@link HUE_MERGE_DEG} to a
 *      stronger one are the same colour and fold away. The top four are taken with the shipped hue
 *      spacing / RGB separation / background distance gates, and short palettes are padded with
 *      lightness variants of the accents inside the same lit window.
 *
 * Background is picked exactly as today (`quantizePixels(16)` + the near-black phone-frame rule).
 * Pure and deterministic: fixed stride sampling, every sort breaks ties on index, no randomness.
 * Uses only image-ops exports plus helpers in this file — private image-ops values are copied and
 * labelled as such.
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
  name: 'hue-peaks',
  description:
    '36-bin hue histogram over vivid pixels (chroma-gated); every bin a candidate, represented by its p75 lightness / median saturation, ranked by own chroma·L × coverage^0.25 with a ground-hue penalty; shipped background.',
};

const PALETTE_SIZE = 5;
const ACCENT_SLOTS = PALETTE_SIZE - 1;

// ---- copied from image-ops.ts (private) — background rule and shared gates -------------------

const STYLE_QUANTIZE_BOXES = 16;
const NEAR_BLACK_LIGHTNESS = 0.06;
const GROUND_MIN_LIGHTNESS = 0.06;
const GROUND_MAX_LIGHTNESS = 0.35;
const GROUND_MIN_SATURATION = 0.15;
const BACKGROUND_MERGE_DISTANCE = 48;
const PALETTE_MIN_SEPARATION = 24;
const ACCENT_HUE_SPACING = 28;

// ---- this candidate's own knobs ----------------------------------------------------------------

/** Vividness window for a pixel to vote on hue (the task's spec: S ≥ 0.25, L ∈ [0.2, 0.95]). */
const VOTE_MIN_SATURATION = 0.25;
const VOTE_MIN_LIGHTNESS = 0.2;
const VOTE_MAX_LIGHTNESS = 0.95;
/**
 * …plus a floor on HSL chroma `S · (1 − |2L − 1|)`. HSL saturation inflates towards white — `#e8f6fa`
 * is L 0.945 with S 0.64 — so without this the near-white cores of every neon glow pass the S gate
 * and drag the hue's representative lightness to 0.94, a tint that glows in no hue at all.
 */
const VOTE_MIN_CHROMA = 0.15;

/** Bins in the circular hue histogram (10° each). */
const HUE_BINS = 36;
const BIN_DEG = 360 / HUE_BINS;

/** Representatives closer than this in hue are one colour and collapse into the stronger. */
const HUE_MERGE_DEG = 20;

/** A bin lighter than this share of the heaviest bin is noise (JPEG fringe, anti-aliasing). */
const PEAK_MIN_RELATIVE_STRENGTH = 0.03;

/** …and a bin needs at least this share of all vivid votes, whatever the heaviest bin weighs. */
const PEAK_MIN_VOTE_SHARE = 0.003;

/** Which lightness inside a hue's peak bin represents it — the glow, not the body. */
const REPRESENTATIVE_L_PERCENTILE = 0.75;
/**
 * The representative's lightness is clamped to this window. 0.5 is where an HSL hue carries full
 * chroma — a hue whose bright pixels sit below it (the shaded purple board) is reported at its
 * pure-neon lightness rather than its body; above 0.82 a colour is a pastel that a near-white
 * placeholder cannot be tinted with.
 */
const REPRESENTATIVE_MIN_L = 0.5;
const REPRESENTATIVE_MAX_L = 0.82;

/** Coverage exponent in the ranking; small so a thin neon rim can beat a big shaded body. */
const COVERAGE_EXPONENT = 0.25;

/** A hue this close to a tinted ground is the background wearing another shade: score × 0.4. */
const GROUND_HUE_RADIUS = 30;
const GROUND_HUE_PENALTY = 0.4;

/**
 * Lightness targets, in order, for the variants that pad a palette short on hues. All inside the
 * lit window: a −0.34 step from a gold accent gave `#7a4f19`, a brown shadow — the one kind of
 * colour this candidate exists to keep out.
 */
const VARIANT_LIGHTNESS_TARGETS: readonly number[] = [0.74, 0.5, 0.62, 0.82, 0.45];

/** Cap on sampled pixels; the frame is walked with a fixed stride, never resampled. */
const MAX_SAMPLES = 131072;

/** Alpha at or below which a pixel is transparent field, not colour. */
const ALPHA_THRESHOLD = 8;

// ---- helpers -----------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

const rgbDistance = (a: RgbColor, b: RgbColor): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

/** Sorted-copy percentile (0..1) of a plain number list; `[]` → 0. */
const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
};

interface Candidate {
  readonly swatch: PaletteSwatch;
  readonly index: number;
}

/** Verbatim logic of image-ops' private `pickBackground`, over coverage swatches. */
const pickBackground = (swatches: readonly PaletteSwatch[]): RgbColor => {
  const heaviest = (entries: readonly Candidate[]): Candidate =>
    entries.reduce((best, entry) => (entry.swatch.weight > best.swatch.weight ? entry : best));
  const candidates = swatches.map((swatch, index) => ({ swatch, index }));
  const top = heaviest(candidates);
  if (rgbToHsl(top.swatch.color).l >= NEAR_BLACK_LIGHTNESS) {
    return top.swatch.color;
  }
  const grounds = candidates.filter(entry => {
    const { s, l } = rgbToHsl(entry.swatch.color);
    return l >= GROUND_MIN_LIGHTNESS && l <= GROUND_MAX_LIGHTNESS && s >= GROUND_MIN_SATURATION;
  });
  return (grounds.length > 0 ? heaviest(grounds) : top).swatch.color;
};

// ---- hue histogram -----------------------------------------------------------------------------

interface VividSample {
  readonly h: number;
  readonly s: number;
  readonly l: number;
  /** HSL chroma: S · (1 − |2L − 1|). */
  readonly c: number;
}

interface HueHistogram {
  /** Σ chroma per bin. */
  readonly chroma: Float64Array;
  /** Σ chroma·L per bin. */
  readonly chromaL: Float64Array;
  /** Samples per bin, in scan order. */
  readonly bins: VividSample[][];
}

const collectVivid = (pixels: ImagePixels): HueHistogram => {
  const chroma = new Float64Array(HUE_BINS);
  const chromaL = new Float64Array(HUE_BINS);
  const bins: VividSample[][] = Array.from({ length: HUE_BINS }, () => []);
  const total = pixels.width * pixels.height;
  if (total <= 0) {
    return { chroma, chromaL, bins };
  }
  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  for (let index = 0; index < total; index += stride) {
    const offset = index * 4;
    if (pixels.data[offset + 3] <= ALPHA_THRESHOLD) {
      continue;
    }
    const { h, s, l } = rgbToHsl({
      r: pixels.data[offset],
      g: pixels.data[offset + 1],
      b: pixels.data[offset + 2],
    });
    if (s < VOTE_MIN_SATURATION || l < VOTE_MIN_LIGHTNESS || l > VOTE_MAX_LIGHTNESS) {
      continue;
    }
    const c = s * (1 - Math.abs(2 * l - 1));
    if (c < VOTE_MIN_CHROMA) {
      continue;
    }
    const bin = Math.min(HUE_BINS - 1, Math.floor(h / BIN_DEG));
    chroma[bin] += c;
    chromaL[bin] += c * l;
    bins[bin].push({ h, s, l, c });
  }
  return { chroma, chromaL, bins };
};

interface HuePeak {
  /** The bin. */
  readonly peakBin: number;
  /** Σ chroma·L of the bin — the coverage term of the ranking. */
  readonly strength: number;
}

/**
 * Every populated bin that clears the noise floors is a candidate. Adjacent bins of one hue all
 * survive here; {@link rankAccents} folds them by representative hue, keeping the strongest.
 */
const findPeaks = (histogram: HueHistogram): HuePeak[] => {
  let heaviest = 0;
  let totalVotes = 0;
  for (let bin = 0; bin < HUE_BINS; bin += 1) {
    heaviest = Math.max(heaviest, histogram.chroma[bin]);
    totalVotes += histogram.chroma[bin];
  }
  const floor = Math.max(heaviest * PEAK_MIN_RELATIVE_STRENGTH, totalVotes * PEAK_MIN_VOTE_SHARE);
  const peaks: HuePeak[] = [];
  for (let bin = 0; bin < HUE_BINS; bin += 1) {
    if (histogram.chroma[bin] <= 0 || histogram.chroma[bin] < floor) {
      continue;
    }
    peaks.push({ peakBin: bin, strength: histogram.chromaL[bin] });
  }
  return peaks;
};

const binCentre = (bin: number): number => bin * BIN_DEG + BIN_DEG / 2;

/**
 * The colour that stands for a hue peak: chroma-weighted circular mean hue over the peak bin's own
 * pixels (10° — neighbours would pull cyan towards blue), the 75th-percentile lightness clamped to
 * [{@link REPRESENTATIVE_MIN_L}, {@link REPRESENTATIVE_MAX_L}] and the median saturation.
 */
const representative = (peak: HuePeak, histogram: HueHistogram): RgbColor => {
  const samples = histogram.bins[peak.peakBin];
  if (samples.length === 0) {
    // A candidate bin is always populated; kept only so the function is total.
    return hslToRgb({ h: binCentre(peak.peakBin), s: 0.8, l: 0.6 });
  }
  let x = 0;
  let y = 0;
  for (const sample of samples) {
    const radians = (sample.h * Math.PI) / 180;
    x += Math.cos(radians) * sample.c;
    y += Math.sin(radians) * sample.c;
  }
  const hue = x === 0 && y === 0 ? binCentre(peak.peakBin) : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const l = percentile(
    samples.map(sample => sample.l),
    REPRESENTATIVE_L_PERCENTILE
  );
  const s = percentile(
    samples.map(sample => sample.s),
    0.5
  );
  return hslToRgb({ h: hue, s, l: clamp(l, REPRESENTATIVE_MIN_L, REPRESENTATIVE_MAX_L) });
};

interface RankedAccent {
  readonly color: RgbColor;
  readonly hue: number;
  readonly score: number;
  readonly index: number;
}

/**
 * Score = the representative's own chroma·L (how hard the colour pops) × coverage^0.3, halved when
 * the hue is within {@link GROUND_HUE_RADIUS}° of a tinted ground. Two representatives closer than
 * {@link HUE_MERGE_DEG} in hue are the same colour and fold into the stronger one.
 */
const rankAccents = (
  peaks: readonly HuePeak[],
  histogram: HueHistogram,
  ground: RgbColor
): RankedAccent[] => {
  const groundHsl = rgbToHsl(ground);
  const groundIsTinted = groundHsl.s >= GROUND_MIN_SATURATION;
  const scored: RankedAccent[] = peaks.map((peak, index) => {
    const color = representative(peak, histogram);
    const { h, s, l } = rgbToHsl(color);
    const chroma = s * (1 - Math.abs(2 * l - 1));
    const nearGround = groundIsTinted && hueDistance(h, groundHsl.h) < GROUND_HUE_RADIUS;
    const score =
      chroma *
      l *
      Math.pow(Math.max(peak.strength, 0), COVERAGE_EXPONENT) *
      (nearGround ? GROUND_HUE_PENALTY : 1);
    return { color, hue: h, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const merged: RankedAccent[] = [];
  for (const entry of scored) {
    if (!merged.some(kept => hueDistance(kept.hue, entry.hue) < HUE_MERGE_DEG)) {
      merged.push(entry);
    }
  }
  return merged;
};

// ---- assembly ----------------------------------------------------------------------------------

export function pick(pixels: ImagePixels): string[] {
  const ground = pickBackground(quantizePixels(pixels, STYLE_QUANTIZE_BOXES));
  const histogram = collectVivid(pixels);
  const ranked = rankAccents(findPeaks(histogram), histogram, ground).map(entry => entry.color);

  const chosen: RgbColor[] = [ground];
  const separated = (color: RgbColor): boolean =>
    chosen.every(picked => rgbDistance(color, picked) >= PALETTE_MIN_SEPARATION);
  const awayFromGround = (color: RgbColor): boolean =>
    rgbDistance(color, ground) >= BACKGROUND_MERGE_DISTANCE;

  const accents: RgbColor[] = [];
  const deferred: RgbColor[] = [];
  const admit = (color: RgbColor): void => {
    accents.push(color);
    chosen.push(color);
  };

  // Pass 1: strongest first, hue-spaced, separated, and clear of the ground.
  for (const color of ranked) {
    if (accents.length >= ACCENT_SLOTS) {
      break;
    }
    if (!awayFromGround(color) || !separated(color)) {
      continue;
    }
    const hue = rgbToHsl(color).h;
    const crowded = accents.some(
      picked => hueDistance(hue, rgbToHsl(picked).h) < ACCENT_HUE_SPACING
    );
    if (crowded) {
      deferred.push(color);
    } else {
      admit(color);
    }
  }

  // Pass 2: short on hues — a peak 20–28° off an admitted one is still a real colour of the
  // picture (gold beside orange), and a better slot than an invented variant.
  for (const color of deferred) {
    if (accents.length >= ACCENT_SLOTS) {
      break;
    }
    const hue = rgbToHsl(color).h;
    const duplicate = accents.some(picked => hueDistance(hue, rgbToHsl(picked).h) < HUE_MERGE_DEG);
    if (!duplicate && awayFromGround(color) && separated(color)) {
      admit(color);
    }
  }

  // Pass 3: invent lightness variants of the accents (strongest first, then the ground's hue) so
  // the palette always has five distinct colours — every one inside the lit window.
  const sources = [...accents, ground];
  for (const source of sources) {
    if (accents.length >= ACCENT_SLOTS) {
      break;
    }
    const base = rgbToHsl(source);
    const saturation = Math.max(base.s, 0.55);
    for (const l of VARIANT_LIGHTNESS_TARGETS) {
      if (accents.length >= ACCENT_SLOTS) {
        break;
      }
      const variant = hslToRgb({ h: base.h, s: saturation, l });
      if (awayFromGround(variant) && separated(variant)) {
        admit(variant);
      }
    }
  }

  // Last resort (a flat single-colour image): walk grey ramps until five distinct colours exist.
  for (let l = 0.9; accents.length < ACCENT_SLOTS && l > 0.1; l -= 0.1) {
    const grey = hslToRgb({ h: 0, s: 0, l });
    if (separated(grey)) {
      admit(grey);
    }
  }

  // Role order: [bg, mid, mid, hazard, player] — mids by strength descending, then #2, then #1.
  const [top, second, ...middle] = accents;
  const ordered: RgbColor[] = [ground, ...middle];
  if (second) {
    ordered.push(second);
  }
  if (top) {
    ordered.push(top);
  }
  return ordered.map(rgbToHex);
}
