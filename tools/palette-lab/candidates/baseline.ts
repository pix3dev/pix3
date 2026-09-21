/**
 * The CURRENT shipped pipeline (`extractStylePalette` in `src/services/image-gen/image-ops.ts`),
 * run against already-decoded pixels through the exported `stylePaletteFromPixels` — the same
 * function the editor calls after decoding, so this control cannot drift from what ships. Every
 * other candidate is measured against this one.
 */
import { stylePaletteFromPixels, type ImagePixels } from '../../../src/services/image-gen/image-ops';
import type { CandidateMeta } from '../types';

export const meta: CandidateMeta = {
  name: 'baseline',
  description:
    'Shipped pipeline: quantizePixels(16) ground + hue-histogram accents + role-aware pickStylePalette (via stylePaletteFromPixels).',
};

const PALETTE_SIZE = 5;

export function pick(pixels: ImagePixels): string[] {
  return stylePaletteFromPixels(pixels, PALETTE_SIZE);
}
