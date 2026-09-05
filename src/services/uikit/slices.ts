/**
 * UI Kit Forge — the slicing and anchoring metadata a CONSUMER needs from a generated frame.
 *
 * Pure functions, no DOM, no module state; a pixel buffer is passed in, never read from a
 * canvas here.
 *
 * WHY THIS MODULE EXISTS. A host rasterizes each component into a PNG and writes a
 * TexturePacker-style record (`frame`, `spriteSourceSize`, `sourceSize`). That is not enough,
 * because a nine-slice consumer STRETCHES the backing and draws the caption itself. Two
 * properties of the generator's output break such a consumer silently:
 *   1. every frame is padded with `theme.pad` transparent pixels, and automatic cap
 *      arithmetic (`min(w, h) / 2` and the like) knows nothing about it, so the padding eats
 *      the cap and the corner arc slides into the stretched middle;
 *   2. captions are stripped before rasterizing, so a card arrives with a hole where its
 *      number belonged.
 *
 * What this module computes per frame:
 *   {@link sliceBorder}  a SAFE nine-slice inset derived from the theme (pad, outline, radius,
 *                        gloss, bevel, drop shadow), so stretching never distorts a corner or
 *                        the gloss. In pix3 this is what feeds
 *                        `TiledSprite2D.sliceBorderLeft/Right/Top/Bottom` (plan §3.2);
 *   {@link trimBounds}   the real non-transparent rect → `spriteSourceSize` / `trimmed`;
 *   {@link bodyBounds}   the OPAQUE body without the soft shadow;
 *   {@link midFraction}  the body's optical centre as a fraction of the frame height;
 *   {@link textAnchor}   where a stripped caption belonged;
 *   {@link frameMeta}    all of the above merged into one serializable record.
 *
 * COORDINATE CONVENTIONS (stated once, used everywhere below):
 *   * pixel grids: origin at the TOP-LEFT of the UNTRIMMED source frame, x to the right,
 *     y DOWN; `rgba` is a flat RGBA buffer, pixel (x, y) at index (y * w + x) * 4;
 *   * a rect {x, y, w, h} covers columns x … x+w-1 and rows y … y+h-1 (inclusive indices);
 *   * a "fraction of frame height" is (distance from the top edge of the untrimmed frame) /
 *     (frame height); the CENTRE of row r is (r + 0.5) / h;
 *   * `theme` lengths and a component's `w`/`h` are DESIGN units (the SVG coordinate space);
 *     `scale` converts them to raster pixels. Every value this module RETURNS is in raster
 *     pixels of the frame — or in design units when `scale` is left at 1, which is how the
 *     engine lane uses it (`SkinSpec.ts`).
 *
 * Ported from `src/dev/uikit/slices.js`, minus the jam game's own constants: the fixed caps
 * of a specific engine are now an OPTIONAL `caps` argument, and the fit checks and their
 * warnings appear only when a caller passes them (plan §9.1).
 */
import type { ForgeTheme } from './ForgeTheme';

// ---------------------------------------------------------------------------
// Alpha thresholds
// ---------------------------------------------------------------------------

/**
 * A pixel counts as BODY (not shadow) from this alpha. On a generated soft shadow
 * (`shadowA` 40 % → alpha ≈ 100 at its densest) anything above ~200 works; 250 is the safer
 * one.
 */
export const BODY_ALPHA = 250;

/**
 * A pixel counts as VISIBLE (part of the sprite) from this alpha — the TexturePacker trim
 * rule: only fully transparent pixels are cut, the shadow's faint tail is kept.
 */
export const TRIM_ALPHA = 1;

/** A flat RGBA buffer, as `CanvasRenderingContext2D.getImageData().data` hands it over. */
export type RgbaBuffer = Uint8ClampedArray | Uint8Array | ArrayLike<number>;

