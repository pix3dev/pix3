import { afterEach, describe, expect, it } from 'vitest';
import { LinearFilter, NearestFilter, SRGBColorSpace, Texture } from 'three';

import { Sprite2D } from '../nodes/2D/Sprite2D';
import { configure2DTexture } from './configure-2d-texture';
import { setProjectTextureFiltering } from './project-texture-filtering';

describe('configure2DTexture', () => {
  afterEach(() => {
    // Reset the global filtering sink between tests.
    setProjectTextureFiltering('linear');
  });

  it('disables mipmaps and uses linear minification in sRGB', () => {
    const texture = new Texture();
    texture.generateMipmaps = true;
    const versionBefore = texture.version;

    configure2DTexture(texture);

    expect(texture.generateMipmaps).toBe(false);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    // `needsUpdate` is a write-only setter that bumps `version`.
    expect(texture.version).toBeGreaterThan(versionBefore);
  });

  it('uses nearest min/mag filtering when the project is set to nearest', () => {
    setProjectTextureFiltering('nearest');
    const texture = new Texture();

    configure2DTexture(texture);

    expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.generateMipmaps).toBe(false);
  });

  it('Sprite2D.setTexture applies the 2D texture configuration', () => {
    const sprite = new Sprite2D({ id: 'sprite', name: 'tool' });
    const texture = new Texture();
    texture.generateMipmaps = true;

    sprite.setTexture(texture);

    expect(texture.generateMipmaps).toBe(false);
    expect(texture.minFilter).toBe(LinearFilter);
  });
});
