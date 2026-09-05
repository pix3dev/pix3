/**
 * UI Kit Forge page — SVG → canvas.
 *
 * Deliberately the page's own copy rather than `@/services/image-gen/svg-render`'s
 * `rasterizeSvg`, for two reasons that are both load-bearing (plan §3.6 anticipated the
 * first, the second turned up on inspection):
 *
 *  - `rasterizeSvg` returns a PNG **blob**. The atlas needs the *canvas*: it reads the pixels
 *    back to measure the trim rect, the body rect and `midY`, then blits the source rect into
 *    the sheet. Going through a blob would mean decoding every frame a second time.
 *  - `prepareSvgForRaster` sanitises, and its CSS rule rewrites every `url(…)` that is not a
 *    local `#fragment` to `none` — which is exactly the `url(data:font/woff2;base64,…)` the
 *    font inlining just put in. Sanitising an SVG **this page generated itself** buys nothing
 *    and would silently drop every caption's face.
 *
 * The editor-side host (Ф6) uses the sanitising editor path instead, because the strings it
 * rasterizes can come from an agent. Same core, different host — which is the whole point of
 * the split.
 */

/** Render an SVG document into a canvas at `scale`. */
export function rasterize(
  svg: string,
  width: number,
  height: number,
  scale: number
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(width * scale));
      canvas.height = Math.max(1, Math.ceil(height * scale));
      const ctx = canvas.getContext('2d');
      URL.revokeObjectURL(url);
      if (!ctx) {
        reject(new Error('Could not get a 2D canvas context to rasterize the SVG.'));
        return;
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The browser could not decode the generated SVG.'));
    };
    image.src = url;
  });
}

/** A canvas as a PNG blob. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob() produced nothing.'));
    }, 'image/png');
  });
}
