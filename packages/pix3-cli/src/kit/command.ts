import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { hasOwnTsconfig } from '../types/project-types.ts';
import { formatKitReport, installKit } from './install.ts';
import { ensureKit } from './kit-source.ts';

/** `pix3 kit [--update] [--project <dir>]`; returns the exit code. */
export const runKitCli = async (options: {
  readonly cwd: string;
  readonly projectDir?: string;
  readonly update: boolean;
}): Promise<number> => {
  const start = options.projectDir ? resolve(options.cwd, options.projectDir) : options.cwd;
  const root = options.projectDir ? start : findProjectRoot(start);
  if (!root || !existsSync(join(root, PROJECT_MANIFEST_FILE))) {
    process.stderr.write(
      `pix3 kit: no ${PROJECT_MANIFEST_FILE} in ${start}${options.projectDir ? '' : ' or any parent folder'}. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  const kit = await ensureKit({ log });
  const runtimeTypes = hasOwnTsconfig(root)
    ? undefined
    : (await import('../types/runtime-types.ts')).ensureRuntimeTypes({ log });
  const report = installKit(root, kit, { update: options.update, runtimeTypes });
  process.stdout.write(formatKitReport(report, root));
  return 0;
};
