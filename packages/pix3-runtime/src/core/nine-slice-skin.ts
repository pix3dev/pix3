import { BufferGeometry, PlaneGeometry } from 'three';
import { buildTiledSpriteGeometry, type TiledSpriteSliceBorder } from './tiled-sprite-geometry';

/**
 * Nine-slice support for the UI controls whose skin is a single stretched rect
 * (`Button2D`, `Slider2D`, `Bar2D`). They are not `TiledSprite2D` — they own their
 * own meshes and sizing — but the *geometry* question is identical, so the actual
 * slicing runs through the same {@link buildTiledSpriteGeometry} the tiled sprite
 * and its editor proxy use. Nothing here duplicates that math.
 *
 * The contract those controls share:
 *
 * - `sliceBorder` defaults to all-zero, which means "no slicing" and produces the
 *   very same centred `PlaneGeometry(width, height)` the controls always built —
 *   an untouched scene renders and serializes exactly as before.
 * - A non-zero border switches the mesh to a 3x3 patch whose corners keep their
 *   source-pixel size while the edges and centre stretch, so one 64x64 skin fits
 *   a button (or a bar fill) of any size instead of being smeared.
 */

/** Border insets in *source-texture pixels* (Godot's `patch_margin_*`). */
export type SliceBorder2D = TiledSpriteSliceBorder;

/** The neutral border: no slicing, plain stretch. */
export const ZERO_SLICE_BORDER: SliceBorder2D = Object.freeze({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
});

/** Coerce arbitrary authored input into a valid, non-negative border. */
export function normalizeSliceBorder(
  border?: Partial<SliceBorder2D> | null | undefined
): SliceBorder2D {
  const clamp = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    left: clamp(border?.left),
    right: clamp(border?.right),
    top: clamp(border?.top),
    bottom: clamp(border?.bottom),
  };
}

/** True when the border asks for no slicing at all (every inset is zero). */
export function isSliceBorderEmpty(border: SliceBorder2D | undefined | null): boolean {
  if (!border) {
    return true;
  }
  return !(border.left > 0 || border.right > 0 || border.top > 0 || border.bottom > 0);
}

export interface SkinGeometryParams {
  /** On-screen width in design pixels. */
  width: number;
  /** On-screen height in design pixels. */
  height: number;
  /** Natural texture width in px; 0/unknown falls back to the on-screen width. */
  textureWidth?: number;
  /** Natural texture height in px; 0/unknown falls back to the on-screen height. */
  textureHeight?: number;
  border?: SliceBorder2D | null;
}

/**
 * The geometry a skinned UI rect should draw with: an ordinary centred
 * `PlaneGeometry` while the border is empty (bit-for-bit the previous behaviour,
 * and the shape existing specs read `.parameters` off), a 9-slice patch otherwise.
 */
export function buildSkinGeometry(params: SkinGeometryParams): BufferGeometry {
  const width = Math.max(0, Number.isFinite(params.width) ? params.width : 0);
  const height = Math.max(0, Number.isFinite(params.height) ? params.height : 0);
  const border = params.border ?? ZERO_SLICE_BORDER;

  if (isSliceBorderEmpty(border)) {
    return new PlaneGeometry(width, height);
  }

  return buildTiledSpriteGeometry({
    mode: 'nine-slice',
    width,
    height,
    textureWidth: params.textureWidth ?? 0,
    textureHeight: params.textureHeight ?? 0,
    border,
    drawCenter: true,
    axisStretchHorizontal: 'stretch',
    axisStretchVertical: 'stretch',
    tileScale: { x: 1, y: 1 },
    tileOffset: { x: 0, y: 0 },
  });
}
