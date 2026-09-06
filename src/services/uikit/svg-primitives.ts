/**
 * UI Kit Forge — the SVG primitives every component is built from.
 *
 * One recipe per shape, all of them reading the build context's theme, so a slider move
 * repaints the whole kit with no plumbing. Nothing here knows about a host: no DOM, no
 * rasterization, no file system (plan §4).
 *
 * Ported from `src/dev/uikit/svg.js`.
 */
import { adj, lum } from './color';
import { DARK, LABEL_EDGE, faceFor, ink } from './ForgeTheme';
import { isStrippingText, pushAnchor, theme, uid } from './build-context';

/**
 * Escape text for an SVG document.
 *
 * Not cosmetic: captions can come from an agent or from a project's own strings, and the
 * jam-august `label()` interpolated them into `<text>` raw (plan §3.6). An unescaped `<`
 * either breaks the document or smuggles markup into it. `"` is escaped too so the same
 * function is safe for attribute values (a font family name, for instance).
 */
export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One generated component: its document and the size of its canvas. */
export interface RawComponent {
  svg: string;
  w: number;
  h: number;
}

/** The body of a component's document, without the `<svg>` wrapper — for nesting it. */
export function innerOf(comp: RawComponent): string {
  return comp.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
}

export function svgDoc(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
}

/** The `<defs>` fragment plus the paint value to use — a gradient, or a flat colour. */
export interface Paint {
  def: string;
  fill: string;
}

/** A vertical gradient: lighter at the top. */
export function vGrad(color: string): Paint {
  const t = theme();
  if (!t.gradOn) return { def: '', fill: color };
  const id = uid('g');
  const top = adj(color, { dl: +t.gradK * 0.9, ds: +3 });
  const bot = adj(color, { dl: -t.gradK * 0.35 });
  return {
    def:
      `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient>`,
    fill: `url(#${id})`,
  };
}

/**
 * The highlight, by type: strip / dome / corners. The area (x,y,w,h,r) is the button's FACE.
 *
 * The strip variant matters for slicing: it is a horizontal band pinned to the top of the
 * face, so a nine-slice must keep the whole band inside the top cap or stretching smears it
 * — see `slices.ts: sliceBorder()`.
 */
export function glossFor(x: number, y: number, w: number, h: number, r: number): string {
  const t = theme();
  const A = t.glossA / 100;
  if (t.glossType === 'dome') {
    const id = uid('gd');
    const gh = Math.max(6, h * (t.glossH / 100));
    return (
      `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="${Math.min(1, A * 1.5)}"/>` +
      `<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
      `<rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${gh}" rx="${Math.max(0, r - 2)}" fill="url(#${id})"/>`
    );
  }
  if (t.glossType === 'corner') {
    const rr = Math.min(w, h);
    const op = Math.min(1, A * 1.8);
    const bx = x + w - Math.max(r * 0.55, rr * 0.14);
    const by = y + Math.max(r * 0.5, rr * 0.16);
    const sx = x + Math.max(r * 0.55, rr * 0.11);
    const sy = y + Math.max(r * 0.45, rr * 0.14);
    return (
      `<ellipse cx="${bx}" cy="${by}" rx="${rr * 0.13}" ry="${rr * 0.08}" fill="#fff" opacity="${op}" transform="rotate(28 ${bx} ${by})"/>` +
      `<ellipse cx="${sx}" cy="${sy}" rx="${rr * 0.08}" ry="${rr * 0.05}" fill="#fff" opacity="${op * 0.75}" transform="rotate(-28 ${sx} ${sy})"/>`
    );
  }
  // strip
  const gp = Math.max(2, r * 0.45);
  const gh = (h * t.glossH) / 100;
  return `<rect x="${x + gp}" y="${y + gp * 0.7}" width="${w - gp * 2}" height="${Math.max(4, gh)}" rx="${Math.max(0, r - gp)}" fill="#ffffff" opacity="${A}"/>`;
}

/**
 * A "pillow": a rounded rectangle whose edges bulge outwards by k px. The corner arcs stay
 * ordinary, the middle of each edge is pushed out with a quadratic curve.
 */
export function pillowPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  k: number
): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const q = 2 * k; // control point: the bulge at the middle equals k
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hEdge = w - 2 * r > 0.5; // is there a straight run horizontally
  const vEdge = h - 2 * r > 0.5; // ...and vertically
  const p: string[] = [];
  p.push(`M ${x + r} ${y}`);
  p.push(hEdge ? `Q ${cx} ${y - q} ${x + w - r} ${y}` : `L ${x + w - r} ${y}`);
  p.push(r > 0 ? `A ${r} ${r} 0 0 1 ${x + w} ${y + r}` : `L ${x + w} ${y}`);
  p.push(vEdge ? `Q ${x + w + q} ${cy} ${x + w} ${y + h - r}` : `L ${x + w} ${y + h - r}`);
  p.push(r > 0 ? `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}` : `L ${x + w} ${y + h}`);
  p.push(hEdge ? `Q ${cx} ${y + h + q} ${x + r} ${y + h}` : `L ${x + r} ${y + h}`);
  p.push(r > 0 ? `A ${r} ${r} 0 0 1 ${x} ${y + h - r}` : `L ${x} ${y + h}`);
  p.push(vEdge ? `Q ${x - q} ${cy} ${x} ${y + r}` : `L ${x} ${y + r}`);
  p.push(r > 0 ? `A ${r} ${r} 0 0 1 ${x + r} ${y}` : `L ${x} ${y}`);
  p.push('Z');
  return p.join(' ');
}

