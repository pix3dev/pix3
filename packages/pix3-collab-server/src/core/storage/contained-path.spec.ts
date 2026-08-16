// @vitest-environment node
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveContainedPath } from './contained-path.js';

/**
 * Containment, from the attacker's side.
 *
 * Every case here is a path that reached a `writeFileSync` in this server at some point: a `..`
 * ladder out of a project directory, an absolute path, a Windows drive-absolute path, and a sibling
 * directory whose name merely starts with the root's. The happy cases are here too, because a
 * containment check that rejects `sub/dir/file.png` is a containment check nobody keeps.
 */

const ROOT = path.resolve('/srv/pix3/data/projects/p1');

describe('resolveContainedPath', () => {
  it('resolves ordinary relative paths under the root', () => {
    expect(resolveContainedPath(ROOT, 'scene.pix3scene')).toBe(path.join(ROOT, 'scene.pix3scene'));
    expect(resolveContainedPath(ROOT, 'assets/sprites/hero.png')).toBe(
      path.join(ROOT, 'assets', 'sprites', 'hero.png')
    );
    // A `..` that stays inside is legitimate — containment is about the destination, not the spelling.
    expect(resolveContainedPath(ROOT, 'assets/../scene.pix3scene')).toBe(
      path.join(ROOT, 'scene.pix3scene')
    );
  });

  it('rejects a `..` ladder that escapes the root', () => {
    expect(resolveContainedPath(ROOT, '../p2/scene.pix3scene')).toBeNull();
    expect(resolveContainedPath(ROOT, '../../../../etc/cron.d/evil')).toBeNull();
    expect(resolveContainedPath(ROOT, 'a/b/../../../outside.pix3scene')).toBeNull();
  });

  it('rejects an absolute path, which replaces the root rather than joining it', () => {
    expect(resolveContainedPath(ROOT, '/etc/passwd')).toBeNull();
    expect(resolveContainedPath(ROOT, path.resolve('/srv/other/file.ts'))).toBeNull();
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The reason the prefix test appends path.sep.
    const sibling = `${path.basename(ROOT)}-evil`;
    expect(resolveContainedPath(ROOT, `../${sibling}/file.ts`)).toBeNull();
  });

  it('rejects the root itself unless the caller opts in', () => {
    expect(resolveContainedPath(ROOT, '')).toBeNull();
    expect(resolveContainedPath(ROOT, '.')).toBeNull();
    expect(resolveContainedPath(ROOT, 'a/..')).toBeNull();

    expect(resolveContainedPath(ROOT, '', { allowRoot: true })).toBe(ROOT);
    expect(resolveContainedPath(ROOT, '.', { allowRoot: true })).toBe(ROOT);
  });

  it('rejects a non-string, which path.resolve would throw on', () => {
    expect(resolveContainedPath(ROOT, undefined as unknown as string)).toBeNull();
    expect(resolveContainedPath(ROOT, null as unknown as string)).toBeNull();
    expect(resolveContainedPath(ROOT, 42 as unknown as string)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('rejects a Windows drive-absolute path', () => {
    expect(resolveContainedPath(ROOT, 'C:/Windows/System32/evil.ts')).toBeNull();
    expect(resolveContainedPath(ROOT, 'C:\\Windows\\evil.ts')).toBeNull();
  });
});
