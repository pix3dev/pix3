/**
 * UI Kit Forge page — the control panel.
 *
 * One declarative list turned into DOM. Every control carries its own `get`/`set` closure
 * rather than a bare key name, which is what keeps the whole panel type-safe without a single
 * `any`: a range writes a number, a select writes its own union, and the three *virtual*
 * controls (preset, caption language, preview backdrop) steer the page rather than the theme
 * and are indistinguishable from the rest here.
 *
 * The panel covers every field of `ForgeTheme`, including the ones the jam-august bench had no
 * widget for — `darkTone`/`labelEdge` and the per-role absolute `palette` override, which is the
 * plan's "absolute colours, not deltas" (§4) made reachable by hand.
 */
import { CYR_FONTS, FONTS, LANGS, PALETTE } from '@/services/uikit';
import type { ForgeLang, ForgeTheme, PaletteId } from '@/services/uikit';

import { BACKDROPS, patchTheme, session, type Backdrop } from './session';
import { presetOptions } from './presets-store';
import { icon } from './ui';

export interface SelectOption {
  value: string;
  label: string;
  /** Renders inside an `<optgroup>` of this name when present. */
  group?: string;
}

interface GroupHeading {
  kind: 'group';
  label: string;
}

interface RangeControl {
  kind: 'range';
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
}

interface CheckControl {
  kind: 'check';
  label: string;
  get(): boolean;
  set(value: boolean): void;
}

interface SelectControl {
  kind: 'select';
  label: string;
  options(): SelectOption[];
  get(): string;
  set(value: string): void;
}

interface ColorControl {
  kind: 'color';
  label: string;
  /** `null` means "not overridden" — the swatch then shows `fallback()`. */
  get(): string | null;
  set(value: string | null): void;
  fallback(): string;
  /** Show the "back to the default" button. */
  clearable?: boolean;
}

export type Control = GroupHeading | RangeControl | CheckControl | SelectControl | ColorControl;

/** What the panel calls back into when a control moves. */
export interface ControlHandlers {
  /** The theme changed and the stage must repaint. */
  onThemeChange(): void;
  /** A font family changed: the face has to be fetched before the repaint means anything. */
  onFontChange(): void;
  /** The caption language changed. */
  onLangChange(): void;
  /** A preset was picked. */
  onPresetChange(id: string): void;
  /** The preview backdrop changed. */
  onBackdropChange(): void;
}

/** The theme fields a slider can write. */
type NumericThemeKey = {
  [K in keyof ForgeTheme]: ForgeTheme[K] extends number ? K : never;
}[keyof ForgeTheme];

const optionsOf = (values: readonly string[]): SelectOption[] =>
  values.map(value => ({ value, label: value }));

/**
 * Write one numeric field.
 *
 * The cast is the one place a computed key meets a typed object: `{ [key]: value }` infers as
 * `Record<string, number>`, which `Partial<ForgeTheme>` cannot accept even though `key` is
 * provably a numeric field of it. Narrow, and `patchTheme` re-validates everything anyway.
 */
function setNumber(key: NumericThemeKey, value: number): void {
  patchTheme({ [key]: value } as Partial<ForgeTheme>);
}

/** Merge one role's absolute override into the theme, or drop it. */
function setPaletteOverride(id: PaletteId, hex: string | null): void {
  const next: Partial<Record<PaletteId, string>> = { ...(session.theme.palette ?? {}) };
  if (hex) next[id] = hex;
  else delete next[id];
  patchTheme({ palette: Object.keys(next).length ? next : null });
}

/**
 * The panel, in display order.
 *
 * Built as a function rather than a module constant because several controls read the live
 * session (the preset list grows as the user saves presets, the palette rows show whatever the
 * current theme overrides).
 */
