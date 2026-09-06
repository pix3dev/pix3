/**
 * UI Kit Forge — offer / day cards and the resource counter.
 *
 * Ported from `src/dev/uikit/components.js`. The counter is a COMPOSITE (a "+" button, a
 * value and a coin in one picture) — kept for the preview and the docs; the engine lane
 * assembles it from parts instead (plan §3.3).
 */
import { adj } from '../color';
import { C, DARK, NAVY, ink } from '../ForgeTheme';
import { theme } from '../build-context';
import { ICONS, icon } from '../icons';
import { bevelRect, label, roundedPoly, svgDoc, vGrad, type RawComponent } from '../svg-primitives';

export type ResourceKind = 'coin' | 'gem';

/** A resource icon (coin / gem) for the offer and day cards. */
export function resIcon(kind: ResourceKind, cx: number, cy: number, r: number): string {
  const t = theme();
  if (kind === 'coin') {
    const c = C('yellow');
    const g = vGrad(c);
    return (
      g.def +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${g.fill}" stroke="${DARK()}" stroke-width="${Math.max(1.5, t.outline)}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="none" stroke="${adj(c, { dl: -18 })}" stroke-width="${r * 0.16}"/>` +
      (t.glossOn
        ? `<ellipse cx="${cx - r * 0.2}" cy="${cy - r * 0.4}" rx="${r * 0.38}" ry="${r * 0.2}" fill="#fff" opacity="0.55"/>`
        : '')
    );
  }
  const c = C('purple');
  const pts: [number, number][] = [
    [cx, cy - r],
    [cx + r * 0.95, cy - r * 0.15],
    [cx, cy + r],
    [cx - r * 0.95, cy - r * 0.15],
  ];
  const g = vGrad(adj(c, { dl: 8, ds: 6 }));
  return (
    g.def +
    roundedPoly(pts, c, { cr: 2.5, fillOverride: g.fill }) +
    `<path d="M${cx - r * 0.4},${cy - r * 0.35} L${cx},${cy - r * 0.7} L${cx + r * 0.15},${cy - r * 0.25} Z" fill="#fff" opacity="0.55"/>`
  );
}

export function compResourceCounter(
  colorId: string,
  iconName: string,
  value: unknown,
  w = 310,
  h = 64
): RawComponent {
  const t = theme();
  const c = C(colorId);
  let s = `<rect x="${t.outline / 2}" y="${h * 0.08}" width="${w - h * 0.35}" height="${h * 0.84}" rx="${Math.min(t.radius * 0.7, h * 0.35)}" fill="${NAVY()}" stroke="${DARK()}" stroke-width="${t.outline}" opacity="0.96"/>`;
  // the "+" button
  const bs = h * 0.7;
  const bx = h * 0.14;
  const by2 = (h - bs) / 2;
  s += bevelRect(bx, by2, bs, bs, c, {
    r: Math.min(t.radius * 0.6, bs * 0.3),
    bevel: t.bevel * 0.6,
  });
  s += icon('plus', bx + bs / 2, by2 + bs / 2 - t.bevel * 0.25, bs * 0.55, ink(c));
  // the value
  s += label((w - h * 0.3) / 2 + h * 0.15, h / 2, value, h * 0.42, { role: 'value' });
  // the resource icon on the right
  const ix = w - h * 0.42;
  const iy = h / 2;
  const ir = h * 0.36;
  if (iconName === 'coin' || iconName === 'gem') {
    s += resIcon(iconName, ix, iy, ir);
  } else {
    s += icon(iconName, ix, iy, ir * 2.1, ICONS[iconName]?.fill ? C(colorId) : '#ffffff');
  }
  return { svg: svgDoc(w, h, s), w, h };
}

export function compOfferCard(
  kind: ResourceKind,
  amount: unknown,
  price: unknown,
  w = 150,
  h = 190
): RawComponent {
  const t = theme();
  const cardBg = '#f5eedd';
  let ss = bevelRect(0.5, 0.5, w - 1, h - 1, cardBg, { gloss: false });
  ss += resIcon(kind, w / 2, h * 0.3, w * 0.19);
  ss += label(w / 2, h * 0.55, amount, w * 0.135, { bg: cardBg, role: 'amount' });
  ss += bevelRect(w * 0.09, h * 0.68, w * 0.82, h * 0.23, C('green'), {
    r: Math.min(t.radius, 10),
    bevel: t.bevel * 0.6,
  });
  ss += label(w / 2, h * 0.68 + h * 0.115 - t.bevel * 0.2, price, h * 0.1, {
    bg: C('green'),
    role: 'price',
  });
  return { svg: svgDoc(w, h, ss), w, h };
}

export type DayCardState = 'done' | 'reward' | 'mystery';

export function compDayCard(state: DayCardState, day: unknown, w = 124, h = 150): RawComponent {
  const t = theme();
  const col =
    state === 'done' ? adj(C('gray'), { dl: 4 }) : state === 'reward' ? C('green') : C('orange');
  let ss = bevelRect(0.5, 0.5, w - 1, h - 1, col, {
    r: Math.min(t.radius, 12),
    bevel: t.bevel * 0.8,
  });
  ss += label(w / 2, h * 0.15, day, h * 0.13, { bg: col, role: 'day' });
  const ix = w * 0.12;
  const iy = h * 0.27;
  const iw = w * 0.76;
  const ih = h * 0.6;
  ss += `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="${Math.min(t.radius, 8)}" fill="${state === 'mystery' ? adj(col, { dl: 8 }) : '#f7f2e4'}" stroke="${DARK()}" stroke-width="${Math.max(1, t.outline * 0.7)}"/>`;
  if (state === 'done') {
    ss += icon('check', w / 2, iy + ih / 2, iw * 0.55, C('green'));
  } else if (state === 'reward') {
    ss += resIcon('coin', w / 2, iy + ih * 0.4, iw * 0.2);
    ss += label(w / 2, iy + ih * 0.78, '500', h * 0.12, { fill: DARK(), role: 'amount' });
  } else {
    ss += label(w / 2, iy + ih / 2, '?', h * 0.22, { fill: adj(col, { dl: -20 }) });
  }
  return { svg: svgDoc(w, h, ss), w, h };
}
