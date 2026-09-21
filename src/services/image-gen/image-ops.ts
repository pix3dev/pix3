/**
 * Pure, browser-side image transforms shared by the Sprite Editor panel (interactive UI) and the
 * headless {@link AssetGenService} (programmatic / agent-driven). Everything here operates on
 * `Blob`s so it can run without any DOM component mounted — the only DOM dependency is a detached
 * `<canvas>` for re-encoding, which is available in any editor context.
 *
 * All raster ops decode via `createImageBitmap` (fast, off-DOM) and re-draw with high-quality
 * smoothing. Output defaults to PNG so an alpha channel (transparent generations / cut-outs) is
 * never silently flattened; callers pass `mimeType` when they explicitly want a lossy format.
 */

export type ImageEncoding = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface RasterResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

export interface EncodeOptions {
  /** Output mime type. Defaults to `image/png` (alpha-safe). */
  mimeType?: ImageEncoding;
  /** Quality 0..1 for lossy formats (jpeg/webp). Ignored for png. */
  quality?: number;
}

export interface ResizeOptions extends EncodeOptions {
  /** Fit within a box of this many px on the longest edge, preserving aspect ratio. */
  maxSize?: number;
  /** Explicit target width. With `height` => exact; alone => height derived from aspect. */
  width?: number;
  /** Explicit target height. With `width` => exact; alone => width derived from aspect. */
  height?: number;
  /** Allow scaling UP past the source size. Default false (downscale only). */
  allowUpscale?: boolean;
}

export interface CropRectPixels {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Clockwise quarter-turn count for {@link rotateImageBlob}: 1 = 90°, 2 = 180°, 3 = 270°. */
export type QuarterTurns = 1 | 2 | 3;

/** Mirror axis for {@link flipImageBlob}. */
export type FlipAxis = 'horizontal' | 'vertical';

const canUseBitmap = (): boolean =>
  typeof createImageBitmap === 'function' && typeof document !== 'undefined';

/**
 * Pick the output encoding for a lossless geometric transform (rotate/flip): honour an explicit
 * request, else keep the source encoding when it is one we can write, else fall back to PNG so an
 * unknown/empty type never drops the alpha channel.
 */
const preservedEncoding = (blob: Blob, encode: EncodeOptions): EncodeOptions => {
  if (encode.mimeType) {
    return encode;
  }
  const type = blob.type;
  const mimeType: ImageEncoding =
    type === 'image/jpeg' || type === 'image/webp' || type === 'image/png' ? type : 'image/png';
  return { mimeType, quality: encode.quality };
};

/** Read a blob's intrinsic pixel dimensions, or `null` if it can't be decoded. */
export async function readBlobSize(blob: Blob): Promise<ImageDimensions | null> {
  if (!canUseBitmap()) {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Encode a canvas to a Blob (Promise wrapper over the callback-style `toBlob`). */
function canvasToBlob(canvas: HTMLCanvasElement, encode: EncodeOptions): Promise<Blob> {
  const mimeType = encode.mimeType ?? 'image/png';
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      result => (result ? resolve(result) : reject(new Error('Failed to encode image'))),
      mimeType,
      encode.quality
    );
  });
}

