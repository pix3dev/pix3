import { describe, expect, it } from 'vitest';
import {
  bundleFileToProjectPath,
  insertTargetDir,
  isTextReferenceFile,
  normalizeBundlePath,
  remapBundleReferences,
} from './library-path-remap';

describe('library-path-remap', () => {
  it('builds target dir and project paths from a slug', () => {
    expect(insertTargetDir('rounded-button')).toBe('assets/library/rounded-button');
    expect(bundleFileToProjectPath('logo.png', 'assets/library/foo')).toBe(
      'assets/library/foo/logo.png'
    );
    expect(bundleFileToProjectPath('textures/btn.png', 'assets/library/foo')).toBe(
      'assets/library/foo/textures/btn.png'
    );
  });

  it('normalizes bundle paths (backslashes, leading ./ and /)', () => {
    expect(normalizeBundlePath('textures\\btn.png')).toBe('textures/btn.png');
    expect(normalizeBundlePath('./a/b.png')).toBe('a/b.png');
    expect(normalizeBundlePath('/a/b.png')).toBe('a/b.png');
  });

  it('prefixes res:// references that match bundle files', () => {
    const yaml = [
      'root:',
      '  - type: Sprite2D',
      '    properties:',
      '      texture:',
      '        type: texture',
      '        url: res://logo.png',
    ].join('\n');
    const out = remapBundleReferences(yaml, ['prefab.pix3scene', 'logo.png'], 'assets/library/foo');
    expect(out).toContain('url: res://assets/library/foo/logo.png');
  });

  it('does not corrupt a longer path whose prefix is another bundle file', () => {
    const text = 'a: res://a/b\nb: res://a/b/c.png';
    const out = remapBundleReferences(text, ['a/b', 'a/b/c.png'], 'lib');
    expect(out).toContain('a: res://lib/a/b\n');
    expect(out).toContain('b: res://lib/a/b/c.png');
    // The longer path must not have been double-prefixed.
    expect(out).not.toContain('res://lib/a/b/c.png/');
    expect(out).not.toContain('res://lib/lib');
  });

  it('respects the right boundary (does not match res://a/b inside res://a/bc)', () => {
    const text = 'x: res://a/bc.png';
    const out = remapBundleReferences(text, ['a/b'], 'lib');
    expect(out).toBe('x: res://a/bc.png');
  });

  it('leaves references to non-bundle files untouched', () => {
    const text = 'url: res://external/thing.png';
    const out = remapBundleReferences(text, ['logo.png'], 'assets/library/foo');
    expect(out).toBe('url: res://external/thing.png');
  });

  it('classifies text-reference files by extension', () => {
    expect(isTextReferenceFile('prefab.pix3scene')).toBe(true);
    expect(isTextReferenceFile('a/b/script.ts')).toBe(true);
    expect(isTextReferenceFile('data.json')).toBe(true);
    expect(isTextReferenceFile('logo.png')).toBe(false);
    expect(isTextReferenceFile('noext')).toBe(false);
  });
});
