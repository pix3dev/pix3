/**
 * UI Kit Forge — bars, sliders and their engine-lane parts.
 *
 * Ported from `src/dev/uikit/components.js`. The `comp*Track` / `comp*Trough` / `comp*Fill`
 * / `comp*Thumb` generators at the bottom are new: they draw the same shapes at EXACTLY the
 * canvas size, which is the form a texture slot on `Bar2D` / `Slider2D` needs.
 */
import { adj } from '../color';
import { C, DARK, NAVY } from '../ForgeTheme';
import { theme } from '../build-context';
import { innerOf, label, recessRect, svgDoc, vGrad, type RawComponent } from '../svg-primitives';
import { compShield } from './badges';

export function compProgress(
  pct: number,
  text: unknown,
  colorId = 'yellow',
  w = 560,
  h = 64
): RawComponent {
  const t = theme();
  const c = C(colorId);
  let s = recessRect(0, 0, w, h, { r: t.radius * 0.8, fill: NAVY() });
  const pad = t.outline + 3;
  const fw = Math.max(0, ((w - pad * 2) * pct) / 100);
  if (fw > 6) {
    const g = vGrad(c);
    s += g.def;
    s += `<rect x="${pad}" y="${pad}" width="${fw}" height="${h - pad * 2}" rx="${t.radius * 0.55}" fill="${adj(c, { dl: -15 })}"/>`;
    s += `<rect x="${pad}" y="${pad}" width="${fw}" height="${h - pad * 2 - t.bevel * 0.7}" rx="${t.radius * 0.55}" fill="${g.fill}"/>`;
    if (t.glossOn) {
      s += `<rect x="${pad + 4}" y="${pad + 3}" width="${fw - 8}" height="${(h - pad * 2) * 0.3}" rx="${t.radius * 0.4}" fill="#fff" opacity="${t.glossA / 100}"/>`;
    }
  }
  if (text) s += label(w / 2, h / 2, text, h * 0.42, { bg: pct >= 50 ? c : null, role: 'value' });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compSegmentBar(
  filled: number,
  total: number,
  text: unknown,
  w = 460,
  h = 52
): RawComponent {
  const t = theme();
  const c = C('yellow');
  let s = recessRect(0, 0, w, h, { r: Math.min(10, t.radius * 0.5), fill: NAVY() });
  const pad = t.outline + 3;
  const gap = 3;
  const sw = (w - pad * 2 - gap * (total - 1)) / total;
  const g = vGrad(c);
  s += g.def;
  for (let i = 0; i < total; i++) {
    const x = pad + i * (sw + gap);
    if (i < filled) {
      s += `<rect x="${x}" y="${pad}" width="${sw}" height="${h - pad * 2}" rx="${Math.min(3, t.radius)}" fill="${adj(c, { dl: -15 })}"/>`;
      s += `<rect x="${x}" y="${pad}" width="${sw}" height="${h - pad * 2 - 4}" rx="${Math.min(3, t.radius)}" fill="${g.fill}"/>`;
    } else {
      s += `<rect x="${x}" y="${pad}" width="${sw}" height="${h - pad * 2}" rx="${Math.min(3, t.radius)}" fill="#000" opacity="0.28"/>`;
    }
  }
  if (text) s += label(w / 2, h / 2, text, h * 0.44, { role: 'value' });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compSlider(pct: number, w = 460, h = 70): RawComponent {
  const t = theme();
  const c = C('sky');
  const th = h * 0.42;
  const ty = (h - th) / 2;
  let s = recessRect(0, ty, w, th, { r: th / 2, fill: NAVY() });
  const pad = t.outline + 2;
  const fw = Math.max(th * 0.6, ((w - pad * 2) * pct) / 100);
  const g = vGrad(c);
  s += g.def;
  s += `<rect x="${pad}" y="${ty + pad * 0.8}" width="${fw}" height="${th - pad * 1.6}" rx="${(th - pad * 1.6) / 2}" fill="${g.fill}"/>`;
  const kx = pad + fw;
  const kr = h * 0.36;
  const gw = vGrad('#ffffff');
  s += gw.def;
  s += `<circle cx="${kx}" cy="${h / 2 + t.bevel * 0.4}" r="${kr}" fill="${adj('#ffffff', { dl: -22 })}" stroke="${DARK()}" stroke-width="${t.outline}"/>`;
  s += `<circle cx="${kx}" cy="${h / 2 - t.bevel * 0.15}" r="${kr}" fill="${gw.fill}" stroke="${DARK()}" stroke-width="${t.outline}"/>`;
  if (t.glossOn) {
    s += `<ellipse cx="${kx}" cy="${h / 2 - kr * 0.5}" rx="${kr * 0.6}" ry="${kr * 0.3}" fill="#fff" opacity="${t.glossA / 100 + 0.12}"/>`;
  }
  return { svg: svgDoc(w, h + 6, s), w, h: h + 6 };
}

export function compLevelBar(
  num: unknown,
  text: unknown,
  badgeColor: string,
  barColor: string,
  w = 430,
  h = 96
): RawComponent {
  const t = theme();
  const bh = h * 0.55;
  const by = (h - bh) / 2 + 4;
  const c = C(barColor);
  let s = `<rect x="${h * 0.4}" y="${by}" width="${w - h * 0.42 - t.outline}" height="${bh}" rx="${Math.min(t.radius, bh / 2)}" fill="${adj(c, { dl: -15 })}" stroke="${DARK()}" stroke-width="${t.outline}"/>`;
  const g = vGrad(c);
  s += g.def;
  s += `<rect x="${h * 0.4}" y="${by}" width="${w - h * 0.42 - t.outline}" height="${bh - t.bevel * 0.7}" rx="${Math.min(t.radius, bh / 2)}" fill="${g.fill}"/>`;
  if (t.glossOn) {
    s += `<rect x="${h * 0.46}" y="${by + 3}" width="${w - h * 0.52}" height="${bh * 0.28}" rx="${Math.min(t.radius * 0.6, bh * 0.2)}" fill="#fff" opacity="${t.glossA / 100}"/>`;
  }
  s += label((w + h * 0.4) / 2, by + bh / 2 - t.bevel * 0.2, text, bh * 0.5, {
    bg: c,
    role: 'value',
  });
  const badge = compShield(num, h * 0.92, badgeColor);
  s += `<g transform="translate(0,${(h - h * 0.92 * 1.08) / 2})">${innerOf(badge)}</g>`;
  return { svg: svgDoc(w, h, s), w, h };
}

// ---------------------------------------------------------------------------
// Engine-lane parts: exactly `w` x `h`, no captions, no decorative padding.
// ---------------------------------------------------------------------------

/** A bar's trough, filling the canvas — `Bar2D`'s background texture. */
export function compBarTrough(w: number, h: number): RawComponent {
  const t = theme();
  return { svg: svgDoc(w, h, recessRect(0, 0, w, h, { r: t.radius * 0.8, fill: NAVY() })), w, h };
}

/** A bar's fill, filling the canvas — `Bar2D`'s foreground texture. */
export function compBarFill(colorId: string, w: number, h: number): RawComponent {
  const t = theme();
  const c = C(colorId);
  const r = Math.min(t.radius * 0.55, h / 2);
  const g = vGrad(c);
  let s = g.def;
  s += `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="${adj(c, { dl: -15 })}"/>`;
  s += `<rect x="0" y="0" width="${w}" height="${Math.max(1, h - t.bevel * 0.7)}" rx="${r}" fill="${g.fill}"/>`;
  if (t.glossOn) {
    s += `<rect x="4" y="3" width="${Math.max(0, w - 8)}" height="${h * 0.3}" rx="${t.radius * 0.4}" fill="#fff" opacity="${t.glossA / 100}"/>`;
  }
  return { svg: svgDoc(w, h, s), w, h };
}

/** A slider's track, filling the canvas — a pill-shaped recess. */
export function compSliderTrack(w: number, h: number): RawComponent {
  return { svg: svgDoc(w, h, recessRect(0, 0, w, h, { r: h / 2, fill: NAVY() })), w, h };
}

/** A slider's thumb, filling the canvas — the white knob of {@link compSlider}. */
export function compSliderThumb(w: number, h: number): RawComponent {
  const t = theme();
  const ow = Math.max(1, t.outline);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.max(1, Math.min(w, h) / 2 - ow / 2);
  const g = vGrad('#ffffff');
  let s = g.def;
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${adj('#ffffff', { dl: -22 })}" stroke="${DARK()}" stroke-width="${ow}"/>`;
  s += `<circle cx="${cx}" cy="${cy - Math.min(t.bevel * 0.4, r * 0.2)}" r="${Math.max(1, r - Math.min(t.bevel * 0.4, r * 0.2))}" fill="${g.fill}"/>`;
  if (t.glossOn) {
    s += `<ellipse cx="${cx}" cy="${cy - r * 0.5}" rx="${r * 0.6}" ry="${r * 0.3}" fill="#fff" opacity="${t.glossA / 100 + 0.12}"/>`;
  }
  return { svg: svgDoc(w, h, s), w, h };
}
