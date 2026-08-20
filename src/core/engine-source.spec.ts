import { describe, expect, it } from 'vitest';

import {
  ENGINE_PATH_PREFIX,
  loadEngineSources,
  readEngineSource,
  resolveEnginePath,
  searchEngineSources,
  toEnginePath,
} from './engine-source';

/**
 * The agent's view of the engine source.
 *
 * Two things are worth pinning here. The **caps** — this is the cheapest tool in the set and
 * therefore the one most likely to be called with a two-letter query, so "there are more matches"
 * has to be reported rather than silently implied by a short list. And the **path tolerance**: a
 * near-miss on a path is a navigation problem, and answering it with suggestions is the difference
 * between one tool call and five.
 */

const sources = new Map<string, string>([
  [
    '@pix3/runtime/src/core/JuiceApi.ts',
    ['export interface ShakeOptions {', '  amplitude?: number;', '  duration?: number;', '}'].join(
      '\n'
    ),
  ],
  [
    '@pix3/runtime/src/nodes/2D/UI/Button2D.ts',
    ['export class Button2D {', '  amplitude = 1;', '}'].join('\n'),
  ],
  ['@pix3/runtime/src/nodes/3D/GeometryMesh.ts', 'export const GEOMETRY_KINDS = [] as const;'],
]);

describe('engine source paths', () => {
  it('maps a build-time module key to the package-relative path an import would use', () => {
    expect(toEnginePath('/repo/packages/pix3-runtime/src/core/JuiceApi.ts')).toBe(
      `${ENGINE_PATH_PREFIX}src/core/JuiceApi.ts`
    );
  });

  it('resolves the full path, the prefix-less form and an unambiguous bare file name', () => {
    expect(resolveEnginePath(sources, '@pix3/runtime/src/core/JuiceApi.ts')).toBe(
      '@pix3/runtime/src/core/JuiceApi.ts'
    );
    expect(resolveEnginePath(sources, 'src/core/JuiceApi.ts')).toBe(
      '@pix3/runtime/src/core/JuiceApi.ts'
    );
    expect(resolveEnginePath(sources, 'JuiceApi.ts')).toBe('@pix3/runtime/src/core/JuiceApi.ts');
  });

  it('answers an unknown path with suggestions instead of a dead end', () => {
    const result = resolveEnginePath(sources, 'src/core/Juice.ts');
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;
    expect(result.error).toContain('No engine source');
    expect(result.suggestions).toContain('@pix3/runtime/src/core/JuiceApi.ts');
  });
});

describe('engine source search', () => {
  it('finds a declaration and reports a line number a read can be anchored on', () => {
    const result = searchEngineSources(sources, { query: 'interface ShakeOptions' });
    expect('matches' in result).toBe(true);
    if (!('matches' in result)) return;
    expect(result.matches).toEqual([
      {
        path: '@pix3/runtime/src/core/JuiceApi.ts',
        line: 1,
        text: 'export interface ShakeOptions {',
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('caps the match list and says so, so a flood reads as "narrow the query"', () => {
    const result = searchEngineSources(sources, { query: 'amplitude', maxMatches: 1 });
    expect('matches' in result).toBe(true);
    if (!('matches' in result)) return;
    expect(result.matches).toHaveLength(1);
    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('honours a path filter and a regex, and refuses a broken pattern', () => {
    const filtered = searchEngineSources(sources, { query: 'amplitude', pathFilter: 'nodes/2D' });
    expect('matches' in filtered && filtered.matches.map(match => match.path)).toEqual([
      '@pix3/runtime/src/nodes/2D/UI/Button2D.ts',
    ]);

    const regex = searchEngineSources(sources, { query: '^export (class|const)', regex: true });
    expect('matches' in regex && regex.matches).toHaveLength(2);

    expect(searchEngineSources(sources, { query: '[unclosed', regex: true })).toEqual({
      error: expect.stringContaining('Invalid regular expression'),
    });
  });

  it('returns context lines when asked, cheaper than reading the file', () => {
    const result = searchEngineSources(sources, { query: 'amplitude?: number', contextLines: 1 });
    expect('matches' in result).toBe(true);
    if (!('matches' in result)) return;
    expect(result.matches[0].context).toEqual([
      'export interface ShakeOptions {',
      '  amplitude?: number;',
      '  duration?: number;',
    ]);
  });
});

describe('engine source read', () => {
  it('reads a line range and reports where it stopped', () => {
    const result = readEngineSource(sources, 'JuiceApi.ts', 2, 2);
    expect('content' in result).toBe(true);
    if (!('content' in result)) return;
    expect(result.content).toBe('  amplitude?: number;\n  duration?: number;');
    expect(result).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4, truncated: true });
  });

  it('does not report more remaining when the slice reached the end', () => {
    const result = readEngineSource(sources, 'JuiceApi.ts', 1, 400);
    expect('truncated' in result && result.truncated).toBe(false);
  });

  it('passes a path error through instead of returning an empty file', () => {
    const result = readEngineSource(sources, 'NoSuchThing.ts');
    expect('error' in result).toBe(true);
  });
});

describe('the shipped engine sources', () => {
  it('are present in the bundle and searchable — the whole premise of the tools', async () => {
    const shipped = await loadEngineSources();
    expect(shipped.size).toBeGreaterThan(100);

    // The exact lookup that cost a compile round-trip before these tools existed.
    const hit = searchEngineSources(shipped, { query: 'export interface ShakeOptions' });
    expect('matches' in hit).toBe(true);
    if (!('matches' in hit)) return;
    expect(hit.matches).toHaveLength(1);

    const file = readEngineSource(shipped, hit.matches[0].path, hit.matches[0].line, 12);
    expect('content' in file && file.content).toContain('amplitude');
  });
});
