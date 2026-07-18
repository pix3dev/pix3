/**
 * Pure, dependency-free MaxRects bin packer (Best-Short-Side-Fit heuristic, no
 * rotation) used by {@link TextureAtlasService} to lay source textures into atlas
 * sheets. Kept editor-side and free of three.js / DOM so it is trivially unit
 * testable: same inputs → same placements, no overlaps, within bounds.
 *
 * Each item reserves `width + padding` × `height + padding` so neighbours keep a
 * `padding` gap (into which the compositor extrudes edge pixels — the bleed
 * guard). New sheets open on overflow; an item larger than a whole empty sheet is
 * reported in `overflow` rather than placed (the caller excludes it).
 */

export interface PackItem {
  id: string;
  width: number;
  height: number;
}

export interface PackPlacement {
  id: string;
  /** Top-left of the frame inside the sheet (px, origin top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackedSheet {
  width: number;
  height: number;
  placements: PackPlacement[];
}

export interface PackResult {
  sheets: PackedSheet[];
  /** Ids of items too large to fit an empty sheet (caller leaves them standalone). */
  overflow: string[];
}

export interface MaxRectsConfig {
  /** Max sheet edge in px (e.g. 2048). Sheets never exceed this. */
  maxSheetSize: number;
  /** Transparent gap reserved on the right/bottom of each frame (px). */
  padding: number;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const roundUpTo = (value: number, multiple: number): number =>
  Math.ceil(value / multiple) * multiple;

export function packMaxRects(items: readonly PackItem[], config: MaxRectsConfig): PackResult {
  const { maxSheetSize, padding } = config;
  const sheets: PackedSheet[] = [];
  const overflow: string[] = [];

  // Largest max-side first packs denser and more deterministically.
  let remaining = [...items].sort((a, b) => {
    const byMaxSide = Math.max(b.width, b.height) - Math.max(a.width, a.height);
    if (byMaxSide !== 0) {
      return byMaxSide;
    }
    const byArea = b.width * b.height - a.width * a.height;
    return byArea !== 0 ? byArea : a.id.localeCompare(b.id);
  });

  // Drop anything that can never fit an empty sheet (with padding footprint).
  remaining = remaining.filter(item => {
    if (item.width + padding > maxSheetSize || item.height + padding > maxSheetSize) {
      overflow.push(item.id);
      return false;
    }
    return true;
  });

  while (remaining.length > 0) {
    const freeRects: FreeRect[] = [{ x: 0, y: 0, w: maxSheetSize, h: maxSheetSize }];
    const placements: PackPlacement[] = [];
    const leftover: PackItem[] = [];
    let usedW = 0;
    let usedH = 0;

    for (const item of remaining) {
      const footprintW = item.width + padding;
      const footprintH = item.height + padding;
      const spot = findBestFreeRect(freeRects, footprintW, footprintH);
      if (!spot) {
        leftover.push(item);
        continue;
      }

      placements.push({ id: item.id, x: spot.x, y: spot.y, width: item.width, height: item.height });
      usedW = Math.max(usedW, spot.x + item.width);
      usedH = Math.max(usedH, spot.y + item.height);
      splitFreeRects(freeRects, { x: spot.x, y: spot.y, w: footprintW, h: footprintH });
      pruneFreeRects(freeRects);
    }

    if (placements.length === 0) {
      // No progress possible — defensive guard against an infinite loop.
      overflow.push(...leftover.map(item => item.id));
      break;
    }

    sheets.push({
      width: Math.min(maxSheetSize, roundUpTo(usedW, 4)),
      height: Math.min(maxSheetSize, roundUpTo(usedH, 4)),
      placements,
    });
    remaining = leftover;
  }

  return { sheets, overflow };
}

/** Best-Short-Side-Fit: the free rect whose smaller leftover dimension is minimal. */
function findBestFreeRect(freeRects: readonly FreeRect[], w: number, h: number): FreeRect | null {
  let best: FreeRect | null = null;
  let bestShortSide = Infinity;
  let bestLongSide = Infinity;

  for (const rect of freeRects) {
    if (rect.w < w || rect.h < h) {
      continue;
    }
    const leftoverH = rect.w - w;
    const leftoverV = rect.h - h;
    const shortSide = Math.min(leftoverH, leftoverV);
    const longSide = Math.max(leftoverH, leftoverV);
    if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
      best = rect;
      bestShortSide = shortSide;
      bestLongSide = longSide;
    }
  }

  return best ? { x: best.x, y: best.y, w, h } : null;
}

/** Replace every free rect overlapping `used` with its non-overlapping remainders. */
function splitFreeRects(freeRects: FreeRect[], used: FreeRect): void {
  for (let i = freeRects.length - 1; i >= 0; i--) {
    const free = freeRects[i];
    if (!overlaps(free, used)) {
      continue;
    }
    freeRects.splice(i, 1);

    // Left slab
    if (used.x > free.x && used.x < free.x + free.w) {
      freeRects.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
    }
    // Right slab
    if (used.x + used.w < free.x + free.w) {
      freeRects.push({
        x: used.x + used.w,
        y: free.y,
        w: free.x + free.w - (used.x + used.w),
        h: free.h,
      });
    }
    // Top slab
    if (used.y > free.y && used.y < free.y + free.h) {
      freeRects.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
    }
    // Bottom slab
    if (used.y + used.h < free.y + free.h) {
      freeRects.push({
        x: free.x,
        y: used.y + used.h,
        w: free.w,
        h: free.y + free.h - (used.y + used.h),
      });
    }
  }
}

/** Drop free rects fully contained by another (MaxRects hygiene). */
function pruneFreeRects(freeRects: FreeRect[]): void {
  for (let i = freeRects.length - 1; i >= 0; i--) {
    for (let j = 0; j < freeRects.length; j++) {
      if (i === j) {
        continue;
      }
      if (contains(freeRects[j], freeRects[i])) {
        freeRects.splice(i, 1);
        break;
      }
    }
  }
}

function overlaps(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
