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
    const threshold = clamp(Math.round(options.alphaThreshold ?? 0), 0, 255);

    let minX = sw;
    let minY = sh;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (data[(y * sw + x) * 4 + 3] > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      return { blob, width: sw, height: sh, empty: true, bounds: null };
    }

    const bounds: CropRectPixels = {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
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
    clamp(Math.round(value), 0, 255)
      .toString(16)
      .padStart(2, '0');
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

  return boxes
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
    .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
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
