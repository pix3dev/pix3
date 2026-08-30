/**
 * The engine's own source, as read-only ground truth.
 *
 * `@pix3/runtime`'s sources are already shipped into the browser — the code editor's TypeScript
 * worker type-checks project scripts against them — so nothing has to be fetched or installed to
 * read them. What was missing is a way for the **agent** to read them, and that gap is expensive in
 * a measurable way: an agent whose only account of the engine is prose documentation guesses field
 * names, and pays a compile round-trip per guess. Documentation is a summary; this is the contract.
 *
 * Two deliberate choices:
 *
 * - **Package-relative paths** (`@pix3/runtime/src/core/JuiceApi.ts`). That is the specifier a game
 *   script imports from plus the path inside the package, so a name found here can be imported
 *   without translation, and {@link resolveEnginePath} accepts the shorter forms an agent is likely
 *   to type instead of failing on them.
 * - **Read-only, and said out loud.** This is the engine that shipped inside the editor build, not
 *   a file the project can edit. An agent that tried to "fix" it would be writing into a bundle.
 */

/**
 * Raw loaders for every runtime source file, keyed by build-time module path.
 *
 * Shared with the code editor's Monaco libs so the two cannot drift onto different copies of the
 * engine: one glob, two consumers.
 */
export const ENGINE_SOURCE_LOADERS = import.meta.glob(
  [
    '../../packages/pix3-runtime/src/**/*.ts',
    '../../packages/pix3-runtime/src/**/*.js',
    '../../packages/pix3-runtime/src/**/*.json',
  ],
  { query: '?raw', import: 'default' }
) as Record<string, () => Promise<string>>;

/** The prefix every agent-facing engine path carries. */
export const ENGINE_PATH_PREFIX = '@pix3/runtime/';

const PACKAGE_MARKER = 'packages/pix3-runtime/';

/** Longest single line returned by a search hit — a minified or generated line can be enormous. */
const MAX_SEARCH_LINE_CHARS = 240;

/** Default / hard ceiling on search hits. Ceilings exist so the cheapest tool cannot flood a turn. */
const DEFAULT_MAX_MATCHES = 40;
const HARD_MAX_MATCHES = 200;
const HARD_MAX_CONTEXT_LINES = 4;

/** Default / hard ceiling on lines returned by one read, plus a byte cap over the whole slice. */
const DEFAULT_READ_LINES = 200;
const HARD_MAX_READ_LINES = 800;
const MAX_READ_CHARS = 16_000;

/** Suggestions offered when a path does not resolve. */
const MAX_PATH_SUGGESTIONS = 8;

export interface EngineSearchMatch {
  path: string;
  /** 1-based line number, so it can be handed straight to `engine_read`'s offset. */
  line: number;
  text: string;
  /** Surrounding lines when `contextLines` was asked for, in file order, including the hit. */
  context?: string[];
}

export interface EngineSearchResult {
  matches: EngineSearchMatch[];
  matchCount: number;
  /** True when the cap cut the list short — the answer is "there are more", not "that is all". */
  truncated: boolean;
  filesSearched: number;
  /** Off-package topics the query touched — see {@link OFF_PACKAGE_TOPICS}. Omitted when empty. */
  notes?: string[];
}

export interface EngineReadResult {
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}

export interface EnginePathError {
  error: string;
  suggestions?: string[];
}

/** Build-time module key → the package-relative path the agent sees. */
export function toEnginePath(globKey: string): string {
  const index = globKey.indexOf(PACKAGE_MARKER);
  const relative = index >= 0 ? globKey.slice(index + PACKAGE_MARKER.length) : globKey;
  return `${ENGINE_PATH_PREFIX}${relative}`;
}

let cached: ReadonlyMap<string, string> | null = null;
let loading: Promise<ReadonlyMap<string, string>> | null = null;

/**
 * Force-load every runtime source and cache it.
 *
 * The glob is lazy per file, which is right for Monaco (it loads them once, when a code tab opens)
 * and wrong for search, which has to look inside all of them. Paid once per session; it is the same
 * bytes the type worker already holds.
 */
