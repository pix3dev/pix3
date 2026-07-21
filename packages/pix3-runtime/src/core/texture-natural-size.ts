/**
 * The natural (intrinsic) pixel size of a loaded texture's `image`, preferring
 * the `naturalWidth`/`naturalHeight` of an `HTMLImageElement` and falling back
 * to `width`/`height` (canvas / ImageBitmap / raw sources). Both `Sprite2D` and
 * `Sprite3D` need this exact fallback chain when they capture a texture's
 * dimensions — this is the only piece they share (they diverge on everything
 * else: 2D scales a shared quad, 3D rebuilds PlaneGeometry), so keep it this
 * trivial and do NOT grow it into a general sprite-sizing abstraction.
 *
 * Framework-agnostic: takes a plain image-like shape, not a three.js `Texture`.
 */
export interface NaturalTextureSizeSource {
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
}

export function getNaturalTextureSize(image: NaturalTextureSizeSource): {
  width?: number;
  height?: number;
} {
  return {
    width: image.naturalWidth ?? image.width,
    height: image.naturalHeight ?? image.height,
  };
}