async function drawToBlob(
  bitmap: ImageBitmap,
  target: { width: number; height: number },
  source: { x: number; y: number; width: number; height: number },
  encode: EncodeOptions
): Promise<RasterResult> {
  const width = Math.max(1, Math.round(target.width));
  const height = Math.max(1, Math.round(target.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, encode);
  return { blob, width, height };
}

/**
 * Resize (and optionally re-encode) an image. Pass `maxSize` to fit within a square box on the
 * longest edge, or `width`/`height` for explicit sizing. Downscale-only unless `allowUpscale`.
 * Returns the original blob unchanged when no resize is requested or the image already fits.
 */
export async function resizeImageBlob(blob: Blob, options: ResizeOptions): Promise<RasterResult> {
  if (!canUseBitmap()) {
    const size = await readBlobSize(blob);
    return { blob, width: size?.width ?? 0, height: size?.height ?? 0 };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const sw = bitmap.width;
    const sh = bitmap.height;
    let targetW = sw;
    let targetH = sh;

    if (options.width && options.height) {
      targetW = options.width;
      targetH = options.height;
    } else if (options.width) {
      targetW = options.width;
      targetH = (sh * options.width) / sw;
    } else if (options.height) {
      targetH = options.height;
      targetW = (sw * options.height) / sh;
    } else if (options.maxSize && options.maxSize > 0) {
      const longest = Math.max(sw, sh);
      let scale = options.maxSize / longest;
      if (!options.allowUpscale) {
        scale = Math.min(1, scale);
      }
      targetW = sw * scale;
      targetH = sh * scale;
    }

    const reEncodeOnly =
      Math.round(targetW) === sw && Math.round(targetH) === sh && !options.mimeType;
    if (reEncodeOnly) {
      // No geometry change and no format change requested — hand back the source untouched so a
      // "save at original size" path writes the exact generated bytes.
      return { blob, width: sw, height: sh };
    }

    return await drawToBlob(
      bitmap,
      { width: targetW, height: targetH },
      { x: 0, y: 0, width: sw, height: sh },
      options
    );
  } finally {
    bitmap.close();
  }
}

/** Crop an axis-aligned pixel rectangle out of an image (clamped to bounds). */
export async function cropImageBlob(
  blob: Blob,
  rect: CropRectPixels,
  encode: EncodeOptions = {}
): Promise<RasterResult> {
  const bitmap = await createImageBitmap(blob);
  try {
    const sx = clamp(Math.round(rect.x), 0, bitmap.width - 1);
    const sy = clamp(Math.round(rect.y), 0, bitmap.height - 1);
    const sw = clamp(Math.round(rect.width), 1, bitmap.width - sx);
    const sh = clamp(Math.round(rect.height), 1, bitmap.height - sy);
    return await drawToBlob(
      bitmap,
      { width: sw, height: sh },
      { x: sx, y: sy, width: sw, height: sh },
      { mimeType: encode.mimeType ?? 'image/png', quality: encode.quality }
    );
  } finally {
    bitmap.close();
  }
}

/**
 * Rotate an image clockwise by a quarter-turn multiple. For 90°/270° the output width/height are
 * swapped. Alpha and the source encoding are preserved (see {@link preservedEncoding}). Returns the
 * source blob unchanged when rotation isn't possible (no canvas) or is a no-op.
 */
export async function rotateImageBlob(
  blob: Blob,
  quarterTurns: QuarterTurns,
  encode: EncodeOptions = {}
): Promise<RasterResult> {
  if (!canUseBitmap()) {
    const size = await readBlobSize(blob);
    return { blob, width: size?.width ?? 0, height: size?.height ?? 0 };
  }
  const turns = (((quarterTurns % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const bitmap = await createImageBitmap(blob);
  try {
    const sw = bitmap.width;
    const sh = bitmap.height;
    if (turns === 0) {
      return { blob, width: sw, height: sh };
    }
    const swap = turns === 1 || turns === 3;
    const width = swap ? sh : sw;
    const height = swap ? sw : sh;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(width / 2, height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(bitmap, -sw / 2, -sh / 2);
    const outBlob = await canvasToBlob(canvas, preservedEncoding(blob, encode));
    return { blob: outBlob, width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Mirror an image horizontally or vertically. Dimensions are unchanged; alpha and the source
 * encoding are preserved. Returns the source blob unchanged when no canvas is available.
 */
export async function flipImageBlob(
  blob: Blob,
  axis: FlipAxis,
  encode: EncodeOptions = {}
): Promise<RasterResult> {
  if (!canUseBitmap()) {
    const size = await readBlobSize(blob);
    return { blob, width: size?.width ?? 0, height: size?.height ?? 0 };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (axis === 'horizontal') {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(bitmap, 0, 0);
    const outBlob = await canvasToBlob(canvas, preservedEncoding(blob, encode));
    return { blob: outBlob, width, height };
  } finally {
    bitmap.close();
  }
}

export interface SliceGrid {
  /** Number of cells across. Values below 1 are clamped to 1. */
  readonly columns: number;
  /** Number of cells down. Values below 1 are clamped to 1. */
  readonly rows: number;
}

/**
 * Cut a spritesheet into `columns × rows` equal cells, row-major (left-to-right, top-to-bottom).
 * Cell size is the fractional source size rounded up to whole output pixels, so a sheet whose
 * dimensions don't divide evenly still yields complete cells instead of a clipped last column/row.
 *
 * This is the pure half of spritesheet slicing — naming and writing the resulting files is the
 * caller's policy (`.pix3anim` frame paths for the animation editor, a user-chosen folder for the
 * Sprite Editor's "Slice…" action).
 */
export async function sliceImageBlob(
  blob: Blob,
  grid: SliceGrid,
  encode: EncodeOptions = {}
): Promise<Blob[]> {
  const columns = Math.max(1, Math.floor(grid.columns));
  const rows = Math.max(1, Math.floor(grid.rows));
  const bitmap = await createImageBitmap(blob);
  try {
    const cellWidth = bitmap.width / columns;
    const cellHeight = bitmap.height / rows;
    const outWidth = Math.max(1, Math.round(cellWidth));
    const outHeight = Math.max(1, Math.round(cellHeight));
    const cells: Blob[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell = await drawToBlob(
          bitmap,
          { width: outWidth, height: outHeight },
          {
            x: column * cellWidth,
            y: row * cellHeight,
            width: cellWidth,
            height: cellHeight,
          },
          { mimeType: encode.mimeType ?? 'image/png', quality: encode.quality }
        );
        cells.push(cell.blob);
      }
    }

    return cells;
  } finally {
    bitmap.close();
  }
}

/**
 * Bounding box of everything in `pixels` more opaque than `alphaThreshold`, or null when nothing is.
 * Shared by the trim bake ({@link trimImageBlob}) and the Sprite Editor's crop tool, which opens its
 * selection on these bounds — the same pixels the trim would keep, so "crop" and "trim" cannot
 * disagree about where the content ends.
 *
 * `alphaThreshold` is inclusive-empty: a pixel counts as content only when `alpha > threshold`, so 0
 * trims only fully transparent pixels.
 */
export const opaqueBounds = (pixels: ImagePixels, alphaThreshold = 0): CropRectPixels | null => {
  const { width, height, data } = pixels;
  const threshold = clamp(Math.round(alphaThreshold), 0, 255);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

export interface TrimOptions extends EncodeOptions {
  /** Transparent padding (px) kept around the opaque content on every side. Default 2. */
  padding?: number;
  /**
   * Alpha value (0..255) at or below which a pixel counts as empty when finding the content
   * bounds. Default 0 (only fully transparent pixels trim away). Raise slightly (e.g. 8) to also
   * crop the near-transparent halo background removal tends to leave behind.
   */
  alphaThreshold?: number;
  /** Center the trimmed content on a square transparent canvas (side = longest content edge). */
  square?: boolean;
}

export interface TrimResult extends RasterResult {
  /** True when the image had no opaque pixels — the source is returned unchanged. */
  readonly empty: boolean;
  /** The detected content bounding box in source pixels (null when {@link empty}). */
  readonly bounds: CropRectPixels | null;
}

/**
 * Crop an image down to the bounding box of its non-transparent pixels (plus optional padding).
 * This is what turns a background-removed generation into a tight sprite. With `square: true` the
 * content is centered on a square canvas so icon grids line up. Returns the source unchanged when
 * the image is fully transparent, has no alpha channel worth trimming, or can't be decoded.
 */
export async function trimImageBlob(blob: Blob, options: TrimOptions = {}): Promise<TrimResult> {
  if (!canUseBitmap()) {
    const size = await readBlobSize(blob);
    return {
      blob,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      empty: false,
      bounds: null,
    };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const sw = bitmap.width;
    const sh = bitmap.height;
    const scan = document.createElement('canvas');
    scan.width = sw;
    scan.height = sh;
    const scanCtx = scan.getContext('2d');
    if (!scanCtx) {
      throw new Error('2D canvas context unavailable');
    }
    scanCtx.drawImage(bitmap, 0, 0);
    const { data } = scanCtx.getImageData(0, 0, sw, sh);

    const bounds = opaqueBounds({ width: sw, height: sh, data }, options.alphaThreshold ?? 0);
    if (!bounds) {
      return { blob, width: sw, height: sh, empty: true, bounds: null };
    }
    const padding = Math.max(0, Math.round(options.padding ?? 2));
    const outW = options.square
      ? Math.max(bounds.width, bounds.height) + padding * 2
      : bounds.width + padding * 2;
    const outH = options.square
      ? Math.max(bounds.width, bounds.height) + padding * 2
      : bounds.height + padding * 2;
    const dx = Math.round((outW - bounds.width) / 2);
    const dy = Math.round((outH - bounds.height) / 2);

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const outCtx = out.getContext('2d');
    if (!outCtx) {
      throw new Error('2D canvas context unavailable');
    }
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(
      bitmap,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      dx,
      dy,
      bounds.width,
      bounds.height
    );
    const outBlob = await canvasToBlob(out, {
      mimeType: options.mimeType ?? 'image/png',
      quality: options.quality,
    });
    return { blob: outBlob, width: outW, height: outH, empty: false, bounds };
  } finally {
    bitmap.close();
  }
}

export interface AlphaMaskOptions {
  /**
   * Alpha value (0..255) at or below which a pixel counts as empty. Default 0 (only fully
   * transparent pixels are empty). Raise slightly (e.g. 8) to also drop the near-transparent halo
   * background removal leaves behind — the same knob {@link TrimOptions} carries.
   */
  alphaThreshold?: number;
}

export interface AlphaMask extends ImageDimensions {
  /** Row-major `width * height` flags, origin top-left: 1 = opaque, 0 = empty. */
  readonly data: Uint8Array;
}

/**
 * Decode an image and reduce it to one opacity flag per pixel — the input the Sprite Editor's
 * auto-collision-polygon tracer (`contour-trace.ts`, §9.12.2) walks, and a cheap-to-keep
 * representation of a cut-out for anything else that needs the *shape* rather than the pixels.
 *
 * Lives next to {@link trimImageBlob} deliberately: both answer "where are the opaque pixels?",
 * both decode the same way, and the agent tool layer and the Asset Generator reach for this module
 * rather than growing their own canvas code. Returns null when the image can't be decoded (no
 * canvas in this context) — callers must treat that as "unknown", never as "empty".
 */
export async function readAlphaMask(
  blob: Blob,
  options: AlphaMaskOptions = {}
): Promise<AlphaMask | null> {
  if (!canUseBitmap()) {
    return null;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const threshold = clamp(Math.round(options.alphaThreshold ?? 0), 0, 255);
    const mask = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = data[index * 4 + 3] > threshold ? 1 : 0;
    }
    return { width, height, data: mask };
  } finally {
    bitmap.close();
  }
}

/** A plain 8-bit-per-channel colour. Alpha is deliberately absent — this is a *key*. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ImagePixels extends ImageDimensions {
  /** Row-major RGBA bytes, origin top-left — the `ImageData.data` layout verbatim. */
  readonly data: Uint8ClampedArray;
}

/**
 * Decode an image into its raw RGBA bytes. The eyedropper half of the chroma-key
 * tool reads its target colour out of this rather than growing its own canvas
 * code, and it is decoded **once** per working image so dragging the picker over
 * the canvas costs nothing per sample.
 *
 * Returns null when the image can't be decoded (no canvas in this context) —
 * callers must treat that as "unknown", never as "black".
 */
export async function readImagePixels(blob: Blob): Promise<ImagePixels | null> {
  if (!canUseBitmap()) {
    return null;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

/**
 * Colour at a pixel, or null when the coordinate is outside the image. Floats are
 * floored, which is what a pointer position in image space needs: 12.9 is still
 * inside pixel 12.
 */
export function samplePixelColor(pixels: ImagePixels, x: number, y: number): RgbColor | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) {
    return null;
  }
  const offset = (py * pixels.width + px) * 4;
  return { r: pixels.data[offset], g: pixels.data[offset + 1], b: pixels.data[offset + 2] };
}

export interface ChromaKeyOptions extends EncodeOptions {
  /**
   * Colour distance, as a fraction (0..1) of the largest possible RGB distance,
   * at or below which a pixel is knocked fully transparent. Default 0.1.
   */
  tolerance?: number;
  /**
   * Width of the ramp *beyond* `tolerance`, in the same 0..1 units, over which
   * alpha falls off linearly instead of cutting. Default 0 — a hard cut (see the
   * note on {@link chromaKeyImage}).
   */
  softness?: number;
}

export interface ChromaKeyResult extends RasterResult {
  /** Pixels driven to alpha 0. */
  readonly keyedPixels: number;
  /** Pixels inside the soft band — alpha reduced but not to zero. Always 0 for a hard cut. */
  readonly softenedPixels: number;
}

/** Largest possible RGB euclidean distance: the black↔white diagonal, √3·255. */
const MAX_RGB_DISTANCE = Math.sqrt(3) * 255;

/**
 * Knock a colour out of an image: every pixel within `tolerance` of `color` loses
 * its alpha. This is the "delete the flat background an image model gave me"
 * tool (§9.12.3), and it lives here rather than in the panel so the Asset
 * Generator and the agent tool layer get it for free — the same reason
 * {@link trimImageBlob} and {@link readAlphaMask} do.
 *
 * **Colour distance is plain RGB euclidean**, normalised by {@link MAX_RGB_DISTANCE}
 * so `tolerance` is a 0..1 fraction the UI can put on a slider. Deliberately not a
 * perceptual metric (CIEDE2000) and not chroma-only (YCbCr): the backgrounds this
 * targets are *flat* — one nearly-uniform RGB value across thousands of pixels —
 * so the extra machinery buys nothing measurable, while euclidean distance keeps
 * the slider's feel linear and the loop a few instructions per pixel. A
 * chroma-only metric would additionally key out *shaded* copies of the background
 * colour, which for a sprite means eating the shadowed side of the subject.
 *
 * **Edges: `softness` is 0 by default, i.e. v1 cuts hard.** A hard cut on an
 * anti-aliased edge leaves a one-pixel fringe of the key colour, so the ramp is
 * implemented and exposed — the *default* is hard because that is the predictable
 * answer for the flat, hard-edged generated art this ships against, and because a
 * ramp interacts with the trim tool's `alphaThreshold` (a softened fringe is
 * exactly the "near-transparent halo" a later trim would then cut anyway).
 *
 * **No despill.** Removing the key colour's contribution from surviving
 * semi-transparent pixels needs an estimate of what is *behind* the subject,
 * which a single flat-background still image does not carry; it is a video-keying
 * concern. Pixels the ramp only partially keys keep their original RGB.
 *
 * Existing alpha is **scaled**, never overwritten, so re-keying an already
 * cut-out image cannot resurrect transparent pixels. Output is PNG unless the
 * caller says otherwise — writing this into a JPEG would discard the whole point.
 */
export async function chromaKeyImage(
  blob: Blob,
  color: RgbColor,
  options: ChromaKeyOptions = {}
): Promise<ChromaKeyResult> {
  if (!canUseBitmap()) {
    const size = await readBlobSize(blob);
    return {
      blob,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      keyedPixels: 0,
      softenedPixels: 0,
    };
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const cut = clamp(options.tolerance ?? 0.1, 0, 1) * MAX_RGB_DISTANCE;
    const ramp = clamp(options.softness ?? 0, 0, 1) * MAX_RGB_DISTANCE;
    let keyedPixels = 0;
    let softenedPixels = 0;

    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3];
      if (alpha === 0) {
        continue;
      }
      const dr = data[index] - color.r;
      const dg = data[index + 1] - color.g;
      const db = data[index + 2] - color.b;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distance <= cut) {
        data[index + 3] = 0;
        keyedPixels += 1;
      } else if (ramp > 0 && distance < cut + ramp) {
        data[index + 3] = Math.round(alpha * ((distance - cut) / ramp));
        softenedPixels += 1;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const outBlob = await canvasToBlob(canvas, {
      mimeType: options.mimeType ?? 'image/png',
      quality: options.quality,
    });
    return { blob: outBlob, width, height, keyedPixels, softenedPixels };
  } finally {
    bitmap.close();
  }
}

// -- palette extraction / tinting -------------------------------------------

/** One entry of an extracted palette: the colour plus how much of the image it covers. */
export interface PaletteSwatch {
  readonly color: RgbColor;
  /** `#rrggbb`, lower-case — the form scenes, briefs and generate-prompts all use. */
  readonly hex: string;
  /** Fraction (0..1) of the sampled pixels this swatch represents. */
  readonly weight: number;
}

export interface PaletteOptions {
  /** Pixels at or below this alpha are ignored (a cut-out's transparent field is not a colour). */
  alphaThreshold?: number;
  /**
   * Upper bound on how many pixels are actually read. The image is walked with a stride rather
   * than downsampled, so the result does not depend on canvas resampling — which keeps the palette
   * byte-for-byte reproducible for the same input. Default 8192.
   */
  maxSamples?: number;
}

/** `#rrggbb` (lower-case) for a colour. Channels are rounded and clamped to 0..255. */
export const rgbToHex = (color: RgbColor): string => {
  const channel = (value: number): string =>
    clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
};

/**
 * Parse `#rgb` / `#rrggbb` (with or without the hash) into channels, or null when it isn't a
 * colour. Deliberately strict: a silent "black" for a typo'd hex would tint every placeholder in a
 * generated project to mud, and the caller can fall back far better than this function can.
 */
export const hexToRgb = (hex: string): RgbColor | null => {
  const value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return {
      r: parseInt(value[0] + value[0], 16),
      g: parseInt(value[1] + value[1], 16),
      b: parseInt(value[2] + value[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(value)) {
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }
  return null;
};

/** Perceptual luminance (ITU-R BT.601), 0..255. Used to order a palette light → dark. */
export const colorLuminance = (color: RgbColor): number =>
  0.299 * color.r + 0.587 * color.g + 0.114 * color.b;

interface ColorSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Median-cut colour quantization over already-decoded pixels.
 *
 * This is the deterministic half of {@link extractPalette} and the reason Flow does **not** ask a
 * model for hex codes: quantizing the user's own style reference is free, instant, and exact, while
 * a model's guess at "the palette of this image" is neither. (The vision helper still earns its
 * place for what quantization cannot see — rendering style, line, lighting, mood.)
 *
 * Median cut rather than k-means for one reason that matters here: it has no random seeding, so the
 * same reference image always yields the same palette, and a re-run of the same prompt cannot
 * silently recolour a project.
 *
 * One deliberate departure from textbook median cut: a box is split at the **widest gap** along its
 * widest channel, not at its median sample. Textbook median cut balances *population*, which on a
 * style reference is the wrong objective — three shades of one flat background would be torn into
 * separate swatches while a small saturated accent (a logo, a UI highlight) gets averaged into
 * whichever half it fell in. Splitting at the gap separates *clusters* instead, and `weight` still
 * reports coverage so a caller that wants the dominant colour just takes the first entry.
 */
export const quantizePixels = (
  pixels: ImagePixels,
  count: number,
  options: PaletteOptions = {}
): PaletteSwatch[] => {
  const wanted = Math.max(1, Math.floor(count));
  const threshold = clamp(Math.round(options.alphaThreshold ?? 8), 0, 255);
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 8192));
  const total = pixels.width * pixels.height;
  if (total <= 0) {
    return [];
  }

  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const samples: ColorSample[] = [];
  for (let index = 0; index < total; index += stride) {
    const offset = index * 4;
    if (pixels.data[offset + 3] <= threshold) {
      continue;
    }
    samples.push({
      r: pixels.data[offset],
      g: pixels.data[offset + 1],
      b: pixels.data[offset + 2],
    });
  }
  if (samples.length === 0) {
    return [];
  }

  let boxes: ColorSample[][] = [samples];
  while (boxes.length < wanted) {
    const splittable = boxes
      .map((box, index) => ({ index, range: boxRange(box) }))
      .filter(entry => entry.range.spread > 0)
      // Widest box first; ties break on index so the split order is fixed.
      .sort((a, b) => b.range.spread - a.range.spread || a.index - b.index);
    const target = splittable[0];
    if (!target) {
      break;
    }
    const box = boxes[target.index];
    const channel = target.range.channel;
    const sorted = [...box].sort(
      (a, b) => a[channel] - b[channel] || a.r - b.r || a.g - b.g || a.b - b.b
    );
    const cut = widestGapIndex(sorted, channel);
    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    if (left.length === 0 || right.length === 0) {
      break;
    }
    boxes = boxes.flatMap((current, index) => (index === target.index ? [left, right] : [current]));
  }

  return (
    boxes
      .map(box => {
        let r = 0;
        let g = 0;
        let b = 0;
        for (const sample of box) {
          r += sample.r;
          g += sample.g;
          b += sample.b;
        }
        const color: RgbColor = {
          r: Math.round(r / box.length),
          g: Math.round(g / box.length),
          b: Math.round(b / box.length),
        };
        return { color, hex: rgbToHex(color), weight: box.length / samples.length };
      })
      // Most-covering colour first — that is the one a caller wants for a background fill.
      .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex))
  );
};

/**
 * Index at which a channel-sorted box splits into its two furthest-apart clusters: the position of
 * the largest step between consecutive values. Ties go to the earlier (and therefore stable) index.
 */
const widestGapIndex = (sorted: readonly ColorSample[], channel: 'r' | 'g' | 'b'): number => {
  let bestIndex = 1;
  let bestGap = -1;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index][channel] - sorted[index - 1][channel];
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = index;
    }
  }
  return bestIndex;
};

