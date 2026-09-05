import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { DEFAULT_THEME, buildSkin, normalizeTheme, presetTheme } from '@/services/uikit';
import { UI_THEME_PATH, UI_KIT_MANIFEST_PATH } from '@/services/uikit-editor/UiKitThemeService';
import {
  DEFAULT_BUTTON_SIZE,
  ICON_BUTTON_GLYPHS,
  ICON_BUTTON_SIZE,
  UI_SPRITE_ROOT,
  UiKitProjectWriter,
  iconPartKey,
  kitIdForTheme,
  partKey,
} from '@/services/uikit-editor/UiKitProjectWriter';

/**
 * The engine-lane bake. Everything browser-shaped is stubbed — rasterization and the pixel
 * read-back both need a real canvas, and neither is what this file is about. What IS tested is the
 * contract the rest of the feature depends on: names come from the theme's hash, every part lands
 * in the manifest with its raster nine-slice, and the theme document is written alongside.
 */

const PNG = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

interface Harness {
  writer: UiKitProjectWriter;
  saved: { id: string; path: string }[];
  writeTextFile: ReturnType<typeof vi.fn>;
  themeSave: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
}

function createWriter(): Harness {
  const writer = new UiKitProjectWriter();
  const saved: { id: string; path: string }[] = [];
  const discard = vi.fn();
  let handles = 0;

  const assets = {
    importBlob: vi.fn(async () => ({ id: `handle-${++handles}` })),
    save: vi.fn(async (id: string, path: string) => {
      saved.push({ id, path });
      return { path, width: 1, height: 1, bytes: 4, mimeType: 'image/png' };
    }),
    discard,
  };
  const writeTextFile = vi.fn(async () => undefined);
  const storage = {
    createDirectory: vi.fn(async () => undefined),
    writeTextFile,
    readTextFile: vi.fn(async () => {
      throw new Error('not found');
    }),
  };
  const themeSave = vi.fn(async () => UI_THEME_PATH);

  Object.defineProperty(writer, 'assets', { value: assets, configurable: true });
  Object.defineProperty(writer, 'storage', { value: storage, configurable: true });
  Object.defineProperty(writer, 'themeService', {
    value: { save: themeSave },
    configurable: true,
  });
  writer.rasterize = vi.fn(async () => PNG());
  // No canvas here, so the writer falls back to scaling the generator's design-unit border —
  // which is exactly the number the manifest must carry.
  writer.readPixels = vi.fn(async () => null);

  return { writer, saved, writeTextFile, themeSave, discard };
}

describe('kitIdForTheme', () => {
  it('is stable, 8 hex, and key-order independent', () => {
    const theme = normalizeTheme(DEFAULT_THEME);
    const id = kitIdForTheme(theme);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(kitIdForTheme(theme)).toBe(id);
    // Same values, different insertion order.
    const reordered = normalizeTheme({ ...theme, palette: null, radius: theme.radius });
    expect(kitIdForTheme(reordered)).toBe(id);
  });

  it('changes when the theme changes', () => {
    const base = normalizeTheme(DEFAULT_THEME);
    expect(kitIdForTheme({ ...base, radius: base.radius + 3 })).not.toBe(kitIdForTheme(base));
    expect(kitIdForTheme(presetTheme('Brawl Stars'))).not.toBe(kitIdForTheme(base));
  });
});