export interface SliceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A finite number or the fallback (theme sliders may hold strings or undefined). */
export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Round to 3 decimals — the precision an optical-centre fraction is written with. */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Round to 2 decimals — enough for raster anchor positions, keeps the JSON short. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Bounds of the pixels whose alpha is >= `alphaMin`. The shared core of {@link trimBounds}
 * and {@link bodyBounds}. Returns null when no pixel qualifies (or the buffer is too short).
 */
export function alphaBounds(
  rgba: RgbaBuffer | null | undefined,
  w: number,
  h: number,
  alphaMin: number
): SliceRect | null {
  if (!rgba || w <= 0 || h <= 0 || rgba.length < w * h * 4) return null;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3] < alphaMin) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// 1. sliceBorder — the safe nine-slice inset
// ---------------------------------------------------------------------------

/**
 * Is the theme's gloss a band pinned to the TOP of the face?
 *
 * `glossFor()` draws three kinds: 'strip' (a rounded band at the top of the face), 'dome' (a
 * top-anchored gradient rect) and 'corner' (two ellipses in the upper corners). The first two
 * have a straight, fixed-height lower edge: if the top slice is shorter than the band, that
 * edge lands in the stretched middle and the gloss grows with the button. 'corner' is handled
 * separately in {@link sliceBorder} (it widens the side caps instead).
 */
export function glossIsTopStrip(theme: Partial<ForgeTheme> | null | undefined): boolean {
  if (!theme || !num(theme.glossOn, 0)) return false;
  const type = String(theme.glossType ?? 'strip').toLowerCase();
  return type === 'strip' || type === 'dome';
}

export interface SliceBorderOptions {
  /** Component height, design units — required to evaluate the gloss band. */
  height?: number;
  /** Component width, design units — for the 'corner' gloss; defaults to `height`. */
  width?: number;
  /** Design units → raster pixels. 1 leaves the result in design units. */
  scale?: number;
  /** Raster frame size; enables the "a cap may not take more than half a side" clamp. */
  frameW?: number;
  frameH?: number;
  /** Override: was the drop shadow drawn for this component? */
  shadow?: boolean;
  /** Override for {@link glossIsTopStrip}. */
  glossTopStrip?: boolean;
}

/**
 * The safe nine-slice inset for a component drawn with `theme`, measured inward from each
 * edge of the UNTRIMMED frame.
 *
 * The rule: a slice must contain everything that is NOT uniform along the edge it belongs to,
 * because a nine-slice stretches the middle of every edge and the centre. Terms, all × scale:
 *
 *   pad      the transparent margin a host adds around the component (`theme.pad`). It is
 *            part of the frame, so every inset starts behind it.
 *   outline  the dark outline ring (`theme.outline`). `bevelRect()` paints it as a filled
 *            outer rounded rect with the face inset by `outline`, so the OUTER arc already
 *            has radius `radius` and starts right at the padding edge; `outline` is kept as a
 *            margin for anti-aliasing and the half-pixel offsets of a scaled rasterization.
 *   radius   the corner radius: the arc spans exactly `radius` px from the frame edge on both
 *            axes.
 *   bevel    (BOTTOM only) the dark lip under the face: the face's bottom arc sits `bevel` px
 *            above the outer arc, so the non-uniform zone at the bottom is `radius + bevel`.
 *   gloss    (TOP only, 'strip'/'dome') the band's lower edge measured from the frame top:
 *            pad + outline + (band offset) + band height, where the band height is
 *            faceH × glossH / 100 — `glossH` is a PERCENT of the FACE height, so `height` is
 *            required to evaluate it. The face is the component minus 2 × outline minus
 *            bevel. Offsets and minimums replicate `glossFor()`.
 *   corner   ('corner' gloss) the two ellipses sit in the upper corners at distances
 *            proportional to `radius` and min(faceW, faceH); their far edge is added to the
 *            LEFT, RIGHT and TOP insets so they stay inside the caps.
 *   shadow   the drop shadow: a blurred copy of the silhouette offset by (dx, dy), so its own
 *            corner arc ends `offset + blur` past the body's. Added on the side the offset
 *            points to; `blur` alone on the others.
 *
 * Every inset is rounded UP to a whole pixel (a slice boundary cannot fall inside an arc) and
 * clamped to floor((frame - 1) / 2) when `frameW`/`frameH` are given, so opposite caps can
 * never meet.
 *
 * NOT covered: `theme.puffy` (`pillowPath` bulges the middle of every edge). A bulged edge is
 * non-uniform along its whole length and cannot be nine-sliced at all — {@link frameMeta}
 * reports it, and `buildSkin()` returns a null border for it.
 */
