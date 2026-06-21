import { describe, expect, it } from 'vitest';

import {
  isTextAsset,
  normalizeImportDirectory,
  resolveUniqueAssetName,
} from './AssetImportService';

describe('resolveUniqueAssetName', () => {
  it('returns the original name when there is no collision', () => {
    expect(resolveUniqueAssetName('hero.png', new Set())).toBe('hero.png');
  });

  it('inserts a numeric suffix before the extension on collision', () => {
    expect(resolveUniqueAssetName('hero.png', new Set(['hero.png']))).toBe('hero (1).png');
  });

  it('increments the suffix until a free name is found', () => {
    const used = new Set(['hero.png', 'hero (1).png', 'hero (2).png']);
    expect(resolveUniqueAssetName('hero.png', used)).toBe('hero (3).png');
  });

  it('matches names case-insensitively', () => {
    expect(resolveUniqueAssetName('Hero.PNG', new Set(['hero.png']))).toBe('Hero (1).PNG');
  });

  it('handles names without an extension', () => {
    expect(resolveUniqueAssetName('README', new Set(['readme']))).toBe('README (1)');
  });

  it('treats dotfiles as having no extension', () => {
    expect(resolveUniqueAssetName('.gitignore', new Set(['.gitignore']))).toBe('.gitignore (1)');
  });

  it('preserves multi-dot file names', () => {
    expect(resolveUniqueAssetName('archive.tar.gz', new Set(['archive.tar.gz']))).toBe(
      'archive.tar (1).gz'
    );
  });

  it('does not mutate the provided set', () => {
    const used = new Set(['hero.png']);
    resolveUniqueAssetName('hero.png', used);
    expect(used.size).toBe(1);
  });
});

describe('normalizeImportDirectory', () => {
  it('returns "." for empty/root inputs', () => {
    expect(normalizeImportDirectory('')).toBe('.');
    expect(normalizeImportDirectory('.')).toBe('.');
    expect(normalizeImportDirectory('/')).toBe('.');
  });

  it('strips leading ./, leading and trailing slashes', () => {
    expect(normalizeImportDirectory('./assets/textures/')).toBe('assets/textures');
    expect(normalizeImportDirectory('/assets/textures')).toBe('assets/textures');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeImportDirectory('assets\\textures')).toBe('assets/textures');
  });
});

describe('isTextAsset', () => {
  const makeFile = (name: string, type = ''): File => new File(['x'], name, { type });

  it('treats text/* MIME types as text', () => {
    expect(isTextAsset(makeFile('notes', 'text/plain'))).toBe(true);
  });

  it('treats known text extensions as text', () => {
    expect(isTextAsset(makeFile('scene.pix3scene'))).toBe(true);
    expect(isTextAsset(makeFile('data.json'))).toBe(true);
  });

  it('treats images and unknown binaries as non-text', () => {
    expect(isTextAsset(makeFile('hero.png', 'image/png'))).toBe(false);
    expect(isTextAsset(makeFile('model.glb'))).toBe(false);
  });
});
