// Prebuilds `pix3 validate` into `dist/validate/prebuilt/` for the published package: the validator,
// `@pix3/runtime` (from this repo's source, lockstep with the CLI version), three and yaml in one
// esbuild bundle, so the installed CLI needs neither the runtime's TypeScript sources nor a
// bundler at run time. A repo checkout never needs this: `src/validate/entry.ts` builds the same
// bundle on the fly. See `src/validate/bundle.ts`.
import { rmSync } from 'node:fs';
import { stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildValidateBundle } from '../src/validate/bundle.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(packageRoot, 'dist', 'validate', 'prebuilt');

rmSync(outdir, { recursive: true, force: true });
await buildValidateBundle(outdir, { minify: true });
stdout.write(`build-validate: wrote ${outdir}\n`);
