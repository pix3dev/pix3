/**
 * Canvas compositor for the Model Lab review loop: draws the reference and the current render
 * side-by-side into one labelled sheet (a port of img2threejs's `make_comparison_sheet.py`). This
 * sheet is the single image handed to the vision review call, so the model judges both panels at
 * once. Total width is kept ≤ ~1100px to keep vision cost modest.
 */

export interface ComparisonSheetInput {
  /** The reference image as a `data:` URL. */
  referenceDataUrl: string;
  /** The offscreen render as a `data:` URL. */
  renderDataUrl: string;
  referenceLabel?: string;
  renderLabel?: string;
}

const CELL_SIZE = 512;
const LABEL_HEIGHT = 34;
const PADDING = 16;
const BACKGROUND = '#1a1c1f';
const LABEL_COLOR = '#e8ebef';
const LABEL_FONT = '600 18px system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Build the reference|render comparison sheet and return it as a PNG data URL. Each cell is a
 * {@link CELL_SIZE}-wide square with a label strip on top; the image is letterboxed inside the cell
 * preserving its aspect ratio, on the dark {@link BACKGROUND}.
 */
export async function buildComparisonSheet(input: ComparisonSheetInput): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error('Comparison sheet compositing requires a browser document context.');
  }

  const [reference, render] = await Promise.all([
    loadImage(input.referenceDataUrl),
    loadImage(input.renderDataUrl),
  ]);

  const cellHeight = LABEL_HEIGHT + CELL_SIZE;
  const width = CELL_SIZE * 2 + PADDING * 3;
  const height = cellHeight + PADDING * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context is unavailable for the comparison sheet.');
  }

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  drawCell(ctx, reference, PADDING, PADDING, input.referenceLabel ?? 'Reference');
  drawCell(ctx, render, PADDING * 2 + CELL_SIZE, PADDING, input.renderLabel ?? 'Render');

  return canvas.toDataURL('image/png');
}

/** Draw one labelled, letterboxed cell at `(originX, originY)`. */
function drawCell(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  originX: number,
  originY: number,
  label: string
): void {
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, originX + 2, originY + LABEL_HEIGHT / 2, CELL_SIZE - 4);

  const boxX = originX;
  const boxY = originY + LABEL_HEIGHT;
  const naturalW = image.naturalWidth || image.width || CELL_SIZE;
  const naturalH = image.naturalHeight || image.height || CELL_SIZE;
  const scale = Math.min(CELL_SIZE / naturalW, CELL_SIZE / naturalH);
  const drawW = Math.max(1, Math.round(naturalW * scale));
  const drawH = Math.max(1, Math.round(naturalH * scale));
  const drawX = boxX + Math.round((CELL_SIZE - drawW) / 2);
  const drawY = boxY + Math.round((CELL_SIZE - drawH) / 2);
  ctx.drawImage(image, drawX, drawY, drawW, drawH);
}

/** Load a `data:` URL into a decoded {@link HTMLImageElement}. */
async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}
