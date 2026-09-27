// Builds `runtime-types/` — the `.d.ts` of `@pix3/runtime` (lockstep with this CLI) plus the
// `@types/three` they reference — which `pix3 new` / `pix3 kit` / `pix3 check` copy into a project's
// `.pix3/types/` so its scripts type-check with no `node_modules`. Runs at `prepack`; a repo
// checkout rebuilds it on demand when the runtime sources change. See `src/types/runtime-types.ts`.
//
// The tarball ships the tree packed into ONE file, `dist/runtime-types.json` (~1 100 small files
// unpacked by npm one by one cost over a second on every `npx` run); the installed CLI expands it
// on first use. Run after `build`, which empties `dist/`.
import { stdout } from 'node:process';

import {
  buildRuntimeTypes,
  packRuntimeTypes,
  runtimeTypesArchive,
} from '../src/types/runtime-types.ts';

buildRuntimeTypes({ log: line => stdout.write(`build-runtime-types: ${line}\n`) });
const packed = packRuntimeTypes();
stdout.write(
  `build-runtime-types: packed ${packed.files} files (${(packed.bytes / 1024).toFixed(0)} KiB) -> ${runtimeTypesArchive()}\n`
);
