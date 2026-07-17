import { LinearFilter, NearestFilter, SRGBColorSpace, type Texture } from 'three';
import { getProjectTextureFiltering } from './project-texture-filtering';

/**
 * Configures a texture for crisp, correct 2D display in the orthographic overlay:
 * sRGB color space, mipmaps OFF, and min/mag filtering per the project's texture
 * filtering setting (linear = smoothed, the default; nearest = crisp pixel-art).
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
  const filter = getProjectTextureFiltering() === 'nearest' ? NearestFilter : LinearFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.needsUpdate = true;
}
