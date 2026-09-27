// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runSfx } from './command.ts';
import {
  durationOf,
  encodeWav16,
  mutateSfx,
  renderSfx,
  resolveSfx,
  SAMPLE_RATE,
  SFX_PRESET_NAMES,
  SFX_PRESETS,
} from './synth.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pix3-sfx-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const capture = (cwd: string) => {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      cwd,
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  };
};

const peakOf = (samples: Float32Array): number => {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  return peak;
};

describe('synth', () => {
  it.each(SFX_PRESET_NAMES)('%s renders: expected length, normalised peak, no NaN', name => {
    const params = SFX_PRESETS[name];
    const samples = renderSfx(params);
    expect(samples.length).toBe(Math.round(durationOf(params) * SAMPLE_RATE));
    const durationMs = (samples.length / SAMPLE_RATE) * 1000;
    expect(durationMs).toBeGreaterThan(20);
    expect(durationMs).toBeLessThan(1500);
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(peakOf(samples)).toBeCloseTo(params.volume, 5);
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(1e-6); // faded out, no click
    // Not silence, not a constant: some energy across the body of the sound.
    const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    expect(rms).toBeGreaterThan(0.05);
  });

  it('is deterministic per seed, and a seed varies the sound', () => {
    const a = renderSfx(mutateSfx(SFX_PRESETS.coin, 7), 7);
    const b = renderSfx(mutateSfx(SFX_PRESETS.coin, 7), 7);
    const c = renderSfx(mutateSfx(SFX_PRESETS.coin, 8), 8);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false);
  });

  it('writes a canonical 16-bit mono PCM WAV', () => {
    const samples = new Float32Array([0, 1, -1, 0.5]);
    const wav = encodeWav16(samples);
    const view = new DataView(wav.buffer);
    const ascii = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([1, 2, 3].map(i => view.getInt16(44 + i * 2, true))).toEqual([32767, -32768, 16384]);
  });

  it('maps descriptions to presets, with modifiers', () => {
    expect(resolveSfx('coin')).toMatchObject({ preset: 'coin', modifiers: [] });
    expect(resolveSfx('short high coin pickup')).toMatchObject({
      preset: 'coin',
      modifiers: ['high', 'short'],
    });
    expect(resolveSfx('big exploding barrel')).toMatchObject({ preset: 'explosion' });
    expect(resolveSfx('UI button tap')).toMatchObject({ preset: 'click' });
    expect(resolveSfx('player gets hurt')).toMatchObject({ preset: 'hit' });
    expect(resolveSfx('level up!')).toMatchObject({ preset: 'powerup' });
    expect(resolveSfx('a hop')).toMatchObject({ preset: 'jump' });
    expect(resolveSfx('ambient rain')).toBeNull();
    const low = resolveSfx('low jump');
    expect(low?.params.freq).toBeCloseTo(SFX_PRESETS.jump.freq * 0.7);
  });
});

describe('pix3 sfx', () => {
  it('writes audio/<preset>.wav in the project root by default and reports res://', () => {
    const root = join(scratch, 'project');
    mkdirSync(join(root, 'scenes'), { recursive: true });
    writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\n');
    const { out, io } = capture(join(root, 'scenes'));
    expect(runSfx(['coin', '--json'], io)).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result).toMatchObject({
      path: '../audio/coin.wav',
      res: 'res://audio/coin.wav',
      preset: 'coin',
      seed: null,
    });
    expect(result.durationMs).toBeGreaterThan(100);
    expect(result.params.wave).toBe('square');
    const bytes = readFileSync(join(root, 'audio/coin.wav'));
    expect(bytes.length).toBe(result.bytes);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('--out, --seed, free text, and human output', () => {
    const { out, io } = capture(scratch);
    expect(runSfx(['big', 'explosion', '--out', 'fx/boom.wav', '--seed', '3'], io)).toBe(0);
    expect(out.stdout).toMatch(
      /^wrote fx\/boom\.wav {2}explosion \(big, seed 3\), \d+ ms, [\d.]+ KiB\n$/
    );
    expect(readFileSync(join(scratch, 'fx/boom.wav')).subarray(8, 12).toString('ascii')).toBe(
      'WAVE'
    );
  });

  it('rejects what it cannot do, with exit 2', () => {
    const cases: [string[], string][] = [
      [[], 'say which sound'],
      [['ambient rain'], 'names no preset'],
      [['coin', '--out', 'a.mp3'], 'must end in .wav'],
      [['coin', '--seed', 'x'], '--seed takes a whole number'],
      [['coin', '--seed'], '--seed needs a value'],
      [['coin', '--bogus'], 'unknown option --bogus'],
    ];
    for (const [argv, message] of cases) {
      const { out, io } = capture(scratch);
      expect(runSfx(argv, io)).toBe(2);
      expect(out.stderr).toContain(message);
    }
    const help = capture(scratch);
    expect(runSfx(['--help'], help.io)).toBe(0);
    expect(help.out.stdout).toContain('coin, jump, hit, explosion, powerup, click');
  });
});
