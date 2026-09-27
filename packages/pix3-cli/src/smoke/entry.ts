import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the smoke bundle (`bundle.ts`) lives, as `index.ts` reaches it — free of runtime imports,
 * so `pix3 new` / `mcp` / `serve` never load it and `node src/index.ts` can import this file as-is.
 *
 * - published package: `dist/smoke/prebuilt/`, built at `prepack` (`scripts/build-smoke.mjs`);
 * - repo checkout: no prebuilt bundle next to this file, so it is built into a temp folder first
 *   (well under a second, needs the repo's `esbuild`), which keeps runtime edits live.
 */

const PREBUILT_DIR = 'prebuilt';
export const SMOKE_WORKER_FILE = 'smoke-worker.mjs';
export const TREE_DEFAULTS_FILE = 'tree-defaults.mjs';

/** `esbuild` as this package sees it (resolved here: a checkout's bundle sits in a temp folder). */
export const resolveEsbuild = (): string | undefined => {
  try {
    return import.meta.resolve('esbuild');
  } catch {
    return undefined;
  }
};

/** This package's root — `three/*` addons a project does not install resolve from here. */
export const cliPackageRoot = (): string => fileURLToPath(new URL('../..', import.meta.url));

/** Run `fn` with the folder holding the smoke bundle (a temp build is removed afterwards). */
export const withSmokeBundle = async <T>(fn: (bundleDir: string) => Promise<T>): Promise<T> => {
  const prebuilt = join(fileURLToPath(new URL('.', import.meta.url)), PREBUILT_DIR);
  if (existsSync(join(prebuilt, SMOKE_WORKER_FILE))) return fn(prebuilt);
  const outdir = mkdtempSync(join(tmpdir(), 'pix3-smoke-bundle-'));
  try {
    const { buildSmokeBundle } = await import('./bundle.ts');
    await buildSmokeBundle(outdir);
    return await fn(outdir);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
};
