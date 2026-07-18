import { describe, it, expect } from 'vitest';
import { packMaxRects, type PackItem, type PackPlacement } from './MaxRectsPacker';

function allPlacements(items: PackItem[], padding = 2, maxSheetSize = 256) {
  const result = packMaxRects(items, { maxSheetSize, padding });
  const flat: Array<PackPlacement & { sheet: number }> = [];
  result.sheets.forEach((sheet, index) => {
    for (const placement of sheet.placements) {
      flat.push({ ...placement, sheet: index });
    }
  });
  return { result, flat };
}

function overlaps(a: PackPlacement, b: PackPlacement, padding: number): boolean {
  // Footprints (frame + padding gap) must not overlap.
  const ax2 = a.x + a.width + padding;
  const ay2 = a.y + a.height + padding;
  const bx2 = b.x + b.width + padding;
  const by2 = b.y + b.height + padding;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

describe('packMaxRects', () => {
  it('places every item exactly once with no footprint overlap', () => {
    const items: PackItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      width: 16 + (i % 5) * 8,
      height: 16 + (i % 3) * 10,
    }));
    const { result, flat } = allPlacements(items, 2, 256);

    expect(result.overflow).toEqual([]);
    expect(flat).toHaveLength(items.length);
    const ids = new Set(flat.map(p => p.id));
    expect(ids.size).toBe(items.length);

    // Only compare placements within the same sheet.
    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        if (flat[i].sheet !== flat[j].sheet) {
          continue;
        }
        expect(overlaps(flat[i], flat[j], 2)).toBe(false);
      }
    }
  });

  it('keeps every frame within its sheet bounds', () => {
    const items: PackItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      width: 40,
      height: 40,
    }));
    const { result } = allPlacements(items, 2, 256);
    for (const sheet of result.sheets) {
      expect(sheet.width).toBeLessThanOrEqual(256);
      expect(sheet.height).toBeLessThanOrEqual(256);
      for (const placement of sheet.placements) {
        expect(placement.x + placement.width).toBeLessThanOrEqual(sheet.width);
        expect(placement.y + placement.height).toBeLessThanOrEqual(sheet.height);
      }
    }
  });

  it('opens additional sheets when items overflow one sheet', () => {
    // 10 frames of 100x100 (footprint 102) cannot all fit a 256 sheet (2 per row/col).
    const items: PackItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `big${i}`,
      width: 100,
      height: 100,
    }));
    const { result, flat } = allPlacements(items, 2, 256);
    expect(result.overflow).toEqual([]);
    expect(result.sheets.length).toBeGreaterThan(1);
    expect(flat).toHaveLength(items.length);
  });

  it('reports items too large for an empty sheet as overflow, not placed', () => {
    const items: PackItem[] = [
      { id: 'ok', width: 32, height: 32 },
      { id: 'huge', width: 300, height: 32 },
    ];
    const { result, flat } = allPlacements(items, 2, 256);
    expect(result.overflow).toContain('huge');
    expect(flat.map(p => p.id)).toEqual(['ok']);
  });

  it('is deterministic for the same input', () => {
    const items: PackItem[] = Array.from({ length: 15 }, (_, i) => ({
      id: `f${i}`,
      width: 20 + i,
      height: 30,
    }));
    const a = packMaxRects(items, { maxSheetSize: 256, padding: 2 });
    const b = packMaxRects(items, { maxSheetSize: 256, padding: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