export interface BevelRectOptions {
  r?: number | null;
  bevel?: number | null;
  gloss?: boolean;
  /**
   * Push the FACE down by this many px without moving the outer shell — the `pressed`
   * button state (plan §9.3). The outer geometry is untouched on purpose, so swapping a
   * state texture cannot make the button jump.
   */
  faceDy?: number;
  /**
   * Paint the face with this colour instead of `color`. The dark shell keeps `color`, which
   * is what makes `hover` (a lighter face) read as the same button rather than a new one.
   */
  faceColor?: string | null;
}

/**
 * The signature "puffy" rectangle: outline + a dark lip along the bottom + a face with a
 * gradient + the highlight.
 *
 * With `theme.skew > 0` the vertical edges lean (a parallelogram, as in Brawl Stars).
 * With `theme.puffy > 0` the edges bulge outwards and the button reads as inflated.
 */
export function bevelRect(
  x0: number,
  y: number,
  w0: number,
  h: number,
  color: string,
  { r = null, bevel = null, gloss = true, faceDy = 0, faceColor = null }: BevelRectOptions = {}
): string {
  const t = theme();
  const radius = r ?? t.radius;
  const lip = bevel ?? t.bevel;
  let x = x0;
  let w = w0;
  let pre = '';
  let post = '';
  const a = t.skew || 0;
  if (a > 0.1) {
    const tan = Math.tan((a * Math.PI) / 180);
    const inset = (tan * h) / 2;
    x += inset;
    w -= inset * 2; // squeeze so the lean stays inside the canvas
    const cy = y + h / 2;
    pre = `<g transform="matrix(1,0,${(-tan).toFixed(4)},1,${(tan * cy).toFixed(2)},0)">`;
    post = '</g>';
  }
  const ow = t.outline;
  const dark = adj(color, { dl: -17, ds: -4 });
  const face = faceColor ?? color;
  const g = vGrad(face);
  const pad = ow;
  // The face's corner radius makes the outline a RING OF EQUAL WIDTH all the way round.
  //
  // The outline is a stroke centred on a path inset by ow/2, so its inner edge is the same
  // rounded rect inset by `ow` with radius `radius - ow/2` — the two are CONCENTRIC. The
  // face used to take `radius - pad` (= radius - ow), i.e. a corner centre ow/2 further in,
  // and on the 45 degree diagonal it ate 0.21*ow of the stroke: the corners came out at 0.79
  // of the straight edges' thickness, which reads as a wobbly outline rather than a drawn one.
  const fr = Math.max(0, radius - ow / 2);
  const k = Math.min(t.puffy || 0, h * 0.14); // how far the edges bulge
  let s = g.def;
  if (k > 0.1) {
    // the geometry shrinks by k so the bulged edges stay inside the canvas
    const ox = x + k;
    const oy = y + k;
    const w2 = w - k * 2;
    const h2 = h - k * 2;
    s += `<path d="${pillowPath(ox + ow / 2, oy + ow / 2, w2 - ow, h2 - ow, radius, k)}" fill="${dark}" stroke="${DARK()}" stroke-width="${ow}"/>`;
    s += `<path d="${pillowPath(ox + pad, oy + pad + faceDy, w2 - pad * 2, h2 - pad * 2 - lip, fr, k * 0.9)}" fill="${g.fill}"/>`;
    if (gloss && t.glossOn) {
      s += glossFor(
        ox + pad + k * 0.4,
        oy + pad + faceDy,
        w2 - pad * 2 - k * 0.8,
        h2 - pad * 2 - lip,
        fr
      );
    }
  } else {
    const fh = h - pad * 2 - lip;
    s += `<rect x="${x + ow / 2}" y="${y + ow / 2}" width="${w - ow}" height="${h - ow}" rx="${radius}" fill="${dark}" stroke="${DARK()}" stroke-width="${ow}"/>`;
    s += `<rect x="${x + pad}" y="${y + pad + faceDy}" width="${w - pad * 2}" height="${fh}" rx="${fr}" fill="${g.fill}"/>`;
    if (gloss && t.glossOn) s += glossFor(x + pad, y + pad + faceDy, w - pad * 2, fh, fr);
  }
  return pre + s + post;
}

