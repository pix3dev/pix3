import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliPackageRoot, prebuiltDir } from '../package-root.ts';

/**
 * Where the smoke bundle (`bundle.ts`) lives, as `index.ts` reaches it — free of runtime imports,
 * so `pix3 new` / `mcp` / `serve` never load it and `node src/index.ts` can import this file as-is.
 *
 * - published package: `dist/smoke/prebuilt/`, built at `prepack` (`scripts/build-smoke.mjs`);
 * - repo checkout (running the `.ts` sources): the prebuilt bundle is never used, even when a
 *   `dist/` from an earlier build exists (`package-root.ts`); it is built into a temp folder first
 *   (well under a second, needs the repo's `esbuild`), which keeps runtime edits live.
 */

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
export { cliPackageRoot };

/** Run `fn` with the folder holding the smoke bundle (a temp build is removed afterwards). */
export const withSmokeBundle = async <T>(fn: (bundleDir: string) => Promise<T>): Promise<T> => {
  const prebuilt = prebuiltDir('smoke');
  if (prebuilt && existsSync(join(prebuilt, SMOKE_WORKER_FILE))) return fn(prebuilt);
  const outdir = mkdtempSync(join(tmpdir(), 'pix3-smoke-bundle-'));
  try {
    const { buildSmokeBundle } = await import('./bundle.ts');
    await buildSmokeBundle(outdir);
    return await fn(outdir);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
};
