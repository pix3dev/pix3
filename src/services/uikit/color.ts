/**
 * UI Kit Forge — the colour maths.
 *
 * Pure functions over `#rrggbb` strings; nothing here reads the theme or the build
 * context, so they are safe to call from a host as well as from a generator.
 *
 * Ported from `src/dev/uikit/theme.js` of the jam-august forge.
 */

/** `#rgb` / `#rrggbb`, the only forms the generators accept. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Is this a hex colour the maths below can consume?
 *
 * `hexToHsl` on a bad string silently yields `#NaNNaN` (plan §7: "validate input"),
 * so every colour arriving from JSON, an agent or a host goes through this first —
 * `normalizeTheme` is the single gate for the theme itself.
 */
export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

/** `#abc` → `aabbcc`, without the leading `#`. */
function expand(hex: string): string {
  const h = hex.replace('#', '');
  return h.length === 3
    ? h
        .split('')
        .map(c => c + c)
        .join('')
    : h;
}

export function hexToHsl(hex: string): [number, number, number] {
  const h6 = expand(hex);
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hslToHex(hue: number, sat: number, light: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(100, Math.max(0, sat)) / 100;
  const l = Math.min(100, Math.max(0, light)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number;
  let g: number;
  let b: number;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  const to = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/** How far to shift a colour in HSL. */
export interface ColorDelta {
  dh?: number;
  ds?: number;
  dl?: number;
}

/** Shift a colour in HSL: hue / saturation / lightness deltas. */
export function adj(hex: string, { dh = 0, ds = 0, dl = 0 }: ColorDelta = {}): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + dh, s + ds, l + dl);
}

/** The HSL lightness, 0..100. */
export function lum(hex: string): number {
  return hexToHsl(hex)[2];
}

/** Perceived brightness 0..1 — drives the adaptive ink colour. */
export function brightness(hex: string): number {
  const h6 = expand(hex);
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
