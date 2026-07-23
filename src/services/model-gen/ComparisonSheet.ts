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

/** One labelled image cell for {@link buildImageStrip}. */
export interface StripImage {
  label: string;
  /** A `data:` URL. */
  dataUrl: string;
}

const STRIP_DEFAULT_CELL_WIDTH = 340;
const STRIP_MAX_TOTAL_WIDTH = 1100;

/**
 * Composite several labelled images into one dark-background row/grid sheet (the Scene lane's review
 * image: the rendered viewpoints plus any reference images). Cells flow left-to-right and wrap into
 * rows so the total width stays within {@link STRIP_MAX_TOTAL_WIDTH}. Each cell is a square letterbox
 * with a label strip on top. Returns a PNG data URL. Independent of {@link buildComparisonSheet}.
 */
export async function buildImageStrip(
  images: StripImage[],
  opts?: { maxCellWidth?: number }
): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error('Image strip compositing requires a browser document context.');
  }
  if (images.length === 0) {
    throw new Error('buildImageStrip requires at least one image.');
  }

  const cellWidth = Math.max(120, Math.min(opts?.maxCellWidth ?? STRIP_DEFAULT_CELL_WIDTH, 512));
  const columns = Math.max(
    1,
    Math.min(images.length, Math.floor((STRIP_MAX_TOTAL_WIDTH - PADDING) / (cellWidth + PADDING)))
  );
  const rows = Math.ceil(images.length / columns);
  const cellImageSize = cellWidth;
  const cellHeight = LABEL_HEIGHT + cellImageSize;

  const width = columns * cellWidth + (columns + 1) * PADDING;
  const height = rows * cellHeight + (rows + 1) * PADDING;

  const decoded = await Promise.all(images.map(image => loadImage(image.dataUrl)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context is unavailable for the image strip.');
  }

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  decoded.forEach((image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const originX = PADDING + column * (cellWidth + PADDING);
    const originY = PADDING + row * (cellHeight + PADDING);
    drawStripCell(ctx, image, originX, originY, cellWidth, cellImageSize, images[index].label);
  });

  return canvas.toDataURL('image/png');
}

/** Draw one labelled, letterboxed strip cell of a given width. */
function drawStripCell(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  originX: number,
  originY: number,
  cellWidth: number,
  imageSize: number,
  label: string
): void {
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, originX + 2, originY + LABEL_HEIGHT / 2, cellWidth - 4);

  const boxY = originY + LABEL_HEIGHT;
  const naturalW = image.naturalWidth || image.width || cellWidth;
  const naturalH = image.naturalHeight || image.height || imageSize;
  const scale = Math.min(cellWidth / naturalW, imageSize / naturalH);
  const drawW = Math.max(1, Math.round(naturalW * scale));
  const drawH = Math.max(1, Math.round(naturalH * scale));
  const drawX = originX + Math.round((cellWidth - drawW) / 2);
  const drawY = boxY + Math.round((imageSize - drawH) / 2);
  ctx.drawImage(image, drawX, drawY, drawW, drawH);
}

/** Load a `data:` URL into a decoded {@link HTMLImageElement}. */
async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}
