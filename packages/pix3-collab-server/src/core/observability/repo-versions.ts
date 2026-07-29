import { config } from '../../config.js';

/**
 * What the repositories currently say, so the dashboard can answer "is production current?" without
 * the operator opening GitHub.
 *
 * Two different sources, on purpose:
 *
 * - **`raw.githubusercontent.com`** for the version files. No rate limit worth worrying about, and
 *   `public/version.json` is byte-identical to what GitHub Pages will serve, so comparing it against
 *   `editor.pix3.dev/version.json` is an exact "deployed == repo" check rather than a guess.
 * - **`api.github.com`** for the head commit and the commit distance. Unauthenticated it allows 60
 *   requests/hour per IP, which is why everything here is cached for ten minutes and why a failure
 *   degrades to nulls instead of breaking the dashboard.
 *
 * Both repositories are public; a `DASHBOARD_GITHUB_TOKEN` is optional and only raises the API limit.
 */

/** One repository's current state on its default branch. */
export interface RepoState {
  readonly slug: string;
  readonly branch: string;
  /** Head commit sha, or null when the API call failed. */
  readonly headSha: string | null;
  readonly headCommittedAt: string | null;
  readonly headMessage: string | null;
  /** Commits between the deployed sha and head, when both are known and comparable. */
  readonly behindBy: number | null;
  /** Non-fatal reason the fields above are missing. */
  readonly error: string | null;
}

/** Versions declared in the pix3 repository (editor + cloud ride one number). */
export interface Pix3RepoVersions {
  /** Root `package.json` version — the single source of truth every workspace is stamped from. */
  readonly rootVersion: string | null;
  /** Committed `public/version.json`, i.e. exactly what a Pages deploy would publish. */
  readonly client: {
    version: string;
    build: number;
    displayVersion?: string;
    publishedAt?: string;
  } | null;
  /** `packages/pix3-collab-server/package.json` version. */
  readonly collabServerVersion: string | null;
}

/** Version the pix3-rooms repository declares for itself. */
export interface RoomsRepoVersions {
  /**
   * `<Version>` from its `Directory.Build.props` — the pix3 platform version that repository claims.
   * Its own manifest, not a copy of ours, so a forgotten cross-repo bump stays visible.
   */
  readonly declaredVersion: string | null;
}

/** Everything the dashboard needs about the repositories. */
export interface RepoVersions {
  readonly fetchedAt: string;
  readonly pix3: RepoState & Pix3RepoVersions;
  readonly rooms: RepoState & RoomsRepoVersions;
}

/** How long a fetched answer is reused. Ten minutes keeps API use at ~24 calls/hour. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Floor on forced refreshes, so a held-down refresh button cannot burn the API budget. */
const FORCE_FLOOR_MS = 60 * 1000;

const FETCH_TIMEOUT_MS = 8_000;

interface DeployedShas {
  readonly pix3: string | null;
  readonly rooms: string | null;
}

