import { describe, expect, it } from 'vitest';
import { buildTiledSpriteGeometry, type TiledSpriteGeometryParams } from './tiled-sprite-geometry';

function baseParams(overrides: Partial<TiledSpriteGeometryParams> = {}): TiledSpriteGeometryParams {
  return {
    mode: 'stretch',
    width: 100,
    height: 100,
    textureWidth: 100,
    textureHeight: 100,
    border: { left: 0, right: 0, top: 0, bottom: 0 },
    drawCenter: true,
    axisStretchHorizontal: 'stretch',
    axisStretchVertical: 'stretch',
    tileScale: { x: 1, y: 1 },
    tileOffset: { x: 0, y: 0 },
    ...overrides,
  };
}

/** Each quad is 2 triangles = 6 vertices. */
function quadCount(params: TiledSpriteGeometryParams): number {
  const geometry = buildTiledSpriteGeometry(params);
  const position = geometry.getAttribute('position');
  return position.count / 6;
}

function uvRange(params: TiledSpriteGeometryParams): { min: number; max: number } {
  const geometry = buildTiledSpriteGeometry(params);
  const uv = geometry.getAttribute('uv');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < uv.count; i += 1) {
    min = Math.min(min, uv.getX(i), uv.getY(i));
    max = Math.max(max, uv.getX(i), uv.getY(i));
  }
  return { min, max };
}

describe('buildTiledSpriteGeometry', () => {
  it('stretch mode emits a single quad spanning the full UV range', () => {
    const params = baseParams({ mode: 'stretch' });
    expect(quadCount(params)).toBe(1);
    const { min, max } = uvRange(params);
    expect(min).toBeCloseTo(0);
    expect(max).toBeCloseTo(1);
  });

  it('centers geometry so the bounding box matches width/height', () => {
    const geometry = buildTiledSpriteGeometry(baseParams({ width: 200, height: 120 }));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(-100);
    expect(box.max.x).toBeCloseTo(100);
    expect(box.min.y).toBeCloseTo(-60);
    expect(box.max.y).toBeCloseTo(60);
  });

  it('tile mode repeats the texture by natural size', () => {
    // 200 / 100 = 2 tiles X, 150 / 75 = 2 tiles Y -> 4 quads.
    const params = baseParams({
      mode: 'tile',
      width: 200,
      height: 150,
      textureWidth: 100,
      textureHeight: 75,
    });
    expect(quadCount(params)).toBe(4);
  });

  it('tile mode honors tileScale', () => {
    // tileScale 2 -> tile is 200px, so 200px rect = 1 tile per axis.
    const params = baseParams({
      mode: 'tile',
      width: 200,
      height: 200,
      textureWidth: 100,
      textureHeight: 100,
      tileScale: { x: 2, y: 2 },
    });
    expect(quadCount(params)).toBe(1);
  });

  it('tile mode splits an extra partial tile when offset is applied', () => {
    // offset 0.5 tile in X -> partial + full + partial = 3 segments in X, 2 in Y.
    const params = baseParams({
      mode: 'tile',
      width: 200,
      height: 150,
      textureWidth: 100,
      textureHeight: 75,
      tileOffset: { x: 0.5, y: 0 },
    });
    expect(quadCount(params)).toBe(6);
  });

  it('nine-slice emits a 3x3 grid of quads', () => {
    const params = baseParams({
      mode: 'nine-slice',
      border: { left: 10, right: 10, top: 10, bottom: 10 },
    });
    expect(quadCount(params)).toBe(9);
  });

  it('nine-slice drops the center quad when drawCenter is false', () => {
    const params = baseParams({
      mode: 'nine-slice',
      border: { left: 10, right: 10, top: 10, bottom: 10 },
      drawCenter: false,
    });
    expect(quadCount(params)).toBe(8);
  });

  it('nine-slice maps corner UVs to the border insets', () => {
    const geometry = buildTiledSpriteGeometry(
      baseParams({
        mode: 'nine-slice',
        width: 100,
        height: 100,
        textureWidth: 100,
        textureHeight: 100,
        border: { left: 10, right: 10, top: 10, bottom: 10 },
      })
    );
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');

    // Find the bottom-left-most vertex (x=-50, y=-50) and confirm its UV is (0,0).
    let found = false;
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getX(i) + 50) < 1e-3 && Math.abs(position.getY(i) + 50) < 1e-3) {
        expect(uv.getX(i)).toBeCloseTo(0);
        expect(uv.getY(i)).toBeCloseTo(0);
        found = true;
      }
      // The inner corner of the bottom-left patch sits at (-40, -40) -> UV (0.1, 0.1).
      if (Math.abs(position.getX(i) + 40) < 1e-3 && Math.abs(position.getY(i) + 40) < 1e-3) {
        expect(uv.getX(i)).toBeCloseTo(0.1);
        expect(uv.getY(i)).toBeCloseTo(0.1);
      }
    }
    expect(found).toBe(true);
  });

  it('tiled 9-slice edges subdivide into more quads than a stretched 9-slice', () => {
    const params = baseParams({
      mode: 'nine-slice',
      width: 400,
      height: 100,
      textureWidth: 100,
      textureHeight: 100,
      border: { left: 10, right: 10, top: 10, bottom: 10 },
      axisStretchHorizontal: 'tile',
    });
    // Middle source width = 80px; middle screen width = 380px -> ~5 horizontal tiles
    // in the 3 horizontal-middle cells. Definitely more than the stretched 9.
    expect(quadCount(params)).toBeGreaterThan(9);
  });

  it('three-slice-h ignores the top/bottom borders (3 quads)', () => {
    const params = baseParams({
      mode: 'three-slice-h',
      width: 300,
      height: 40,
      border: { left: 10, right: 10, top: 20, bottom: 20 },
    });
    expect(quadCount(params)).toBe(3);
  });

  it('three-slice-v ignores the left/right borders (3 quads)', () => {
    const params = baseParams({
      mode: 'three-slice-v',
      width: 40,
      height: 300,
      border: { left: 20, right: 20, top: 10, bottom: 10 },
    });
    expect(quadCount(params)).toBe(3);
  });

  it('produces valid (non-NaN) attributes for a zero-border nine-slice', () => {
    const geometry = buildTiledSpriteGeometry(
      baseParams({ mode: 'nine-slice', border: { left: 0, right: 0, top: 0, bottom: 0 } })
    );
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      expect(Number.isFinite(position.getX(i))).toBe(true);
      expect(Number.isFinite(position.getY(i))).toBe(true);
    }
  });
});