export function sliceBorder(
  theme: Partial<ForgeTheme> | null | undefined,
  opts: SliceBorderOptions = {}
): SliceBorder {
  const t = theme || {};
  const s = num(opts.scale, 1);
  const pad = Math.max(0, num(t.pad));
  const outline = Math.max(0, num(t.outline));
  const radius = Math.max(0, num(t.radius));
  const bevel = Math.max(0, num(t.bevel));
  const compH = Math.max(0, num(opts.height, 0));
  const compW = Math.max(0, num(opts.width, compH));
  const faceH = Math.max(0, compH - 2 * outline - bevel);
  const faceW = Math.max(0, compW - 2 * outline);

  const side = pad + outline + radius;
  let left = side;
  let right = side;
  let top = side;
  let bottom = side + bevel;

  // gloss: a top band, or two corner highlights
  const glossOn = !!num(t.glossOn, 0);
  const glossType = String(t.glossType ?? 'strip').toLowerCase();
  const isStrip = opts.glossTopStrip !== undefined ? !!opts.glossTopStrip : glossIsTopStrip(t);
  if (isStrip && faceH > 0) {
    const gh = (faceH * num(t.glossH)) / 100;
    const band =
      glossType === 'dome'
        ? 2 + Math.max(6, gh) // glossFor(): dome rect at y+2, height max(6, gh)
        : 0.7 * Math.max(2, radius * 0.45) + Math.max(4, gh); // strip: y + gp*0.7, height max(4, gh)
    top = Math.max(top, pad + outline + band);
  } else if (glossOn && glossType === 'corner' && faceH > 0) {
    const rr = Math.min(faceW || faceH, faceH);
    const ax = rr * 0.13; // the larger semi-axis (rotated ellipse)
    const bigX = Math.max(radius * 0.55, rr * 0.14) + ax; // big ellipse: from the RIGHT face edge
    const bigY = Math.max(radius * 0.5, rr * 0.16) + ax;
    const smallX = Math.max(radius * 0.55, rr * 0.11) + ax; // small ellipse: from the LEFT edge
    const smallY = Math.max(radius * 0.45, rr * 0.14) + ax;
    right = Math.max(right, pad + outline + bigX);
    left = Math.max(left, pad + outline + smallX);
    top = Math.max(top, pad + outline + Math.max(bigY, smallY));
  }

  // drop shadow: a blurred, offset silhouette — its arc ends offset + blur past the body's
  const shadowOn = opts.shadow !== undefined ? !!opts.shadow : !!num(t.shadowMode, 0);
  if (shadowOn) {
    const dx = num(t.shadowDx);
    const dy = num(t.shadowDy);
    const blur = Math.max(0, num(t.shadowBlur));
    left += blur + Math.max(0, -dx);
    right += blur + Math.max(0, dx);
    top += blur + Math.max(0, -dy);
    bottom += blur + Math.max(0, dy);
  }

  const out: SliceBorder = {
    left: Math.ceil(left * s),
    right: Math.ceil(right * s),
    top: Math.ceil(top * s),
    bottom: Math.ceil(bottom * s),
  };
  // opposite caps may not meet
  const fw = num(opts.frameW, 0);
  const fh = num(opts.frameH, 0);
  if (fw > 0) {
    const m = Math.max(0, Math.floor((fw - 1) / 2));
    out.left = Math.min(out.left, m);
    out.right = Math.min(out.right, m);
  }
  if (fh > 0) {
    const m = Math.max(0, Math.floor((fh - 1) / 2));
    out.top = Math.min(out.top, m);
    out.bottom = Math.min(out.bottom, m);
  }
  return out;
}

