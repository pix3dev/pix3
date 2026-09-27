import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { findProjectRoot } from '../manifest.ts';
import {
  encodeWav16,
  mutateSfx,
  renderSfx,
  resolveSfx,
  SAMPLE_RATE,
  SFX_PRESET_NAMES,
  type SfxParams,
} from './synth.ts';

/**
 * `pix3 sfx <preset|"text"> [--out audio/x.wav] [--seed n] [--json]` — a sound effect without the
 * editor. Offline, no network, no key, no native module; see `synth.ts`.
 */

export const SFX_USAGE = `Usage: pix3 sfx <preset|"description"> [--out <file.wav>] [--seed <n>] [--json]

Synthesizes a short sound effect offline into a 44.1 kHz 16-bit mono WAV.
  presets     ${SFX_PRESET_NAMES.join(', ')}
  description words that name a preset ("coin pickup", "big explosion"), plus modifiers:
              high/low, short/long, soft
  --out       output file (default: audio/<preset>.wav in the project root)
  --seed      a variation of the preset (same seed, same sound); default: the preset as tuned
  --json      print { path, res, durationMs, preset, seed, modifiers, bytes, peak, params }
Reference it from a scene or script as res://<path inside the project>.
`;

export interface SfxIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface SfxResult {
  /** As written, relative to the current folder, forward slashes. */
  readonly path: string;
  /** `res://…` when the file landed inside a Pix3 project, else null. */
  readonly res: string | null;
  readonly durationMs: number;
  readonly preset: string;
  readonly seed: number | null;
  readonly modifiers: readonly string[];
  readonly bytes: number;
  readonly peak: number;
  readonly params: SfxParams;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

const roundedParams = (params: SfxParams): SfxParams => {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'number' ? round(value) : value;
  }
  return out as unknown as SfxParams;
};

export const runSfx = (argv: readonly string[], io: SfxIo): number => {
  let text: string | undefined;
  let out: string | undefined;
  let seedText: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      io.stdout(SFX_USAGE);
      return 0;
    }
    if (arg === '--json') {
      json = true;
    } else if (arg === '--out' || arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        io.stderr(`pix3 sfx: ${arg} needs a value.\n`);
        return 2;
      }
      if (arg === '--out') out = value;
      else seedText = value;
      i++;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice(6);
    } else if (arg.startsWith('--seed=')) {
      seedText = arg.slice(7);
    } else if (arg.startsWith('--')) {
      io.stderr(`pix3 sfx: unknown option ${arg}.\n\n${SFX_USAGE}`);
      return 2;
    } else {
      text = text === undefined ? arg : `${text} ${arg}`;
    }
  }
  if (text === undefined || text.trim() === '') {
    io.stderr(`pix3 sfx: say which sound.\n\n${SFX_USAGE}`);
    return 2;
  }
  let seed: number | null = null;
  if (seedText !== undefined) {
    const parsed = Number(seedText);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
      io.stderr(`pix3 sfx: --seed takes a whole number 0..4294967295, not "${seedText}".\n`);
      return 2;
    }
    seed = parsed;
  }
  const resolved = resolveSfx(text);
  if (!resolved) {
    io.stderr(
      `pix3 sfx: "${text}" names no preset. Use one of ${SFX_PRESET_NAMES.join(', ')}, or words like "coin pickup", "big explosion", "button click".\n`
    );
    return 2;
  }
  if (out !== undefined && !/\.wav$/i.test(out)) {
    io.stderr(`pix3 sfx: --out must end in .wav (the only format this writes), got "${out}".\n`);
    return 2;
  }

  const params = seed === null ? resolved.params : mutateSfx(resolved.params, seed);
  const samples = renderSfx(params, seed ?? 1);
  const wav = encodeWav16(samples);
  const target =
    out !== undefined
      ? resolve(io.cwd, out)
      : resolve(findProjectRoot(io.cwd) ?? io.cwd, 'audio', `${resolved.preset}.wav`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wav);

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const root = findProjectRoot(dirname(target));
  const inProject = root ? relative(root, target) : null;
  const result: SfxResult = {
    path: relative(io.cwd, target).split(sep).join('/'),
    res:
      inProject && !inProject.startsWith('..') ? `res://${inProject.split(sep).join('/')}` : null,
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    preset: resolved.preset,
    seed,
    modifiers: resolved.modifiers,
    bytes: wav.byteLength,
    peak: round(peak, 3),
    params: roundedParams(params),
  };
  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const how = [
      resolved.modifiers.length > 0 ? resolved.modifiers.join(' ') : null,
      seed !== null ? `seed ${seed}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    io.stdout(
      `wrote ${result.path}  ${result.preset}${how ? ` (${how})` : ''}, ${result.durationMs} ms, ${(result.bytes / 1024).toFixed(1)} KiB` +
        `${result.res ? `\n  use it as ${result.res}` : ''}\n`
    );
  }
  return 0;
};