export async function loadEngineSources(): Promise<ReadonlyMap<string, string>> {
  if (cached) {
    return cached;
  }
  if (!loading) {
    loading = (async () => {
      const entries = await Promise.all(
        Object.entries(ENGINE_SOURCE_LOADERS).map(
          async ([key, load]) => [toEnginePath(key), await load()] as const
        )
      );
      cached = new Map(entries);
      return cached;
    })();
  }
  return loading;
}

/** Test seam: drop the cache so a spec can install its own map. */
export function __resetEngineSourceCache(): void {
  cached = null;
  loading = null;
}

/**
 * Resolve whatever an agent typed to a real key.
 *
 * Accepts the full package path, the package-relative path without the prefix, or a bare file name
 * when it is unambiguous — a near-miss on a path is a navigation problem, and answering it with
 * suggestions costs one tool call where a flat failure costs several.
 */
export function resolveEnginePath(
  sources: ReadonlyMap<string, string>,
  requested: string
): string | EnginePathError {
  const wanted = requested.trim().replace(/^\.?\//, '');
  if (!wanted) {
    return { error: 'Empty path.' };
  }
  if (sources.has(wanted)) {
    return wanted;
  }
  const withPrefix = `${ENGINE_PATH_PREFIX}${wanted}`;
  if (sources.has(withPrefix)) {
    return withPrefix;
  }
  const suffix = wanted.startsWith(ENGINE_PATH_PREFIX)
    ? wanted.slice(ENGINE_PATH_PREFIX.length)
    : wanted;
  const endsWith = [...sources.keys()].filter(key => key.endsWith(`/${suffix}`));
  if (endsWith.length === 1) {
    return endsWith[0];
  }
  if (endsWith.length > 1) {
    return {
      error: `"${requested}" matches ${endsWith.length} files — name one.`,
      suggestions: endsWith.slice(0, MAX_PATH_SUGGESTIONS),
    };
  }
  const base = suffix.split('/').pop() ?? suffix;
  const needle = base.toLowerCase().replace(/\.[jt]s$/, '');
  const fuzzy = [...sources.keys()].filter(key => key.toLowerCase().includes(needle));
  return {
    error: `No engine source at "${requested}".`,
    ...(fuzzy.length > 0 ? { suggestions: fuzzy.slice(0, MAX_PATH_SUGGESTIONS) } : {}),
  };
}

/**
 * A capability that lives OUTSIDE `@pix3/runtime/src` and therefore cannot be found by searching it.
 *
 * A search is only ground truth about the tree it searches. When the thing being looked for is
 * wired by the *editor* instead — shipped in the bundle and handed to project scripts through the
 * runtime import map — a silent result reads as "the engine does not have this", which is exactly
 * backwards. That misreading is not hypothetical: one session searched `rigidbody`, then `physics`,
 * then `rapier`, took the absence as an answer, and hand-wrote a 505-line box solver.
 *
 * So the search answers those queries with a note instead of leaving a silence to interpret. Two
 * details are deliberate: the note rides *alongside* whatever matches exist rather than replacing
 * them, and it fires on the **query**, not on the match count — the failure above did get hits
 * (comment mentions), so "zero matches" would have been too narrow a trigger.
 */
export interface OffPackageTopic {
  id: string;
  /** Tested against the raw query. Must not carry the `g` flag: these are reused across calls. */
  pattern: RegExp;
  note: string;
}

export const OFF_PACKAGE_TOPICS: readonly OffPackageTopic[] = [
  {
    id: 'rapier-physics',
    // `gravity` is deliberately absent: Particles3D has its own, so it would fire as pure noise.
    pattern: /rigid.?bod|\bphysics\b|\brapier\b|\bcollider|\bsolver\b/i,
    note:
      'Rigid-body physics is NOT in `@pix3/runtime/src`, so this search cannot see it — an empty ' +
      'or comment-only result here is not evidence the engine has none. Rapier ships inside the ' +
      'editor and reaches project scripts through the runtime import map: ' +
      "`import RAPIER from '@dimforge/rapier3d-compat'`, then `await RAPIER.init()` (a resolved " +
      'stub in the editor, real init in an export) and ' +
      '`new RAPIER.World({ x: 0, y: -9.81, z: 0 })`. It is lazy-loaded (nothing downloads until a ' +
      'compiled bundle mentions the module) and the single-file playable export vendors it, so a ' +
      'game built on it still exports. Use it for 3D rigid bodies only: 2D games stay on the ' +
      "engine's own `Collision2DService` + the `core:Hitbox2D` behaviour, which the editor and the " +
      'verification tools already understand. Do NOT hand-write a solver. Full detail: ' +
      "read_skill('game-prototype', 'Rapier').",
  },
];

/** Notes for every off-package topic a query touches. Exported so a spec can drive the table. */
export function matchOffPackageNotes(query: string): string[] {
  return OFF_PACKAGE_TOPICS.filter(topic => topic.pattern.test(query)).map(topic => topic.note);
}

export interface EngineSearchOptions {
  query: string;
  /** Treat `query` as a JS regular expression instead of a literal substring. */
  regex?: boolean;
  /** Case-insensitive substring of the path, e.g. `nodes/2D` or `JuiceApi`. */
  pathFilter?: string;
  maxMatches?: number;
  contextLines?: number;
}

/** Search the engine sources. Pure over the map so a spec can drive it without the bundle. */
export function searchEngineSources(
  sources: ReadonlyMap<string, string>,
  options: EngineSearchOptions
): EngineSearchResult | { error: string } {
  const query = options.query?.trim() ?? '';
  if (!query) {
    return { error: 'Provide a query.' };
  }
  const cap = clamp(options.maxMatches ?? DEFAULT_MAX_MATCHES, 1, HARD_MAX_MATCHES);
  const contextLines = clamp(options.contextLines ?? 0, 0, HARD_MAX_CONTEXT_LINES);
  const pathFilter = options.pathFilter?.trim().toLowerCase() ?? '';

  let matcher: (line: string) => boolean;
  if (options.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(query);
    } catch (error) {
      return { error: `Invalid regular expression: ${(error as Error).message}` };
    }
    matcher = line => expression.test(line);
  } else {
    const needle = query.toLowerCase();
    matcher = line => line.toLowerCase().includes(needle);
  }

  const matches: EngineSearchMatch[] = [];
  let matchCount = 0;
  let filesSearched = 0;
  // Sorted so the same query answers the same way twice — a search whose order depends on module
  // iteration makes two identical turns look like different worlds.
  for (const path of [...sources.keys()].sort()) {
    if (pathFilter && !path.toLowerCase().includes(pathFilter)) {
      continue;
    }
    filesSearched++;
    const lines = (sources.get(path) ?? '').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!matcher(lines[index])) {
        continue;
      }
      matchCount++;
      if (matches.length >= cap) {
        continue;
      }
      matches.push({
        path,
        line: index + 1,
        text: truncate(lines[index].trimEnd(), MAX_SEARCH_LINE_CHARS),
        ...(contextLines > 0
          ? {
              context: lines
                .slice(Math.max(0, index - contextLines), index + contextLines + 1)
                .map(line => truncate(line.trimEnd(), MAX_SEARCH_LINE_CHARS)),
            }
          : {}),
      });
    }
  }
  const notes = matchOffPackageNotes(query);
  return {
    matches,
    matchCount,
    truncated: matchCount > matches.length,
    filesSearched,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Read a slice of one engine source file. `offset` is a 1-based line number. */
export function readEngineSource(
  sources: ReadonlyMap<string, string>,
  requested: string,
  offset = 1,
  limit = DEFAULT_READ_LINES
): EngineReadResult | EnginePathError {
  const resolved = resolveEnginePath(sources, requested);
  if (typeof resolved !== 'string') {
    return resolved;
  }
  const lines = (sources.get(resolved) ?? '').split('\n');
  const start = clamp(Math.round(offset), 1, Math.max(1, lines.length));
  const count = clamp(Math.round(limit), 1, HARD_MAX_READ_LINES);
  const slice = lines.slice(start - 1, start - 1 + count);
  let content = slice.join('\n');
  let truncated = start - 1 + slice.length < lines.length;
  if (content.length > MAX_READ_CHARS) {
    content = content.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  const returnedLines = content.split('\n').length;
  return {
    path: resolved,
    totalLines: lines.length,
    startLine: start,
    endLine: start + returnedLines - 1,
    content,
    truncated,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
