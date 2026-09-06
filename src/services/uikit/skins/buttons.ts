/**
 * UI Kit Forge — button generators.
 *
 * One function per element, each returning `{ svg, w, h }`. They are the only place that
 * knows a component's proportions; the theme decides how it LOOKS. That split is what lets
 * one slider repaint the whole kit.
 *
 * Ported from `src/dev/uikit/components.js`, plus the four button STATES the plan adds
 * (§9.3) — the kit is allowed to run ahead of the runtime here.
 */
import { adj, lum } from '../color';
import { C, ink } from '../ForgeTheme';
import { theme } from '../build-context';
import { icon } from '../icons';
import {
  bevelRect,
  fitTextSize,
  label,
  roundedPoly,
  svgDoc,
  vGrad,
  type RawComponent,
} from '../svg-primitives';

/**
 * The four states a `Button2D` can swap textures between.
 *
 * They share IDENTICAL outer geometry on purpose: the outer shell of {@link bevelRect} is
 * drawn from the same rect in every state, so a texture swap cannot make the button jump.
 * Only the face colour, the face's vertical offset and the ink change.
 */
export type ButtonSkinState = 'normal' | 'hover' | 'pressed' | 'disabled';

export interface ButtonStateStyle {
  /** The colour the dark shell and the outline are derived from. */
  shell: string;
  /** The colour of the face (and of its gradient). */
  face: string;
  /** The caption / glyph colour. */
  ink: string;
  /** How far the face is pushed down — `bevel` for `pressed`, so the lip disappears. */
  faceDy: number;
}

/** Resolve one button state into the colours and the face offset that express it. */
export function buttonStateStyle(
  base: string,
  state: ButtonSkinState = 'normal'
): ButtonStateStyle {
  const t = theme();
  if (state === 'hover') {
    const face = adj(base, { dl: +6 });
    return { shell: base, face, ink: ink(face), faceDy: 0 };
  }
  if (state === 'pressed') {
    // The face drops by the whole bevel, so the lip under it goes to 0 and the button reads
    // as pushed in. The shell — and therefore the silhouette — is untouched.
    return { shell: base, face: base, ink: ink(base), faceDy: t.bevel };
  }
  if (state === 'disabled') {
    const flat = adj(base, { ds: -35, dl: -6 });
    const normal = ink(flat);
    // "Muted" means LESS CONTRAST, so the ink moves towards the face rather than always
    // darker: a dark ink on a light face would otherwise get stronger, not weaker.
    const dir = lum(flat) > lum(normal) ? 1 : -1;
    return { shell: flat, face: flat, ink: adj(normal, { ds: -10, dl: dir * 18 }), faceDy: 0 };
  }
  return { shell: base, face: base, ink: ink(base), faceDy: 0 };
}

export interface ButtonOptions {
  state?: ButtonSkinState;
}

export function compButton(
  colorId: string,
  text: unknown,
  w = 250,
  h = 88,
  { state = 'normal' }: ButtonOptions = {}
): RawComponent {
  const t = theme();
  const st = buttonStateStyle(C(colorId), state);
  let s = bevelRect(0.5, 0.5, w - 1, h - 1, st.shell, { faceColor: st.face, faceDy: st.faceDy });
  s += label(w / 2, h / 2 - t.bevel / 3 + st.faceDy, text, h * 0.38, {
    fill: st.ink,
    role: 'label',
  });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compBannerButton(colorId: string, text: unknown, w = 250, h = 88): RawComponent {
  const t = theme();
  const c = C(colorId);
  const n = h * 0.28;
  const cr = Math.min(10, t.radius * 0.6);
  const pts: [number, number][] = (
    [
      [n, 0],
      [w - n, 0],
      [w, h / 2],
      [w - n, h],
      [n, h],
      [0, h / 2],
    ] as [number, number][]
  ).map(p => [
    p[0] === 0 ? cr + t.outline : p[0] === w ? w - cr - t.outline : p[0],
    p[1] === 0 ? cr + t.outline : p[1] === h ? h - cr - t.outline : p[1] === h / 2 ? h / 2 : p[1],
  ]);
  const dark = adj(c, { dl: -17, ds: -4 });
  const g = vGrad(c);
  let s = g.def;
  s += roundedPoly(pts, dark, { cr });
  // the face: the same polygon, pulled in from the bottom by `bevel`
  const face: [number, number][] = pts.map(p => [p[0], p[1] > h / 2 ? p[1] - t.bevel : p[1]]);
  s += roundedPoly(face, c, { cr: cr * 0.9, outline: false, fillOverride: g.fill });
  if (t.glossOn) {
    const gpts = face.map(p => [
      p[0] * 0.98 + w * 0.01,
      p[1] <= h / 2 ? p[1] + cr * 0.4 : h * 0.44,
    ]);
    s += `<path d="M${gpts.map(p => p.join(',')).join('L')}Z" fill="#fff" opacity="${t.glossA / 100}" stroke="#fff" stroke-width="${cr}" stroke-linejoin="round"/>`;
  }
  // The caption lives between the NOTCHES, not inside the rect: the sides cut in by `n`, so
  // a word measured against `w` runs into the arrow tips. Cap at h*0.36, shrink to the flat
  // middle when it must.
  s += label(w / 2, h / 2 - t.bevel / 3, text, fitTextSize(text, w - n * 2 - cr * 2, h * 0.36), {
    bg: c,
    role: 'label',
  });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compHexButton(colorId: string, iconName: string, size = 110): RawComponent {
  const t = theme();
  const c = C(colorId);
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - t.outline - 8;
  const cr = Math.min(9, t.radius * 0.55);
  const hex = (a0: number): [number, number][] =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 + a0;
      return [cx + Math.cos(a) * R, cy + Math.sin(a) * R] as [number, number];
    });
  const pts = hex(-Math.PI / 2);
  const dark = adj(c, { dl: -17, ds: -4 });
  const g = vGrad(c);
  let s = g.def;
  s += roundedPoly(pts, dark, { cr });
  const face: [number, number][] = pts.map(p => [
    cx + (p[0] - cx) * 0.94,
    cy + (p[1] - cy) * 0.94 - t.bevel * 0.55,
  ]);
  s += roundedPoly(face, c, { cr: cr * 0.85, outline: false, fillOverride: g.fill });
  if (t.glossOn) {
    const gl = face.map(p => [
      cx + (p[0] - cx) * 0.8,
      p[1] < cy ? cy + (p[1] - cy) * 0.85 : cy * 0.92,
    ]);
    s += `<path d="M${gl.map(p => p.join(',')).join('L')}Z" fill="#fff" opacity="${t.glossA / 100}" stroke="#fff" stroke-width="${cr}" stroke-linejoin="round"/>`;
  }
  s += icon(iconName, cx, cy - t.bevel * 0.4, size * 0.44, ink(c));
  return { svg: svgDoc(size, size, s), w: size, h: size };
}

