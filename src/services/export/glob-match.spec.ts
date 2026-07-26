import { describe, expect, it } from 'vitest';

import { createGlobMatcher, globToRegExp } from '@/services/export/glob-match';

describe('globToRegExp', () => {
  it('matches a literal path exactly', () => {
    const pattern = globToRegExp('src/assets/hero.png');

    expect(pattern.test('src/assets/hero.png')).toBe(true);
    expect(pattern.test('src/assets/hero.png.bak')).toBe(false);
    expect(pattern.test('other/src/assets/hero.png')).toBe(false);
  });

  it('keeps a single star inside one path segment', () => {
    const pattern = globToRegExp('src/assets/*.png');

    expect(pattern.test('src/assets/hero.png')).toBe(true);
    expect(pattern.test('src/assets/ui/hero.png')).toBe(false);
  });

  it('spans path segments with a globstar', () => {
    const pattern = globToRegExp('src/assets/**');

    expect(pattern.test('src/assets/hero.png')).toBe(true);
    expect(pattern.test('src/assets/ui/deep/hero.png')).toBe(true);
    expect(pattern.test('src/other/hero.png')).toBe(false);
  });

  it('lets a globstar segment match zero segments', () => {
    const pattern = globToRegExp('src/**/hero.png');

    expect(pattern.test('src/hero.png')).toBe(true);
    expect(pattern.test('src/assets/hero.png')).toBe(true);
    expect(pattern.test('src/assets/ui/hero.png')).toBe(true);
    expect(pattern.test('assets/hero.png')).toBe(false);
  });

  it('matches exactly one character per question mark', () => {
    const pattern = globToRegExp('frames/ex000?.png');

    expect(pattern.test('frames/ex0001.png')).toBe(true);
    expect(pattern.test('frames/ex0012.png')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    const pattern = globToRegExp('assets/hero(1).png');

    expect(pattern.test('assets/hero(1).png')).toBe(true);
    // `.` must not act as a wildcard.
    expect(pattern.test('assets/heroX1Y.png')).toBe(false);
  });
});

describe('createGlobMatcher', () => {
  it('never matches when no patterns are configured', () => {
    const matches = createGlobMatcher([]);

    expect(matches('anything/at/all.png')).toBe(false);
    expect(matches('')).toBe(false);
  });

  it('matches when any pattern matches', () => {
    const matches = createGlobMatcher(['src/assets/audio/**', '**/*.tmp']);

    expect(matches('src/assets/audio/theme.mp3')).toBe(true);
    expect(matches('scratch/file.tmp')).toBe(true);
    expect(matches('src/assets/textures/hero.png')).toBe(false);
  });
});
