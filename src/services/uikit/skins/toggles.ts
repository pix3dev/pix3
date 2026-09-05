/**
 * UI Kit Forge — switches, checkboxes, radios and the tick slider.
 *
 * Ported from `src/dev/uikit/components.js`. The `*Box` variants at the bottom are new:
 * they draw the same shapes at EXACTLY the canvas size, which is what the engine lane needs
 * (a `Checkbox2D` texture slot has no room for the source kit's decorative padding).
 */
import { adj } from '../color';
import { C, DARK, NAVY } from '../ForgeTheme';
import { icon } from '../icons';
import { svgDoc, vGrad, type RawComponent } from '../svg-primitives';
import { theme, uid } from '../build-context';

export function compToggle(on: boolean, w = 176, h = 96): RawComponent {
  const t = theme();
  // as in the reference: a squat pill track plus a large knob that overhangs it
  const trackC = on
    ? adj(C('yellow'), { dh: -7, ds: 6, dl: -3 })
    : adj(C('bluegray'), { dh: 18, ds: -8, dl: -2 });
  const knobC = on ? '#ffffff' : adj(C('bluegray'), { dh: 18, ds: -10, dl: 8 });
  const ow = Math.max(2, t.outline + 1);
  const kr = h * 0.42; // the knob is bigger than the track
  const th = h * 0.56;
  const tw = w - kr * 0.9;
  const tx = (w - tw) / 2;
  const ty = (h - th) / 2;
  let s = '';
  const gT = vGrad(trackC);
  s += gT.def;
  const track = `x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="${th / 2}"`;
  s += `<rect ${track} fill="${gT.fill}"/>`;
  // The shading in the trough is CLIPPED TO THE TRACK, so at the ends it takes the cap's
  // curve. It used to be a free rounded rect inset by 4 px: its square ends cut across the
  // round caps and the strip read as a sticker lying on the switch rather than as the inside
  // of it. Drawn before the stroke, so the rim stays crisp over it.
  const cid = uid('tgc');
  s += `<clipPath id="${cid}"><rect ${track}/></clipPath>`;
  s += `<rect x="${tx}" y="${ty + th * 0.58}" width="${tw}" height="${th * 0.42}" fill="#000" opacity="0.12" clip-path="url(#${cid})"/>`;
  s += `<rect ${track} fill="none" stroke="${DARK()}" stroke-width="${ow}"/>`;
  const kx = on ? tx + tw - th * 0.42 : tx + th * 0.42;
  const ky = h / 2;
  // The knob's lip is a fraction of the KNOB as well as of the theme's bevel: at a small
  // switch a flat `bevel*0.35` left a heavy dark crescent under a 13 px knob.
  const klip = Math.min(t.bevel * 0.35, kr * 0.06);
  const gK = vGrad(knobC);
  s += gK.def;
  s += `<circle cx="${kx}" cy="${ky}" r="${kr}" fill="${adj(knobC, { dl: -16 })}" stroke="${DARK()}" stroke-width="${ow}"/>`;
  s += `<circle cx="${kx}" cy="${ky - klip}" r="${Math.max(2, kr - klip)}" fill="${gK.fill}"/>`;
  if (t.glossOn) {
    s += `<ellipse cx="${kx}" cy="${ky - kr * 0.45}" rx="${kr * 0.55}" ry="${kr * 0.26}" fill="#fff" opacity="${t.glossA / 100 + 0.08}"/>`;
  }
  return { svg: svgDoc(w, h, s), w, h };
}

/** The dark checkbox box drawn to fill `w`x`h` exactly — the engine-lane shape. */
export function compCheckboxBox(w: number, h: number): RawComponent {
  const t = theme();
  const ow = Math.max(2, t.outline + 0.5);
  const s = `<rect x="${ow / 2}" y="${ow / 2}" width="${w - ow}" height="${h - ow}" rx="${t.radius * 1.1}" fill="${NAVY()}" stroke="${adj(NAVY(), { dl: 9 })}" stroke-width="${ow}"/>`;
  return { svg: svgDoc(w, h, s), w, h };
}

/** The bold tick drawn to fill `w`x`h` — the mark that goes ON a checkbox. */
export function compCheckMarkBox(w: number, h: number): RawComponent {
  const s = icon('check', w * 0.5, h * 0.46, Math.min(w, h) * 0.92, C('orange'));
  return { svg: svgDoc(w, h, s), w, h };
}

