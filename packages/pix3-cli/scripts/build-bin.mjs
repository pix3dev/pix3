// Bundles the `pix3` bin into ONE file, `dist/index.js`, with every runtime dependency inlined
// (`yaml`, `@modelcontextprotocol/sdk` and its tree — zod, ajv, … —, `ws`), so the published
// package has zero `dependencies` and a cold `npx -y @pix3/cli@X.Y.Z` fetches one tarball and
// installs nothing (plan §11.1; measured in `.plans/measurements/external-agent-phase0-cold-start.md`).
//
// What stays OUT of the bundle:
// - Node built-ins;
// - `esbuild` and `typescript` — optional, resolved at run time from the installed package
//   (`import.meta.resolve` from the bin: `validate/entry.ts`, `smoke/entry.ts`, `check/typescript.ts`);
// - `bufferutil` / `utf-8-validate` — `ws`'s optional native accelerators, `require`d in a try/catch;
// - the checkout-only modules (`validate/bundle.ts`, `smoke/bundle.ts`, the kit generator): they
//   bundle `@pix3/runtime` from source and only run from a repo checkout, where the bin is never
//   used. They are replaced by a stub that throws if ever reached.
// The prebuilt `dist/validate/prebuilt`, `dist/smoke/prebuilt` bundles, `kit/`, `runtime-types/`
// and `templates/` stay files next to the bin, found through `src/package-root.ts`.
//
// Lazy commands stay lazy: esbuild turns each `await import('./x.ts')` into a deferred module
// init, so `pix3 new` never evaluates the MCP SDK.
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfileFlag = process.argv.indexOf('--outfile');
/** `--outfile <path>`: build elsewhere and leave `dist/` alone (the bin spec uses it). */
const customOutfile = outfileFlag >= 0 ? resolve(process.argv[outfileFlag + 1]) : null;
const outfile = customOutfile ?? join(packageRoot, 'dist', 'index.js');

/** Modules only a repo checkout ever loads (relative to `src/`). */
const CHECKOUT_ONLY = [
  'validate/bundle.ts',
  'smoke/bundle.ts',
  'kit/generate.ts',
  'kit/core-components.ts',
].map(path => join(packageRoot, 'src', path));

const checkoutOnlyStub = {
  name: 'pix3-checkout-only',
  setup(build) {
    build.onResolve({ filter: /\.ts$/ }, args => {
      if (args.kind !== 'dynamic-import') return undefined;
      const path = resolve(args.resolveDir, args.path);
      return CHECKOUT_ONLY.includes(path) ? { path, namespace: 'pix3-checkout-only' } : undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'pix3-checkout-only' }, args => ({
      contents: `throw new Error(${JSON.stringify(
        `${args.path.slice(packageRoot.length + 1)} is only available in a checkout of the pix3 repo ` +
          '(the published @pix3/cli ships its bundles prebuilt)'
      )});`,
      loader: 'js',
    }));
  },
};

// `dist/` holds only what this and the validate / smoke prebuild scripts write.
if (!customOutfile) rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: [join(packageRoot, 'src', 'index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // Resolve package `exports` the way Node does for an ESM import.
  conditions: ['node', 'import'],
  mainFields: ['module', 'main'],
  external: ['esbuild', 'typescript', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (ws, ajv, …) `require` Node built-ins and the optional natives above.
  banner: {
    js: "import { createRequire as __pix3CreateRequire } from 'node:module'; const require = __pix3CreateRequire(import.meta.url);",
  },
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [checkoutOnlyStub],
});

const size = statSync(outfile).size;
stdout.write(`build-bin: wrote ${outfile} (${(size / 1024).toFixed(0)} KiB)\n`);

/** `--metafile <path>`: esbuild's metafile, for the bin spec's check of what stays external. */
const metafileFlag = process.argv.indexOf('--metafile');
if (metafileFlag >= 0)
  writeFileSync(resolve(process.argv[metafileFlag + 1]), JSON.stringify(result.metafile));

// `--meta`: what the bin is made of, by package.
if (process.argv.includes('--meta')) {
  const bytes = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(
    result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs
  )) {
    const name = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input)?.[1] ?? '(@pix3/cli)';
    bytes.set(name, (bytes.get(name) ?? 0) + bytesInOutput);
  }
  for (const [name, total] of [...bytes].sort((a, b) => b[1] - a[1])) {
    stdout.write(`  ${(total / 1024).toFixed(0).padStart(5)} KiB  ${name}\n`);
  }
}
