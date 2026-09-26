// Generates the agent kit into `kit/` (gitignored, shipped in the tarball) from `kit-src/` templates
// and the repo sources they include (docs/, agent-skills/, the CLI README, the runtime's component
// registry). Runs at `prepack`; a repo checkout regenerates it automatically when stale. See
// `src/kit/generate.ts` for the template directives and `src/kit.spec.ts` for the drift checks.
import { stdout } from 'node:process';

import { buildKitFromCheckout, kitDir } from '../src/kit/kit-source.ts';

const manifest = await buildKitFromCheckout();
stdout.write(
  `build-kit: ${manifest.files.length} files (kit ${manifest.version}, from ${manifest.sources.length} sources) -> ${kitDir()}\n`
);
