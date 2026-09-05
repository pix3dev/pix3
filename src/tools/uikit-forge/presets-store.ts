/**
 * UI Kit Forge page — the preset store.
 *
 * The core ships the built-in presets (`PRESETS`, `presetTheme`) as pure data; a *saved* preset
 * is a host concern, because `localStorage` has no place in a host-agnostic core. So the
 * page keeps the user's own presets here, under one key, and merges the two lists for the
 * picker.
 *
 * Identity is an id, not the visible name: a user preset called "Flat" must not shadow the
 * built-in one, so user entries are addressed as `user:<name>` and shown in their own
 * `<optgroup>` — which is also why the list needs no star glyph to tell the two apart.
 */
import {
  PRESETS,
  normalizeTheme,
  presetNames,
  presetTheme,
  type ForgeTheme,
} from '@/services/uikit';

const STORAGE_KEY = 'pix3.uikit-forge.user-presets';

/** The id prefix of a saved preset. */
export const USER_PREFIX = 'user:';

export const isUserPreset = (id: string): boolean => id.startsWith(USER_PREFIX);

/** The visible name of a preset id. */
export const presetLabel = (id: string): string =>
  isUserPreset(id) ? id.slice(USER_PREFIX.length) : id;

/**
 * Every saved preset, name → theme.
 *
 * Never throws: `localStorage` is unavailable in a private window and in some embedded
 * contexts, and a tool that dies because it could not read its own convenience store would be
 * a worse bug than losing the presets.
 */
export function loadUserPresets(): Record<string, ForgeTheme> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ForgeTheme> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[name] = normalizeTheme(value);
    }
    return out;
  } catch {
    return {};
  }
}

/** @returns false when the store could not be written (quota, private window). */
function writeUserPresets(map: Record<string, ForgeTheme>): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** Save (or overwrite) one preset. @returns the id, or null when the store refused. */
export function saveUserPreset(name: string, theme: ForgeTheme): string | null {
  const clean = name.trim();
  if (!clean) return null;
  const map = loadUserPresets();
  map[clean] = normalizeTheme(theme);
  return writeUserPresets(map) ? USER_PREFIX + clean : null;
}

/** Remove one saved preset. */
export function deleteUserPreset(id: string): boolean {
  if (!isUserPreset(id)) return false;
  const map = loadUserPresets();
  delete map[presetLabel(id)];
  return writeUserPresets(map);
}

export interface PresetOption {
  id: string;
  label: string;
  /** The `<optgroup>` the entry belongs to. */
  group: string;
}

/** Built-in presets first, then the user's own — each in its own group. */
export function presetOptions(): PresetOption[] {
  const out: PresetOption[] = presetNames().map(name => ({
    id: name,
    label: name,
    group: 'Presets',
  }));
  for (const name of Object.keys(loadUserPresets()).sort()) {
    out.push({ id: USER_PREFIX + name, label: name, group: 'Yours' });
  }
  return out;
}

/**
 * The theme a preset id stands for.
 *
 * An id that no longer exists yields `null` rather than a default — the caller wants to say so
 * rather than silently repaint something else.
 */
export function themeForPreset(id: string): ForgeTheme | null {
  if (isUserPreset(id)) {
    const saved = loadUserPresets()[presetLabel(id)];
    return saved ? normalizeTheme(saved) : null;
  }
  return id in PRESETS ? presetTheme(id) : null;
}