/**
 * A glyph button at an arbitrary size — {@link compSquareIcon} with the four button STATES and
 * a free aspect ratio.
 *
 * The glyph is sized against the SHORTER side so a wide bar-style icon button keeps a round
 * glyph, and it rides the face: in the `pressed` state it drops with the face by the whole
 * bevel, exactly as a caption does, so a state swap reads as one movement.
 */
export function compIconButton(
  colorId: string,
  iconName: string,
  w = 92,
  h = 92,
  { state = 'normal' }: ButtonOptions = {}
): RawComponent {
  const t = theme();
  const st = buttonStateStyle(C(colorId), state);
  let s = bevelRect(0.5, 0.5, w - 1, h - 1, st.shell, { faceColor: st.face, faceDy: st.faceDy });
  s += icon(iconName, w / 2, h / 2 - t.bevel / 3 + st.faceDy, Math.min(w, h) * 0.5, st.ink);
  return { svg: svgDoc(w, h, s), w, h };
}

export function compSquareIcon(colorId: string, iconName: string, size = 92): RawComponent {
  const t = theme();
  const c = C(colorId);
  let s = bevelRect(0.5, 0.5, size - 1, size - 1, c);
  s += icon(iconName, size / 2, size / 2 - t.bevel / 3, size * 0.5, ink(c));
  return { svg: svgDoc(size, size, s), w: size, h: size };
}

export function compBigButton(
  colorId: string,
  iconName: string,
  text: unknown,
  w = 300,
  h = 120
): RawComponent {
  const t = theme();
  const c = C(colorId);
  let s = bevelRect(0.5, 0.5, w - 1, h - 1, c, { r: t.radius * 1.3 });
  s += icon(iconName, w * 0.22, h / 2 - t.bevel / 3, h * 0.52, ink(c));
  s += label(w * 0.6, h / 2 - t.bevel / 3, text, h * 0.34, { bg: c, role: 'label' });
  return { svg: svgDoc(w, h, s), w, h };
}

/**
 * A button with a glyph on the left and a caption beside it.
 *
 * The caption is sized against the room the icon LEAVES, not against the button: at h*0.36 a
 * two-word label grew under the glyph and touched the right edge. The cap is h*0.30 and
 * `fitTextSize` shrinks it further when the words are long, and the text is centred in that
 * free box rather than at a fixed 0.6*w.
 */
export function compIconTextButton(
  colorId: string,
  iconName: string,
  text: unknown,
  w = 260,
  h = 86
): RawComponent {
  const t = theme();
  const c = C(colorId);
  const ic = h * 0.46; // glyph box
  const icx = h * 0.55; // its centre
  const boxX = icx + ic / 2 + h * 0.1; // where the caption may start
  const boxW = Math.max(h * 0.5, w - boxX - h * 0.14);
  let s = bevelRect(0.5, 0.5, w - 1, h - 1, c);
  s += icon(iconName, icx, h / 2 - t.bevel / 3, ic, ink(c));
  s += label(boxX + boxW / 2, h / 2 - t.bevel / 3, text, fitTextSize(text, boxW, h * 0.3), {
    bg: c,
    role: 'label',
  });
  return { svg: svgDoc(w, h, s), w, h };
}

export function compPlate(colorId: string, text: unknown, w = 170, h = 52): RawComponent {
  const t = theme();
  const c = C(colorId);
  let s = bevelRect(0.5, 0.5, w - 1, h - 1, c, { bevel: t.bevel * 0.6 });
  s += label(w / 2, h / 2 - t.bevel * 0.2, text, h * 0.42, { bg: c, role: 'label' });
  return { svg: svgDoc(w, h, s), w, h };
}