/**
 * The single symmetric cap a consumer that slices all four sides by ONE number can take: an
 * asymmetric border collapses to its largest side. Larger is safe (the corner is simply taken
 * whole).
 */
export function nineCap(border: SliceBorder): number {
  return Math.max(border.left, border.right, border.top, border.bottom);
}

// ---------------------------------------------------------------------------
// 2–4. Pixel measurements
// ---------------------------------------------------------------------------

/**
 * Tight bounds of the non-transparent pixels: the real sprite inside the padded frame. This
 * is TexturePacker's `spriteSourceSize`.
 */
export function trimBounds(
  rgba: RgbaBuffer | null | undefined,
  w: number,
  h: number,
  alphaMin = TRIM_ALPHA
): SliceRect | null {
  return alphaBounds(rgba, w, h, Math.max(1, alphaMin));
}

/**
 * Bounds of the OPAQUE body only: the button itself without its soft drop shadow. The
 * difference between {@link trimBounds} and this is the shadow's extent.
 */
export function bodyBounds(
  rgba: RgbaBuffer | null | undefined,
  w: number,
  h: number,
  opaqueMin = BODY_ALPHA
): SliceRect | null {
  return alphaBounds(rgba, w, h, opaqueMin);
}

/**
 * The optical centre of the body as a fraction of the frame HEIGHT.
 *
 * Convention: scan the CENTRE COLUMN only, `x = w >> 1` — there are no end caps there, so the
 * column crosses the body top to bottom; `top`/`bot` are the first and last rows with
 * alpha >= threshold (inclusive); the body's middle is `(top + bot + 1) / 2` (rows are cells,
 * row r spans [r, r+1)); the fraction is `mid / h`, h being the FULL frame height (padding
 * and shadow included, because that is the rect a consumer stretches the sprite into).
 *
 * Fallbacks: a centre column with no opaque pixel (a ring-shaped trough, a frame) falls back
 * to the middle of {@link bodyBounds}; no body at all → 0.5, i.e. "the body fills the rect".
 */
export function midFraction(
  rgba: RgbaBuffer | null | undefined,
  w: number,
  h: number,
  opaqueMin = BODY_ALPHA
): number {
  if (!rgba || w <= 0 || h <= 0 || rgba.length < w * h * 4) return 0.5;
  const x = w >> 1;
  let top = -1;
  let bot = -1;
  for (let y = 0; y < h; y++) {
    if (rgba[(y * w + x) * 4 + 3] < opaqueMin) continue;
    if (top < 0) top = y;
    bot = y;
  }
  if (top >= 0) return (top + bot + 1) / 2 / h;
  const body = bodyBounds(rgba, w, h, opaqueMin);
  if (body) return (body.y + body.h / 2) / h;
  return 0.5;
}

// ---------------------------------------------------------------------------
// 5. textAnchor — where a stripped caption belonged
// ---------------------------------------------------------------------------

const ALIGN: Readonly<Record<string, TextAnchorAlign>> = {
  start: 'left',
  left: 'left',
  middle: 'center',
  center: 'center',
  end: 'right',
  right: 'right',
};
const BASELINE = new Set(['top', 'middle', 'alphabetic', 'bottom']);

export type TextAnchorAlign = 'left' | 'center' | 'right';
export type TextAnchorBaseline = 'top' | 'middle' | 'alphabetic' | 'bottom';

export interface TextAnchor {
  role: string;
  x: number;
  y: number;
  size: number;
  align: TextAnchorAlign;
  baseline: TextAnchorBaseline;
  sample?: string;
}