export interface RoundedPolyOptions {
  cr?: number;
  outline?: boolean;
  translate?: string;
  fillOverride?: string | null;
}

/** A polygon with rounded corners (a thick stroke with a round join). */
export function roundedPoly(
  pts: readonly (readonly [number, number])[],
  color: string,
  { cr = 6, outline = true, translate = '', fillOverride = null }: RoundedPolyOptions = {}
): string {
  const t = theme();
  const d = 'M' + pts.map(p => p[0] + ',' + p[1]).join('L') + 'Z';
  const ow = t.outline;
  let s = '';
  if (outline) {
    s += `<path d="${d}" fill="${DARK()}" stroke="${DARK()}" stroke-width="${(cr + ow) * 2}" stroke-linejoin="round" ${translate}/>`;
  }
  const fill = fillOverride || color;
  s += `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="${cr * 2}" stroke-linejoin="round" ${translate}/>`;
  return s;
}

export interface RecessRectOptions {
  r?: number | null;
  depth?: number | null;
  fill?: string | null;
}

/**
 * A recess: the inverse of {@link bevelRect} — a dark well sunk INTO a panel, with the light
 * rim along the bottom edge instead of the top.
 *
 * The primitive exists because a bar's trough and the field under a grid are inset shapes;
 * without it they were drawn ad hoc and never matched the rest of the kit.
 */
export function recessRect(
  x: number,
  y: number,
  w: number,
  h: number,
  { r = null, depth = null, fill = null }: RecessRectOptions = {}
): string {
  const t = theme();
  const radius = r ?? Math.min(h / 2, t.radius);
  const d = depth ?? Math.max(2, t.bevel * 0.6);
  const ow = Math.max(1, t.outline);
  let s = `<rect x="${x + ow / 2}" y="${y + ow / 2}" width="${w - ow}" height="${h - ow}" rx="${radius}" fill="${fill || DARK()}" stroke="${DARK()}" stroke-width="${ow}"/>`;
  // the shading that reads as depth: dark under the top edge, a light lip on the bottom one
  s += `<rect x="${x + ow}" y="${y + ow}" width="${w - ow * 2}" height="${d}" rx="${Math.max(0, radius - ow)}" fill="#000" opacity="0.28"/>`;
  s += `<rect x="${x + ow}" y="${y + h - ow - d * 0.8}" width="${w - ow * 2}" height="${d * 0.8}" rx="${Math.max(0, radius - ow)}" fill="#fff" opacity="0.07"/>`;
  return s;
}

// ---------------------------------------------------------------------------
// Text
//
// Two modes. In the preview the caption is drawn, so the design can be judged with real
// words in it. For the engine/atlas lane it is STRIPPED — the engine draws captions at
// runtime, and a baked word would be wrong in every other language and at every other count.
//
// Stripping used to lose information: an exported card arrived with a hole where its number
// belonged and nothing recorded where that was. So while stripping we COLLECT the anchors
// instead: position, size and alignment of every caption that was skipped.
// ---------------------------------------------------------------------------

