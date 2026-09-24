import { describe, expect, it } from 'vitest';
import { terminalVisualChange, type TerminalFrame } from './terminal-visual';

const frame = (changed: number, delta: number): TerminalFrame => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4);
  for (let pixel = 0; pixel < changed; pixel += 1) pixels[pixel * 4] = delta;
  return { width: 10, height: 10, pixels };
};

describe('terminalVisualChange', () => {
  it('measures a broad color pulse across independent pixel samples', () => {
    expect(terminalVisualChange([frame(0, 0), frame(30, 200), frame(0, 0)])).toEqual([0.3, 0.3]);
  });

  it('ignores tiny color noise and reports only a small animated region', () => {
    expect(terminalVisualChange([frame(0, 0), frame(8, 31), frame(0, 0)])).toEqual([0, 0]);
    expect(terminalVisualChange([frame(0, 0), frame(8, 100)])).toEqual([0.08]);
  });

  it('rejects incompatible or empty captures', () => {
    expect(terminalVisualChange([frame(0, 0)])).toBeNull();
    expect(
      terminalVisualChange([frame(0, 0), { width: 0, height: 0, pixels: new Uint8ClampedArray() }])
    ).toBeNull();
  });
});