/** Widest channel of a box and how wide it is (0 when every sample is identical). */
const boxRange = (box: readonly ColorSample[]): { channel: 'r' | 'g' | 'b'; spread: number } => {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (const sample of box) {
    if (sample.r < minR) minR = sample.r;
    if (sample.r > maxR) maxR = sample.r;
    if (sample.g < minG) minG = sample.g;
    if (sample.g > maxG) maxG = sample.g;
    if (sample.b < minB) minB = sample.b;
    if (sample.b > maxB) maxB = sample.b;
  }
  const spreadR = maxR - minR;
  const spreadG = maxG - minG;
  const spreadB = maxB - minB;
  if (spreadG >= spreadR && spreadG >= spreadB) {
    return { channel: 'g', spread: spreadG };
  }
  if (spreadR >= spreadB) {
    return { channel: 'r', spread: spreadR };
  }
  return { channel: 'b', spread: spreadB };
};

/**
 * Extract up to `count` dominant colours from an image, most-covering first. Returns an empty array
 * when the image can't be decoded (no canvas in this context) — callers must treat that as
 * "unknown" and keep whatever palette they already had, never as "no colours".
 */
export async function extractPalette(
  source: Blob,
  count = 5,
  options: PaletteOptions = {}
): Promise<PaletteSwatch[]> {
  const pixels = await readImagePixels(source);
  if (!pixels) {
    return [];
  }
  return quantizePixels(pixels, count, options);
}

/** Hue (0..360, 0 for greys), saturation and lightness (0..1) of a colour. */
export interface HslColor {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/**
 * RGB → HSL. Exported because the style-palette picker below reasons in "how colourful / how
 * bright", which is exactly what S and L are and exactly what RGB channels are not.
 */
export const rgbToHsl = (color: RgbColor): HslColor => {
  const r = clamp(color.r, 0, 255) / 255;
  const g = clamp(color.g, 0, 255) / 255;
  const b = clamp(color.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { h: 0, s: 0, l };
  }
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) {
    h = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    h = 60 * ((b - r) / delta + 2);
  } else {
    h = 60 * ((r - g) / delta + 4);
  }
  return { h: (h + 360) % 360, s, l };
};

