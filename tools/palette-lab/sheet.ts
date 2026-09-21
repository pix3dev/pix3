import { hexToRgb, type RgbColor } from '../../src/services/image-gen/image-ops';
import { createRaster, type Raster } from './png';
import type { ImagePixels } from './types';

export const THUMB_WIDTH = 180;
export const SWATCH_SIZE = 90;
export const SWATCH_GAP = 6;
export const ROW_GAP = 8;
export const MARGIN = 8;

const SHEET_BACKGROUND: RgbColor = { r: 24, g: 24, b: 28 };

const fillRect = (
  raster: Raster,
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: RgbColor
): void => {
  const x1 = Math.min(raster.width, x0 + width);
  const y1 = Math.min(raster.height, y0 + height);
  for (let y = Math.max(0, y0); y < y1; y += 1) {
    for (let x = Math.max(0, x0); x < x1; x += 1) {
      const offset = (y * raster.width + x) * 4;
      raster.data[offset] = color.r;
      raster.data[offset + 1] = color.g;
      raster.data[offset + 2] = color.b;
      raster.data[offset + 3] = 255;
    }
  }
};

/** Nearest-neighbour blit of `source` scaled to `width`×`height` at (x0, y0). */
const blitScaled = (
  raster: Raster,
  source: ImagePixels,
  x0: number,
  y0: number,
  width: number,
  height: number
): void => {
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y / height) * source.height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x / width) * source.width));
      const from = (sy * source.width + sx) * 4;
      const to = ((y0 + y) * raster.width + (x0 + x)) * 4;
      const alpha = source.data[from + 3] / 255;
      // Composite over the sheet ground so a transparent reference still reads.
      raster.data[to] = Math.round(source.data[from] * alpha + SHEET_BACKGROUND.r * (1 - alpha));
      raster.data[to + 1] = Math.round(
        source.data[from + 1] * alpha + SHEET_BACKGROUND.g * (1 - alpha)
      );
      raster.data[to + 2] = Math.round(
        source.data[from + 2] * alpha + SHEET_BACKGROUND.b * (1 - alpha)
      );
      raster.data[to + 3] = 255;
    }
  }
};

export interface SheetRow {
  readonly pixels: ImagePixels;
  readonly palette: readonly string[];
}

const thumbHeight = (pixels: ImagePixels): number =>
  Math.max(1, Math.round((pixels.height / pixels.width) * THUMB_WIDTH));

/**
 * One row per image: nearest-neighbour thumbnail on the left, then the five swatches in role order
 * drawn on a panel filled with that palette's own background colour (index 0), so the accents are
 * judged against the ground they will actually sit on.
 */
export const renderSheet = (rows: readonly SheetRow[]): Raster => {
  const swatchCount = Math.max(1, ...rows.map(row => row.palette.length));
  const panelWidth = swatchCount * SWATCH_SIZE + (swatchCount + 1) * SWATCH_GAP;
  const width = MARGIN + THUMB_WIDTH + SWATCH_GAP + panelWidth + MARGIN;
  const rowHeights = rows.map(row => Math.max(thumbHeight(row.pixels), SWATCH_SIZE + 2 * SWATCH_GAP));
  const height =
    MARGIN * 2 + rowHeights.reduce((sum, h) => sum + h, 0) + ROW_GAP * Math.max(0, rows.length - 1);

  const sheet = createRaster(width, height);
  fillRect(sheet, 0, 0, width, height, SHEET_BACKGROUND);

  let y = MARGIN;
  rows.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex];
    const th = thumbHeight(row.pixels);
    blitScaled(sheet, row.pixels, MARGIN, y + Math.floor((rowHeight - th) / 2), THUMB_WIDTH, th);

    const panelX = MARGIN + THUMB_WIDTH + SWATCH_GAP;
    const ground = hexToRgb(row.palette[0] ?? '#000000') ?? { r: 0, g: 0, b: 0 };
    fillRect(sheet, panelX, y, panelWidth, rowHeight, ground);

    const swatchY = y + Math.floor((rowHeight - SWATCH_SIZE) / 2);
    row.palette.forEach((hex, index) => {
      const color = hexToRgb(hex) ?? { r: 255, g: 0, b: 255 };
      const x = panelX + SWATCH_GAP + index * (SWATCH_SIZE + SWATCH_GAP);
      fillRect(sheet, x, swatchY, SWATCH_SIZE, SWATCH_SIZE, color);
    });

    y += rowHeight + ROW_GAP;
  });

  return sheet;
};
