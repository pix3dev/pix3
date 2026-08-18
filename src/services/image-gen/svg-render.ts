/**
 * SVG plumbing for the `svg-llm` image provider: pull an SVG document out of a chat completion,
 * make it safe to keep and to render, and bake it into a PNG at an exact pixel size.
 *
 * Everything here except {@link rasterizeSvg} is pure string work, deliberately: happy-dom has no
 * real canvas and no `Image` decode, so the interesting logic (extraction, sanitising, viewBox
 * injection) is unit-testable and the one browser-only step is a single function behind a seam.
 *
 * The sanitiser is string-based rather than DOM-based on purpose. A `DOMParser` round-trip would
 * re-serialise the document, and the source is a **kept artifact** — the user reads and hand-edits
 * it, and the next edit turn sends it back to the model — so mangling the author's formatting to
 * strip a `<script>` that the browser's SVG-as-image mode would never have run anyway is a bad
 * trade. Rendering safety comes from that restricted mode; this pass is what makes the *stored*
 * text safe for anything else that ever touches it.
 */

/** Requested raster size in device pixels. */
export interface SvgRasterSize {
  readonly width: number;
  readonly height: number;
}

/** Hard cap on a generated source, so a runaway completion can't be stored or re-sent forever. */
export const MAX_SVG_SOURCE_LENGTH = 256 * 1024;

/** Sizes the UI offers as one-click presets, and the clamp range for hand-typed values. */
export const MIN_SPRITE_SIZE = 8;
export const MAX_SPRITE_SIZE = 2048;

/** Clamp a requested pixel dimension into the supported range, rounding to whole pixels. */
export const clampSpriteSize = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(MAX_SPRITE_SIZE, Math.max(MIN_SPRITE_SIZE, Math.round(value)));
};

const FENCED_SVG_RE = /```(?:svg|xml|html)?\s*\r?\n([\s\S]*?)```/gi;
const SVG_SPAN_RE = /<svg[\s>][\s\S]*?<\/svg\s*>/i;

/**
 * Pull the SVG document out of a model reply: a fenced code block first (models nearly always wrap
 * it), otherwise the first bare `<svg>…</svg>` span, so a reply that forgot the fence or wrapped
 * prose around the markup still parses. Returns null when there is no `<svg>` root at all — the
 * caller retries once with the failure quoted back to the model.
 */
export function extractSvgSource(text: string): string | null {
  if (!text) {
    return null;
  }
  FENCED_SVG_RE.lastIndex = 0;
  for (let match = FENCED_SVG_RE.exec(text); match; match = FENCED_SVG_RE.exec(text)) {
    const inner = SVG_SPAN_RE.exec(match[1]);
    if (inner) {
      return inner[0].trim();
    }
  }
  const bare = SVG_SPAN_RE.exec(text);
  return bare ? bare[0].trim() : null;
}

/**
 * Strip everything an SVG has no business carrying when it is stored, re-sent to a model, or opened
 * outside the renderer's restricted mode: scripting, HTML smuggled through `<foreignObject>`, entity
 * declarations (a `DOCTYPE` is how "billion laughs" gets in), event handlers, and every reference
 * that would reach off-document. Local fragment references (`#gradient-1`) survive, because gradients
 * and clip paths are how real vector art is built.
 */
export function sanitizeSvgSource(svg: string): string {
  let out = svg;
  // Element-level removals (content included — an unclosed tag would otherwise leak its body).
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  out = out.replace(/<foreignObject\b[^>]*\/>/gi, '');
  out = out.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '');
  out = out.replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '');
  // Attribute-level removals.
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  out = stripExternalReferences(out);
  // CSS `url(...)` pointing anywhere but a local fragment (external images, remote fonts).
  out = out.replace(/url\(\s*(['"]?)(?!#)[^)'"]*\1\s*\)/gi, 'none');
  return out.trim();
}

/** Drop `href` / `xlink:href` attributes that point anywhere but a local `#fragment`. */
function stripExternalReferences(svg: string): string {
  return svg.replace(
    /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim();
      return value.startsWith('#') ? match : '';
    }
  );
}

/** Numeric part of an SVG length attribute (`"64"`, `"64px"`, `"64.5pt"`), or null. */
const parseLength = (raw: string | undefined): number | null => {
  if (!raw) {
    return null;
  }
  const match = /^\s*(-?[\d.]+)/.exec(raw);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const readAttribute = (openTag: string, name: string): string | undefined => {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(openTag);
  return match ? (match[1] ?? match[2]) : undefined;
};

/**
 * Guarantee the root `<svg>` carries a `viewBox` and a pixel `width`/`height` matching the requested
 * raster size. Without a viewBox an SVG drawn into a canvas at a size other than its intrinsic one
 * is cropped rather than scaled — which is exactly the "I asked for 96×32" case this provider exists
 * for. The user coordinate system is taken from the author's own `width`/`height` when it has them,
 * so hand-written coordinates keep meaning what they meant; otherwise it falls back to the request.
 */
export function ensureSvgViewBox(svg: string, size: SvgRasterSize): string {
  const openTagMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!openTagMatch) {
    return svg;
  }
  const openTag = openTagMatch[0];
  const selfClosing = /\/>$/.test(openTag);
  const inner = openTag.slice(4, selfClosing ? -2 : -1);

  const existingViewBox = readAttribute(openTag, 'viewBox');
  const intrinsicWidth = parseLength(readAttribute(openTag, 'width'));
  const intrinsicHeight = parseLength(readAttribute(openTag, 'height'));

  const viewBox =
    existingViewBox && existingViewBox.trim()
      ? existingViewBox.trim()
      : `0 0 ${intrinsicWidth ?? size.width} ${intrinsicHeight ?? size.height}`;

  const withoutSized = inner
    .replace(/\s(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .trim();
  const attributes = [
    withoutSized,
    `width="${size.width}"`,
    `height="${size.height}"`,
    `viewBox="${viewBox}"`,
  ]
    .filter(Boolean)
    .join(' ');

  return `${svg.slice(0, openTagMatch.index)}<svg ${attributes}${selfClosing ? ' />' : '>'}${svg.slice(
    openTagMatch.index + openTag.length
  )}`;
}

/**
 * Sanitise + size an authored SVG so it can be both stored and rasterised. Returns the exact text
 * that becomes the asset's `svgSource`, so what the user reads is what was rendered.
 */
export function prepareSvgForRaster(svg: string, size: SvgRasterSize): string {
  return ensureSvgViewBox(sanitizeSvgSource(svg), size);
}

/**
 * Bake an SVG into a PNG blob at exactly `size`, with a real alpha channel.
 *
 * The blob-URL → `<img>` route puts the browser in its restricted SVG-as-image mode: no scripting,
 * no external loads, no interactivity. That is the actual security boundary (the sanitiser above
 * protects the *stored* text), and it is also why fonts must be generic families — the image mode
 * will not fetch a webfont.
 *
 * The one browser-only function in this module; keep it that way so everything else stays testable.
 */
export async function rasterizeSvg(svg: string, size: SvgRasterSize): Promise<Blob> {
  const prepared = prepareSvgForRaster(svg, size);
  const url = URL.createObjectURL(new Blob([prepared], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await decodeImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get a 2D canvas context to rasterize the SVG.');
    }
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(image, 0, 0, size.width, size.height);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const decodeImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('The generated SVG could not be decoded (malformed markup).'));
    image.src = url;
  });

const canvasToPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode the rasterized SVG as a PNG.'));
      }
    }, 'image/png');
  });
