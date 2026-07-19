import { describe, expect, it } from 'vitest';

import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_BY_ID,
  categorizeAssetPath,
  getAssetPathExtension,
  groupedCategoryExpansionKey,
  groupedDirectoryExpansionKey,
  splitGroupedDirectoryExpansionKey,
} from './asset-categories';

describe('asset-categories', () => {
  it('classifies extensions into categories case-insensitively', () => {
    expect(categorizeAssetPath('scenes/Main.pix3scene')).toBe('scenes');
    expect(categorizeAssetPath('prefabs/Enemy.PIX3SCENE')).toBe('scenes');
    expect(categorizeAssetPath('assets/sprites/ui/button.png')).toBe('images');
    expect(categorizeAssetPath('icon.SVG')).toBe('images');
    expect(categorizeAssetPath('models/robot.glb')).toBe('models');
    expect(categorizeAssetPath('audio/theme.mp3')).toBe('audio');
    expect(categorizeAssetPath('anims/walk.pix3anim')).toBe('animations');
    expect(categorizeAssetPath('scripts/player.ts')).toBe('scripts');
    expect(categorizeAssetPath('fonts/Inter.woff2')).toBe('fonts');
    expect(categorizeAssetPath('media/intro.mp4')).toBe('video');
    expect(categorizeAssetPath('config/settings.json')).toBe('data');
  });

  it('classifies locale tables by their locales/ directory', () => {
    expect(categorizeAssetPath('locales/en.json')).toBe('locales');
    expect(categorizeAssetPath('locales/ru.json')).toBe('locales');
    expect(categorizeAssetPath('res://locales/de.json')).toBe('locales');
    expect(categorizeAssetPath('sub\\Locales\\fr.json')).toBe('locales');
    expect(categorizeAssetPath('locales/readme.txt')).toBe('data'); // only JSON tables
    expect(categorizeAssetPath('mylocales/en.json')).toBe('data'); // segment match, not substring
  });

  it('falls back to "other" for unknown or missing extensions', () => {
    expect(categorizeAssetPath('README')).toBe('other');
    expect(categorizeAssetPath('archive.zip')).toBe('other');
    expect(categorizeAssetPath('.gitignore')).toBe('other');
    expect(categorizeAssetPath('folder/trailing.')).toBe('other');
  });

  it('extracts extensions from paths with separators', () => {
    expect(getAssetPathExtension('a/b/c.PNG')).toBe('png');
    expect(getAssetPathExtension('a\\b\\c.glb')).toBe('glb');
    expect(getAssetPathExtension('noext')).toBe('');
    expect(getAssetPathExtension('.hidden')).toBe('');
  });

  it('keeps a definition for every category id in display order', () => {
    for (const definition of ASSET_CATEGORIES) {
      expect(ASSET_CATEGORY_BY_ID[definition.id]).toBe(definition);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.icon.length).toBeGreaterThan(0);
    }
  });

  it('round-trips grouped directory expansion keys', () => {
    const key = groupedDirectoryExpansionKey('images', 'assets/sprites/ui');
    expect(splitGroupedDirectoryExpansionKey(key)).toEqual({
      categoryId: 'images',
      path: 'assets/sprites/ui',
    });
  });

  it('rejects non-directory expansion keys', () => {
    expect(splitGroupedDirectoryExpansionKey(groupedCategoryExpansionKey('images'))).toBeNull();
    expect(splitGroupedDirectoryExpansionKey('bogus::assets')).toBeNull();
    expect(splitGroupedDirectoryExpansionKey('no-separator')).toBeNull();
  });
});