describe('UiKitProjectWriter.writeKit', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    appState.project.id = 'proj-1';
  });

  afterEach(() => {
    resetAppState();
  });

  it('refuses to write without an open project', async () => {
    resetAppState();
    const { writer } = createWriter();
    await expect(writer.writeKit(normalizeTheme(DEFAULT_THEME))).rejects.toThrow(/No project/);
  });

  it('names every sprite under sprites/ui/<kitId>/ and records it in the manifest', async () => {
    const { writer, saved, writeTextFile, themeSave } = createWriter();
    const theme = normalizeTheme(DEFAULT_THEME);

    const result = await writer.writeKit(theme, { colorRoles: ['green'], scale: 2 });
    const kitId = kitIdForTheme(theme);

    expect(result.kitId).toBe(kitId);
    expect(result.scale).toBe(2);
    expect(saved.length).toBeGreaterThan(0);
    for (const entry of saved) {
      expect(entry.path.startsWith(`${UI_SPRITE_ROOT}/${kitId}/`)).toBe(true);
      expect(entry.path.endsWith('.png')).toBe(true);
    }

    // Four button states, the role parts, and the role-independent parts.
    for (const state of ['normal', 'hover', 'pressed', 'disabled'] as const) {
      expect(result.manifest.parts[partKey('button', 'green', state)]).toBeDefined();
    }
    for (const key of [
      partKey('panel-body', 'green'),
      partKey('header-plate', 'green'),
      partKey('bar-fill', 'green'),
      partKey('slot'),
      partKey('checkbox'),
      partKey('checkbox-mark'),
      partKey('slider-track'),
      partKey('slider-thumb'),
      partKey('bar-trough'),
    ]) {
      expect(result.manifest.parts[key], key).toBeDefined();
    }

    // The other nine roles were not asked for and must not appear.
    expect(result.manifest.parts[partKey('button', 'red', 'normal')]).toBeUndefined();

    // Both JSON documents.
    expect(writeTextFile).toHaveBeenCalledWith(
      UI_KIT_MANIFEST_PATH,
      expect.stringContaining(kitId)
    );
    expect(themeSave).toHaveBeenCalledTimes(1);
    expect(result.paths).toContain(UI_KIT_MANIFEST_PATH);
    expect(result.paths).toContain(UI_THEME_PATH);
  });

  it('bakes a glyph button per icon, at its semantic role and with no nine-slice', async () => {
    const { writer } = createWriter();
    const theme = normalizeTheme(DEFAULT_THEME);

    const result = await writer.writeKit(theme, { colorRoles: ['green'] });

    for (const [icon, role] of Object.entries(ICON_BUTTON_GLYPHS)) {
      for (const state of ['normal', 'hover', 'pressed', 'disabled'] as const) {
        const record = result.manifest.parts[iconPartKey(icon, role, state)];
        expect(record, `${icon}/${state}`).toBeDefined();
        expect(record.icon, icon).toBe(icon);
        // The glyph sits where a nine-slice would stretch, so the kit promises none.
        expect(record.sliceBorder, icon).toBeNull();
        expect(record.w, icon).toBe(ICON_BUTTON_SIZE.w * result.scale);
      }
    }
    // A glyph is baked in its own role only — 7 x 10 roles would be pictures nothing asks for.
    expect(result.manifest.parts[iconPartKey('close', 'purple', 'normal')]).toBeUndefined();
  });

  it('can be told to skip the glyph buttons (the T0 expander does)', async () => {
    const { writer } = createWriter();

    const result = await writer.writeKit(normalizeTheme(DEFAULT_THEME), {
      colorRoles: ['green'],
      iconButtons: false,
    });

    expect(result.manifest.parts[iconPartKey('close', 'red', 'normal')]).toBeUndefined();
    expect(result.manifest.parts[partKey('button', 'green', 'normal')]).toBeDefined();
  });

  /**
   * Caught live, not by a test: the manifest carried a 228 px top inset for a 512 px panel while
   * `buildSkin` reported 66. `frameMeta` re-derives the insets from a theme, and the writer was
   * handing it the AUTHOR's theme instead of the one the part was drawn with — the two differ by
   * exactly the gloss cap.
   */
  it('re-measures the border with the theme the part was DRAWN with, cap included', async () => {
    const { writer } = createWriter();
    // A canvas is available here: the writer measures the raster instead of scaling the
    // generator's own numbers, which is the path that went wrong.
    writer.readPixels = vi.fn(async (_blob: Blob, w: number, h: number) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      rgba.fill(255);
      return rgba;
    });
    const theme = normalizeTheme({ ...DEFAULT_THEME, radius: 30, glossH: 51, glossOn: 1 });

    const result = await writer.writeKit(theme, {
      colorRoles: ['sky'],
      scale: 2,
      iconButtons: false,
    });

    const record = result.manifest.parts[partKey('panel-body', 'sky')];
    const part = buildSkin(
      { component: 'panel-body', colorRole: 'sky', width: 256, height: 256 },
      theme
    );
    expect(record.sliceBorder).not.toBeNull();
    // Within a pixel of the generator's own answer: the raster measurement rounds up once at
    // scale 2 where the design-unit one rounds up at scale 1.
    expect(Math.abs(record.sliceBorder!.top - part.sliceBorder!.top * 2)).toBeLessThanOrEqual(1);
    // And the cap is what makes that number small enough for the panel to stretch at all.
    expect(record.sliceBorder!.top).toBeLessThan(record.h / 4);
  });

  it('scales the nine-slice border from design units into raster px', async () => {
    const { writer } = createWriter();
    const theme = normalizeTheme(DEFAULT_THEME);
    const scale = 3;

    const result = await writer.writeKit(theme, { colorRoles: ['blue'], scale });

    const record = result.manifest.parts[partKey('button', 'blue', 'normal')];
    const part = buildSkin(
      {
        component: 'button',
        colorRole: 'blue',
        width: DEFAULT_BUTTON_SIZE.w,
        height: DEFAULT_BUTTON_SIZE.h,
        state: 'normal',
      },
      theme
    );

    expect(part.sliceBorder).not.toBeNull();
    expect(record.w).toBe(DEFAULT_BUTTON_SIZE.w * scale);
    expect(record.h).toBe(DEFAULT_BUTTON_SIZE.h * scale);
    expect(record.sliceBorder).toEqual({
      left: Math.round(part.sliceBorder!.left * scale),
      right: Math.round(part.sliceBorder!.right * scale),
      top: Math.round(part.sliceBorder!.top * scale),
      bottom: Math.round(part.sliceBorder!.bottom * scale),
    });
    expect(record.role).toBe('blue');
    expect(record.state).toBe('normal');
  });

  it('records a null border for a silhouette that cannot be nine-sliced', async () => {
    const { writer } = createWriter();
    // `skew` leans the vertical edges, so the side slices are not uniform along their length.
    const theme = normalizeTheme({ ...DEFAULT_THEME, skew: 8 });

    const result = await writer.writeKit(theme, { colorRoles: ['gray'] });

    expect(result.manifest.parts[partKey('button', 'gray', 'normal')].sliceBorder).toBeNull();
  });

  it('frees the working handle after each save', async () => {
    const { writer, discard, saved } = createWriter();
    await writer.writeKit(normalizeTheme(DEFAULT_THEME), { colorRoles: ['sky'] });
    expect(discard).toHaveBeenCalledTimes(saved.length);
  });

  it('reports progress for every part', async () => {
    const { writer } = createWriter();
    const ticks: number[] = [];
    const result = await writer.writeKit(normalizeTheme(DEFAULT_THEME), {
      colorRoles: ['yellow'],
      onProgress: (done, total) => {
        ticks.push(done);
        expect(total).toBeGreaterThan(0);
      },
    });
    // One tick before each part plus a final one for the manifest.
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(Object.keys(result.manifest.parts).length);
  });
});
