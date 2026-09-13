// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRepoVersions,
  parseMsBuildVersion,
  resetRepoVersionsCache,
  touchesDeployPaths,
} from './repo-versions.js';

/**
 * "Is production current?" is not the same question as "is production at HEAD".
 *
 * Both deploy workflows fire on a `paths:` filter, so the deployed sha falls behind the branch head
 * every time a sibling part of the repository moves. The dashboard used to read that gap as staleness
 * and reported a backend that was missing nothing as "отстаёт на 15" — fifteen editor commits, none
 * of them touching `packages/pix3-collab-server/`. These tests pin the distinction.
 */

const HEAD_SHA = '82f4e5ef0000000000000000000000000000dead';
const DEPLOYED_SHA = 'baaf4ac0000000000000000000000000000beef0';

interface CompareStub {
  ahead_by: number;
  files: { filename: string }[];
}

/** Answers every URL the loader reaches for; only the compare payload varies per test. */
function stubGitHub(compare: CompareStub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (href.includes('/compare/')) {
        return json(compare);
      }
      if (href.includes('api.github.com')) {
        return json({ sha: HEAD_SHA, commit: { message: 'head', committer: { date: null } } });
      }
      if (href.endsWith('Directory.Build.props')) {
        return new Response(
          '<Project><PropertyGroup><Version>1.6.0</Version></PropertyGroup></Project>'
        );
      }
      if (href.endsWith('public/version.json')) {
        return json({ version: '1.6.0', build: 47 });
      }
      return json({ version: '1.6.0' });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRepoVersionsCache();
});

describe('touchesDeployPaths', () => {
  it('matches a directory entry by prefix', () => {
    expect(
      touchesDeployPaths(
        ['packages/pix3-collab-server/src/index.ts'],
        ['packages/pix3-collab-server/']
      )
    ).toBe(true);
  });

  it('does not let a sibling package under the same parent match', () => {
    expect(
      touchesDeployPaths(['packages/pix3-runtime/src/fw/di.ts'], ['packages/pix3-collab-server/'])
    ).toBe(false);
  });

  it('matches a file entry exactly, not as a prefix', () => {
    expect(touchesDeployPaths(['package-lock.json'], ['package-lock.json'])).toBe(true);
    expect(touchesDeployPaths(['package-lock.json.bak'], ['package-lock.json'])).toBe(false);
  });
});

describe('parseMsBuildVersion', () => {
  it('reads the first <Version> element', () => {
    expect(parseMsBuildVersion('<Project><Version>1.6.0</Version></Project>')).toBe('1.6.0');
  });

  it('returns null for content without one', () => {
    expect(parseMsBuildVersion('<Project />')).toBeNull();
    expect(parseMsBuildVersion(null)).toBeNull();
  });
});

describe('getRepoVersions', () => {
  it('clears the deploy verdict when the range touches nothing the backend ships', async () => {
    stubGitHub({
      ahead_by: 15,
      files: [{ filename: 'src/services/viewport/PeekService.ts' }, { filename: 'docs/CLAUDE.md' }],
    });

    const result = await getRepoVersions({ pix3: DEPLOYED_SHA, rooms: null });

    expect(result.pix3.behindBy).toBe(15);
    expect(result.pix3.deployPathsTouched).toBe(false);
  });

  it('flags the range when the backend itself changed', async () => {
    stubGitHub({
      ahead_by: 3,
      files: [
        { filename: 'src/main.ts' },
        { filename: 'packages/pix3-collab-server/src/core/admin/dashboard-service.ts' },
      ],
    });

    const result = await getRepoVersions({ pix3: DEPLOYED_SHA, rooms: null });

    expect(result.pix3.deployPathsTouched).toBe(true);
  });

  it('refuses to vouch for a truncated file list', async () => {
    stubGitHub({
      ahead_by: 400,
      files: Array.from({ length: 300 }, (_, index) => ({ filename: `src/file-${index}.ts` })),
    });

    const result = await getRepoVersions({ pix3: DEPLOYED_SHA, rooms: null });

    // 300 is the compare endpoint's cap, so "no backend file in the list" is no longer evidence.
    expect(result.pix3.deployPathsTouched).toBeNull();
  });
});
