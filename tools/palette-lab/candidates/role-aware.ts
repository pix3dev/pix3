/**
 * ROLE-AWARE + CONTRAST candidate.
 *
 * The shipped picker ranks accents by `s · brightness · coverage^0.35` and hands the roles out by
 * rank. On the painted mockups in the corpus that lets a large, saturated but DARK region (the purple
 * shadow side of a pinball table) outrank the small neon strokes a person would actually name. This
 * candidate instead:
 *
 *   1. keeps the shipped background choice (`quantizePixels(16)` + the phone-mockup correction), so
 *      index 0 is unchanged from the control;
 *   2. builds its own accent pool from a HUE HISTOGRAM of the vivid pixels rather than a median cut —
 *      each 15° bin (split once more into a dark/mid and a light band) is represented by the mean of
 *      its brightest-chroma third, so a bin that is mostly shadow but has a neon core is represented
 *      by the neon, not the shadow; coverage only decides whether a bin is real (anti-aliasing noise
 *      is dropped) and adds a whisper (`share^0.1`) to the ranking;
 *   3. fills the roles EXPLICITLY:
 *        player      = max chroma·lightness pop with WCAG contrast ≥ 3 against the background
 *        collectible = a warm (gold / orange / yellow) colour if the picture has one — claimed before
 *                      the hazard search so "farthest hue" cannot spend the only gold
 *        hazard      = the strong vivid colour far in hue from the player (prominence x hue-distance)
 *        collectible = (when nothing warm) the next best pop
 *        ui          = the lightest colour left in a hue of its own, else a same-hue pastel, raised
 *                      to L ≥ 0.6
 *   4. lifts every accent's HSL lightness until it clears contrast ≥ 2.5 against the background
 *      (player ≥ 3) instead of dropping it, and invents missing roles as lightness variants of the
 *      accents already chosen, with a lightness target per role.
 *
 * Output order is the recipe contract: [bg, collectible, ui, hazard, player]. Pure and
 * deterministic: fixed sampling stride, stable sorts with index tie-breaks, no randomness.
 */
import {
  hslToRgb,
  quantizePixels,
  rgbToHex,
  rgbToHsl,
  type HslColor,
  type ImagePixels,
  type PaletteSwatch,
  type RgbColor,
} from '../../../src/services/image-gen/image-ops';
import type { CandidateMeta } from '../types';

export const meta: CandidateMeta = {
  name: 'role-aware',
  description:
    'Hue-histogram accents represented by their bright core; roles filled explicitly (player=max pop, collectible=warm, hazard=far hue, ui=pastel); every accent lifted to WCAG contrast >= 2.5 vs bg.',
};

// ---- background: same rules as the shipped picker -------------------------------------------

const STYLE_QUANTIZE_BOXES = 16;
const NEAR_BLACK_LIGHTNESS = 0.06;
const GROUND_MIN_LIGHTNESS = 0.06;
const GROUND_MAX_LIGHTNESS = 0.35;
const GROUND_MIN_SATURATION = 0.15;

// ---- accent pool ------------------------------------------------------------------------------

/** Pixels actually read; a stride walk over the raster, so a small neon stroke still gets votes. */
const ACCENT_MAX_SAMPLES = 24576;
const HUE_BINS = 24;
/** Hue bins are split once more by lightness so a pastel and a neon of the same hue both survive. */
const LIGHT_BAND_LIGHTNESS = 0.66;
/** A pixel must be at least this chromatic to vote for an accent. */
const VIVID_MIN_SATURATION = 0.3;
const VIVID_MIN_LIGHTNESS = 0.2;
const VIVID_MAX_LIGHTNESS = 0.93;
/** Fraction of the sampled OPAQUE pixels a bin needs to count as a real colour, not fringe. */
const BIN_MIN_SHARE = 0.0015;
const BIN_MIN_PIXELS = 12;
/** Portion of a bin (by pop, top first) whose mean represents the bin. */
const BIN_CORE_FRACTION = 0.33;
/** Exponent on coverage in `prominence`: 0.1 means 10x the area buys ~26% more rank, no more. */
const SHARE_EXPONENT = 0.1;
/** A pool entry must sit at least this far from the background to be an accent at all. */
const BACKGROUND_MERGE_DISTANCE = 48;

