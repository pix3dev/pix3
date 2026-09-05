/**
 * UI Kit Forge — the showcase: whole screens assembled from the very components that live in
 * the other tabs.
 *
 * Why screens and not just a grid of parts: a row of loose buttons cannot answer whether the
 * style HOLDS. A screen can — it shows the parts at their real sizes, next to each other, on
 * a background, with captions in them. Move a slider and all six screens repaint, so a change
 * of theme is judged on layouts rather than on swatches.
 *
 * The screens are marked `noExport` in the registry: they are a specification, not sprites.
 * Their bricks are exported as separate components instead — and the settings screen is the
 * layout `TemplateSpec.ts` derives its dialog from (plan §3.3, §5).
 *
 * Ported from `src/dev/uikit/showcase.js`.
 */
import { adj } from './color';
import { C, DARK } from './ForgeTheme';
import { theme, uid } from './build-context';
import {
  bevelRect,
  fitTextSize,
  innerOf,
  label,
  svgDoc,
  type RawComponent,
} from './svg-primitives';
import { tx } from './strings';
import {
  compBannerButton,
  compButton,
  compDayCard,
  compHeaderPlate,
  compHexButton,
  compIconTextButton,
  compLevelHex,
  compOfferCard,
  compPanelBody,
  compPlate,
  compResourceCounter,
  compRibbon,
  compSquareIcon,
  compStar,
  compTickSlider,
  compToggle,
  goldStar,
  shadowDef,
} from './skins';

export { innerOf };

/**
 * Drop one component onto a screen at (x, y).
 *
 * The theme's drop shadow is applied HERE. A component generator returns a bare body — the
 * shadow is post-processing, and outside the showcase it comes from `withShadow()`, which
 * also pads the canvas. Padding is wrong on a screen (positions are fixed, everything would
 * shift by `theme.pad`), so the screen uses the same filter with no padding: the filter
 * region is relative to the element's bounding box, and the screen SVG has room around it.
 *
 * Without this the showcase drew every button flat while the component cards next to it had
 * shadows — the same kit looking like two kits.
 */
export function place(comp: RawComponent, x: number, y: number, sc = 1): string {
  const sh = shadowDef();
  return `${sh.def}<g${sh.attr} transform="translate(${x},${y})${sc !== 1 ? ` scale(${sc})` : ''}">${innerOf(comp)}</g>`;
}

export function screenDoc(w: number, h: number, body: string): RawComponent {
  const id = uid('scr');
  const bg =
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0c5da6"/><stop offset="1" stop-color="#083a6b"/></linearGradient>` +
    `<rect width="${w}" height="${h}" rx="18" fill="url(#${id})"/>`;
  return { svg: svgDoc(w, h, bg + body), w, h };
}

export function scShop(): RawComponent {
  const w = 430;
  const h = 760;
  let b = '';
  b += place(compResourceCounter('orange', 'coin', '834', 190, 44), 14, 16);
  b += place(compResourceCounter('purple', 'gem', '120', 166, 44), 218, 16);
  b += place(compRibbon('orange', tx('shop_title'), 300, 104), (w - 300) / 2, 54);
  b += place(compSquareIcon('red', 'close', 58), w - 70, 66);
  b += place(compPanelBody('sky', w - 28, 560), 14, 164);
  const cw = 122;
  (
    [
      ['coin', 'x500', '0.99$'],
      ['coin', 'x1200', '1.99$'],
      ['gem', 'x50', '4.99$'],
    ] as const
  ).forEach((t, i) => {
    b += place(compOfferCard(t[0], t[1], t[2], cw, 170), 26 + i * (cw + 7), 204);
  });
  let sp = bevelRect(0.5, 0.5, w - 84, 118, C('purple'));
  sp += label((w - 84) / 2, 44, tx('shop_pack'), 34, { bg: C('purple') });
  sp += label((w - 84) / 2, 84, '4.99$', 26, { bg: C('purple') });
  b += place({ svg: svgDoc(w - 82, 120, sp), w: w - 82, h: 120 }, 42, 404);
  b += place(compButton('green', tx('shop_buy'), 210, 78), (w - 210) / 2, 566);
  return screenDoc(w, h, b);
}