/** HSL → RGB, the inverse of {@link rgbToHsl}. Used to build lightness variants of a colour. */
export const hslToRgb = (color: HslColor): RgbColor => {
  const h = ((color.h % 360) + 360) % 360;
  const s = clamp(color.s, 0, 1);
  const l = clamp(color.l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector: readonly [number, number, number] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((sector[0] + m) * 255),
    g: Math.round((sector[1] + m) * 255),
    b: Math.round((sector[2] + m) * 255),
  };
};

/** Shortest angular distance between two hues, 0..180. */
const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

/** Plain euclidean RGB distance (0..√3·255) — the same metric {@link chromaKeyImage} uses. */
const rgbDistance = (a: RgbColor, b: RgbColor): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

/**
 * How many boxes the style palette quantizes the whole image into for the **ground**. Deliberately
 * more than the five colours it returns: median cut spends its boxes where the *pixels* are, so at
 * five boxes a neon reference gets four shades of its own backdrop and one muddy average of
 * everything else.
 */
const STYLE_QUANTIZE_BOXES = 16;

/**
 * Pixels the accent histogram reads (fixed stride) when the caller sets no `maxSamples`. Three
 * times the quantizer's default: a 15° hue bin needs a stable population for a thin neon stroke —
 * the ball, a "+25" — to clear {@link BIN_MIN_SHARE} reliably rather than by luck of the stride.
 */
const STYLE_HISTOGRAM_SAMPLES = 24576;

/** Lightness at or below which a swatch is the device frame / letterbox, not a game ground. */
const NEAR_BLACK_LIGHTNESS = 0.06;

/** The window a *game's* background sits in: dark, but lit and tinted rather than black. */
const GROUND_MIN_LIGHTNESS = 0.06;
const GROUND_MAX_LIGHTNESS = 0.35;
const GROUND_MIN_SATURATION = 0.15;

/**
 * What counts as a colour worth building a game palette on: chromatic, lit, and not blown out. A
 * phone-mockup reference is ~60% device frame, so these bounds — not coverage — decide which pixels
 * get a vote on the accents at all. The ceiling is where a glow core stops carrying a hue: tinting
 * a near-white placeholder with a near-white "colour" hands back the placeholder.
 */
const VIVID_MIN_SATURATION = 0.3;
const VIVID_MIN_LIGHTNESS = 0.2;
const VIVID_MAX_LIGHTNESS = 0.9;

/** Hue bins of the accent histogram (15° each); each is split once more into a dark/mid and a light band. */
const HUE_BINS = 24;
const LIGHT_BAND_LIGHTNESS = 0.66;

/**
 * Share of the sampled opaque pixels a hue bin needs to be a colour *of the picture* rather than
 * anti-aliasing fringe. At the sample counts the picker runs at (≥ 8k) this is a dozen pixels or
 * more; it is a share, not a count, so a tiny image still yields its colours.
 */
const BIN_MIN_SHARE = 0.0015;

/** Portion of a bin (by pop, brightest-chroma first) whose mean represents the bin. */
const BIN_CORE_FRACTION = 0.33;

/** Two bin representatives within one bin of hue and closer than this in RGB are one colour. */
const TWIN_RGB_DISTANCE = 40;

/** Exponent on coverage in `prominence`: 10× the area buys ~26% more rank, no more. */
const SHARE_EXPONENT = 0.1;

/**
 * RGB distance below which a swatch counts as "the background again". A fine quantization splits a
 * gradient backdrop into several near-identical boxes; without this the accent slots fill up with
 * copies of the thing the accents are supposed to pop against.
 */
const BACKGROUND_MERGE_DISTANCE = 48;

/** No two colours in a returned palette may be closer than this — five slots, five colours. */
const PALETTE_MIN_SEPARATION = 24;

/** Nothing this dark may enter the palette as an accent — it would alias onto the background. */
const FILL_MIN_LIGHTNESS = 0.12;

/**
 * Quality tiers for an accent candidate. Tier 1 is the window a colour must sit in to be tinted onto
 * a near-white sprite and still glow: saturated and mid-lit. Below the lightness floor it is a
 * shadow; above the ceiling or below the saturation floor it is a wash or a neutral (tan, cream,
 * dusty rose). Tier 2 is the same window relaxed; tier 3 is everything else that passed the vivid
 * gate. Roles are filled tier by tier, so a 30% shadow cannot outrank a 2% highlight on coverage —
 * it is never in the running while a highlight exists.
 */
const PRIME_MIN_SATURATION = 0.55;
const PRIME_MIN_LIGHTNESS = 0.45;
const PRIME_MAX_LIGHTNESS = 0.8;
const RELAXED_MIN_SATURATION = 0.45;
const RELAXED_MIN_LIGHTNESS = 0.4;
const RELAXED_MAX_LIGHTNESS = 0.85;

/**
 * A candidate within this many degrees of a *tinted* ground's hue is the background wearing another
 * shade — a mid-blue on an indigo board — and drops one tier, unless it is saturated enough to be a
 * neon of that hue in its own right.
 */
const GROUND_HUE_RADIUS = 25;
const GROUND_HUE_NEON_SATURATION = 0.75;

/** Hue degrees within which two accents read as the same colour. */
const ACCENT_HUE_SPACING = 28;
/** …relaxed when the picture has fewer distinct hues than the palette has slots (gold beside orange). */
const ACCENT_HUE_SPACING_RELAXED = 20;

/**
 * WCAG contrast an accent must reach against the ground. 2.5 reads on a deep ground; a mid-lightness
 * ground (a lit purple board, L ≈ 0.38) needs 3 or orchid-on-purple passes. The player gets a bonus.
 */
const DARK_GROUND_MAX_LIGHTNESS = 0.3;
const ACCENT_MIN_CONTRAST_DARK = 2.5;
const ACCENT_MIN_CONTRAST_MID = 3;
const PLAYER_CONTRAST_BONUS = 0.5;

/**
 * The player slot goes to the most prominent accent unless the runner-up of the same tier pops this
 * much harder against the ground (contrast ratio). Magenta out-scores cyan on chroma on a purple
 * board, but the cyan ball is what reads as "the player" there.
 */
const PLAYER_CONTRAST_SWAP_RATIO = 1.25;

/** A hazard candidate must already read this well as painted; the lift does the rest. */
const HAZARD_MIN_PAINTED_CONTRAST = 1.8;
/** Share of the hazard score that is prominence; the rest is hue distance from the player. */
const HAZARD_BASE_WEIGHT = 0.4;
/** A hazard should be saturated, not pastel: a candidate above the prime lightness ceiling is scaled by this. */
const HAZARD_PASTEL_PENALTY = 0.7;

/** Gold / orange / yellow — the collectible hue when the picture has one. */
const WARM_HUE_MIN = 18;
const WARM_HUE_MAX = 70;

const UI_MIN_LIGHTNESS = 0.6;
/** A same-hue pastel may take the ui slot when it is at least this light… */
const UI_SAME_HUE_MIN_LIGHTNESS = 0.65;
/** …and at least this far in RGB from every colour already chosen. */
const UI_SAME_HUE_MIN_DISTANCE = 60;

/** The contrast lift: HSL lightness steps, bounded so a lifted colour stays the colour it was. */
const LIFT_STEP = 0.02;
const LIFT_MIN_LIGHTNESS = 0.08;
const LIFT_MAX_LIGHTNESS = 0.88;
/**
 * Lift beyond this is a different colour, not a legible version of the measured one; a candidate
 * that needs more is passed over while another candidate exists.
 */
const MAX_BOUNDED_LIFT = 0.16;

/** Lightness targets tried, in order, when a role has to be invented from an existing accent. */
const INVENT_TARGETS: Readonly<Record<AccentRole, readonly number[]>> = {
  player: [0.6, 0.7, 0.5],
  hazard: [0.5, 0.68, 0.4, 0.78],
  collectible: [0.74, 0.58, 0.84, 0.48],
  ui: [0.82, 0.72, 0.62, 0.86],
};
/** An invented variant of a chromatic seed is pinned this saturated so it glows rather than fades. */
const INVENT_MIN_SATURATION = 0.55;
/** A seed below this saturation is grey, and its variants stay grey — no hue is invented. */
const GREY_SEED_SATURATION = 0.15;
/**
 * When no role target of any seed separates, the seed's whole **lightness ladder** is searched —
 * every {@link LIFT_STEP} from {@link LIFT_MIN_LIGHTNESS} to {@link LIFT_MAX_LIGHTNESS} — at its
 * pinned saturation first and then at these alternatives (a grey seed stays grey). A ladder spans
 * a few hundred RGB units along one hue, room for a dozen colours at the palette floor, so a
 * reference with a single usable hue still yields distinct slots. There is deliberately **no fixed
 * fallback colour**: a constant reached twice is a duplicate the second time, and a gold that is not
 * in the picture is an invented hue — `#808080` alone used to return `#423006` twice for that reason.
 */
const INVENT_ALT_SATURATIONS: readonly number[] = [1, 0.35];

type AccentRole = 'player' | 'hazard' | 'collectible' | 'ui';

/** True when a colour is chromatic and lit — the gate every accent path shares. */
const isVividColor = (color: RgbColor): boolean => {
  const { s, l } = rgbToHsl(color);
  return s >= VIVID_MIN_SATURATION && l >= VIVID_MIN_LIGHTNESS && l <= VIVID_MAX_LIGHTNESS;
};

