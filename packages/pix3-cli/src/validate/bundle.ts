import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

/**
 * Builds `validate` into a self-contained ESM bundle: the validator, `@pix3/runtime` (from source),
 * three and yaml, split so that `runtime.js` / `three.js` are importable entries sharing their
 * chunks with the validator.
 *
 * Why a bundle at all: `@pix3/runtime` ships TypeScript sources written for a bundler (extensionless
 * imports), which Node cannot load. So:
 * - the published package runs a bundle prebuilt by `scripts/build-validate.mjs` at `prepack`
 *   (`dist/validate/prebuilt/`), and needs neither the runtime nor TypeScript at run time;
 * - a repo checkout (`node packages/pix3-cli/src/index.ts validate`) builds it on the fly into a
 *   temp folder (`entry.ts`), so edits to the runtime are picked up with no build step.
 * `@pix3/runtime` resolves through `tsconfig.json` `paths` (esbuild honours them), the same mapping
 * `tsc` and the root vitest alias use.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

export const VALIDATE_BUNDLE_MAIN = 'bundle-main.js';

/** One three.js: resolve every `three` import from this package, whoever imports it. */
const dedupeThree = (): Plugin => ({
  name: 'pix3-dedupe-three',
  setup(build) {
    build.onResolve({ filter: /^three(\/.*)?$/ }, async args => {
      if (args.pluginData === 'pix3-dedupe-three') return undefined;
      const result = await build.resolve(args.path, {
        kind: args.kind,
        resolveDir: packageRoot,
        pluginData: 'pix3-dedupe-three',
      });
      return result.errors.length > 0 ? undefined : { path: result.path };
    });
  },
});

export interface BuildValidateBundleOptions {
  readonly minify?: boolean;
}

export const buildValidateBundle = async (
  outdir: string,
  options: BuildValidateBundleOptions = {}
): Promise<void> => {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: {
      'bundle-main': join(here, 'bundle-main.ts'),
      runtime: join(here, 'bundle-entries', 'runtime.ts'),
      three: join(here, 'bundle-entries', 'three.ts'),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    // Loaded lazily by level 2 only, and optional.
    external: ['esbuild'],
    // A CommonJS dependency (yaml) calls `require` for Node built-ins.
    banner: {
      js: "import { createRequire as __pix3CreateRequire } from 'node:module'; const require = __pix3CreateRequire(import.meta.url);",
    },
    minify: options.minify === true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [dedupeThree()],
  });
};
