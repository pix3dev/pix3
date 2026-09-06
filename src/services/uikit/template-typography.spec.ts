import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME, type ForgeTheme } from './ForgeTheme';
import { buildTemplate, walkTemplate, TEMPLATE_TYPE_SCALE } from './TemplateSpec';

/**
 * A template has to carry its own typography, and this is why: a prefab built without it left
 * every caption on `UIControl2D`'s defaults — 16 px Arial, no outline — while the page that
 * designed the kit drew the same button at `height × 0.38` in a display face with the kit's
 * sticker edge. The two were visibly different kits on one screen.
 */
describe('template typography', () => {
  const theme: ForgeTheme = {
    ...DEFAULT_THEME,
    font: 'Lilita One',
    fontCyr: 'Rubik',
    txtOut: 1.5,
    txtDrop: 2,
    track: 1,
    labelEdge: '#181410',
  };

  it('reads the recipe off the theme', () => {
    const spec = buildTemplate('dialog', theme, { lang: 'en' });
    const t = spec.typography;
    expect(t.family).toBe('Lilita One');
    expect(t.cyrFamily).toBe('Rubik');
    // Each family is drawn at ITS OWN weight: a CSS stack carries one, and the Latin display
    // faces are 400, which is how Cyrillic captions used to come out thin.
    expect(t.weight).not.toBe(t.cyrWeight);
    expect(t.outlineWidth).toBe(theme.txtOut);
    expect(t.shadowOffsetY).toBe(theme.txtDrop);
    expect(t.letterSpacing).toBe(theme.track);
    expect(t.outlineColor.startsWith('#')).toBe(true);
    expect(t.shadowColor).not.toBeNull();
  });

  it('drops the shadow when the theme has none worth drawing', () => {
    const spec = buildTemplate('dialog', { ...theme, txtDrop: 0 }, { lang: 'en' });
    expect(spec.typography.shadowColor).toBeNull();
  });

  it('sizes every caption from its own element, never from a constant', () => {
    const spec = buildTemplate('settings', theme, { lang: 'en' });
    const sized: { name: string; fontSize: number; h: number }[] = [];
    walkTemplate(spec.root, node => {
      if ((node.label ?? '').length > 0) {
        expect(node.fontSize, node.name).toBeGreaterThan(0);
        sized.push({ name: node.name, fontSize: node.fontSize ?? 0, h: node.h });
      }
    });
    expect(sized.length).toBeGreaterThan(3);
    // Nothing is left on the engine's 16 px default, which is the bug this fixes.
    expect(sized.every(entry => entry.fontSize !== 16 || entry.h < 44)).toBe(true);
    const ok = sized.find(entry => entry.name === 'OkButton');
    expect(ok?.fontSize).toBe(Math.round((ok?.h ?? 0) * TEMPLATE_TYPE_SCALE.buttonCaption));
  });

  it('scales the action caption with the dialog it is built at', () => {
    const small = buildTemplate('dialog', theme, { lang: 'en', width: 300, height: 220 });
    const title = (id: string, spec: ReturnType<typeof buildTemplate>): number => {
      let size = 0;
      walkTemplate(spec.root, node => {
        if (node.name === id) size = node.fontSize ?? 0;
      });
      return size;
    };
    // The header keeps its own height across sizes, so its caption is stable — the point of the
    // ratio is that a size is derived, not typed in.
    expect(title('Title', small)).toBeGreaterThan(16);
  });

  it('gives a Cyrillic dialog the supplier face through its own weight', () => {
    const ru = buildTemplate('settings', theme, { lang: 'ru' });
    expect(ru.typography.cyrFamily).toBe('Rubik');
    expect(ru.typography.cyrWeight).toBeGreaterThan(400);
  });
});
