import { readFileSync, writeFileSync } from 'node:fs';
import pngjs from 'pngjs';
import type { ImagePixels } from './types';

const { PNG } = pngjs;

/** A mutable RGBA raster the sheet renderer draws into. Same layout as {@link ImagePixels}. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Decode a PNG file into the `ImagePixels` shape `image-ops.ts` expects — RGBA, 8 bits per channel,
 * row-major, origin top-left. pngjs normalises palette / greyscale / 16-bit inputs into that layout
 * for us, which matches what a browser canvas `getImageData` would hand back for the same file.
 */
export const decodePng = (path: string): ImagePixels => {
  const png = PNG.sync.read(readFileSync(path));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
};

export const createRaster = (width: number, height: number): Raster => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

export const encodePng = (raster: Raster, path: string): void => {
  const buffer = PNG.sync.write(
    {
      width: raster.width,
      height: raster.height,
      data: Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength),
    },
    { colorType: 6 }
  );
  writeFileSync(path, buffer);
};
