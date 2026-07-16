/**
 * Downscale + encode a (WebGL) canvas into a base64 image payload. Shared by the
 * editor-viewport and running-game screenshot paths (`ViewportRendererService` /
 * `GamePlaySessionService`). Callers MUST render a frame synchronously right
 * before calling this: the WebGL drawing buffer is cleared after compositing
 * (`preserveDrawingBuffer` is off), so pixels read in a later task are blank.
 */

export interface CanvasScreenshot {
  dataBase64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface CanvasScreenshotOptions {
  /** Longest-edge cap in px (default 1024). */
  maxSize?: number;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
}

export function encodeCanvasScreenshot(
  source: HTMLCanvasElement,
  options: CanvasScreenshotOptions = {}
): CanvasScreenshot | null {
  if (source.width === 0 || source.height === 0) {
    return null;
  }
  const maxSize = options.maxSize && options.maxSize > 0 ? options.maxSize : 1024;
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.drawImage(source, 0, 0, width, height);

  const requestedMime = options.mimeType ?? 'image/jpeg';
  const dataUrl = copy.toDataURL(requestedMime, 0.85);
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
  return {
    dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mimeType,
    width,
    height,
  };
}
