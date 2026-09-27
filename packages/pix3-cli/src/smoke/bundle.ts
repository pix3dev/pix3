import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

/**
 * Builds the runtime-carrying half of `pix3 smoke` (and of `pix3 tree --props`) into one ESM
 * bundle, the way `validate/bundle.ts` does for the validator and for the same reason:
 * `@pix3/runtime` ships TypeScript sources written for a bundler, which Node cannot load.
 *
 * Entries (all `.mjs`, so Node treats them as ESM wherever the folder lives):
 * - `smoke-worker` — the worker-thread entry that runs a game (`worker.ts`);
 * - `tree-defaults` — per-node-type default property values for `pix3 tree --props`;
 * - `runtime` / `three` — what compiled project scripts import, sharing their chunks with the
 *   worker so `instanceof Script` holds across the seam.
 *
 * Published package: prebuilt into `dist/smoke/prebuilt/` at `prepack` (`scripts/build-smoke.mjs`).
 * Repo checkout: `entry.ts` builds it into a temp folder on demand, so runtime edits are live.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

/** One three.js: resolve every `three` import from this package, whoever imports it. */
const dedupeThree = (): Plugin => ({
  name: 'pix3-smoke-dedupe-three',
  setup(build) {
    build.onResolve({ filter: /^three(\/.*)?$/ }, async args => {
      if (args.pluginData === 'pix3-smoke-dedupe-three') return undefined;
      const result = await build.resolve(args.path, {
        kind: args.kind,
        resolveDir: packageRoot,
        pluginData: 'pix3-smoke-dedupe-three',
      });
      return result.errors.length > 0 ? undefined : { path: result.path };
    });
  },
});

export const buildSmokeBundle = async (
  outdir: string,
  options: { readonly minify?: boolean } = {}
): Promise<void> => {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: {
      'smoke-worker': join(here, 'worker.ts'),
      'tree-defaults': join(here, '..', 'tree', 'defaults.ts'),
      runtime: join(here, 'bundle-entries', 'runtime.ts'),
      three: join(here, 'bundle-entries', 'three.ts'),
    },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    // Loaded lazily to compile the project's scripts, and optional.
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