export function createControls(handlers: ControlHandlers): Control[] {
  const t = (): ForgeTheme => session.theme;

  /** A slider over one numeric theme field. */
  const range = (
    key: NumericThemeKey,
    label: string,
    min: number,
    max: number,
    step: number
  ): RangeControl => ({
    kind: 'range',
    label,
    min,
    max,
    step,
    get: () => t()[key],
    set: value => {
      setNumber(key, value);
      handlers.onThemeChange();
    },
  });

  /** A 0/1 theme flag. The theme stores these as numbers, as the sliders write them. */
  const flag = (key: NumericThemeKey, label: string): CheckControl => ({
    kind: 'check',
    label,
    get: () => t()[key] > 0,
    set: on => {
      setNumber(key, on ? 1 : 0);
      handlers.onThemeChange();
    },
  });

  const controls: Control[] = [
    { kind: 'group', label: 'Preset' },
    {
      kind: 'select',
      label: 'Style',
      options: () => presetOptions().map(p => ({ value: p.id, label: p.label, group: p.group })),
      get: () => session.preset,
      set: id => handlers.onPresetChange(id),
    },
    // The kit is bilingual and so is the bench: the same button has to hold "НАГРАДА" and
    // "REWARD", and Cyrillic is both wider and drawn by another face. The page's own chrome
    // stays English — this switch is the KIT's language.
    {
      kind: 'select',
      label: 'Caption language',
      options: () => [
        { value: 'en', label: 'English' },
        { value: 'ru', label: 'Русский' },
      ],
      get: () => session.lang,
      set: value => {
        session.lang = (LANGS as readonly string[]).includes(value)
          ? (value as ForgeLang)
          : session.lang;
        handlers.onLangChange();
      },
    },

    { kind: 'group', label: 'Palette' },
    range('hue', 'Hue', -180, 180, 1),
    range('sat', 'Saturation', -40, 30, 1),
    range('light', 'Lightness', -20, 20, 1),
    {
      kind: 'color',
      label: 'Dark tone',
      get: () => t().darkTone,
      set: value => {
        if (value) patchTheme({ darkTone: value });
        handlers.onThemeChange();
      },
      fallback: () => t().darkTone,
    },
    {
      kind: 'color',
      label: 'Label edge',
      clearable: true,
      get: () => t().labelEdge,
      set: value => {
        patchTheme({ labelEdge: value });
        handlers.onThemeChange();
      },
      // A panel's edge and a sticker's edge are different colours in every real kit; with no
      // override the caption borrows the dark tone.
      fallback: () => t().labelEdge ?? t().darkTone,
    },

    { kind: 'group', label: 'Shape' },
    range('radius', 'Radius', 0, 50, 1),
    range('bevel', 'Bevel', 0, 16, 1),
    range('outline', 'Outline', 0, 8, 0.5),
    range('skew', 'Skew', 0, 14, 0.5),
    range('puffy', 'Puffiness', 0, 10, 0.5),
    range('pad', 'Canvas padding', 0, 48, 1),

    { kind: 'group', label: 'Effects' },
    flag('gradOn', 'Gradient'),
    range('gradK', 'Contrast', 0, 24, 1),
    flag('glossOn', 'Gloss'),
    {
      kind: 'select',
      label: 'Gloss type',
      options: () => [
        { value: 'strip', label: 'Strip' },
        { value: 'dome', label: 'Dome' },
        { value: 'corner', label: 'Corners' },
      ],
      get: () => t().glossType,
      set: value => {
        patchTheme({ glossType: value === 'dome' || value === 'corner' ? value : 'strip' });
        handlers.onThemeChange();
      },
    },
    range('glossH', 'Gloss height', 10, 60, 1),
    range('glossA', 'Gloss brightness', 5, 60, 1),

    { kind: 'group', label: 'Shadow' },
    {
      kind: 'select',
      label: 'Shadow type',
      options: () => [
        { value: '0', label: 'None' },
        { value: '1', label: 'Sharp' },
        { value: '2', label: 'Blurred' },
      ],
      get: () => String(t().shadowMode),
      set: value => {
        patchTheme({ shadowMode: value === '1' ? 1 : value === '2' ? 2 : 0 });
        handlers.onThemeChange();
      },
    },
    range('shadowDx', 'Offset X', -16, 16, 1),
    range('shadowDy', 'Offset Y', -16, 16, 1),
    range('shadowBlur', 'Blur', 0, 12, 1),
    range('shadowA', 'Opacity', 0, 80, 1),

    { kind: 'group', label: 'Typography' },
    // TWO pickers, because the interface is bilingual and most display faces are Latin-only
    // (only Nunito and Rubik carry Cyrillic). The primary supplies Latin; the second supplies
    // Cyrillic, and the face is chosen per CAPTION rather than by per-character CSS fallback —
    // a CSS stack carries one weight, and with it every Russian caption came out thin.
    {
      kind: 'select',
      label: 'Font (Latin)',
      options: () => optionsOf(FONTS.map(f => f.f)),
      get: () => t().font,
      set: font => {
        patchTheme({ font });
        handlers.onFontChange();
      },
    },
    {
      kind: 'select',
      label: 'Font (Cyrillic)',
      options: () => optionsOf(CYR_FONTS.map(f => f.f)),
      get: () => t().fontCyr,
      set: fontCyr => {
        patchTheme({ fontCyr });
        handlers.onFontChange();
      },
    },
    {
      kind: 'select',
      label: 'Text colour',
      options: () => [
        { value: 'white', label: 'White' },
        { value: 'dark', label: 'Dark' },
        { value: 'auto', label: 'Adaptive' },
      ],
      get: () => t().txtColor,
      set: value => {
        patchTheme({ txtColor: value === 'dark' ? 'dark' : value === 'auto' ? 'auto' : 'white' });
        handlers.onThemeChange();
      },
    },
    range('txtOut', 'Text outline', 0, 8, 0.5),
    range('txtDrop', 'Text shadow', 0, 8, 0.5),
    range('track', 'Tracking', 0, 4, 0.1),

    { kind: 'group', label: 'Preview' },
    {
      kind: 'select',
      label: 'Background',
      options: () => optionsOf(BACKDROPS),
      get: () => session.backdrop,
      set: value => {
        session.backdrop = (BACKDROPS as readonly string[]).includes(value)
          ? (value as Backdrop)
          : session.backdrop;
        handlers.onBackdropChange();
      },
    },
  ];

  // The absolute per-role override. A project palette pins the roles here and the hue /
  // saturation / lightness sliders stay a convenience on top of it (plan §4).
  controls.push({ kind: 'group', label: 'Role colours (absolute)' });
  for (const entry of PALETTE) {
    controls.push({
      kind: 'color',
      label: entry.label || entry.id,
      clearable: true,
      get: () => t().palette?.[entry.id] ?? null,
      set: value => {
        setPaletteOverride(entry.id, value);
        handlers.onThemeChange();
      },
      fallback: () => t().palette?.[entry.id] ?? entry.hex,
    });
  }

  return controls;
}

