import { readFileSync } from 'node:fs';

/**
 * The CLI's own version, read from its package.json at runtime.
 *
 * `src/` and `dist/` both sit one level under the package root, so the same relative URL works
 * when running the sources (`node src/index.ts`) and the published build. The number is the
 * lockstep product version (root `package.json`, stamped by `scripts/update-version.mjs`).
 */
const readVersion = (): string => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const CLI_VERSION = readVersion();
