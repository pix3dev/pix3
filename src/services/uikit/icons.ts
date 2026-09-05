/**
 * UI Kit Forge — the vector glyphs: white shapes with a dark outline, drawn with the same
 * outline/shadow recipe as the captions so an icon and a word on one button match.
 *
 * Every path lives in a 24x24 box and is scaled to the requested size. Glyphs ship as their
 * OWN sprites: a host composes a backing and a glyph with two draws, so blank backings plus
 * loose glyphs beat baking one sprite per backing/icon pair.
 *
 * Ported from `src/dev/uikit/icons.js` — path data verbatim.
 */
import { DARK } from './ForgeTheme';
import { theme } from './build-context';

export interface IconStrokeOptions {
  sw?: number;
  fillMode?: boolean;
  color?: string;
}

/**
 * Stroke a set of 24x24 paths as a kit glyph at (cx, cy) with the given box size.
 *
 * The band and the drop are what the CAPTION wears (`svg-primitives: label`), in px,
 * converted into the 24x24 box — so an icon and a word on one button match whatever size
 * either is drawn at. Both used to be constants of the box (`txtOut*1.6`, `txtDrop*0.8`),
 * which made them proportional to the icon: a 48 px hex glyph carried a 1.45x heavier edge
 * than a 33 px button caption beside it.
 */
export function iconStroke(
  paths: readonly string[],
  cx: number,
  cy: number,
  size: number,
  { sw = 2.6, fillMode = false, color = '#ffffff' }: IconStrokeOptions = {}
): string {
  const t = theme();
  const k = size / 24;
  const band = t.txtOut / k;
  const drop = t.txtDrop / k;
  const inner = paths.map(d => `<path d="${d}"/>`).join('');
  // The dark layer is the WHITE one grown by the band on each side, so its width has to be
  // measured from the width the white is actually stroked with. Taking it from `sw` while a
  // filled glyph draws its white at sw*0.6 handed every filled icon (the gear, the star, the
  // home) an extra 0.2*sw of edge — 25 % on the gear.
  const mainW = fillMode ? Math.max(0.4, sw * 0.6) : sw;
  const darkW = mainW + band * 2;
  const dark = DARK();
  const darkA = fillMode
    ? `fill="${dark}" stroke="${dark}" stroke-width="${darkW}" stroke-linejoin="round" stroke-linecap="round"`
    : `fill="none" stroke="${dark}" stroke-width="${darkW}" stroke-linejoin="round" stroke-linecap="round"`;
  const mainA = fillMode
    ? `fill="${color}" stroke="${color}" stroke-width="${mainW}" stroke-linejoin="round" stroke-linecap="round"`
    : `fill="none" stroke="${color}" stroke-width="${mainW}" stroke-linejoin="round" stroke-linecap="round"`;
  let g = '';
  if (drop > 0.15) g += `<g ${darkA} transform="translate(0,${drop.toFixed(2)})">${inner}</g>`;
  g += `<g ${darkA}>${inner}</g><g ${mainA}>${inner}</g>`;
  return `<g transform="translate(${cx - 12 * k},${cy - 12 * k}) scale(${k})">${g}</g>`;
}

/** The gear is generated rather than hand-drawn: 8 teeth, an inner hole. */
function gearD(): string {
  const teeth = 8;
  const r1 = 10.5;
  const r2 = 7.6;
  const cx = 12;
  const cy = 12;
  let d = '';
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? r1 : r2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
  }
  d += 'Z M12,8.6 a3.4,3.4 0 1,0 0.001,0 Z';
  return d;
}

export interface IconDef {
  d: readonly string[];
  fill?: boolean;
  sw?: number;
}

