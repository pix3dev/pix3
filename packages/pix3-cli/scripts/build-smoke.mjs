// Prebuilds the runtime half of `pix3 smoke` / `pix3 tree --props` into `dist/smoke/prebuilt/` for
// the published package: the smoke worker, the tree defaults, `@pix3/runtime` (from this repo's
// source, lockstep with the CLI version) and three in one esbuild bundle. A repo checkout never
// needs this: `src/smoke/entry.ts` builds the same bundle on the fly. See `src/smoke/bundle.ts`.
import { rmSync } from 'node:fs';
import { stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSmokeBundle } from '../src/smoke/bundle.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(packageRoot, 'dist', 'smoke', 'prebuilt');

rmSync(outdir, { recursive: true, force: true });
await buildSmokeBundle(outdir, { minify: true });
stdout.write(`build-smoke: wrote ${outdir}\n`);
