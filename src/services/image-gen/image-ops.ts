/**
 * Pure, browser-side image transforms shared by the Asset Generator panel (interactive UI) and the
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

const canUseBitmap = (): boolean =>
  typeof createImageBitmap === 'function' && typeof document !== 'undefined';

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
export const imageExtensionForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

/** Strip an image extension from a path/name if present. */
export const stripImageExtension = (path: string): string => path.replace(IMAGE_EXT_RE, '');

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
