import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import {
  BUTTON_STATES,
  DEFAULT_THEME,
  buildSkin,
  normalizeTheme,
  presetTheme,
} from '@/services/uikit';
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
  // No network in a spec: the bake's font download answers empty (a warning-free "offline").
  writer.fetchFonts = vi.fn(async () => ({ files: [], warnings: [] }));

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
   * The middle ground: the T0 expander's window prefabs wear exactly one glyph (the dialog's
   * close control), and 4 pictures is a very different bake from the full set's 28.
   */
  it('bakes only the named glyphs when iconButtonGlyphs is given', async () => {
    const { writer } = createWriter();

    const result = await writer.writeKit(normalizeTheme(DEFAULT_THEME), {
      colorRoles: ['green'],
      iconButtonGlyphs: ['close'],
    });

    const icons = Object.values(result.manifest.parts).filter(
      part => part.component === 'icon-button'
    );
    expect(icons).toHaveLength(BUTTON_STATES.length);
    expect(new Set(icons.map(part => part.icon))).toEqual(new Set(['close']));
    expect(result.manifest.parts[iconPartKey('close', 'red', 'normal')]).toBeDefined();
    expect(result.manifest.parts[iconPartKey('gear', 'bluegray', 'normal')]).toBeUndefined();
  });

  it('ignores iconButtonGlyphs when the glyphs are switched off entirely', async () => {
    const { writer } = createWriter();

    const result = await writer.writeKit(normalizeTheme(DEFAULT_THEME), {
      colorRoles: ['green'],
      iconButtons: false,
      iconButtonGlyphs: ['close'],
    });

    expect(
      Object.values(result.manifest.parts).filter(part => part.component === 'icon-button')
    ).toHaveLength(0);
  });

  /**
   * The manifest is what reaches `Bar2D.sliceBorder*`, so a wrong number here squashes a trough
   * in the game even though the generator knew better. The writer used to re-derive the insets
   * with the general `bevelRect` formula, which on a 240x36 trough returns caps that meet in the
   * middle; the recess shapes have their own arithmetic and it has to survive into the file.
   */
  it('warns once about a theme that cannot be sliced, and never about a glyph button', async () => {
    const { writer } = createWriter();
    const skewed = normalizeTheme({ ...DEFAULT_THEME, skew: 6 });

    const result = await writer.writeKit(skewed, { colorRoles: ['sky'], scale: 1 });

    // A glyph button is unsliceable by construction (its icon sits where a nine-slice stretches),
    // so 28 identical lines about it would bury the message that matters.
    expect(result.warnings.some(w => w.startsWith('icon-button/'))).toBe(false);
    expect(result.warnings.some(w => /skew\/puffy/.test(w))).toBe(true);
    expect(result.manifest.parts[partKey('panel-body', 'sky')].sliceBorder).toBeNull();
  });

  it('keeps a stretchable middle for the recess and fill parts', async () => {
    const { writer } = createWriter();
    const theme = normalizeTheme({ ...DEFAULT_THEME, radius: 7, bevel: 5, outline: 1.5 });

    const result = await writer.writeKit(theme, {
      colorRoles: ['sky'],
      scale: 2,
      iconButtons: false,
    });

    for (const key of ['bar-trough', 'slot', 'slider-track']) {
      const record = result.manifest.parts[partKey(key as never)];
      expect(record, key).toBeDefined();
      const border = record.sliceBorder;
      expect(border, key).not.toBeNull();
      if (!border) continue;
      // Opposite caps leave a middle to stretch — the property that was lost.
      expect(border.left + border.right, `${key} horizontal`).toBeLessThan(record.w);
      expect(border.top + border.bottom, `${key} vertical`).toBeLessThan(record.h);
    }
  });

  /**
   * Caught live, not by a test: the manifest carried a 228 px top inset for a 512 px panel while
   * `buildSkin` reported 66, because the insets were re-derived from the AUTHOR's theme instead
   * of the one the part was drawn with (the two differ by exactly the gloss cap). The manifest
   * now records the generator's own answer, scaled — this pins that the two agree.
   */
  it("records the generator's own border, gloss cap included", async () => {
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