export const ICONS: Readonly<Record<string, IconDef>> = {
  gear: { d: [gearD()], fill: true, sw: 1 },
  play: { d: ['M8.5 5.5 L18.5 12 L8.5 18.5 Z'], fill: true, sw: 1.5 },
  refresh: { d: ['M18.4 8.2 A7.4 7.4 0 1 0 19.4 12', 'M18.9 3.6 L18.9 8.6 L13.9 8.6'], sw: 3 },
  exit: { d: ['M13 4 H6 V20 H13', 'M11 12 H21', 'M17.6 8.4 L21 12 L17.6 15.6'], sw: 3 },
  trash: {
    d: [
      'M5.5 7 H18.5',
      'M9 7 V4.5 H15 V7',
      'M7 7 L8 20 H16 L17 7',
      'M10.5 10.5 V16.5',
      'M13.5 10.5 V16.5',
    ],
    sw: 2.6,
  },
  close: { d: ['M6.5 6.5 L17.5 17.5', 'M17.5 6.5 L6.5 17.5'], sw: 4 },
  left: { d: ['M14.5 5.5 L8 12 L14.5 18.5'], sw: 4.4 },
  right: { d: ['M9.5 5.5 L16 12 L9.5 18.5'], sw: 4.4 },
  plus: { d: ['M12 4.5 V19.5', 'M4.5 12 H19.5'], sw: 4.6 },
  lock: { d: ['M7 11 H17 V19 H7 Z', 'M9 11 V8 a3 3 0 0 1 6 0 V11'], sw: 2.8 },
  check: { d: ['M5 12.5 L10 17.5 L19 6.5'], sw: 4.6 },
  minus: { d: ['M5 12 H19'], sw: 4.6 },
  swords: {
    d: [
      'M4.5 4.5 L15 15 M15 15 L18 14 M15 15 L14 18',
      'M19.5 4.5 L9 15 M9 15 L6 14 M9 15 L10 18',
      'M17 17 L19.5 19.5',
      'M7 17 L4.5 19.5',
    ],
    sw: 2.6,
  },
  map: {
    d: [
      'M4 6 L9.3 4.2 L14.6 6 L20 4.2 V18 L14.6 19.8 L9.3 18 L4 19.8 Z',
      'M9.3 4.2 V18',
      'M14.6 6 V19.8',
    ],
    sw: 2,
  },
  bolt: { d: ['M13 2.5 L5.5 13.5 H11 L9.5 21.5 L18.5 9.5 H12.5 Z'], fill: true, sw: 1 },
  sound: {
    d: ['M5 9.5 H8.5 L13.5 5 V19 L8.5 14.5 H5 Z', 'M16.5 9 A5 5 0 0 1 16.5 15'],
    fill: false,
    sw: 2.4,
  },
  film: {
    d: [
      'M4 6 H20 V18 H4 Z',
      'M4 9.5 H20',
      'M8 6 L10 9.5',
      'M13 6 L15 9.5',
      'M18 6 L20 9.5',
      'M9.8 12 L14 14 L9.8 16 Z',
    ],
    sw: 2,
  },
  home: { d: ['M12 3.5 L20 10.5 V20 H14.5 V14.5 H9.5 V20 H4 V10.5 Z'], fill: true, sw: 1.4 },
  star: {
    d: [
      'M12 2.8 L14.7 8.4 L20.8 9.2 L16.3 13.5 L17.4 19.6 L12 16.6 L6.6 19.6 L7.7 13.5 L3.2 9.2 L9.3 8.4 Z',
    ],
    fill: true,
    sw: 1.2,
  },
  heart: {
    d: [
      'M12 20.2 C5 15 3.5 10.5 5.5 7.8 C7.2 5.5 10.3 5.8 12 8.3 C13.7 5.8 16.8 5.5 18.5 7.8 C20.5 10.5 19 15 12 20.2 Z',
    ],
    fill: true,
    sw: 1.2,
  },
  trophy: {
    d: [
      'M7 4 H17 V10 A5 5 0 0 1 7 10 Z',
      'M7 5.5 H4 V8 A3 3 0 0 0 7.5 10.8',
      'M17 5.5 H20 V8 A3 3 0 0 1 16.5 10.8',
      'M10.5 14 H13.5 V16.5 H10.5 Z',
      'M8 16.5 H16 V19.5 H8 Z',
    ],
    fill: true,
    sw: 1.4,
  },
  crown: {
    d: ['M4.5 8 L8.5 11 L12 5.5 L15.5 11 L19.5 8 L18 16 H6 Z', 'M6.5 18 H17.5 V20 H6.5 Z'],
    fill: true,
    sw: 1.2,
  },
  shield2: {
    d: ['M12 3 L19 5.8 V11 C19 15.8 12 20.6 12 20.6 C12 20.6 5 15.8 5 11 V5.8 Z'],
    fill: true,
    sw: 1.2,
  },
  cart: {
    d: [
      'M3.5 5.5 H6 L8.2 15 H17.5 L19.5 8 H7',
      'M9.5 17 a1.5 1.5 0 1 0 0.01 0',
      'M16 17 a1.5 1.5 0 1 0 0.01 0',
    ],
    sw: 2.4,
  },
  info: { d: ['M12 3.5 a8.5 8.5 0 1 0 0.01 0', 'M12 11 V16.5', 'M12 7.4 V7.9'], sw: 2.8 },
  question: {
    d: ['M12 3.5 a8.5 8.5 0 1 0 0.01 0', 'M9.4 9.4 A2.7 2.7 0 1 1 12 12.4 V13.6', 'M12 16.6 V17.1'],
    sw: 2.6,
  },
  bell: {
    d: [
      'M12 3.5 C8.8 3.5 7 6 7 9 V13 L5.2 16 H18.8 L17 13 V9 C17 6 15.2 3.5 12 3.5 Z',
      'M9.8 18 A2.2 2.2 0 0 0 14.2 18',
    ],
    fill: true,
    sw: 1.4,
  },
  chat: { d: ['M4 5 H20 V16 H12 L7.5 20 V16 H4 Z'], fill: true, sw: 1.4 },
  calendar: {
    d: ['M4.5 6.5 H19.5 V19.5 H4.5 Z', 'M4.5 10 H19.5', 'M8 4 V7.5', 'M16 4 V7.5'],
    sw: 2.4,
  },
  flag2: { d: ['M6.5 4 V20', 'M6.5 5 H17.5 L15.4 8.5 L17.5 12 H6.5'], sw: 2.6 },
  key: {
    d: [
      'M7.5 9.5 a3.5 3.5 0 1 0 0.01 0',
      'M10.8 13.2 L19.5 13.2',
      'M16.5 13.2 V16',
      'M19.5 13.2 V15.5',
    ],
    sw: 2.6,
  },
  search: { d: ['M10.5 4.5 a6 6 0 1 0 0.01 0', 'M15 15 L20 20'], sw: 3 },
  pause: { d: ['M7 5 H10.5 V19 H7 Z', 'M13.5 5 H17 V19 H13.5 Z'], fill: true, sw: 1.2 },
  share: {
    d: [
      'M17 3.6 a2.4 2.4 0 1 0 0.01 0',
      'M17 15.6 a2.4 2.4 0 1 0 0.01 0',
      'M6 9.6 a2.4 2.4 0 1 0 0.01 0',
      'M8.2 10.9 L14.9 7.1',
      'M8.2 13.1 L14.9 16.9',
    ],
    sw: 2.4,
  },
};

