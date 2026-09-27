import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cliPackageRoot } from './package-root.ts';

/**
 * The CLI's own version, read from its package.json at runtime.
 *
 * Found from the package root (`package-root.ts`), so it works from the sources, the `tsc`
 * output and the single-file published bin alike. The number is the
 * lockstep product version (root `package.json`, stamped by `scripts/update-version.mjs`).
 */
const readVersion = (): string => {
  try {
    const raw = readFileSync(join(cliPackageRoot(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const CLI_VERSION = readVersion();
