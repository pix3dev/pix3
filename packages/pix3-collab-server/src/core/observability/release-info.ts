import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * What this backend *is*: its package version and the commit it was deployed from.
 *
 * The version alone cannot answer "is production current?" — it is lockstep with the editor and
 * therefore identical across every deploy inside one release. The commit can, and there are two
 * places to get it, in order of trust:
 *
 * 1. `PIX3_RELEASE_SHA` / `RELEASE_SHA` in the environment, if the host chooses to set it.
 * 2. The deploy layout itself: `deploy-collab-server.yml` unpacks each release into
 *    `releases/<sha>/packages/pix3-collab-server` and points `current` at it. Node resolves symlinks
 *    when loading modules, so this module's own path carries the sha — no build-time stamping and no
 *    extra deploy step needed.
 */

/** Deployed identity of this process. */
export interface ReleaseInfo {
  /** `package.json` version of `@pix3/collab-server` (lockstep with the editor's). */
  readonly version: string;
  /** Git sha this release was deployed from, or null when it cannot be established. */
  readonly commit: string | null;
  /** How the commit was found, for when the answer is surprising. */
  readonly commitSource: 'env' | 'release-path' | null;
}

const RELEASE_PATH_PATTERN = /[/\\]releases[/\\]([0-9a-f]{7,40})[/\\]/i;

function readCommitFromEnvironment(): string | null {
  for (const key of ['PIX3_RELEASE_SHA', 'RELEASE_SHA', 'GIT_COMMIT'] as const) {
    const value = process.env[key]?.trim();
    if (value && /^[0-9a-f]{7,40}$/i.test(value)) {
      return value.toLowerCase();
    }
  }

  return null;
}

/** Extracts a release sha out of a filesystem path. Exported for tests. */
export function parseCommitFromPath(modulePath: string): string | null {
  const match = RELEASE_PATH_PATTERN.exec(modulePath);
  return match ? match[1].toLowerCase() : null;
}

let cached: ReleaseInfo | null = null;

/**
 * Reads the deployed identity once and caches it: neither the version nor the commit can change
 * without restarting the process.
 */
export async function resolveReleaseInfo(): Promise<ReleaseInfo> {
  if (cached) {
    return cached;
  }

  const modulePath = fileURLToPath(import.meta.url);
  const envCommit = readCommitFromEnvironment();
  const pathCommit = parseCommitFromPath(modulePath);

  cached = {
    version: await readPackageVersion(modulePath),
    commit: envCommit ?? pathCommit,
    commitSource: envCommit ? 'env' : pathCommit ? 'release-path' : null,
  };

  return cached;
}

/**
 * Reads the workspace package's own version.
 *
 * `dist/` mirrors `src/`, so the package root is three levels up from this module either way — as
 * `src/core/observability/release-info.ts` under `tsx` and as `dist/core/observability/release-info.js`
 * in production.
 */
async function readPackageVersion(modulePath: string): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(modulePath), '../../../package.json');

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
