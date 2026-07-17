import type { TextureRegion } from '@pix3/runtime';

/**
 * Shared texture-region math for the mechanical odometer digit strips.
 *
 * `number_indicator.png` is a vertical strip of ten digit cells. Top→bottom the
 * cells read 0, 9, 8, 7, 6, 5, 4, 3, 2, 1 (the original SkyDefender ordering),
 * so a physical strip row maps to a digit via `stripPositionForDigit`.
 *
 * The SAME function authors the crop used by both play mode
 * (`Sprite2D.setTextureRegion` in Odometer.onUpdate) and the editor preview
 * (`ctx.setAppearanceOverride({ textureRegion })` in OdometerDigit.tickEditorPreview),
 * so edit and play modes are guaranteed to show identical framing.
 *
 * `TextureRegion` is expressed in NORMALIZED texture coordinates (0..1), top-left
 * origin, so no source-texture pixel size is needed.
 */
export const DIGIT_ROWS = 10;

/** Map a digit (0..9) to its physical row index (0..9) on the strip. */
export function stripPositionForDigit(digit: number): number {
  const d = ((Math.floor(digit) % DIGIT_ROWS) + DIGIT_ROWS) % DIGIT_ROWS;
  return (DIGIT_ROWS - d) % DIGIT_ROWS;
}

/**
 * Normalized sub-rectangle (0..1) framing a single digit cell.
 *
 * `TextureRegion.y` uses a BOTTOM-left origin (UV convention), so cell 0 (the
 * top cell "0" in the image) lives at the HIGH end of y. We therefore flip:
 * a strip row `stripPos` (0 = top image cell) maps to `y = 1 - (stripPos+1)/N`.
 * `stripPos` may be fractional while a drum rolls between cells.
 */
export function digitStripRegion(stripPos: number): TextureRegion {
  return {
    x: 0,
    y: 1 - (stripPos + 1) / DIGIT_ROWS,
    width: 1,
    height: 1 / DIGIT_ROWS,
  };
}

/** Split a clamped integer value into per-slot digits (most-significant first). */
export function digitForSlot(value: number, slotIndex: number, slotCount: number): number {
  const max = Math.pow(10, slotCount) - 1;
  const clamped = Math.max(0, Math.min(max, Math.floor(value)));
  return Math.floor(clamped / Math.pow(10, slotCount - 1 - slotIndex)) % 10;
}