/** Every glyph name, in registration order. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

/**
 * Names a caller is likely to ask for that are not the ones the sheet registers.
 *
 * The sheet is drawn from shapes ("gear", "close"), while a caller — an agent asking for an
 * icon button, a template naming a role — thinks in FUNCTIONS ("settings", "back"). Resolving
 * the second into the first here keeps one glyph per shape instead of duplicating paths, and
 * keeps `icon()` strict about everything else.
 */
export const ICON_ALIASES: Readonly<Record<string, string>> = {
  settings: 'gear',
  options: 'gear',
  x: 'close',
  cross: 'close',
  cancel: 'close',
  tick: 'check',
  ok: 'check',
  add: 'plus',
  remove: 'minus',
  back: 'left',
  prev: 'left',
  next: 'right',
  forward: 'right',
};

/** The glyph a name stands for: itself when it is registered, its alias otherwise. */
export function resolveIconName(name: string): string {
  const key = String(name ?? '').trim();
  if (key in ICONS) return key;
  const alias = ICON_ALIASES[key.toLowerCase()];
  return alias && alias in ICONS ? alias : key;
}

export function icon(name: string, cx: number, cy: number, size: number, color?: string): string {
  const def = ICONS[resolveIconName(name)];
  if (!def) throw new Error(`UI Kit Forge: no such icon "${name}"`);
  return iconStroke(def.d, cx, cy, size, {
    sw: def.sw ?? 2.6,
    fillMode: !!def.fill,
    color: color || '#ffffff',
  });
}