/**
 * A conservative estimate of a caption's per-character advance, as a fraction of the font
 * size.
 *
 * The generators must run headlessly, so there is no `measureText` to lean on. Measured on
 * Nunito 900 with the strings the showcase actually uses, the per-character advance ran
 * 0.479…0.596 of the font size, averaging 0.526. `ADV` takes the upper end plus a hair, so
 * the estimate never UNDERSTATES the width: for layout a slightly roomy guess is harmless
 * and a slightly tight one is a collision.
 */
const ADV = 0.6;

export function estTextWidth(text: unknown, size: number, track?: number): number {
  const tr = track ?? theme().track;
  const n = String(text).length;
  if (!n) return 0;
  return n * size * ADV + Math.max(0, n - 1) * (tr > 0 ? tr : 0);
}

/**
 * The largest size at or below `size` at which `text` fits `maxW`, never below `min`.
 * Returns `size` unchanged when it already fits, so the common case costs nothing visually.
 */
export function fitTextSize(text: unknown, maxW: number, size: number, min = 14): number {
  const w = estTextWidth(text, size);
  if (w <= maxW || w <= 0) return size;
  return Math.max(min, Math.floor((size * maxW) / w));
}

export interface LabelOptions {
  fill?: string | null;
  /** The ground the caption sits on — decides the adaptive ink colour. */
  bg?: string | null;
  /** SVG `text-anchor`. */
  anchor?: 'start' | 'middle' | 'end';
  outScale?: number;
  /** Names the caption in the exported anchor list ('amount', 'price', 'level'…). */
  role?: string | null;
}

/**
 * A caption in the kit's style: a drop shadow, an outline and the fill.
 *
 * Dark text (`theme.txtColor === 'dark'`, or an explicitly dark fill) gets neither outline
 * nor shadow — on a light ground they would only muddy it.
 */
export function label(
  x: number,
  y: number,
  text: unknown,
  size: number,
  { fill = null, bg = null, anchor = 'middle', outScale = 1, role = null }: LabelOptions = {}
): string {
  const t = theme();
  if (isStrippingText()) {
    pushAnchor({ role, x, y, size, align: anchor, sample: String(text) });
    return '';
  }
  // The face is picked by the CAPTION: a Cyrillic one is drawn in the Cyrillic supplier at
  // ITS OWN weight, not in the primary's stack at the primary's weight (ForgeTheme: faceFor).
  const face = faceFor(text);
  const resolved = fill || ink(bg);
  const track = t.track > 0 ? ` letter-spacing="${t.track}"` : '';
  const body = escapeXml(text);
  const common =
    `x="${x}" y="${y}" font-family="${escapeXml(face.stack)}" font-weight="${face.weight}" ` +
    `font-size="${size}" text-anchor="${anchor}" dominant-baseline="middle"${track}`;
  if (lum(resolved) < 45) {
    return `<text ${common} fill="${resolved}">${body}</text>`;
  }
  // ABSOLUTE, not scaled by the caption's size. `txtOut` is the visible dark band outside
  // the letter (the stroke is centred on the glyph, so the SVG width is twice it), and a
  // sticker outline is a constant of the kit: a 48 px hex icon and a 33 px button caption
  // standing side by side must wear the same edge, or the bigger element reads as drawn in
  // a heavier hand. The same number, converted into the 24x24 box, is what `icons.ts`
  // strokes its glyphs with.
  const ow = t.txtOut * outScale;
  const drop = t.txtDrop;
  const edge = LABEL_EDGE();
  let s = '';
  if (drop > 0.2) {
    s += `<text ${common} transform="translate(0,${drop.toFixed(1)})" fill="${edge}" stroke="${edge}" stroke-width="${ow * 2}" stroke-linejoin="round" paint-order="stroke">${body}</text>`;
  }
  s += `<text ${common} fill="${resolved}" stroke="${edge}" stroke-width="${ow * 2}" stroke-linejoin="round" paint-order="stroke">${body}</text>`;
  return s;
}
