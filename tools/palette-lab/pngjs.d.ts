/**
 * Minimal ambient typing for `pngjs` 5 (the package ships no types and `@types/pngjs` is not
 * installed). Only the sync surface the lab uses is declared.
 */
declare module 'pngjs' {
  export interface PngImage {
    width: number;
    height: number;
    /** RGBA, 8 bits per channel, row-major, origin top-left. */
    data: Buffer;
  }

  export interface PngReadOptions {
    skipRescale?: boolean;
  }

  export interface PngWriteOptions {
    colorType?: 0 | 2 | 4 | 6;
    inputHasAlpha?: boolean;
    deflateLevel?: number;
  }

  export interface PngSync {
    read(buffer: Buffer, options?: PngReadOptions): PngImage;
    write(png: PngImage, options?: PngWriteOptions): Buffer;
  }

  export interface PngStatic {
    sync: PngSync;
  }

  export const PNG: PngStatic;

  const pkg: { PNG: PngStatic };
  export default pkg;
}
