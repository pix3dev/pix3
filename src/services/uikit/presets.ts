/**
 * UI Kit Forge — the presets: named theme snapshots.
 *
 * Style references, nothing more: "what would this kit look like if it were Brawl Stars".
 * The jam-august forge also carried a preset built from THAT game's tokens; it does not
 * travel (plan §9.1), because a pix3 project's absolute palette comes from its own
 * `design/style.md` and lands in `theme.palette` instead.
 *
 * User presets are a HOST concern: `localStorage` has no place in a host-agnostic core.
 */
import { DEFAULT_THEME, normalizeTheme, type ForgeTheme } from './ForgeTheme';

/** A preset is a patch over {@link DEFAULT_THEME}, never a whole theme. */
export type ForgePreset = Partial<ForgeTheme>;

export const PRESETS: Readonly<Record<string, ForgePreset>> = {
  Standard: {},
  'Brawl Stars': {
    radius: 6,
    bevel: 7,
    outline: 3,
    skew: 7,
    gradOn: 1,
    gradK: 9,
    glossOn: 0,
    shadowMode: 1,
    shadowDx: 3,
    shadowDy: 7,
    shadowA: 55,
    // Lilita One is Latin-only, so Cyrillic comes from Rubik — the closest heavy face that
    // has it (ForgeTheme: FONTS[].cyr).
    font: 'Lilita One',
    fontCyr: 'Rubik',
    txtOut: 3.5,
    txtDrop: 1.5,
    txtColor: 'white',
  },
  Bombastic: {
    sat: 8,
    radius: 0,
    bevel: 9,
    outline: 4,
    skew: 0,
    gradOn: 0,
    gradK: 13,
    glossOn: 0,
    glossType: 'strip',
    glossH: 45,
    glossA: 20,
    puffy: 0,
    shadowMode: 1,
    shadowDx: 2,
    shadowDy: 5,
    shadowBlur: 5,
    shadowA: 60,
    font: 'Rubik',
    fontCyr: 'Rubik',
    txtOut: 0,
    txtDrop: 0,
    txtColor: 'auto',
  },
  'Candy Pop': {
    hue: 38,
    sat: 10,
    light: 4,
    radius: 24,
    bevel: 8,
    outline: 2,
    gradOn: 1,
    gradK: 14,
    glossOn: 1,
    glossH: 42,
    glossA: 34,
    shadowMode: 2,
    shadowDx: 3,
    shadowDy: 6,
    shadowBlur: 6,
    shadowA: 35,
    font: 'Baloo 2',
    fontCyr: 'Nunito',
    txtOut: 3,
    txtDrop: 3,
    txtColor: 'white',
  },
  'Soft shadow': {
    shadowMode: 2,
    shadowDx: 2,
    shadowDy: 5,
    shadowBlur: 6,
    shadowA: 32,
  },
  'Puffy (capsule)': {
    radius: 44,
    bevel: 4,
    outline: 2.5,
    puffy: 6,
    gradOn: 1,
    gradK: 12,
    glossOn: 1,
    glossType: 'corner',
    glossA: 38,
    shadowMode: 2,
    shadowDx: 0,
    shadowDy: 5,
    shadowBlur: 5,
    shadowA: 30,
    font: 'Baloo 2',
    fontCyr: 'Nunito',
    txtOut: 2.5,
    txtDrop: 2,
    txtColor: 'white',
  },
  Flat: {
    gradOn: 0,
    glossOn: 0,
    bevel: 0,
    outline: 2,
    radius: 10,
    shadowMode: 0,
    txtOut: 0,
    txtDrop: 0,
  },
};

export const DEFAULT_PRESET = 'Standard';

/** Every preset name, in declaration order. */
export function presetNames(): string[] {
  return Object.keys(PRESETS);
}

/**
 * The full theme a preset stands for: defaults first, the patch on top, normalized.
 *
 * An unknown name yields the defaults rather than throwing — a stale name in a host's
 * settings must not take the tool down.
 */
export function presetTheme(name: string): ForgeTheme {
  const patch = PRESETS[name] ?? {};
  return normalizeTheme({ ...DEFAULT_THEME, ...patch });
}