export function compCheckbox(on: boolean, size = 88): RawComponent {
  const t = theme();
  // a dark square; the tick is orange and breaks out past the top-right corner
  const pad = size * 0.2;
  const box = size - pad;
  const by = pad;
  const ow = Math.max(2, t.outline + 0.5);
  let s = `<rect x="${ow / 2}" y="${by + ow / 2}" width="${box - ow}" height="${box - ow}" rx="${t.radius * 1.1}" fill="${NAVY()}" stroke="${adj(NAVY(), { dl: 9 })}" stroke-width="${ow}"/>`;
  if (on) s += icon('check', box * 0.56, by + box * 0.32, box * 1.05, C('orange'));
  return { svg: svgDoc(size, size, s), w: size, h: size };
}

/** The bold tick on its own (as in the reference). */
export function compCheckMark(size = 88): RawComponent {
  return compCheckMarkBox(size, size);
}

export function compRadio(on: boolean, size = 80): RawComponent {
  const t = theme();
  const cx = size / 2;
  const r = size / 2 - 3;
  const ow = Math.max(2, t.outline + 0.5);
  let s = `<circle cx="${cx}" cy="${cx}" r="${r - ow / 2}" fill="${NAVY()}" stroke="${adj(NAVY(), { dl: 9 })}" stroke-width="${ow}"/>`;
  if (on) {
    const c = C('sky');
    const g = vGrad(c);
    s += g.def;
    const ir = r * 0.56;
    s += `<circle cx="${cx}" cy="${cx}" r="${ir}" fill="${adj(c, { dl: -15 })}" stroke="${DARK()}" stroke-width="${ow}"/>`;
    s += `<circle cx="${cx}" cy="${cx - t.bevel * 0.3}" r="${Math.max(2, ir - t.bevel * 0.3)}" fill="${g.fill}"/>`;
    if (t.glossOn) {
      s += `<ellipse cx="${cx}" cy="${cx - ir * 0.45}" rx="${ir * 0.55}" ry="${ir * 0.26}" fill="#fff" opacity="${t.glossA / 100 + 0.08}"/>`;
    }
  }
  return { svg: svgDoc(size, size, s), w: size, h: size };
}

export function compTickSlider(pct: number, w = 440, h = 100): RawComponent {
  const t = theme();
  // a slider of vertical ticks plus a white upright pill knob
  const n = 17;
  const m = 24;
  const ticksW = w - m * 2;
  const tw = Math.max(4, (ticksW / n) * 0.4);
  const gap = (ticksW - tw * n) / (n - 1);
  const th = h * 0.44;
  const ty = (h - th) / 2;
  const kxC = m + (ticksW * pct) / 100;
  const ow = Math.max(1.5, t.outline);
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = m + i * (tw + gap);
    const filled = x + tw / 2 < kxC;
    const c = filled ? adj(C('yellow'), { dh: -7, ds: 6, dl: -3 }) : adj(NAVY(), { dl: 10 });
    s += `<rect x="${x}" y="${ty}" width="${tw}" height="${th}" rx="${tw / 2}" fill="${c}" stroke="${DARK()}" stroke-width="${Math.min(2, ow)}"/>`;
  }
  const kw = h * 0.4;
  const kh = h * 0.88;
  const ky = (h - kh) / 2;
  const g = vGrad('#ffffff');
  s += g.def;
  s += `<rect x="${kxC - kw / 2}" y="${ky + t.bevel * 0.4}" width="${kw}" height="${kh - t.bevel * 0.4}" rx="${kw / 2}" fill="${adj('#ffffff', { dl: -20 })}" stroke="${DARK()}" stroke-width="${Math.max(2, ow + 0.5)}"/>`;
  s += `<rect x="${kxC - kw / 2}" y="${ky}" width="${kw}" height="${kh - t.bevel * 0.4}" rx="${kw / 2}" fill="${g.fill}" stroke="${DARK()}" stroke-width="${Math.max(2, ow + 0.5)}"/>`;
  const ah = 6;
  s += `<path d="M${kxC - kw * 0.14} ${h / 2 - ah} l${-ah} ${ah} l${ah} ${ah} M${kxC + kw * 0.14} ${h / 2 - ah} l${ah} ${ah} l${-ah} ${ah}" stroke="#9aa5bd" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return { svg: svgDoc(w, h, s), w, h };
}
