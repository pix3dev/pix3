import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `pix3 validate` as `index.ts` reaches it — deliberately free of runtime imports, so `pix3 new` /
 * `pix3 mcp` never pay for the validator and `node src/index.ts` can load this file directly.
 *
 * The validator itself always runs from an esbuild bundle (see `bundle.ts` for why):
 * - published package: `dist/validate/prebuilt/bundle-main.js`, built at `prepack`;
 * - repo checkout: no prebuilt bundle next to this file, so it is built into a temp folder first
 *   (~0.5 s, needs the repo's `esbuild`), which keeps runtime edits live without a build step.
 */

interface BundledValidate {
  runBundledValidate(
    argv: readonly string[],
    io: {
      cwd: string;
      stdout: (text: string) => void;
      stderr: (text: string) => void;
      esbuildSpecifier?: string;
    }
  ): Promise<number>;
}

const PREBUILT_DIR = 'prebuilt';
const BUNDLE_MAIN = 'bundle-main.js';

/**
 * `esbuild` as this package sees it (an optional dependency when published, the repo's in a
 * checkout). Resolved here, not in the bundle: a checkout's bundle lives in a temp folder.
 */
const resolveEsbuild = (): string | undefined => {
  try {
    return import.meta.resolve('esbuild');
  } catch {
    return undefined;
  }
};

const runFrom = async (dir: string, argv: readonly string[]): Promise<number> => {
  const specifier = pathToFileURL(join(dir, BUNDLE_MAIN)).href;
  const bundle = (await import(specifier)) as BundledValidate;
  return bundle.runBundledValidate(argv, {
    cwd: process.cwd(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    esbuildSpecifier: resolveEsbuild(),
  });
};

/** Run `pix3 validate` with the arguments after the command word; resolves to the exit code. */
export const runValidateCli = async (argv: readonly string[]): Promise<number> => {
  const prebuilt = join(fileURLToPath(new URL('.', import.meta.url)), PREBUILT_DIR);
  if (existsSync(join(prebuilt, BUNDLE_MAIN))) {
    return runFrom(prebuilt, argv);
  }
  // Repo checkout: build the bundle from source first.
  const outdir = mkdtempSync(join(tmpdir(), 'pix3-validate-bundle-'));
  try {
    const { buildValidateBundle } = await import('./bundle.ts');
    await buildValidateBundle(outdir);
    return await runFrom(outdir, argv);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
};