/** WCAG 2.x relative luminance (sRGB → linear, Rec. 709 weights). */
const relativeLuminance = (color: RgbColor): number => {
  const linear = (channel: number): number => {
    const c = clamp(channel, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
};

/** WCAG 2.x contrast ratio, 1..21. */
const contrastRatio = (a: RgbColor, b: RgbColor): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** HSL chroma — the real colourfulness, which collapses towards both black and white. */
const hslChroma = (hsl: HslColor): number => (1 - Math.abs(2 * hsl.l - 1)) * hsl.s;

/**
 * How much a colour would "pop" as a glowing sprite: chroma, weighted towards the light side so that
 * of two equally saturated colours the brighter one wins, with a soft penalty on very dark ones.
 */
const popOf = (hsl: HslColor): number => hslChroma(hsl) * (0.35 + hsl.l);

/**
 * The bar a swatch must clear to fill a slot the vivid pass left empty: not near-black, and not the
 * background wearing another shade. Both halves are a live failure this replaced — `#060813` took
 * the hazard slot off a phone mockup because the old fill step only looked at coverage.
 */
const passesFillGate = (color: RgbColor, background: RgbColor): boolean =>
  rgbToHsl(color).l >= FILL_MIN_LIGHTNESS &&
  rgbDistance(color, background) >= BACKGROUND_MERGE_DISTANCE;

/**
 * The colour the game's world sits on.
 *
 * Normally the most-covering swatch, because that is what a reference is mostly made of. The
 * exception is the one that produced `#363d55, #000201, #010100, #060813, #eec2ae` from a real
 * moodboard: a **phone mockup**, where most of the frame is the black device body and the actual
 * game is the bright rectangle inside it. When the dominant swatch is that near-black, the ground is
 * the most-covering swatch that is dark *but lit and tinted* — a deep purple, a navy — and the
 * device frame is scenery.
 */
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

/** See the tier constants: 1 = tintable neon, 2 = relaxed window, 3 = merely vivid. */
const accentTier = (hsl: HslColor, ground: HslColor): 1 | 2 | 3 => {
  const inWindow = (minS: number, minL: number, maxL: number): boolean =>
    hsl.s >= minS && hsl.l >= minL && hsl.l <= maxL;
  let tier: 1 | 2 | 3 = inWindow(PRIME_MIN_SATURATION, PRIME_MIN_LIGHTNESS, PRIME_MAX_LIGHTNESS)
    ? 1
    : inWindow(RELAXED_MIN_SATURATION, RELAXED_MIN_LIGHTNESS, RELAXED_MAX_LIGHTNESS)
      ? 2
      : 3;
  const wearsGroundHue =
    ground.s >= GROUND_MIN_SATURATION &&
    hueDistance(hsl.h, ground.h) < GROUND_HUE_RADIUS &&
    hsl.s < GROUND_HUE_NEON_SATURATION;
  if (wearsGroundHue && tier < 3) {
    tier = (tier + 1) as 2 | 3;
  }
  return tier;
};

/** One accent candidate, measured once against the ground it has to read on. */
interface PoolEntry {
  readonly color: RgbColor;
  readonly hsl: HslColor;
  readonly pop: number;
  /** `pop` with a whisper of coverage — ranks comparably popping colours by how much is there. */
  readonly prominence: number;
  readonly tier: 1 | 2 | 3;
  /** WCAG contrast against the ground, as painted. */
  readonly contrast: number;
  /** Position in the (sorted) pool — the tie-break every sort ends on. */
  readonly index: number;
}

const byProminence = (a: PoolEntry, b: PoolEntry): number =>
  b.prominence - a.prominence || a.index - b.index;

/**
 * The accent candidates of a swatch list: everything vivid and clear of the ground, or — only when a
 * reference has nothing chromatic — whatever clears the fill gate. Sorted by prominence, and the
 * position in that order is the index every later tie-break falls back on.
 */
const buildAccentPool = (swatches: readonly PaletteSwatch[], ground: RgbColor): PoolEntry[] => {
  const groundHsl = rgbToHsl(ground);
  const vivid = swatches.filter(
    swatch =>
      isVividColor(swatch.color) && rgbDistance(swatch.color, ground) >= BACKGROUND_MERGE_DISTANCE
  );
  const usable =
    vivid.length > 0 ? vivid : swatches.filter(swatch => passesFillGate(swatch.color, ground));
  const measured = usable.map((swatch, index) => {
    const hsl = rgbToHsl(swatch.color);
    const pop = popOf(hsl);
    return {
      color: swatch.color,
      hsl,
      pop,
      prominence: pop * Math.pow(Math.max(swatch.weight, 0), SHARE_EXPONENT),
      tier: accentTier(hsl, groundHsl),
      contrast: contrastRatio(swatch.color, ground),
      index,
    };
  });
  return measured.sort(byProminence).map((entry, index) => ({ ...entry, index }));
};

interface Lifted {
  readonly color: RgbColor;
  /** How far (HSL lightness) the colour had to move; 0 when it already read. */
  readonly amount: number;
}

/**
 * Raise (or, on a light ground, lower) lightness in {@link LIFT_STEP}s until the colour clears the
 * contrast bar, keeping hue and saturation. Reports how far it had to go so a caller can refuse a
 * lift that has turned the measured colour into a different one.
 */
const liftToContrast = (color: RgbColor, background: RgbColor, minContrast: number): Lifted => {
  if (contrastRatio(color, background) >= minContrast) {
    return { color, amount: 0 };
  }
  const base = rgbToHsl(color);
  const lighten = rgbToHsl(background).l <= 0.5;
  let l = base.l;
  let best = color;
  let reached = base.l;
  for (let step = 0; step < 60; step += 1) {
    l = lighten ? l + LIFT_STEP : l - LIFT_STEP;
    if (l < LIFT_MIN_LIGHTNESS || l > LIFT_MAX_LIGHTNESS) {
      break;
    }
    best = hslToRgb({ h: base.h, s: base.s, l });
    reached = l;
    if (contrastRatio(best, background) >= minContrast) {
      break;
    }
  }
  return { color: best, amount: Math.abs(reached - base.l) };
};

/** One rung of a {@link lightnessLadder}. */
interface Rung {
  readonly color: RgbColor;
  readonly l: number;
  /** 0 for the ladder's primary saturation, then the position in {@link INVENT_ALT_SATURATIONS}. */
  readonly saturationRank: number;
}

/**
 * The saturation an invented variant of `seed` wears: pinned vivid for a chromatic seed so it glows
 * rather than fades, untouched for a grey one so no hue is conjured out of a neutral.
 */
const pinnedSaturation = (seed: HslColor): number =>
  seed.s < GREY_SEED_SATURATION ? seed.s : Math.max(seed.s, INVENT_MIN_SATURATION);

/**
 * Every lightness variant of `seed`'s hue, {@link LIFT_MIN_LIGHTNESS} to {@link LIFT_MAX_LIGHTNESS}
 * in {@link LIFT_STEP}s — at `saturation` first (rank 0), then, for a chromatic seed, at each of
 * {@link INVENT_ALT_SATURATIONS}. The search space an invented or re-seated colour is drawn from:
 * always the seed's own hue, in a fixed order, so the pick is deterministic.
 */
const lightnessLadder = (seed: HslColor, saturation = pinnedSaturation(seed)): Rung[] => {
  const saturations =
    seed.s < GREY_SEED_SATURATION
      ? [saturation]
      : [saturation, ...INVENT_ALT_SATURATIONS.filter(alt => alt !== saturation)];
  const steps = Math.round((LIFT_MAX_LIGHTNESS - LIFT_MIN_LIGHTNESS) / LIFT_STEP);
  const rungs: Rung[] = [];
  saturations.forEach((s, saturationRank) => {
    for (let step = 0; step <= steps; step += 1) {
      const l = Math.round((LIFT_MIN_LIGHTNESS + step * LIFT_STEP) * 1000) / 1000;
      rungs.push({ color: hslToRgb({ h: seed.h, s, l }), l, saturationRank });
    }
  });
  return rungs;
};

/**
 * Pick a *usable game palette* out of a quantized image.
 *
 * The roles this feeds (`paletteColorForRole` in `recipe-contract.ts`) are assigned by index, and
 * coverage order is the wrong index for them: on any reference with a big backdrop — worse, on a
 * phone mockup, where the backdrop is the black device body — every one of the five most-covering
 * boxes is a shade of that backdrop, so the player, the hazard and the pickup all come out
 * near-black. What a brief needs is one ground colour and a handful of things that *pop against it*:
 * a question about saturation and lightness, not about area.
 *
 * The **background** comes from `swatches` by coverage, with the mockup correction in
 * {@link pickBackground}. The **accents** come from `accentSwatches` — in the shipping path the hue
 * histogram of {@link accentHistogram}, where a swatch's `weight` is the share of the picture in its
 * hue — or, when the caller has none, from whichever of `swatches` pass the vividness gate. Coverage
 * then decides almost nothing: candidates are ranked by `pop = chroma · (0.35 + lightness)` with a
 * `coverage^0.1` whisper, and are taken **tier by tier** (saturated mid-lit first, see the tier
 * constants), so a large dark saturated region — the shadow side of a purple board, 30% of a real
 * mockup — never outranks a 2% neon stroke. That was the measured defect this design replaced:
 * `#364078 #28134c #4a0856 #085b7a #da96c2`, three of four accents shadows, because the old score
 * multiplied by `coverage^0.35`.
 *
 * Roles are then filled explicitly, each ≥ {@link ACCENT_HUE_SPACING}° in hue from every accent
 * already placed (relaxed to {@link ACCENT_HUE_SPACING_RELAXED}° before anything is invented):
 *
 *   - **player** = the most prominent candidate that reads at the player contrast — unless the
 *     runner-up of the same tier pops {@link PLAYER_CONTRAST_SWAP_RATIO}× harder off the ground;
 *   - **collectible** = a warm (gold/orange) colour if the picture has one, claimed *before* the
 *     hazard search so "the farthest hue" cannot spend the only gold;
 *   - **hazard** = prominence × hue distance from the player, over candidates that already read as
 *     painted;
 *   - **ui** = the lightest colour in a hue of its own (a darker one is raised to L ≥ 0.6 before the
 *     hue spacing is relaxed), and only when no free hue is left a same-hue pastel far enough in
 *     RGB from everything chosen.
 *
 * Every accent is lifted in lightness until it clears the contrast floor (which scales with the
 * ground's lightness), but a candidate needing more than {@link MAX_BOUNDED_LIFT} is passed over for
 * the next one while one exists — a lifted colour must still be the colour that was measured. A
 * reference short on hues is padded with **lightness variants** of its own accents — or, when it has
 * none, of its ground — never a hue that is not in the picture, never a rejected dark box, and never
 * a fixed fallback colour; the two middle slots are seeded from different accents so a two-hue
 * picture does not fill both with one hue. Every returned colour is at least
 * {@link PALETTE_MIN_SEPARATION} from every other, by construction: nothing is admitted or invented
 * without clearing that floor against everything already chosen (an invented colour searches its
 * seed's whole {@link lightnessLadder} for a rung that does), so a one-hue picture still yields five
 * distinct colours. On a mid-lit or light ground those are the *darker* variants — contrast, not
 * brightness, decides which way a colour moves to read.
 *
 * Output order is the role mapper's contract, not a ranking: index 0 = background, the **last**
 * entry is the player pop colour, `n-2` is the hazard, index 1 the collectible, index 2 the ui
 * colour, and anything else sits between. Shorter palettes drop roles from the middle first (`count`
 * 3 → `[bg, hazard, player]`). Pure and deterministic: every sort breaks ties on the input index, and
 * the variants are generated in a fixed order.
 */
export const pickStylePalette = (
  swatches: readonly PaletteSwatch[],
  count = 5,
  accentSwatches?: readonly PaletteSwatch[]
): string[] => {
  const wanted = Math.max(1, Math.floor(count));
  if (swatches.length === 0) {
    return [];
  }
  const ground = pickBackground(swatches);
  const slots = wanted - 1;
  if (slots === 0) {
    return [rgbToHex(ground)];
  }

  const source = accentSwatches && accentSwatches.length > 0 ? accentSwatches : swatches;
  const pool = buildAccentPool(source, ground);
  const groundHsl = rgbToHsl(ground);
  const accentMinContrast =
    groundHsl.l < DARK_GROUND_MAX_LIGHTNESS ? ACCENT_MIN_CONTRAST_DARK : ACCENT_MIN_CONTRAST_MID;
  const playerMinContrast = accentMinContrast + PLAYER_CONTRAST_BONUS;

  const chosen: RgbColor[] = [ground];
  const taken = new Set<number>();
  const usedHues: number[] = [];
  const separated = (color: RgbColor, floor = PALETTE_MIN_SEPARATION): boolean =>
    chosen.every(picked => rgbDistance(color, picked) >= floor);
  const readsOnGround = (color: RgbColor): boolean =>
    contrastRatio(color, ground) >= accentMinContrast;
  const hueFree = (hue: number, spacing: number): boolean =>
    usedHues.every(used => hueDistance(used, hue) >= spacing);
  const available = (spacing: number): PoolEntry[] =>
    pool.filter(entry => !taken.has(entry.index) && hueFree(entry.hsl.h, spacing));

  interface Admitted {
    readonly entry: PoolEntry;
    readonly color: RgbColor;
  }

  /**
   * The best of `candidates` for a slot: best tier first, then those that read on the ground as
   * painted, then `rank`, then index. A candidate whose lift would exceed the bound is passed over
   * while another exists; one that lands on a colour already chosen is never admitted — a role a
   * measured colour cannot fill separately is invented instead, so the floor holds by construction.
   */
  const choose = (
    candidates: readonly PoolEntry[],
    minContrast: number,
    rank: (entry: PoolEntry) => number,
    minLightness = 0
  ): Admitted | null => {
    const reads = (entry: PoolEntry): number => (entry.contrast >= minContrast ? 1 : 0);
    const sorted = candidates
      .slice()
      .sort(
        (a, b) => a.tier - b.tier || reads(b) - reads(a) || rank(b) - rank(a) || a.index - b.index
      );
    let fallback: Admitted | null = null;
    for (const entry of sorted) {
      const raised =
        entry.hsl.l >= minLightness
          ? entry.color
          : hslToRgb({ h: entry.hsl.h, s: entry.hsl.s, l: minLightness });
      const lifted = liftToContrast(raised, ground, minContrast);
      if (!separated(lifted.color)) {
        continue;
      }
      if (lifted.amount <= MAX_BOUNDED_LIFT) {
        return { entry, color: lifted.color };
      }
      if (!fallback) {
        fallback = { entry, color: lifted.color };
      }
    }
    return fallback;
  };
  const admit = (pick: Admitted): RgbColor => {
    taken.add(pick.entry.index);
    usedHues.push(pick.entry.hsl.h);
    chosen.push(pick.color);
    return pick.color;
  };
  /**
   * `choose` over the free candidates in four passes: tintable colours (tier ≤ 2) at the standard
   * hue spacing, then at the relaxed one, and only then the merely-vivid tier 3 at either spacing.
   * A free hue does not make mud an accent while a real colour sits 20° from a taken hue.
   */
  const SELECTION_PASSES: ReadonlyArray<readonly [spacing: number, maxTier: number]> = [
    [ACCENT_HUE_SPACING, 2],
    [ACCENT_HUE_SPACING_RELAXED, 2],
    [ACCENT_HUE_SPACING, 3],
    [ACCENT_HUE_SPACING_RELAXED, 3],
  ];
  const chooseSpaced = (
    filter: (entries: PoolEntry[]) => PoolEntry[],
    minContrast: number,
    rank: (entry: PoolEntry) => number,
    minLightness = 0
  ): RgbColor | null => {
    for (const [spacing, maxTier] of SELECTION_PASSES) {
      const free = available(spacing).filter(entry => entry.tier <= maxTier);
      const pick = choose(filter(free), minContrast, rank, minLightness);
      if (pick) {
        return admit(pick);
      }
    }
    return null;
  };
  const prominence = (entry: PoolEntry): number => entry.prominence;

  // --- player: the most eye-catching colour that can actually be seen on the ground --------------
  let player: RgbColor | null = null;
  let playerHue = 0;
  {
    const candidates = available(ACCENT_HUE_SPACING);
    const first = choose(candidates, playerMinContrast, prominence);
    if (first) {
      const runner = choose(
        candidates.filter(entry => entry.index !== first.entry.index),
        playerMinContrast,
        prominence
      );
      // …unless the runner-up is the picture's gold and a collectible slot is waiting for it.
      const isWarm = (entry: PoolEntry): boolean =>
        entry.hsl.h >= WARM_HUE_MIN && entry.hsl.h <= WARM_HUE_MAX;
      const swap =
        runner !== null &&
        runner.entry.tier === first.entry.tier &&
        !(slots >= 3 && isWarm(runner.entry)) &&
        contrastRatio(runner.color, ground) >=
          contrastRatio(first.color, ground) * PLAYER_CONTRAST_SWAP_RATIO;
      const pick = swap && runner ? runner : first;
      playerHue = pick.entry.hsl.h;
      player = admit(pick);
    }
  }

  // --- collectible: a warm colour, if the picture has one, is claimed before the hazard search can
  // spend it as "the farthest hue". A tier-3 warm is brown, not gold, and does not qualify. ---------
  let collectible: RgbColor | null = null;
  if (slots >= 3) {
    collectible = chooseSpaced(
      entries =>
        entries.filter(
          entry => entry.tier <= 2 && entry.hsl.h >= WARM_HUE_MIN && entry.hsl.h <= WARM_HUE_MAX
        ),
      accentMinContrast,
      prominence
    );
  }

  // --- hazard: the strong vivid colour far in hue from the player. Prominence times a hue-distance
  // bonus rather than distance alone: the literal complement of a neon cyan is a dull orange-red,
  // while the hot magenta a person would call "the other colour" sits at 130°. -------------------
  let hazard: RgbColor | null = null;
  if (slots >= 2 && player) {
    const hue = playerHue;
    hazard = chooseSpaced(
      entries => {
        // The relaxed spacing may bring a hazard closer to the collectible, never to the player.
        const apart = entries.filter(entry => hueDistance(entry.hsl.h, hue) >= ACCENT_HUE_SPACING);
        const painted = apart.filter(entry => entry.contrast >= HAZARD_MIN_PAINTED_CONTRAST);
        return painted.length > 0 ? painted : apart;
      },
      accentMinContrast,
      entry =>
        entry.prominence *
        (entry.hsl.l > PRIME_MAX_LIGHTNESS ? HAZARD_PASTEL_PENALTY : 1) *
        (HAZARD_BASE_WEIGHT + (1 - HAZARD_BASE_WEIGHT) * (hueDistance(entry.hsl.h, hue) / 180))
    );
  }

  // --- collectible, when nothing warm was there: the next best pop ---------------------------------
  if (slots >= 3 && !collectible) {
    collectible = chooseSpaced(entries => entries, accentMinContrast, prominence);
  }

  // --- ui: the lightest thing left in a hue of its own; then a pastel of a hue already in use (a pale
  // cyan next to neon cyan is what HUD text looks like) if it is far enough in RGB from everything
  // chosen; then the next candidate raised to L ≥ 0.6 -------------------------------------------
  let ui: RgbColor | null = null;
  if (slots >= 4) {
    const lightness = (entry: PoolEntry): number => entry.hsl.l;
    // A hue of its own beats lightness: in each pass, the lightest colour already at L ≥ 0.6, else
    // the best remaining colour raised there — only then is the pass relaxed.
    for (const [spacing, maxTier] of SELECTION_PASSES) {
      const free = available(spacing).filter(entry => entry.tier <= maxTier);
      const pick =
        choose(
          free.filter(entry => entry.hsl.l >= UI_MIN_LIGHTNESS),
          accentMinContrast,
          lightness
        ) ?? choose(free, accentMinContrast, prominence, UI_MIN_LIGHTNESS);
      if (pick) {
        ui = admit(pick);
        break;
      }
    }
    if (!ui) {
      const pastel = choose(
        pool.filter(
          entry =>
            !taken.has(entry.index) &&
            entry.hsl.l >= UI_SAME_HUE_MIN_LIGHTNESS &&
            separated(entry.color, UI_SAME_HUE_MIN_DISTANCE)
        ),
        accentMinContrast,
        lightness
      );
      if (pastel) {
        ui = admit(pastel);
      }
    }
  }

  // --- extra middle slots (palettes wider than five): next best, hue-spaced ------------------------
  const extras: RgbColor[] = [];
  while (extras.length < slots - 4) {
    const extra = chooseSpaced(entries => entries, accentMinContrast, prominence);
    if (!extra) {
      break;
    }
    extras.push(extra);
  }

  // --- invent missing roles as lightness variants of what IS there, never from what was rejected.
  // Seeds are ordered per role so the two middle slots come from different hues when two exist. ----
  const invent = (role: AccentRole): RgbColor => {
    const seedsByRole: Record<AccentRole, ReadonlyArray<RgbColor | null>> = {
      player: [hazard, collectible, ground],
      hazard: [collectible, player, ground],
      collectible: [player, hazard, ground],
      ui: [player, hazard, collectible, ground],
    };
    const seeds = seedsByRole[role]
      .filter((seed): seed is RgbColor => seed !== null)
      .map(seed => rgbToHsl(seed));
    const accept = (color: RgbColor): RgbColor => {
      chosen.push(color);
      return color;
    };
    // Seed-major: every lightness of the preferred seed before the next seed, so a hazard becomes
    // another orange before it becomes another player-cyan. An invented colour must read on the
    // ground and earn its slot at the full merge distance — a target that brackets its seed yields
    // a near-twin otherwise — and only when nothing does is the palette floor enough.
    for (const floor of [BACKGROUND_MERGE_DISTANCE, PALETTE_MIN_SEPARATION]) {
      for (const base of seeds) {
        for (const target of INVENT_TARGETS[role]) {
          const variant = hslToRgb({ h: base.h, s: pinnedSaturation(base), l: target });
          const lifted = liftToContrast(variant, ground, accentMinContrast).color;
          if (readsOnGround(lifted) && separated(lifted, floor)) {
            return accept(lifted);
          }
        }
      }
    }
    // The targets, lifted, all landed on colours already chosen (the lift walks every target of a
    // hue to the same first legible lightness — that is how a one-hue picture used to collapse to a
    // fixed gold, twice). Walk the seeds' whole lightness ladders instead: any rung that separates,
    // preferring one that reads, the preferred seed, its pinned saturation, the rung nearest the
    // role's first target, then the lighter one. Still the picture's own hues, never a constant.
    const target = INVENT_TARGETS[role][0];
    const rungs = seeds.flatMap((base, seedRank) =>
      lightnessLadder(base).map((rung, index) => ({ ...rung, seedRank, index }))
    );
    const separate = rungs.filter(rung => separated(rung.color));
    if (separate.length > 0) {
      separate.sort(
        (a, b) =>
          Number(readsOnGround(b.color)) - Number(readsOnGround(a.color)) ||
          a.seedRank - b.seedRank ||
          a.saturationRank - b.saturationRank ||
          Math.abs(a.l - target) - Math.abs(b.l - target) ||
          b.l - a.l ||
          a.index - b.index
      );
      return accept(separate[0].color);
    }
    // Nothing on any ladder clears the floor (a palette far wider than any caller asks for): the
    // rung farthest from everything chosen is the best the picture's hues can do.
    const gap = (color: RgbColor): number =>
      Math.min(...chosen.map(picked => rgbDistance(color, picked)));
    const widest = rungs.reduce((best, rung) => (gap(rung.color) > gap(best.color) ? rung : best));
    return accept(widest.color);
  };
  const playerColor = player ?? invent('player');
  if (slots >= 2 && !hazard) {
    hazard = invent('hazard');
  }
  if (slots >= 3 && !collectible) {
    collectible = invent('collectible');
  }
  if (slots >= 4 && !ui) {
    ui = invent('ui');
  }
  while (extras.length < slots - 4) {
    extras.push(invent('ui'));
  }

  // --- assemble in role order ---------------------------------------------------------------------
  const roles: RgbColor[] = [];
  if (collectible) {
    roles.push(collectible);
  }
  if (ui) {
    roles.push(ui);
  }
  roles.push(...extras);
  if (hazard) {
    roles.push(hazard);
  }
  roles.push(playerColor);

  // --- safety net: every admission and invention above checked the floor against everything chosen,
  // so no pair should be closer than it. Should one be, the offender is re-seated on its own hue's
  // lightness ladder — the separated rung that reads, nearest to where it sat — never re-lifted,
  // because the lift walks straight back to the lightness it just left. One pass suffices: each
  // re-seat is checked against every other role, later re-seats included. --------------------------
  const others = (skip: number): RgbColor[] => [ground, ...roles.filter((_, i) => i !== skip)];
  const clearOf = (color: RgbColor, rest: readonly RgbColor[]): boolean =>
    rest.every(other => rgbDistance(color, other) >= PALETTE_MIN_SEPARATION);
  for (let i = 0; i < roles.length; i += 1) {
    const rest = others(i);
    if (clearOf(roles[i], rest)) {
      continue;
    }
    const base = rgbToHsl(roles[i]);
    const rungs = lightnessLadder(base, base.s)
      .map((rung, index) => ({ ...rung, index }))
      .filter(rung => clearOf(rung.color, rest));
    if (rungs.length === 0) {
      continue;
    }
    rungs.sort(
      (a, b) =>
        Number(readsOnGround(b.color)) - Number(readsOnGround(a.color)) ||
        a.saturationRank - b.saturationRank ||
        Math.abs(a.l - base.l) - Math.abs(b.l - base.l) ||
        b.l - a.l ||
        a.index - b.index
    );
    roles[i] = rungs[0].color;
  }

  return [ground, ...roles].map(rgbToHex);
};

interface BinSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly pop: number;
  readonly index: number;
}

interface BinSwatch {
  readonly color: RgbColor;
  readonly pop: number;
  readonly share: number;
  readonly index: number;
}

/**
 * The accent candidates of an image as a **hue histogram**, packed as {@link PaletteSwatch}es whose
 * `weight` is the share of the sampled opaque pixels in that hue — the pool
 * {@link pickStylePalette} fills its roles from.
 *
 * A histogram rather than a second median cut, because a median-cut box averages the bright and
 * the dim pixels of one hue into a muddy mid-tone, and on a painted mockup the dim pixels win: the
 * shadow side of the purple board is most of the purple. Here every vivid pixel votes into one of
 * {@link HUE_BINS} 15° bins (split once more into a dark/mid and a light band, so a pastel and a
 * neon of one hue both survive), and a bin is represented by the mean of its **brightest-chroma
 * third** — a bin that is mostly shadow with a neon core is represented by the neon. Coverage only
 * decides whether a bin is real ({@link BIN_MIN_SHARE}); bins too close to the ground are dropped,
 * and twin bins that came out as one colour (a hue straddling a bin edge) fold into the stronger.
 *
 * Sampling is a fixed stride over the raster (never a canvas resample) so the pool is byte-for-byte
 * reproducible; the alpha threshold is the one {@link quantizePixels} uses so the accents are drawn
 * from exactly the pixels the ground was measured over. Returns an empty list when nothing vivid is
 * there — the caller then falls back to the full-image swatches.
 */
const accentHistogram = (
  pixels: ImagePixels,
  ground: RgbColor,
  options: PaletteOptions
): PaletteSwatch[] => {
  const threshold = clamp(Math.round(options.alphaThreshold ?? 8), 0, 255);
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? STYLE_HISTOGRAM_SAMPLES));
  const total = pixels.width * pixels.height;
  if (total <= 0) {
    return [];
  }
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const bins: BinSample[][] = Array.from({ length: HUE_BINS * 2 }, () => []);
  let sampled = 0;
  let visited = 0;
  for (let index = 0; index < total; index += stride) {
    const offset = index * 4;
    if (pixels.data[offset + 3] <= threshold) {
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
    bins[hueBin * 2 + band].push({
      r: color.r,
      g: color.g,
      b: color.b,
      pop: popOf(hsl),
      index: visited,
    });
    visited += 1;
  }
  if (sampled === 0) {
    return [];
  }

  const represented: BinSwatch[] = [];
  bins.forEach((bin, binIndex) => {
    const share = bin.length / sampled;
    if (bin.length === 0 || share < BIN_MIN_SHARE) {
      return;
    }
    const sorted = bin.slice().sort((a, b) => b.pop - a.pop || a.index - b.index);
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
    if (rgbDistance(color, ground) < BACKGROUND_MERGE_DISTANCE) {
      return;
    }
    represented.push({ color, pop: popOf(rgbToHsl(color)), share, index: binIndex });
  });

  // Merge bins that ended up as the same colour (a hue straddling a bin edge, or a band split that
  // produced two near-identical means): keep the stronger representative, add the shares.
  const strength = (entry: BinSwatch): number => entry.pop * Math.pow(entry.share, SHARE_EXPONENT);
  const byStrength = (a: BinSwatch, b: BinSwatch): number =>
    strength(b) - strength(a) || b.share - a.share || a.index - b.index;
  const merged: BinSwatch[] = [];
  for (const entry of represented.slice().sort(byStrength)) {
    const twin = merged.findIndex(
      kept =>
        hueDistance(rgbToHsl(kept.color).h, rgbToHsl(entry.color).h) < 360 / HUE_BINS &&
        rgbDistance(kept.color, entry.color) < TWIN_RGB_DISTANCE
    );
    if (twin >= 0) {
      const kept = merged[twin];
      merged[twin] = { ...kept, share: kept.share + entry.share };
    } else {
      merged.push(entry);
    }
  }
  return merged
    .sort(byStrength)
    .map(entry => ({ color: entry.color, hex: rgbToHex(entry.color), weight: entry.share }));
};