export interface TextAnchorOptions {
  role?: string | null;
  align?: string | null;
  baseline?: string | null;
  sample?: string | null;
  scale?: number;
  dx?: number;
  dy?: number;
}

/**
 * Normalize one caption the generator skipped into a small serializable descriptor.
 *
 * `label()` collects `{ role, x, y, size, align: <svg text-anchor>, sample }` while
 * stripping; this turns the SVG vocabulary into the canvas one an engine uses
 * (`textAlign` / `textBaseline`) and moves the point into raster pixels of the frame.
 * `dx`/`dy` shift them into the frame (a host's padding offset, if the component SVG does not
 * already include it).
 */
export function textAnchor(
  x: number,
  y: number,
  size: number,
  opts: TextAnchorOptions = {}
): TextAnchor {
  const s = num(opts.scale, 1);
  const alignKey = String(opts.align ?? 'center').toLowerCase();
  const baseline = String(opts.baseline ?? '');
  const out: TextAnchor = {
    role: typeof opts.role === 'string' && opts.role ? opts.role : 'label',
    x: round2((num(x) + num(opts.dx)) * s),
    y: round2((num(y) + num(opts.dy)) * s),
    size: round2(num(size) * s),
    align: ALIGN[alignKey] || 'center',
    baseline: BASELINE.has(baseline) ? (baseline as TextAnchorBaseline) : 'middle',
  };
  if (opts.sample !== undefined && opts.sample !== null) out.sample = String(opts.sample);
  return out;
}

// ---------------------------------------------------------------------------
// 6. frameMeta — the record a host merges into its manifest entry
// ---------------------------------------------------------------------------

/**
 * The fixed slicing caps of a CONSUMER engine, when it has any.
 *
 * pix3 has none — `TiledSprite2D` reads the four insets straight from the manifest — so this
 * is optional and the fit checks below only run when a caller supplies it (plan §9.1: the
 * jam game's `SQ_CAP`/`TR_CAP` are not ours).
 */
export interface SliceCaps {
  /** The one symmetric nine-slice cap the consumer takes, in frame pixels. */
  sqCap: number;
  /** The cap at both ends of a trough's LONG axis, in frame pixels. */
  trCap: number;
}

export interface SliceFit {
  pill: boolean;
  pillCap: number;
  nine: boolean;
  nineCap: number;
  trough: boolean;
  troughCap: number;
}

/** Does a frame with this border fit a consumer's FIXED slicing constants? */
export function fitsCaps(border: SliceBorder, w: number, h: number, caps: SliceCaps): SliceFit {
  const pillCap = Math.min(w / 2, h / 2);
  const longAxis =
    h >= w ? Math.max(border.top, border.bottom) : Math.max(border.left, border.right);
  return {
    pill: Math.max(border.left, border.right) <= pillCap,
    pillCap,
    nine: nineCap(border) <= caps.sqCap,
    nineCap: caps.sqCap,
    trough: longAxis <= caps.trCap,
    troughCap: caps.trCap,
  };
}

/** A raw anchor as `label()` collected it, or an already-normalized one. */
export interface FrameMetaComponent {
  name?: string;
  kind?: string;
  /** Design units. */
  w?: number;
  h?: number;
  anchors?: readonly {
    role?: string | null;
    x: number;
    y: number;
    size: number;
    align?: string;
    sample?: string;
  }[];
  anchorDx?: number;
  anchorDy?: number;
  /** Was the drop shadow drawn for this component? */
  shadow?: boolean;
  glossTopStrip?: boolean;
}

export interface FrameMetaArgs {
  rgba: RgbaBuffer;
  w: number;
  h: number;
  theme: Partial<ForgeTheme>;
  comp?: FrameMetaComponent;
  /** Design units → raster pixels. */
  scale?: number;
  /** The consumer's fixed caps, when it has any — omit and no fit check is emitted. */
  caps?: SliceCaps;
}

