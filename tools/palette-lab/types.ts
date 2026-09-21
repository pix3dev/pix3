import type { ImagePixels } from '../../src/services/image-gen/image-ops';

export type { ImagePixels };

/** What a candidate says about itself — printed in the report header and stored in the JSON. */
export interface CandidateMeta {
  readonly name: string;
  readonly description: string;
}

/**
 * A palette candidate: decoded RGBA pixels in, EXACTLY five `#rrggbb` out, in the role order the
 * recipe contract (`paletteColorForRole`) reads by index:
 *
 *   [0] background / board ground
 *   [1] collectible / ui (by coverage)
 *   [2] collectible / ui (by coverage)
 *   [3] hazard (second-strongest accent)
 *   [4] player pop colour (strongest accent)
 */
export type PaletteCandidate = (pixels: ImagePixels) => string[];

/** Shape of `tools/palette-lab/candidates/<name>.ts`. */
export interface CandidateModule {
  readonly meta: CandidateMeta;
  readonly pick: PaletteCandidate;
}

export interface PaletteMetrics {
  /** Mean HSL lightness (0..1) of the four accents (indices 1..4). */
  readonly accentMeanL: number;
  /** Darkest accent's HSL lightness. */
  readonly accentMinL: number;
  /** Mean HSL saturation (0..1) of the four accents. */
  readonly accentMeanS: number;
  /** Smallest euclidean RGB distance between any two of the five colours. */
  readonly minPairwiseRgb: number;
  /** WCAG 2.x relative-luminance contrast ratio between palette[0] and palette[4]. */
  readonly bgVsPlayerContrast: number;
  /** Smallest circular hue distance (degrees) between any two accents. */
  readonly hueSpreadDeg: number;
  /** HSL lightness of the background. */
  readonly bgL: number;
}

export interface ImageResult {
  readonly image: string;
  readonly palette: readonly string[];
  readonly metrics: PaletteMetrics;
}

export interface RunReport {
  readonly candidate: CandidateMeta;
  readonly images: readonly ImageResult[];
}