/**
 * Measure already-decoded pixels the way a *game* needs a palette: quantize the whole frame for the
 * ground colour, histogram its vivid pixels by hue for the accents ({@link accentHistogram}), then
 * fill the roles ({@link pickStylePalette}). This is the whole shipping pipeline minus the decode,
 * exported so it can run over pixels from any source — the palette lab under `tools/palette-lab`
 * uses it as its regression control. Returns an empty array for an image with no opaque pixels.
 */
export const stylePaletteFromPixels = (
  pixels: ImagePixels,
  count = 5,
  options: PaletteOptions = {}
): string[] => {
  const swatches = quantizePixels(pixels, STYLE_QUANTIZE_BOXES, options);
  if (swatches.length === 0) {
    return [];
  }
  const ground = pickBackground(swatches);
  const accents = accentHistogram(pixels, ground, options);
  return pickStylePalette(swatches, count, accents);
};

/**
 * Measure a reference image's palette the way a *game* needs it — see {@link stylePaletteFromPixels}.
 * Returns an empty array when the image can't be decoded — callers must treat that as "unknown",
 * never as "no colours".
 */
export async function extractStylePalette(
  source: Blob,
  count = 5,
  options: PaletteOptions = {}
): Promise<string[]> {
  const pixels = await readImagePixels(source);
  if (!pixels) {
    return [];
  }
  return stylePaletteFromPixels(pixels, count, options);
}