let cached: RepoVersions | null = null;
let cachedAt = 0;
let inFlight: Promise<RepoVersions> | null = null;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    // GitHub asks for a UA; an anonymous one is answered with 403 often enough to matter.
    'user-agent': 'pix3-collab-server-dashboard',
  };

  if (config.DASHBOARD_GITHUB_TOKEN) {
    headers.authorization = `Bearer ${config.DASHBOARD_GITHUB_TOKEN}`;
  }

  return headers;
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    headers: headers ?? { 'user-agent': 'pix3-collab-server-dashboard' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

function rawUrl(slug: string, branch: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${slug}/${branch}/${filePath}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readVersionField(
  slug: string,
  branch: string,
  filePath: string
): Promise<string | null> {
  try {
    const parsed = await fetchJson<{ version?: unknown }>(rawUrl(slug, branch, filePath));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Extracts `<Version>` from an MSBuild props file. Exported for tests.
 *
 * A regex rather than an XML parser on purpose: the one property we want is a single element in a
 * file this server has no other business understanding, and adding a parser dependency to read one
 * line would be the larger risk. `Directory.Build.props` declares it exactly once — the comment above
 * it in that repository says so — so the first match is the answer.
 */
export function parseMsBuildVersion(content: string | null): string | null {
  if (!content) {
    return null;
  }

  const match = /<Version>\s*([^<\s]+)\s*<\/Version>/i.exec(content);
  return match ? match[1] : null;
}

/** Reads the platform version pix3-rooms declares, straight out of its `Directory.Build.props`. */
async function readRoomsDeclaredVersion(slug: string, branch: string): Promise<string | null> {
  try {
    const response = await fetch(rawUrl(slug, branch, 'Directory.Build.props'), {
      headers: { 'user-agent': 'pix3-collab-server-dashboard' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    return response.ok ? parseMsBuildVersion(await response.text()) : null;
  } catch {
    return null;
  }
}

async function readClientManifest(
  slug: string,
  branch: string
): Promise<Pix3RepoVersions['client']> {
  try {
    const parsed = await fetchJson<Record<string, unknown>>(
      rawUrl(slug, branch, 'public/version.json')
    );
    if (typeof parsed.version !== 'string' || typeof parsed.build !== 'number') {
      return null;
    }

    return {
      version: parsed.version,
      build: parsed.build,
      displayVersion: typeof parsed.displayVersion === 'string' ? parsed.displayVersion : undefined,
      publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function readRepoState(
  slug: string,
  branch: string,
  deployedSha: string | null
): Promise<RepoState> {
  let headSha: string | null = null;
  let headCommittedAt: string | null = null;
  let headMessage: string | null = null;
  let error: string | null = null;

  try {
    const commit = await fetchJson<{
      sha?: string;
      commit?: { message?: string; committer?: { date?: string } };
    }>(`https://api.github.com/repos/${slug}/commits/${branch}`, githubHeaders());

    headSha = typeof commit.sha === 'string' ? commit.sha : null;
    headCommittedAt = commit.commit?.committer?.date ?? null;
    headMessage = commit.commit?.message?.split('\n')[0] ?? null;
  } catch (fetchError) {
    error = errorMessage(fetchError);
  }

  let behindBy: number | null = null;
  if (deployedSha && headSha && !sameCommit(deployedSha, headSha)) {
    try {
      const comparison = await fetchJson<{ behind_by?: number; ahead_by?: number }>(
        `https://api.github.com/repos/${slug}/compare/${deployedSha}...${branch}`,
        githubHeaders()
      );
      // `ahead_by` counts commits the branch has that the deployed sha does not — that is the
      // "how far behind is production" number, despite the field's name being read from the base.
      behindBy = typeof comparison.ahead_by === 'number' ? comparison.ahead_by : null;
    } catch {
      // A force-pushed or garbage-collected deployed sha cannot be compared; the shas alone still tell
      // the operator they differ.
      behindBy = null;
    }
  } else if (deployedSha && headSha) {
    behindBy = 0;
  }

  return { slug, branch, headSha, headCommittedAt, headMessage, behindBy, error };
}

/** True when a short sha and a full sha denote the same commit. */
export function sameCommit(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }

  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const shortest = Math.min(a.length, b.length);
  return shortest >= 7 && a.slice(0, shortest) === b.slice(0, shortest);
}

async function load(deployed: DeployedShas): Promise<RepoVersions> {
  const pix3Slug = config.DASHBOARD_PIX3_REPO;
  const roomsSlug = config.DASHBOARD_ROOMS_REPO;
  const branch = config.DASHBOARD_REPO_BRANCH;

  const [pix3State, rootVersion, client, collabServerVersion, roomsState, roomsDeclaredVersion] =
    await Promise.all([
      readRepoState(pix3Slug, branch, deployed.pix3),
      readVersionField(pix3Slug, branch, 'package.json'),
      readClientManifest(pix3Slug, branch),
      readVersionField(pix3Slug, branch, 'packages/pix3-collab-server/package.json'),
      readRepoState(roomsSlug, branch, deployed.rooms),
      readRoomsDeclaredVersion(roomsSlug, branch),
    ]);

  return {
    fetchedAt: new Date().toISOString(),
    pix3: { ...pix3State, rootVersion, client, collabServerVersion },
    rooms: { ...roomsState, declaredVersion: roomsDeclaredVersion },
  };
}

/**
 * Repository state, cached. `force` re-reads unless the last read was under a minute ago.
 *
 * Concurrent callers share one in-flight fetch: a dashboard auto-refreshing every five seconds must
 * not turn a slow GitHub into a queue of duplicate requests.
 */
export async function getRepoVersions(
  deployed: DeployedShas,
  options: { force?: boolean } = {}
): Promise<RepoVersions> {
  const age = Date.now() - cachedAt;
  const isFresh = cached !== null && age < (options.force ? FORCE_FLOOR_MS : CACHE_TTL_MS);
  if (isFresh && cached) {
    return cached;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = load(deployed)
    .then(result => {
      cached = result;
      cachedAt = Date.now();
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    return await inFlight;
  } catch (error) {
    // Never let a GitHub outage take the dashboard down: serve the previous answer, or an empty one.
    if (cached) {
      return cached;
    }

    const message = errorMessage(error);
    return {
      fetchedAt: new Date().toISOString(),
      pix3: {
        slug: config.DASHBOARD_PIX3_REPO,
        branch: config.DASHBOARD_REPO_BRANCH,
        headSha: null,
        headCommittedAt: null,
        headMessage: null,
        behindBy: null,
        error: message,
        rootVersion: null,
        client: null,
        collabServerVersion: null,
      },
      rooms: {
        slug: config.DASHBOARD_ROOMS_REPO,
        branch: config.DASHBOARD_REPO_BRANCH,
        headSha: null,
        headCommittedAt: null,
        headMessage: null,
        behindBy: null,
        error: message,
        declaredVersion: null,
      },
    };
  }
}

/** Drops the cache. Tests only. */
export function resetRepoVersionsCache(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
