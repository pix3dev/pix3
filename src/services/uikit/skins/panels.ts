/**
 * UI Kit Forge — panels, plates, slots, tab bars and ribbons.
 *
 * Ported from `src/dev/uikit/components.js`.
 *
 * A dialog is `compPanelBody` + `compHeaderPlate` — ONE shape split into two parts, not
 * three separate cards. `compPanel` bakes the title and the close button into a single
 * picture; it is kept for the preview and the docs, but the engine lane never ships it
 * (plan §3.3: a composite becomes a TEMPLATE — parts plus a layout — not one PNG).
 */
import { adj } from '../color';
import { C, DARK, NAVY, faceFor } from '../ForgeTheme';
import { icon } from '../icons';
import { isStrippingText, theme } from '../build-context';
import {
  bevelRect,
  escapeXml,
  glossFor,
  label,
  recessRect,
  svgDoc,
  vGrad,
  type RawComponent,
} from '../svg-primitives';

/** The outline width of the dialog parts: a panel is drawn a hair heavier than a button. */
function panelOutline(): number {
  return Math.max(2, theme().outline + 1);
}

/**
 * The corner radius of the dialog. The body and the header plate SHARE it: the plate sits on
 * the body's top corners, and a smaller radius there made it poke out past them.
 */
function panelRadius(): number {
  return Math.max(10, theme().radius * 1.6);
}

export function compPanelBody(colorId = 'sky', w = 420, h = 520): RawComponent {
  const t = theme();
  const c = C(colorId);
  const ow = panelOutline();
  const r = panelRadius();
  // The lip along the bottom is the same trick as on a button (`bevelRect`): a dark body with
  // the face laid on top, shorter by `lip`. It therefore FOLLOWS the bottom corners. It used
  // to be a floating strip with a 3 px gap under it and a 4.5 px radius of its own — at a
  // 25 px panel corner that read as a bar someone forgot to remove.
  const lip = Math.max(3, t.bevel);
  const g = vGrad(c);
  let ss = g.def;
  ss += `<rect x="${ow / 2}" y="${ow / 2}" width="${w - ow}" height="${h - ow}" rx="${r}" fill="${adj(c, { dl: -17, ds: -4 })}" stroke="${DARK()}" stroke-width="${ow}"/>`;
  // r - ow/2, not r - ow: the face has to be CONCENTRIC with the stroke's inner edge, or the
  // outline comes out thinner on the corners than on the straight edges (`bevelRect`).
  ss += `<rect x="${ow}" y="${ow}" width="${w - ow * 2}" height="${h - ow * 2 - lip}" rx="${Math.max(0, r - ow / 2)}" fill="${g.fill}"/>`;
  return { svg: svgDoc(w, h, ss), w, h };
}

/**
 * The header plate of a dialog: the title band that caps the panel body.
 *
 * Its BOTTOM edge is square and unstroked — the plate is not a free-standing card, it is the
 * top slice of the panel, and a rounded outlined bottom drew a second frame inside the
 * dialog. Top corners use `panelRadius()` so the plate nests into the body exactly.
 */
export function compHeaderPlate(title: unknown, colorId = 'sky', w = 420, h = 76): RawComponent {
  const base = C(colorId);
  const c = adj(base, { dl: -10, ds: 3 });
  const ow = panelOutline();
  const r = Math.min(panelRadius(), h - ow);
  const x0 = ow / 2;
  const x1 = w - ow / 2;
  const y0 = ow / 2;
  const y1 = h; // the bottom runs to the very edge: no gap
  const top =
    `M ${x0} ${y1} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0}` +
    ` L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1}`;
  let ss = `<path d="${top} Z" fill="${c}"/>`;
  ss += `<path d="${top}" fill="none" stroke="${DARK()}" stroke-width="${ow}"/>`;
  ss += label(w / 2, h / 2, title, h * 0.44, { bg: c, role: 'title' });
  return { svg: svgDoc(w, h, ss), w, h };
}

/** The whole window as one picture — preview and documentation only (see the file header). */
export function compPanel(title: unknown, w = 420, h = 300): RawComponent {
  const t = theme();
  let s = '';
  const g = vGrad(adj(NAVY(), { dl: 6 }));
  s += g.def;
  s += `<rect x="${t.outline / 2}" y="${t.outline / 2}" width="${w - t.outline}" height="${h - t.outline}" rx="${t.radius * 1.4}" fill="${g.fill}" stroke="${DARK()}" stroke-width="${t.outline}"/>`;
  s += `<rect x="${t.outline + 6}" y="${h * 0.2}" width="${w - t.outline * 2 - 12}" height="${h - h * 0.2 - t.outline - 8}" rx="${t.radius}" fill="#000" opacity="0.22"/>`;
  // the title plate
  const hw = w * 0.62;
  const hh = h * 0.17;
  s += bevelRect((w - hw) / 2, -2, hw, hh + 6, C('yellow'), {
    r: Math.min(t.radius, hh * 0.45),
    bevel: t.bevel * 0.7,
  });
  s += label(w / 2, hh * 0.5 + 2, title, hh * 0.62, { bg: C('yellow') });
  // the close button
  const cs = h * 0.155;
  s +=
    `<g transform="translate(${w - cs * 0.9},${-cs * 0.1})">` +
    bevelRect(0, 0, cs, cs, C('red'), {
      r: Math.min(t.radius * 0.7, cs * 0.3),
      bevel: t.bevel * 0.6,
    }) +
    icon('close', cs / 2, cs / 2 - t.bevel * 0.25, cs * 0.5) +
    '</g>';
  return {
    svg: svgDoc(w + 6, h + 4, `<g transform="translate(3,4)">${s}</g>`),
    w: w + 6,
    h: h + 4,
  };
}