let rowSeq = 0;

/** Render the panel into `root`, replacing whatever was there. */
export function renderControls(root: HTMLElement, controls: Control[]): void {
  root.textContent = '';
  let group: HTMLElement = root;

  for (const control of controls) {
    if (control.kind === 'group') {
      group = document.createElement('div');
      group.className = 'grp';
      const title = document.createElement('b');
      title.textContent = control.label;
      group.appendChild(title);
      root.appendChild(group);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'row';
    const id = `ctl_${++rowSeq}`;

    if (control.kind === 'range') {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = control.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.get());
      const out = document.createElement('output');
      out.textContent = String(control.get());
      // `input`, not `change`: the point of a slider here is that the kit repaints while it
      // moves, and a control read on `change` alone looks dead until the pointer is released.
      input.addEventListener('input', () => {
        out.textContent = input.value;
        control.set(parseFloat(input.value));
      });
      row.append(label, input, out);
    } else if (control.kind === 'check') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = control.get();
      const label = document.createElement('label');
      label.className = 'cb-label';
      label.htmlFor = id;
      label.textContent = control.label;
      input.addEventListener('change', () => control.set(input.checked));
      row.append(input, label);
    } else if (control.kind === 'select') {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = control.label;
      const select = document.createElement('select');
      select.id = id;
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const option of control.options()) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        if (option.group) {
          let optgroup = groups.get(option.group);
          if (!optgroup) {
            optgroup = document.createElement('optgroup');
            optgroup.label = option.group;
            groups.set(option.group, optgroup);
            select.appendChild(optgroup);
          }
          optgroup.appendChild(optionEl);
        } else {
          select.appendChild(optionEl);
        }
      }
      select.value = control.get();
      select.addEventListener('change', () => control.set(select.value));
      row.append(label, select);
    } else {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = control.label;
      const input = document.createElement('input');
      input.type = 'color';
      input.id = id;
      input.value = control.fallback();
      input.classList.toggle('is-default', control.get() === null);
      input.addEventListener('input', () => {
        input.classList.remove('is-default');
        control.set(input.value);
      });
      row.append(label, input);
      if (control.clearable) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'icobtn';
        clear.title = 'Back to the default';
        clear.setAttribute('aria-label', `Reset ${control.label}`);
        clear.innerHTML = icon('rotate-ccw');
        clear.addEventListener('click', () => {
          control.set(null);
          input.value = control.fallback();
          input.classList.add('is-default');
        });
        row.append(clear);
      }
    }

    group.appendChild(row);
  }
}
