import type { Texture } from 'three';

/**
 * A normalized UV sub-rect of a texture. `x`/`y` are the offset of the rect's
 * bottom-left corner (0–1, three.js UV origin bottom-left); `width`/`height` are
 * the normalized size (0–1). Semantics match a three.js texture `offset` /
 * `repeat` pair, so an odometer strip of 10 glyphs stacked vertically shows the
 * n-th digit with `{ x: 0, y: 1 - (n + 1) / 10, width: 1, height: 1 / 10 }`.
 */
export interface TextureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Validate and clamp a region into usable UV space. Offsets clamp to [0,1] and
 * sizes to (0,1]. Returns `null` when the input is missing, non-finite, or has a
 * non-positive size — callers treat `null` as "no region" (full texture).
 */
export function sanitizeTextureRegion(region: TextureRegion | null | undefined): TextureRegion | null {
  if (!region) {
    return null;
  }
  if (
    !isFiniteNumber(region.x) ||
    !isFiniteNumber(region.y) ||
    !isFiniteNumber(region.width) ||
    !isFiniteNumber(region.height)
  ) {
    return null;
  }
  const width = clamp01(region.width);
  const height = clamp01(region.height);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: clamp01(region.x),
    y: clamp01(region.y),
    width,
    height,
  };
}

/**
 * Apply a region to a texture via its `offset`/`repeat`, or reset to the full
 * texture when `region` is `null`. This is the single place the crop maps to
 * three.js, shared by the runtime Sprite2D material and the editor proxy so edit
 * and play modes render identically.
 */
export function applyTextureRegionToTexture(texture: Texture, region: TextureRegion | null): void {
  if (region) {
    texture.offset.set(region.x, region.y);
    texture.repeat.set(region.width, region.height);
  } else {
    texture.offset.set(0, 0);
    texture.repeat.set(1, 1);
  }
}

/**
 * Compose a `local` region (expressed in a source texture's own UV space) into
 * the UV space of an atlas sheet, given the `base` region where that source was
 * packed. Identity when `base` is null (non-atlased texture), and passthrough
 * when `local` is null (no crop — the base frame itself). This is the single
 * mapping that lets a Sprite2D crop or an AnimatedSprite2D frame — authored
 * against the full source texture — sample the correct subrect of a packed sheet.
 *
 * `result = base ∘ local`: the local rect is scaled into the base rect and
 * offset by the base origin, matching three.js `offset`/`repeat` semantics.
 */
export function composeTextureRegion(
  base: TextureRegion | null,
  local: TextureRegion | null
): TextureRegion | null {
  if (!base) {
    return local;
  }
  if (!local) {
    return base;
  }
  return {
    x: base.x + local.x * base.width,
    y: base.y + local.y * base.height,
    width: local.width * base.width,
    height: local.height * base.height,
  };
}

export function isSameTextureRegion(a: TextureRegion | null, b: TextureRegion | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