// ---- roles -------------------------------------------------------------------------------------

const PLAYER_MIN_CONTRAST = 3;
const ACCENT_MIN_CONTRAST = 2.5;
const ACCENT_HUE_SPACING = 28;
/** A hazard candidate must already read this well as painted; the lift does the rest. */
const HAZARD_MIN_PAINTED_CONTRAST = 1.8;
/** Share of the hazard score that is prominence; the rest is hue distance from the player. */
const HAZARD_BASE_WEIGHT = 0.4;
/** A hazard should be saturated, not pastel: the light band's score is scaled by this. */
const HAZARD_PASTEL_PENALTY = 0.7;
const WARM_HUE_MIN = 18;
const WARM_HUE_MAX = 70;
const UI_MIN_LIGHTNESS = 0.6;
/** A same-hue pastel may take the ui slot when it is at least this light… */
const UI_SAME_HUE_MIN_LIGHTNESS = 0.65;
/** …and at least this far in RGB from every colour already chosen. */
const UI_SAME_HUE_MIN_DISTANCE = 60;
const PALETTE_MIN_SEPARATION = 24;
const LIFT_STEP = 0.02;
const LIFT_MAX_LIGHTNESS = 0.92;
/** Lightness targets tried, in order, when a role has to be invented from an existing accent. */
const INVENT_TARGETS: Readonly<
  Record<'player' | 'hazard' | 'collectible' | 'ui', readonly number[]>
> = {
  player: [0.6, 0.7, 0.5],
  hazard: [0.5, 0.68, 0.4, 0.78],
  collectible: [0.74, 0.58, 0.84, 0.48],
  ui: [0.82, 0.72, 0.9, 0.62],
};
const INVENT_MIN_SATURATION = 0.55;

// ---- helpers -----------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const rgbDistance = (a: RgbColor, b: RgbColor): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

const relativeLuminance = (color: RgbColor): number => {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
};

const contrastRatio = (a: RgbColor, b: RgbColor): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** HSL chroma — the real colourfulness, which collapses towards black and white. */
const chroma = (hsl: HslColor): number => (1 - Math.abs(2 * hsl.l - 1)) * hsl.s;

/**
 * How much a colour would "pop" as a glowing sprite: chroma, weighted towards the light side so that
 * of two equally saturated colours the brighter one wins, with a soft penalty on very dark ones.
 */
const pop = (hsl: HslColor): number => chroma(hsl) * (0.35 + hsl.l);

const pickBackground = (swatches: readonly PaletteSwatch[]): RgbColor => {
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

interface PoolEntry {
  readonly color: RgbColor;
  readonly hsl: HslColor;
  readonly pop: number;
  /** `pop` with a whisper of coverage — ranks comparably popping colours by how much is there. */
  readonly prominence: number;
  /** Fraction of sampled opaque pixels in this bin. */
  readonly share: number;
  readonly index: number;
}

interface BinSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly pop: number;
}

/**
 * The vivid pixels of the image, bucketed by hue (and by a dark/light band) and represented by the
 * bright core of each bucket.
 */
