/**
 * UI Kit Forge — stars, shields, level hexes, the lock badge and the loose glyph card.
 *
 * Ported from `src/dev/uikit/components.js`.
 */
import { adj } from '../color';
import { C, DARK, NAVY } from '../ForgeTheme';
import { theme } from '../build-context';
import { icon } from '../icons';
import { bevelRect, label, roundedPoly, svgDoc, vGrad, type RawComponent } from '../svg-primitives';

/** The `d` of a five-pointed star centred on (cx, cy) with outer radius R. */
export function starPts(cx: number, cy: number, R: number): string {
  const r = R * 0.5;
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r : R;
    d +=
      (i ? 'L' : 'M') +
      (cx + Math.cos(a) * rr).toFixed(1) +
      ',' +
      (cy + Math.sin(a) * rr).toFixed(1);
  }
  return d + 'Z';
}

export function goldStar(cx: number, cy: number, R: number): string {
  const t = theme();
  const c = C('yellow');
  return (
    `<path d="${starPts(cx, cy, R)}" fill="${c}" stroke="${DARK()}" stroke-width="${Math.max(1.5, t.outline)}" stroke-linejoin="round"/>` +
    (t.glossOn
      ? `<ellipse cx="${cx - R * 0.22}" cy="${cy - R * 0.28}" rx="${R * 0.2}" ry="${R * 0.12}" fill="#fff" opacity="0.7"/>`
      : '')
  );
}

export function compStar(size = 96): RawComponent {
  return {
    svg: svgDoc(size, size, goldStar(size / 2, size / 2 + size * 0.04, size * 0.42)),
    w: size,
    h: size,
  };
}

export function compShield(num: unknown, size = 88, colorId = 'sky'): RawComponent {
  const t = theme();
  const c = C(colorId);
  const w = size;
  const h = size * 1.08;
  const pts: [number, number][] = [
    [w * 0.5, h * 0.02],
    [w * 0.93, h * 0.16],
    [w * 0.93, h * 0.55],
    [w * 0.5, h * 0.97],
    [w * 0.07, h * 0.55],
    [w * 0.07, h * 0.16],
  ];
  const cr = Math.min(7, t.radius * 0.45);
  const dark = adj(c, { dl: -17, ds: -4 });
  const g = vGrad(c);
  let s = g.def;
  s += roundedPoly(pts, dark, { cr });
  const face: [number, number][] = pts.map(p => [
    w / 2 + (p[0] - w / 2) * 0.9,
    h / 2 + (p[1] - h / 2) * 0.9 - t.bevel * 0.4,
  ]);
  s += roundedPoly(face, c, { cr: cr * 0.8, outline: false, fillOverride: g.fill });
  if (t.glossOn) {
    const gl = face.filter(p => p[1] < h * 0.55);
    if (gl.length > 2) {
      s += `<path d="M${gl.map(p => p.join(',')).join('L')}Z" fill="#fff" opacity="${t.glossA / 100}" stroke="#fff" stroke-width="${cr}" stroke-linejoin="round"/>`;
    }
  }
  s += label(w / 2, h * 0.47, String(num), size * 0.5, { bg: c, role: 'count' });
  return { svg: svgDoc(w, Math.ceil(h), s), w, h: Math.ceil(h) };
}

export type LevelHexState = 'done' | 'current' | 'locked';

export function compLevelHex(num: unknown, state: LevelHexState, size = 124): RawComponent {
  const t = theme();
  const col =
    state === 'done'
      ? C('green')
      : state === 'current'
        ? C('purple')
        : adj(C('gray'), { ds: -16, dl: -4 });
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 10;
  const hex = (rad: number, dy = 0): [number, number][] =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      return [cx + Math.cos(a) * rad, cy + dy + Math.sin(a) * rad] as [number, number];
    });
  const cr = Math.min(8, Math.max(2, t.radius * 0.5));
  let ss = '';
  if (state === 'current') {
    ss += `<path d="M${hex(R)
      .map(p => p.join(','))
      .join(
        'L'
      )}Z" fill="${col}" stroke="${col}" stroke-width="${cr * 2 + 14}" stroke-linejoin="round" opacity="0.35"/>`;
  }
  const dark = adj(col, { dl: -16, ds: -4 });
  const g = vGrad(col);
  ss += g.def;
  ss += roundedPoly(hex(R), dark, { cr });
  ss += roundedPoly(hex(R * 0.82, -t.bevel * 0.4), col, {
    cr: cr * 0.8,
    outline: false,
    fillOverride: g.fill,
  });
  const hasSub = state !== 'current';
  ss += label(cx, cy - (hasSub ? size * 0.07 : 0) - t.bevel * 0.3, String(num), size * 0.32, {
    bg: col,
    role: 'level',
  });
  if (state === 'locked') ss += icon('lock', cx, cy + size * 0.2, size * 0.22);
  if (state === 'done') {
    for (let i = -1; i <= 1; i++) {
      ss += goldStar(cx + i * size * 0.15, cy + size * 0.2 + (i === 0 ? 0 : 2), size * 0.08);
    }
  }
  return { svg: svgDoc(size, size, ss), w: size, h: size };
}

export function compLockBadge(size = 100): RawComponent {
  const c = NAVY();
  let s = bevelRect(0.5, 0.5, size - 1, size - 1, adj(c, { dl: 8 }), { gloss: false });
  s += icon('lock', size / 2, size * 0.42, size * 0.5);
  s += label(size / 2, size * 0.78, 'Lv.99', size * 0.2, { role: 'label' });
  return { svg: svgDoc(size, size, s), w: size, h: size };
}

export function compGlyph(name: string, size = 72): RawComponent {
  return { svg: svgDoc(size, size, icon(name, size / 2, size / 2, size * 0.8)), w: size, h: size };
}
