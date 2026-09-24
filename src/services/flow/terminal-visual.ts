import type { CanvasScreenshot } from '@/core/canvas-screenshot';

export interface TerminalFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/** Decode the encoded game screenshot so the probe judges source pixels, not base64 similarity. */
export const decodeTerminalFrame = async (
  shot: CanvasScreenshot
): Promise<TerminalFrame | null> => {
  const image = new Image();
  image.src = `data:${shot.mimeType};base64,${shot.dataBase64}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = shot.width;
  canvas.height = shot.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, shot.width, shot.height);
  return {
    width: shot.width,
    height: shot.height,
    pixels: context.getImageData(0, 0, shot.width, shot.height).data,
  };
};

/** Fraction of pixels whose RGB values moved visibly across adjacent game-time samples. */
export const terminalVisualChange = (frames: readonly TerminalFrame[]): number[] | null => {
  if (frames.length < 2) return null;
  const { width, height } = frames[0];
  if (
    width <= 0 ||
    height <= 0 ||
    !frames.every(
      frame =>
        frame.width === width &&
        frame.height === height &&
        frame.pixels.length === width * height * 4
    )
  )
    return null;
  const fractions: number[] = [];
  for (let sample = 1; sample < frames.length; sample += 1) {
    const before = frames[sample - 1].pixels;
    const after = frames[sample].pixels;
    let changed = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      if (
        Math.max(
          Math.abs(before[offset] - after[offset]),
          Math.abs(before[offset + 1] - after[offset + 1]),
          Math.abs(before[offset + 2] - after[offset + 2])
        ) >= 32
      ) {
        changed += 1;
      }
    }
    fractions.push(changed / (width * height));
  }
  return fractions;
};
