import { describe, expect, it } from 'vitest';
import { deriveSceneIdFromResourcePath } from '@/core/scene-id';

describe('deriveSceneIdFromResourcePath', () => {
  it('strips the res:// scheme, the extension and slugifies the rest', () => {
    expect(deriveSceneIdFromResourcePath('res://scenes/Main Menu.pix3scene')).toBe(
      'scenes-main-menu'
    );
  });

  it('strips the collab:// scheme', () => {
    expect(deriveSceneIdFromResourcePath('collab://x')).toBe('x');
  });

  it('falls back to "scene" when nothing is left', () => {
    expect(deriveSceneIdFromResourcePath('')).toBe('scene');
    expect(deriveSceneIdFromResourcePath('res://')).toBe('scene');
  });

  it('collapses runs of separators into a single dash', () => {
    expect(deriveSceneIdFromResourcePath('templ://ui//my_scene  file.pix3scene')).toBe(
      'ui-my-scene-file'
    );
  });
});