const buildPool = (pixels: ImagePixels, background: RgbColor): PoolEntry[] => {
  const total = pixels.width * pixels.height;
  if (total <= 0) {
    return [];
  }
  const stride = Math.max(1, Math.ceil(total / ACCENT_MAX_SAMPLES));
  const bins: BinSample[][] = Array.from({ length: HUE_BINS * 2 }, () => []);
  let sampled = 0;
  for (let index = 0; index < total; index += stride) {
    const offset = index * 4;
    if (pixels.data[offset + 3] <= 8) {
      continue;
    }
    sampled += 1;
    const color: RgbColor = {
      r: pixels.data[offset],
      g: pixels.data[offset + 1],
      b: pixels.data[offset + 2],
    };
    const hsl = rgbToHsl(color);
    if (
      hsl.s < VIVID_MIN_SATURATION ||
      hsl.l < VIVID_MIN_LIGHTNESS ||
      hsl.l > VIVID_MAX_LIGHTNESS
    ) {
      continue;
    }
    const hueBin = Math.min(HUE_BINS - 1, Math.floor((hsl.h / 360) * HUE_BINS));
    const band = hsl.l >= LIGHT_BAND_LIGHTNESS ? 1 : 0;
    bins[hueBin * 2 + band].push({ r: color.r, g: color.g, b: color.b, pop: pop(hsl) });
  }
  if (sampled === 0) {
    return [];
  }

  const pool: PoolEntry[] = [];
  bins.forEach((bin, binIndex) => {
    const share = bin.length / sampled;
    if (bin.length < BIN_MIN_PIXELS || share < BIN_MIN_SHARE) {
      return;
    }
    // Stable: pop desc, then original push order (JS sort is stable since ES2019).
    const sorted = bin.slice().sort((a, b) => b.pop - a.pop);
    const coreCount = Math.max(1, Math.round(sorted.length * BIN_CORE_FRACTION));
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < coreCount; i += 1) {
      r += sorted[i].r;
      g += sorted[i].g;
      b += sorted[i].b;
    }
    const color: RgbColor = {
      r: Math.round(r / coreCount),
      g: Math.round(g / coreCount),
      b: Math.round(b / coreCount),
    };
    if (rgbDistance(color, background) < BACKGROUND_MERGE_DISTANCE) {
      return;
    }
    const hsl = rgbToHsl(color);
    const strength = pop(hsl);
    pool.push({
      color,
      hsl,
      pop: strength,
      prominence: strength * Math.pow(share, SHARE_EXPONENT),
      share,
      index: binIndex,
    });
  });

  // Merge bins that ended up as the same colour (a hue straddling a bin edge, or a band split that
  // produced two near-identical means): keep the stronger representative, add the shares.
  const byProminence = (a: PoolEntry, b: PoolEntry): number =>
    b.prominence - a.prominence || b.share - a.share || a.index - b.index;
  const merged: PoolEntry[] = [];
  for (const entry of pool.slice().sort(byProminence)) {
    const twin = merged.findIndex(
      kept =>
        hueDistance(kept.hsl.h, entry.hsl.h) < 360 / HUE_BINS &&
        rgbDistance(kept.color, entry.color) < 40
    );
    if (twin >= 0) {
      const kept = merged[twin];
      const share = kept.share + entry.share;
      merged[twin] = { ...kept, share, prominence: kept.pop * Math.pow(share, SHARE_EXPONENT) };
    } else {
      merged.push(entry);
    }
  }
  return merged.sort(byProminence);
};

/** Raise (or, for a light bg, lower) lightness until the colour clears the contrast bar. */
const liftToContrast = (color: RgbColor, background: RgbColor, minContrast: number): RgbColor => {
  if (contrastRatio(color, background) >= minContrast) {
    return color;
  }
  const base = rgbToHsl(color);
  const bgLight = rgbToHsl(background).l > 0.5;
  let l = base.l;
  let best = color;
  for (let step = 0; step < 60; step += 1) {
    l = bgLight ? l - LIFT_STEP : l + LIFT_STEP;
    if (l < 0.08 || l > LIFT_MAX_LIGHTNESS) {
      break;
    }
    best = hslToRgb({ h: base.h, s: base.s, l });
    if (contrastRatio(best, background) >= minContrast) {
      return best;
    }
  }
  return best;
};

