/**
 * Palette lab — runs one palette candidate over a folder of reference PNGs and writes:
 *
 *   <out>/<candidate>.json       palettes + metrics per image
 *   <out>/<candidate>-sheet.png  contact sheet: thumbnail | five swatches on the picture's own bg
 *
 * and prints a Markdown table to stdout.
 *
 *   npx tsx tools/palette-lab/run.ts --candidate baseline --corpus <dir> --out <dir>
 *
 * Pure Node: pngjs decodes and encodes, the palette code is imported straight from
 * `src/services/image-gen/image-ops.ts` (that module has no load-time browser dependencies; only its
 * Blob/canvas entry points touch the DOM, and the lab never calls those).
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, encodePng } from './png';
import { computeMetrics } from './metrics';
import { renderSheet, type SheetRow } from './sheet';
import type { CandidateModule, ImageResult, RunReport } from './types';

interface CliArgs {
  readonly candidate: string;
  readonly corpus: string;
  readonly out: string;
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${key} needs a value`);
      }
      values.set(key, next);
      index += 1;
    }
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) {
      throw new Error(
        `Missing --${key}. Usage: tsx tools/palette-lab/run.ts --candidate <name> --corpus <dir> --out <dir>`
      );
    }
    return value;
  };
  return {
    candidate: required('candidate'),
    corpus: resolve(required('corpus')),
    out: resolve(required('out')),
  };
};

const loadCandidate = async (name: string): Promise<CandidateModule> => {
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Candidate name must be a plain identifier, got ${JSON.stringify(name)}`);
  }
  const url = pathToFileURL(join(import.meta.dirname, 'candidates', `${name}.ts`)).href;
  const mod = (await import(url)) as Partial<CandidateModule>;
  if (!mod.meta || typeof mod.pick !== 'function') {
    throw new Error(`Candidate ${name} must export { meta, pick }`);
  }
  return { meta: mod.meta, pick: mod.pick };
};

const HEX_RE = /^#[0-9a-f]{6}$/;

const validatePalette = (image: string, palette: string[]): void => {
  if (palette.length !== 5) {
    throw new Error(`${image}: candidate returned ${palette.length} colours, expected exactly 5`);
  }
  for (const hex of palette) {
    if (!HEX_RE.test(hex)) {
      throw new Error(`${image}: ${JSON.stringify(hex)} is not lower-case #rrggbb`);
    }
  }
};

const markdownTable = (report: RunReport): string => {
  const header =
    '| image | palette (bg, mid, mid, hazard, player) | accent L̄ / min | accent S̄ | min ΔRGB | hue Δmin | bg:player |';
  const rule = '| --- | --- | --- | --- | --- | --- | --- |';
  const rows = report.images.map(entry => {
    const m = entry.metrics;
    return `| ${entry.image} | \`${entry.palette.join(' ')}\` | ${m.accentMeanL.toFixed(2)} / ${m.accentMinL.toFixed(2)} | ${m.accentMeanS.toFixed(2)} | ${m.minPairwiseRgb.toFixed(0)} | ${m.hueSpreadDeg.toFixed(0)}° | ${m.bgVsPlayerContrast.toFixed(1)} |`;
  });
  return [header, rule, ...rows].join('\n');
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await loadCandidate(args.candidate);
  mkdirSync(args.out, { recursive: true });

  const files = readdirSync(args.corpus)
    .filter(file => extname(file).toLowerCase() === '.png')
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`No .png files in ${args.corpus}`);
  }

  const results: ImageResult[] = [];
  const rows: SheetRow[] = [];
  for (const file of files) {
    const pixels = decodePng(join(args.corpus, file));
    const image = basename(file, extname(file));
    const palette = candidate.pick(pixels);
    validatePalette(image, palette);
    results.push({ image, palette, metrics: computeMetrics(palette) });
    rows.push({ pixels, palette });
    process.stderr.write(`${image} ${pixels.width}x${pixels.height} -> ${palette.join(' ')}\n`);
  }

  const report: RunReport = { candidate: candidate.meta, images: results };
  const jsonPath = join(args.out, `${candidate.meta.name}.json`);
  const sheetPath = join(args.out, `${candidate.meta.name}-sheet.png`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const sheet = renderSheet(rows);
  encodePng(sheet, sheetPath);

  process.stdout.write(`## ${candidate.meta.name} — ${candidate.meta.description}\n\n`);
  process.stdout.write(`${markdownTable(report)}\n\n`);
  process.stdout.write(`json:  ${jsonPath}\nsheet: ${sheetPath} (${sheet.width}x${sheet.height})\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
