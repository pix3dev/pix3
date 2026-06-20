import { LinearFilter, SRGBColorSpace, type Texture } from 'three';

/**
 * Configures a texture for crisp, correct 2D display in the orthographic overlay:
 * sRGB color space, mipmaps OFF, linear minification.
 *
 * Mipmaps MUST be disabled. On some ANGLE/D3D11 backends (notably Qualcomm Adreno
 * on Windows on ARM), mipmap generation for the frequently non-power-of-two 2D
 * textures uploads the first level as transparent black and three.js caches that
 * empty upload (the texture version never changes again), so the sprite/label
 * renders semi-transparent with its apparent opacity varying by the sampled mip
 * level — i.e. by camera zoom or on-screen size. 2D content is drawn ~1:1 in the
 * orthographic viewport, so mipmaps add no value here regardless.
 *
 * The editor's ViewportRenderService applies the same workaround for its own
 * texture loading; this is the runtime-side equivalent so play mode matches.
 */
export function configure2DTexture(texture: Texture): void {
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
}
