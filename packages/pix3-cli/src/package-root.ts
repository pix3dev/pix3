import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this package's files live, whichever way the CLI runs:
 *
 * - repo checkout, sources: `node src/index.ts` — this module is `src/package-root.ts`;
 * - `tsc` output: `dist/package-root.js`;
 * - published package: every module is inlined into the single-file bin `dist/index.js`
 *   (`scripts/build-bin.mjs`), so `import.meta.url` is the bin's URL in all of them.
 *
 * A path written relative to "this file" differs between those three, so none is: the package
 * root is found by walking up to the `package.json` named `@pix3/cli`, and everything the CLI
 * reads from its own package (templates, kit, runtime types, the prebuilt validate / smoke
 * bundles) is addressed from that root.
 */

const PACKAGE_NAME = '@pix3/cli';

const isOurPackageJson = (file: string): boolean => {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name === PACKAGE_NAME;
  } catch {
    return false;
  }
};

let cachedRoot: string | undefined;

/** Absolute path of the `@pix3/cli` package root (the folder holding its `package.json`). */
export const cliPackageRoot = (): string => {
  if (cachedRoot !== undefined) return cachedRoot;
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate) && isOurPackageJson(candidate)) return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Unreachable in any supported layout; fall back to the historical "one level up".
  return (cachedRoot = dirname(start));
};

/**
 * True when the CLI runs from its TypeScript sources (a repo checkout, or the specs) rather than
 * from built JavaScript. The sources never use a prebuilt bundle: they rebuild it from the
 * runtime's sources so runtime edits are live, and a stale `dist/` from an earlier build is
 * never picked up.
 */
export const runsFromSources = (): boolean => import.meta.url.endsWith('.ts');

/** `dist/<command>/prebuilt/` — a bundle built at `prepack`, or null when running the sources. */
export const prebuiltDir = (command: 'validate' | 'smoke'): string | null =>
  runsFromSources() ? null : join(cliPackageRoot(), 'dist', command, 'prebuilt');