export function scMap(): RawComponent {
  const w = 430;
  const h = 790;
  const seg = (x1: number, y1: number, x2: number, y2: number, col: string): string =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${DARK()}" stroke-width="20" stroke-linecap="round"/>` +
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="13" stroke-linecap="round"/>`;
  const gold = C('yellow');
  const gr = adj(C('bluegray'), { dl: -6 });
  let b = '';
  b += seg(330, 720, 320, 650, gold);
  b += seg(320, 630, 195, 515, gold);
  b += seg(195, 495, 258, 385, gold);
  b += seg(258, 365, 322, 255, gr);
  b += seg(322, 235, 195, 120, gr);
  b += place(compLevelHex(47, 'done', 118), 262, 580);
  b += place(compLevelHex(48, 'done', 118), 136, 458);
  b += place(compLevelHex(49, 'current', 130), 192, 320);
  b += place(compLevelHex(50, 'locked', 118), 262, 196);
  b += place(compPlate('red', tx('map_hard'), 148, 42), 250, 308);
  b += place(compLevelHex(51, 'locked', 118), 136, 58);
  b += place(compHexButton('blue', 'gear', 74), 10, 8);
  b += place(compResourceCounter('red', 'heart', '5', 148, 44), 96, 20);
  b += place(compResourceCounter('orange', 'coin', '755', 164, 44), 252, 20);
  b += place(compButton('yellow', tx('map_play'), 228, 86), (w - 228) / 2, 682);
  b += place(compSquareIcon('yellow', 'trophy', 76), 22, 688);
  b += place(compSquareIcon('sky', 'cart', 76), w - 22 - 76, 688);
  return screenDoc(w, h, b);
}

/**
 * The settings row: [icon] [label ......] [control], the control pinned to the panel's right
 * edge and the label given exactly the gap that is left.
 *
 * It used to be four hardcoded x values, and the longest label ran straight under the toggle.
 * Deriving the control's x from the panel edge and the label's box from what remains means a
 * longer word cannot collide with anything; `fitTextSize` shrinks it only if it still would
 * not fit.
 *
 * These numbers are also the layout `buildTemplate('settings')` reproduces as nodes.
 */
export const SETTINGS_ROW = {
  /** panel inner padding */
  padX: 22,
  icon: 46,
  gap: 12,
  /** the size the tutorial captions use as well */
  label: 23,
  slider: 168,
  toggle: 112,
  step: 80,
} as const;

/** The width the showcase draws its screens at — and the default dialog width. */
export const SCREEN_W = 430;

export interface SettingsRow {
  icon: string;
  label: string;
  ctrl?: 'slider' | 'toggle';
}

export interface SettingsButton {
  col: string;
  icon: string;
  t: string;
}

export function scSettingsBase(
  panelColor: string,
  rows: readonly SettingsRow[],
  btnPairs: readonly (readonly [SettingsButton, SettingsButton])[],
  wideBtns: readonly SettingsButton[],
  h: number
): RawComponent {
  const w = SCREEN_W;
  const R = SETTINGS_ROW;
  const c = C(panelColor);
  let b = '';
  b += place(compPanelBody(panelColor, w - 32, h - 72), 16, 38);
  b += place(compHeaderPlate(tx('set_title'), panelColor, w - 32, 70), 16, 38);
  b += place(compSquareIcon('red', 'close', 54), w - 16 - 54 - 10, 46);
  const left = 16 + R.padX; // first content column
  const right = w - 16 - R.padX; // last content column
  const labelX = left + R.icon + R.gap;
  let y = 142;
  for (const r of rows) {
    const ctrlW = r.ctrl === 'slider' ? R.slider : R.toggle;
    const ctrlX = right - ctrlW;
    const box = ctrlX - R.gap - labelX; // what the label may occupy
    const size = fitTextSize(r.label, box, R.label);
    b += place(compSquareIcon('sky', r.icon, R.icon), left, y + (R.icon < 52 ? 3 : 0));
    b += label(labelX, y + 26, r.label, size, { bg: c, anchor: 'start' });
    if (r.ctrl === 'slider') b += place(compTickSlider(45, ctrlW, 54), ctrlX, y - 2);
    else b += place(compToggle(true, ctrlW, 60), ctrlX, y - 4);
    y += R.step;
  }
  y += 8;
  for (const pair of btnPairs) {
    b += place(compIconTextButton(pair[0].col, pair[0].icon, pair[0].t, 180, 72), 26, y);
    b += place(compIconTextButton(pair[1].col, pair[1].icon, pair[1].t, 180, 72), w - 26 - 180, y);
    y += 86;
  }
  for (const wb of wideBtns) {
    b += place(compIconTextButton(wb.col, wb.icon, wb.t, 262, 72), (w - 262) / 2, y);
    y += 86;
  }
  b += label(w / 2, h - 52, '0.33.0 (315)', 18, { fill: adj(c, { dl: -24 }) });
  return screenDoc(w, h, b);
}

export function scSettings(): RawComponent {
  return scSettingsBase(
    'sky',
    [
      { icon: 'sound', label: tx('set_sounds'), ctrl: 'slider' },
      { icon: 'bolt', label: tx('set_haptic') },
      { icon: 'bell', label: tx('set_notify') },
    ],
    [
      [
        { col: 'yellow', icon: 'shield2', t: tx('set_privacy') },
        { col: 'green', icon: 'chat', t: tx('set_contact') },
      ],
      [
        { col: 'purple', icon: 'cart', t: tx('set_restore') },
        { col: 'blue', icon: 'check', t: tx('set_save') },
      ],
    ],
    [],
    700
  );
}

export function scSettingsGame(): RawComponent {
  return scSettingsBase(
    'purple',
    [
      { icon: 'sound', label: tx('set_sounds'), ctrl: 'slider' },
      { icon: 'bolt', label: tx('set_haptic') },
    ],
    [
      [
        { col: 'yellow', icon: 'shield2', t: tx('set_privacy') },
        { col: 'green', icon: 'chat', t: tx('set_contact') },
      ],
    ],
    [
      { col: 'blue', icon: 'refresh', t: tx('set_restart') },
      { col: 'red', icon: 'home', t: tx('set_home') },
    ],
    660
  );
}

export function scTutorial(): RawComponent {
  const w = 430;
  const h = 760;
  let b = `<rect width="${w}" height="${h}" rx="18" fill="#0c1930"/>`;
  // A hand-drawn pointer: a quadratic curve with a head on its tip.
  //
  // The head is built from the curve's REAL end point and its REAL tangent there. It used to
  // be a triangle at a hardcoded offset, which did not coincide with the end point at all —
  // the head floated off to the side of the tip and pointed the wrong way. For a quadratic
  // the tangent at t=1 is simply P2 - P1.
  const arrow = (x: number, y: number, flip: boolean): string => {
    const s = flip ? -1 : 1;
    const c = { x: x + s * 46, y: y + 34 }; // control point
    const p2 = { x: x + s * 16, y: y + 76 }; // end point
    const d = `M ${x} ${y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`;
    const tl = Math.hypot(p2.x - c.x, p2.y - c.y) || 1;
    const ux = (p2.x - c.x) / tl;
    const uy = (p2.y - c.y) / tl; // unit direction of travel
    const nx = -uy;
    const ny = ux; // unit normal
    const LEN = 26;
    const HALF = 13;
    // the tip sits a little past the curve's end, so the head's base covers the round cap
    const tip = { x: p2.x + ux * LEN * 0.55, y: p2.y + uy * LEN * 0.55 };
    const back = { x: tip.x - ux * LEN, y: tip.y - uy * LEN };
    const f = (v: number): string => v.toFixed(1);
    const head =
      `M ${f(tip.x)} ${f(tip.y)} L ${f(back.x + nx * HALF)} ${f(back.y + ny * HALF)} ` +
      `L ${f(back.x - nx * HALF)} ${f(back.y - ny * HALF)} Z`;
    return (
      `<path d="${d}" fill="none" stroke="${DARK()}" stroke-width="15" stroke-linecap="round"/>` +
      `<path d="${head}" fill="${DARK()}" stroke="${DARK()}" stroke-width="6" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>` +
      `<path d="${head}" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>`
    );
  };
  b += place(compRibbon('orange', tx('tut_title'), 330, 110), (w - 330) / 2, 26);
  b += label(w / 2, 196, tx('tut_line1'), 23);
  b += arrow(w * 0.64, 216, false);
  b += place(compPanelBody('blue', 336, 146), 47, 318);
  b += place(compDayCard('done', tx('day_1'), 98, 118), 63, 332);
  b += place(compDayCard('reward', tx('day_2'), 98, 118), 166, 332);
  b += place(compDayCard('mystery', tx('day_5'), 98, 118), 269, 332);
  b += label(w / 2, 502, tx('tut_line2'), 23);
  b += arrow(w * 0.36, 522, true);
  b += place(compStar(92), (w - 92) / 2, 586);
  b += label(w / 2, 712, tx('tut_tap'), 28);
  return { svg: svgDoc(w, h, b), w, h };
}

export function scWin(): RawComponent {
  const t = theme();
  const w = 430;
  const h = 720;
  let b = `<rect width="${w}" height="${h}" rx="18" fill="#0b1830"/>`;
  b += goldStar(122, 126, 44) + goldStar(215, 100, 60) + goldStar(308, 126, 44);
  let fr = bevelRect(0.5, 0.5, 300, 340, C('yellow'), { r: t.radius * 1.2 });
  fr += `<rect x="36" y="36" width="228" height="248" rx="${Math.min(t.radius, 10)}" fill="#6b5b4a" stroke="${DARK()}" stroke-width="${Math.max(1, t.outline * 0.7)}"/>`;
  fr += label(150, 312, tx('win_level_name'), 30, { bg: C('yellow') });
  b += place({ svg: svgDoc(302, 342, fr), w: 300, h: 340 }, (w - 300) / 2, 176);
  // The two actions are ONE row: same size, same baseline, symmetric margins — they used to
  // differ by 8 px of height and sit 6 px apart vertically, which read as a mistake. The
  // reward is the CLAIM shape (compBannerButton), the kit's own "this is the prize" button;
  // the restart stays an ordinary icon+text one.
  const bw = 192;
  const bh = 76;
  const by = 602;
  const pad = 18;
  b += place(compIconTextButton('blue', 'refresh', tx('win_again'), bw, bh), pad, by);
  b += place(compBannerButton('green', tx('win_reward'), bw, bh), w - pad - bw, by);
  return { svg: svgDoc(w, h, b), w, h };
}