/**
 * A bare recess — the well a progress bar or a grid sits in. Exported on its own because a
 * host draws it on its own, and it is the engine lane's `slot` part.
 */
export function compPanelSlot(w = 320, h = 56): RawComponent {
  const t = theme();
  return { svg: svgDoc(w, h, recessRect(0, 0, w, h, { r: Math.min(h / 2, t.radius) })), w, h };
}

export function compTabBar(
  labels: readonly string[],
  active: number,
  w = 520,
  h = 84
): RawComponent {
  const t = theme();
  const ow = Math.max(2, t.outline + 0.5);
  let s = `<rect x="${ow / 2}" y="${ow / 2}" width="${w - ow}" height="${h - ow}" rx="${t.radius * 1.2}" fill="${NAVY()}" stroke="${adj(NAVY(), { dl: 8 })}" stroke-width="${ow}"/>`;
  const cw = w / labels.length;
  labels.forEach((text, i) => {
    const cx = cw * i + cw / 2;
    if (i === active) {
      s += label(cx, h * 0.44, text, h * 0.32, { fill: '#ffffff' });
      s += `<rect x="${cx - cw * 0.26}" y="${h * 0.72}" width="${cw * 0.52}" height="${h * 0.085}" rx="${h * 0.042}" fill="#ffffff"/>`;
    } else if (!isStrippingText()) {
      const face = faceFor(text);
      s += `<text x="${cx}" y="${h * 0.47}" font-family="${escapeXml(face.stack)}" font-weight="${face.weight}" font-size="${h * 0.29}" text-anchor="middle" dominant-baseline="middle" fill="${adj(C('sky'), { dl: 6 })}" opacity="0.9">${escapeXml(text)}</text>`;
    }
  });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compRibbon(colorId: string, text: unknown, w = 460, h = 150): RawComponent {
  const t = theme();
  const c = C(colorId);
  const dark = adj(c, { dl: -13, ds: 2 });
  const darker = adj(c, { dl: -27, ds: -2 });
  const ow = Math.max(1.5, t.outline);
  const bandX = w * 0.13;
  const bandW = w - bandX * 2;
  const bandY = h * 0.14;
  const bandH = h * 0.5;
  const tailTop = bandY + bandH * 0.42;
  const tailH = bandH * 0.95;
  const notch = w * 0.055;
  const fold = w * 0.035;
  let s = '';
  // the tails with their V notch
  const L = `M ${w * 0.015} ${tailTop} L ${bandX + fold} ${tailTop} L ${bandX + fold} ${tailTop + tailH} L ${w * 0.015} ${tailTop + tailH} L ${w * 0.015 + notch} ${tailTop + tailH / 2} Z`;
  const R = `M ${w - w * 0.015} ${tailTop} L ${w - bandX - fold} ${tailTop} L ${w - bandX - fold} ${tailTop + tailH} L ${w - w * 0.015} ${tailTop + tailH} L ${w - w * 0.015 - notch} ${tailTop + tailH / 2} Z`;
  s += `<path d="${L}" fill="${dark}" stroke="${DARK()}" stroke-width="${ow}" stroke-linejoin="round"/>`;
  s += `<path d="${R}" fill="${dark}" stroke="${DARK()}" stroke-width="${ow}" stroke-linejoin="round"/>`;
  // the folds behind the central band
  s += `<path d="M ${bandX} ${bandY + bandH} L ${bandX + fold} ${bandY + bandH} L ${bandX + fold} ${tailTop + tailH} Z" fill="${darker}"/>`;
  s += `<path d="M ${w - bandX} ${bandY + bandH} L ${w - bandX - fold} ${bandY + bandH} L ${w - bandX - fold} ${tailTop + tailH} Z" fill="${darker}"/>`;
  // the central band
  const g = vGrad(c);
  s += g.def;
  const rr = Math.min(t.radius * 0.5, 8);
  s += `<rect x="${bandX}" y="${bandY}" width="${bandW}" height="${bandH}" rx="${rr}" fill="${g.fill}" stroke="${DARK()}" stroke-width="${ow}"/>`;
  if (t.glossOn) s += glossFor(bandX + ow, bandY + ow, bandW - ow * 2, bandH - ow * 2, rr);
  s += label(w / 2, bandY + bandH / 2, text, bandH * 0.46, { bg: c, role: 'title' });
  return { svg: svgDoc(w, h, s), w, h };
}