export interface FrameMeta {
  sourceSize: { w: number; h: number };
  spriteSourceSize: SliceRect;
  trimmed: boolean;
  pad: number;
  border: SliceBorder;
  cap: number;
  body: SliceRect | null;
  trim: SliceRect | null;
  shadow: SliceBorder | null;
  midY: number;
  midYTrimmed: number;
  anchors: TextAnchor[];
  warnings: string[];
  /** Present only when `caps` was passed. */
  fits?: SliceFit;
  name?: string;
  kind?: string;
}

/**
 * The full metadata record for one rasterized frame. Plain serializable object; every length
 * is in raster pixels of the untrimmed frame (see the header for conventions).
 */
export function frameMeta({
  rgba,
  w,
  h,
  theme,
  comp = {},
  scale = 1,
  caps,
}: FrameMetaArgs): FrameMeta {
  const t = theme || {};
  const s = num(scale, 1) || 1;
  const pad = Math.max(0, num(t.pad));
  const compH = num(comp.h, w > 0 && h > 0 ? h / s - 2 * pad : 0);
  const compW = num(comp.w, w > 0 ? w / s - 2 * pad : compH);

  const trim = trimBounds(rgba, w, h);
  const body = bodyBounds(rgba, w, h);
  const border = sliceBorder(t, {
    scale: s,
    height: compH,
    width: compW,
    frameW: w,
    frameH: h,
    shadow: comp.shadow,
    glossTopStrip: comp.glossTopStrip,
  });
  const cap = nineCap(border);
  const mid = midFraction(rgba, w, h);
  const fits = caps ? fitsCaps(border, w, h, caps) : null;

  const warnings: string[] = [];
  if (num(t.puffy, 0) > 0) {
    warnings.push(
      'puffy: pillowPath bulges every edge — the middle slices are not uniform, a nine-slice will flatten the bulge'
    );
  }
  if (num(t.skew, 0) > 0) {
    warnings.push(
      'skew: the vertical edges lean — the side slices are not uniform along their length'
    );
  }
  if (!trim) warnings.push('empty: the frame is fully transparent');
  else if (!body) {
    warnings.push(
      'no body: no pixel reaches BODY_ALPHA — midY fell back to 0.5 and cannot be measured'
    );
  }
  if (fits) {
    if (!fits.nine) {
      warnings.push(
        `cap ${cap} > sqCap ${fits.nineCap}: the consumer would stretch the corner unless the call site passes cap=${cap}`
      );
    }
    if (!fits.pill) {
      warnings.push(
        `side inset ${Math.max(border.left, border.right)} > min(w,h)/2 = ${fits.pillCap}: a 3-slice would cut into the end cap`
      );
    }
  }

  const meta: FrameMeta = {
    sourceSize: { w, h },
    spriteSourceSize: trim ? { ...trim } : { x: 0, y: 0, w, h },
    trimmed: !!trim && (trim.x > 0 || trim.y > 0 || trim.w < w || trim.h < h),
    pad: Math.round(pad * s),
    border,
    cap,
    body: body ? { ...body } : null,
    trim: trim ? { ...trim } : null,
    shadow:
      body && trim
        ? {
            left: body.x - trim.x,
            right: trim.x + trim.w - (body.x + body.w),
            top: body.y - trim.y,
            bottom: trim.y + trim.h - (body.y + body.h),
          }
        : null,
    midY: round3(mid),
    midYTrimmed: trim ? round3((mid * h - trim.y) / trim.h) : round3(mid),
    anchors: Array.isArray(comp.anchors)
      ? comp.anchors.map(a =>
          textAnchor(a.x, a.y, a.size, {
            role: a.role,
            align: a.align,
            sample: a.sample,
            scale: s,
            dx: comp.anchorDx,
            dy: comp.anchorDy,
          })
        )
      : [],
    warnings,
  };
  if (fits) meta.fits = fits;
  if (comp.name) meta.name = String(comp.name);
  if (comp.kind) meta.kind = String(comp.kind);
  return meta;
}