export interface TintOptions extends EncodeOptions {
  /**
   * How much of the tint to apply, 0..1. 1 (default) is a full multiply; lower values mix back
   * toward the original colour, which is how a placeholder keeps a little of its own hue.
   */
  strength?: number;
  /** Pixels at or below this alpha are left untouched (nothing to tint). Default 0. */
  alphaThreshold?: number;
}

/**
 * Multiply-tint an image with a solid colour, preserving its alpha channel exactly — the operation
 * that turns a recipe's near-white placeholder art into the brief's palette, so a freshly expanded
 * project looks deliberate rather than grey before a single asset has been generated.
 *
 * Multiply (not replace) because the placeholders carry their own shading: `out = src · tint / 255`
 * keeps every gradient and outline and simply pulls the whole sprite toward the target hue, which
 * is why near-white source art is a requirement of the recipe contract — white is multiply's
 * identity, so the tint lands at full strength.
 *
 * **Per-pixel rather than `globalCompositeOperation: 'multiply'` + `'destination-in'`.** The
 * composite recipe reaches the same place for fully-opaque pixels but not for anti-aliased edges:
 * the multiply pass composites a fully-opaque fill over a partly-transparent backdrop, dragging
 * fringe pixels toward the flat tint colour, and the `destination-in` pass then restores the alpha
 * around that already-wrong colour — a visible halo on every sprite edge. Reading the bytes keeps
 * alpha untouched by construction, costs microseconds at sprite sizes, and matches how
 * {@link chromaKeyImage} works in this module. Returns the source unchanged when the colour can't
 * be parsed or no canvas is available.
 */