export function pick(pixels: ImagePixels): string[] {
  const swatches = quantizePixels(pixels, STYLE_QUANTIZE_BOXES, {});
  const background: RgbColor =
    swatches.length > 0 ? pickBackground(swatches) : { r: 20, g: 20, b: 32 };
  const pool = buildPool(pixels, background);

  const chosen: RgbColor[] = [background];
  const separated = (color: RgbColor, floor = PALETTE_MIN_SEPARATION): boolean =>
    chosen.every(picked => rgbDistance(color, picked) >= floor);
  const usedHues: number[] = [];
  const hueFree = (hue: number): boolean =>
    usedHues.every(used => hueDistance(used, hue) >= ACCENT_HUE_SPACING);
  const taken = new Set<number>();

  const admit = (entry: PoolEntry, minContrast: number, minLightness = 0): RgbColor => {
    taken.add(entry.index);
    usedHues.push(entry.hsl.h);
    const raised =
      entry.hsl.l >= minLightness
        ? entry.color
        : hslToRgb({ h: entry.hsl.h, s: entry.hsl.s, l: minLightness });
    const lifted = liftToContrast(raised, background, minContrast);
    chosen.push(lifted);
    return lifted;
  };
  const available = (): PoolEntry[] =>
    pool.filter(entry => !taken.has(entry.index) && hueFree(entry.hsl.h));
  /** Prefer what already reads on the ground; only then what has to be lifted there. */
  const visibleFirst = (entries: readonly PoolEntry[], minContrast: number): PoolEntry[] => {
    const visible = entries.filter(entry => contrastRatio(entry.color, background) >= minContrast);
    return visible.length > 0 ? visible : entries.slice();
  };

  // --- player: the most eye-catching colour that can actually be seen on the ground -------------
  let player: RgbColor | null = null;
  let playerHue = 0;
  {
    const winner = visibleFirst(available(), PLAYER_MIN_CONTRAST)[0];
    if (winner) {
      playerHue = winner.hsl.h;
      player = admit(winner, PLAYER_MIN_CONTRAST);
    }
  }

  // --- collectible: a warm colour, if the picture has one, is claimed before the hazard search can
  // spend it as "the farthest hue" -------------------------------------------------------------
  let collectible: RgbColor | null = null;
  {
    const warm = visibleFirst(
      available().filter(entry => entry.hsl.h >= WARM_HUE_MIN && entry.hsl.h <= WARM_HUE_MAX),
      ACCENT_MIN_CONTRAST
    )[0];
    if (warm) {
      collectible = admit(warm, ACCENT_MIN_CONTRAST);
    }
  }

  // --- hazard: the strong vivid colour far in hue from the player. Ranked by prominence times a
  // hue-distance bonus rather than by distance alone: the literal complement of a neon cyan is a
  // dull orange-red, while the hot magenta a person would call "the other colour" sits at 130°. Only
  // colours that can be lifted to readability without becoming pastel (contrast >= 1.8 as painted)
  // are considered ------------------------------------------------------------------------------
  let hazard: RgbColor | null = null;
  if (player) {
    const candidates = visibleFirst(available(), HAZARD_MIN_PAINTED_CONTRAST);
    const best = candidates
      .map((entry, order) => ({
        entry,
        order,
        score:
          entry.prominence *
          (entry.hsl.l >= LIGHT_BAND_LIGHTNESS ? HAZARD_PASTEL_PENALTY : 1) *
          (HAZARD_BASE_WEIGHT +
            (1 - HAZARD_BASE_WEIGHT) * (hueDistance(entry.hsl.h, playerHue) / 180)),
      }))
      .sort((a, b) => b.score - a.score || a.order - b.order)[0];
    if (best) {
      hazard = admit(best.entry, ACCENT_MIN_CONTRAST);
    }
  }

  // --- collectible, when nothing warm was there: the next best pop ---------------------------------
  if (!collectible) {
    const winner = visibleFirst(available(), ACCENT_MIN_CONTRAST)[0];
    if (winner) {
      collectible = admit(winner, ACCENT_MIN_CONTRAST);
    }
  }

  // --- ui: the lightest / most pastel thing left, in a hue of its own if the picture has one. A
  // pastel of an accent hue already in use is the second choice (a pale cyan next to neon cyan is
  // what HUD text looks like), as long as it is far enough in RGB from everything chosen; the last
  // is the next best pop, raised to L >= 0.6 ------------------------------------------------------
  let ui: RgbColor | null = null;
  {
    const byLightness = (a: PoolEntry, b: PoolEntry): number =>
      b.hsl.l - a.hsl.l || a.index - b.index;
    const light = pool.filter(
      entry => !taken.has(entry.index) && entry.hsl.l >= UI_MIN_LIGHTNESS
    );
    const ownHue = light.filter(entry => hueFree(entry.hsl.h)).sort(byLightness)[0];
    const sameHuePastel = light
      .filter(
        entry =>
          entry.hsl.l >= UI_SAME_HUE_MIN_LIGHTNESS &&
          separated(entry.color, UI_SAME_HUE_MIN_DISTANCE)
      )
      .sort(byLightness)[0];
    const winner = ownHue ?? sameHuePastel ?? available()[0];
    if (winner) {
      ui = admit(winner, ACCENT_MIN_CONTRAST, UI_MIN_LIGHTNESS);
    }
  }

  // --- pad missing roles with lightness variants of the accents already chosen (then the ground) --
  const invent = (role: keyof typeof INVENT_TARGETS): RgbColor => {
    const seeds: RgbColor[] = [player, hazard, collectible, background].filter(
      (c): c is RgbColor => c !== null
    );
    for (const target of INVENT_TARGETS[role]) {
      for (const seed of seeds) {
        const base = rgbToHsl(seed);
        const variant = hslToRgb({
          h: base.h,
          s: Math.max(base.s, INVENT_MIN_SATURATION),
          l: target,
        });
        const lifted = liftToContrast(variant, background, ACCENT_MIN_CONTRAST);
        if (separated(lifted)) {
          chosen.push(lifted);
          return lifted;
        }
      }
    }
    // Last resort: a warm gold that reads on anything dark, lowered on anything light.
    const fallback = liftToContrast({ r: 240, g: 200, b: 80 }, background, ACCENT_MIN_CONTRAST);
    chosen.push(fallback);
    return fallback;
  };
  if (!player) player = invent('player');
  if (!hazard) hazard = invent('hazard');
  if (!collectible) collectible = invent('collectible');
  if (!ui) ui = invent('ui');

  // --- final separation pass: nudge any pair closer than the floor apart by lightness -------------
  const roles: RgbColor[] = [collectible, ui, hazard, player];
  const others = (skip: number): RgbColor[] => [background, ...roles.filter((_, i) => i !== skip)];
  for (let i = 0; i < roles.length; i += 1) {
    let attempt = 0;
    while (
      others(i).some(other => rgbDistance(roles[i], other) < PALETTE_MIN_SEPARATION) &&
      attempt < 12
    ) {
      const base = rgbToHsl(roles[i]);
      const direction = attempt % 2 === 0 ? 1 : -1;
      const magnitude = 0.08 * (Math.floor(attempt / 2) + 1);
      const variant = hslToRgb({
        h: base.h,
        s: base.s,
        l: clamp(base.l + direction * magnitude, 0.2, LIFT_MAX_LIGHTNESS),
      });
      roles[i] = liftToContrast(variant, background, ACCENT_MIN_CONTRAST);
      attempt += 1;
    }
  }

  return [background, ...roles].map(rgbToHex);
}

/** Debug aid for the lab: the accent pool a picture produces, strongest first. Not used by `pick`. */
export function analyze(pixels: ImagePixels): { background: string; pool: string[] } {
  const swatches = quantizePixels(pixels, STYLE_QUANTIZE_BOXES, {});
  const background = pickBackground(swatches);
  const pool = buildPool(pixels, background);
  return {
    background: rgbToHex(background),
    pool: pool.map(
      entry =>
        `${rgbToHex(entry.color)} h${entry.hsl.h.toFixed(0)} s${entry.hsl.s.toFixed(2)} l${entry.hsl.l.toFixed(2)} pop${entry.pop.toFixed(2)} prom${entry.prominence.toFixed(2)} share${(entry.share * 100).toFixed(2)}% c${contrastRatio(entry.color, background).toFixed(1)}`
    ),
  };
}
