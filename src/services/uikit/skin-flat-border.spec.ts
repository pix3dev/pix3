import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME } from './ForgeTheme';
import { FLAT_COMPONENTS, buildSkin } from './SkinSpec';

/**
 * Recess and fill parts are drawn without bevelRect's lip and strip gloss, so the generic
 * `sliceBorder()` formula over-reported them: a 240×36 trough came back with insets that met in
 * the middle and `Bar2D` squashed it instead of extending it. These pin that every flat part
 * keeps a stretchable middle on the long axis and that its insets stay at outline + corner arc.
 */
describe('buildSkin — flat parts keep a stretchable middle', () => {
  const theme = { ...DEFAULT_THEME, radius: 7, bevel: 5, outline: 1.5, glossOn: 1 };

  it.each(FLAT_COMPONENTS)('%s at 240×36 has a middle on both axes', component => {
    const part = buildSkin({ component, colorRole: 'sky', width: 240, height: 36 }, theme);
    expect(part.sliceBorder).not.toBeNull();
    const b = part.sliceBorder!;
    expect(b.left + b.right).toBeLessThan(240 * 0.25);
    expect(b.top + b.bottom).toBeLessThan(36);
    for (const v of Object.values(b)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('a pill slider track takes half its height on each side and nothing more', () => {
    const part = buildSkin(
      { component: 'slider-track', colorRole: 'sky', width: 300, height: 24 },
      theme
    );
    const b = part.sliceBorder!;
    expect(b.left).toBeLessThanOrEqual(Math.ceil(1.5 + 12));
    expect(b.left).toBe(b.right);
    expect(b.left + b.right).toBeLessThan(300 / 2);
  });

  it('a bar trough is still not sliceable under skew', () => {
    const part = buildSkin(
      { component: 'bar-trough', colorRole: 'sky', width: 240, height: 36 },
      { ...theme, skew: 6 }
    );
    expect(part.sliceBorder).toBeNull();
  });
});
