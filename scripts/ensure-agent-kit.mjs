// Makes sure the generated agent kit (`packages/pix3-cli/kit/`, gitignored) exists and is current
// before the editor bundles it (`src/services/project/agent-kit/bundled-kit.ts` globs that folder).
// Called by `vite.config.ts` and `vitest.config.ts` at config load, so `npm run dev`, `vite build`
// and every test run see the same kit `pix3 kit` would write. Regenerates only when the kit's
// inputs changed (the CLI's own staleness stamp); a no-op costs a few hundred milliseconds.
import { stdout } from 'node:process';

import { ensureKit } from '../packages/pix3-cli/src/kit/kit-source.ts';

const source = await ensureKit({ log: line => stdout.write(`ensure-agent-kit: ${line}\n`) });
stdout.write(
  `ensure-agent-kit: kit ${source.manifest.version}, ${source.manifest.files.length} files\n`
);