export async function tintImage(
  source: Blob,
  hexColor: string,
  options: TintOptions = {}
): Promise<RasterResult> {
  const tint = hexToRgb(hexColor);
  if (!tint || !canUseBitmap()) {
    const size = await readBlobSize(source);
    return { blob: source, width: size?.width ?? 0, height: size?.height ?? 0 };
  }

  const bitmap = await createImageBitmap(source);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    tintPixelsInPlace(imageData.data, tint, options);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvasToBlob(canvas, {
      mimeType: options.mimeType ?? 'image/png',
      quality: options.quality,
    });
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * The tint itself: `out = lerp(src, src · tint / 255, strength)` per channel, alpha untouched.
 * Exported so the arithmetic is testable without a canvas — {@link tintImage} calls exactly this
 * over the bytes it reads back from the context.
 */
export const tintPixelsInPlace = (
  data: Uint8ClampedArray,
  tint: RgbColor,
  options: TintOptions = {}
): void => {
  const strength = clamp(options.strength ?? 1, 0, 1);
  const threshold = clamp(Math.round(options.alphaThreshold ?? 0), 0, 255);
  if (strength === 0) {
    return;
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] <= threshold) {
      continue;
    }
    data[index] = mixChannel(data[index], tint.r, strength);
    data[index + 1] = mixChannel(data[index + 1], tint.g, strength);
    data[index + 2] = mixChannel(data[index + 2], tint.b, strength);
  }
};

const mixChannel = (source: number, tint: number, strength: number): number => {
  const multiplied = (source * tint) / 255;
  return Math.round(source + (multiplied - source) * strength);
};

export interface AlphaStats {
  /** True when any pixel is meaningfully transparent (alpha ≤ 250 for >0.5% of pixels). */
  readonly hasAlpha: boolean;
  /** Fraction (0..1) of pixels that are fully/near transparent (alpha ≤ 16). */
  readonly transparentFraction: number;
}

/**
 * Deterministically measure an image's transparency. This exists because **vision models cannot
 * judge transparency** — a transparent PNG is flattened onto an opaque (usually white) background
 * before the model sees it, so asking a vision helper "is the background transparent?" reliably
 * returns a wrong "it's white". Read the alpha channel directly instead. Returns `hasAlpha:false`
 * when the image can't be decoded (no canvas).
 */
export async function imageAlphaStats(blob: Blob): Promise<AlphaStats> {
  if (!canUseBitmap()) {
    return { hasAlpha: false, transparentFraction: 0 };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { hasAlpha: false, transparentFraction: 0 };
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const total = w * h || 1;
    let transparent = 0;
    let anyPartial = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] <= 16) transparent++;
      if (data[i] <= 250) anyPartial++;
    }
    const transparentFraction = transparent / total;
    return { hasAlpha: anyPartial / total > 0.005, transparentFraction };
  } finally {
    bitmap.close();
  }
}

/**
 * Re-encode an image to a (typically lossy) format to shrink its byte size, optionally downscaling
 * at the same time. Defaults to WebP at quality 0.85 — good compression with alpha support.
 */
export async function compressImageBlob(
  blob: Blob,
  options: ResizeOptions = {}
): Promise<RasterResult> {
  return resizeImageBlob(blob, {
    ...options,
    mimeType: options.mimeType ?? 'image/webp',
    quality: options.quality ?? 0.85,
  });
}

// -- base64 / data-url helpers ----------------------------------------------

/** Base64-encode a blob WITHOUT the `data:` URI prefix (provider reference/output format). */
export const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });

/** Full `data:` URL for a blob (used for JSON-safe previews over the debug bridge). */
export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });

/** Decode a base64 payload (no `data:` prefix) into a typed Blob. */
export const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

// -- asset path helpers ------------------------------------------------------

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

/** File extension (no dot) for a mime type. */
const imageExtensionForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

/** Normalise a user/agent-supplied save path: drop `res://`, back-slashes, leading slashes. */
export const normalizeAssetPath = (path: string): string =>
  path
    .trim()
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^\/+/, '');

/** Append a mime-derived extension only when the path lacks a recognised image extension. */
export const ensureImageExtension = (path: string, mimeType: string): string => {
  if (!path) {
    return path;
  }
  return IMAGE_EXT_RE.test(path) ? path : `${path}.${imageExtensionForMime(mimeType)}`;
};

/** Compute aspect-preserving downscaled dimensions for a longest-edge cap (no upscaling). */
export const scaledDimensions = (
  width: number,
  height: number,
  maxSize: number
): ImageDimensions => {
  if (!maxSize || maxSize <= 0) {
    return { width, height };
  }
  const longest = Math.max(width, height);
  if (longest <= maxSize) {
    return { width, height };
  }
  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));
