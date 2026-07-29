// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseCommitFromPath, resolveReleaseInfo } from './release-info.js';
import { parseMsBuildVersion, sameCommit } from './repo-versions.js';

/**
 * How the dashboard learns which commit is live.
 *
 * The path parse is the load-bearing half: the collab deploy leaves no version stamp anywhere, so
 * `releases/<sha>/…` in this module's own resolved path is the only record of what was deployed.
 */
describe('parseCommitFromPath', () => {
  it('recovers the sha from a release path', () => {
    expect(
      parseCommitFromPath(
        '/srv/pix3-collab/releases/8f2c1ab9d4e5f60718293a4b5c6d7e8f90123456/packages/pix3-collab-server/dist/core/observability/release-info.js'
      )
    ).toBe('8f2c1ab9d4e5f60718293a4b5c6d7e8f90123456');
  });

  it('handles a windows-style path and lowercases the sha', () => {
    expect(
      parseCommitFromPath(
        'C:\\srv\\pix3\\releases\\ABCDEF1234\\packages\\pix3-collab-server\\dist\\x.js'
      )
    ).toBe('abcdef1234');
  });

  it('finds nothing in a development checkout', () => {
    expect(
      parseCommitFromPath(
        '/home/dev/pix3/packages/pix3-collab-server/src/core/observability/release-info.ts'
      )
    ).toBeNull();
    // 'releases/<branch>' is not a sha, and reporting a branch name as a commit would be worse than null.
    expect(parseCommitFromPath('/srv/app/releases/main/dist/x.js')).toBeNull();
  });
});

describe('sameCommit', () => {
  it('matches a short sha against the full one', () => {
    expect(sameCommit('8f2c1ab', '8f2c1ab9d4e5f60718293a4b5c6d7e8f90123456')).toBe(true);
    expect(sameCommit('8F2C1AB9', '8f2c1ab9d4e5f60718293a4b5c6d7e8f90123456')).toBe(true);
    expect(sameCommit('8f2c1ab', '9012345abcdef')).toBe(false);
  });

  it('refuses a prefix too short to identify a commit, and any missing side', () => {
    expect(sameCommit('8f2c', '8f2c1ab9d4e5')).toBe(false);
    expect(sameCommit(null, '8f2c1ab9d4e5')).toBe(false);
    expect(sameCommit('8f2c1ab9d4e5', null)).toBe(false);
  });
});

/**
 * pix3-rooms declares the shared platform version in MSBuild rather than in a package.json, so the
 * dashboard reads it out of `Directory.Build.props` with a regex — the file is not otherwise this
 * server's business, and a real XML parser to read one element would be the bigger dependency.
 */
describe('parseMsBuildVersion', () => {
  it('reads <Version> out of a props file, comments and all', () => {
    const props = [
      '<Project>',
      '  <PropertyGroup>',
      '    <TargetFramework>net10.0</TargetFramework>',
      '    <!-- The pix3 PLATFORM version, shared with the editor. -->',
      '    <Version>1.2.0</Version>',
      '  </PropertyGroup>',
      '</Project>',
    ].join('\n');

    expect(parseMsBuildVersion(props)).toBe('1.2.0');
    expect(parseMsBuildVersion('<Version>  2.0.1-rc.1  </Version>')).toBe('2.0.1-rc.1');
  });

  it('answers null rather than guessing when the property is absent', () => {
    // TargetFramework is not a version, and neither is an empty element.
    expect(
      parseMsBuildVersion('<Project><TargetFramework>net10.0</TargetFramework></Project>')
    ).toBeNull();
    expect(parseMsBuildVersion('<Version></Version>')).toBeNull();
    expect(parseMsBuildVersion(null)).toBeNull();
  });
});

describe('resolveReleaseInfo', () => {
  it('reports the package version of this workspace', async () => {
    const info = await resolveReleaseInfo();

    // Lockstep with the editor, so it is a real semver and never the 'unknown' fallback.
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.commitSource === null || info.commit).toBeTruthy();
  });
});
