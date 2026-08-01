import { describe, expect, it } from 'vitest';

import {
  buildAnimationFrameResourcePath,
  createDefaultAnimationResource,
  deriveAnimationAssetStem,
  getAnimationAssetDirectory,
  normalizeAnimationAssetPath,
} from './animation-asset-utils';

describe('animation asset utils', () => {
  it('normalizes folder-based animation asset paths', () => {
    expect(normalizeAnimationAssetPath('res://src/assets/animations/player')).toBe(
      'res://src/assets/animations/player/player.pix3anim'
    );
    expect(normalizeAnimationAssetPath('src/assets/animations/player')).toBe(
      'res://src/assets/animations/player/player.pix3anim'
    );
  });

  it('preserves explicit pix3anim paths and derives a stable stem', () => {
    const explicitPath = 'res://src/assets/animations/player/player.pix3anim';
    expect(normalizeAnimationAssetPath(explicitPath)).toBe(explicitPath);
    expect(deriveAnimationAssetStem(explicitPath)).toBe('player');
    expect(getAnimationAssetDirectory(explicitPath)).toBe('res://src/assets/animations/player');
    expect(buildAnimationFrameResourcePath(explicitPath, 12)).toBe(
      'res://src/assets/animations/player/frame_0012.png'
    );
  });

  it('scopes frame file names by clip so clips cannot overwrite each other', () => {
    const explicitPath = 'res://sprites/character/character.pix3anim';

    expect(buildAnimationFrameResourcePath(explicitPath, 1, { clipName: 'idle' })).toBe(
      'res://sprites/character/idle_0001.png'
    );
    expect(buildAnimationFrameResourcePath(explicitPath, 1, { clipName: 'run' })).toBe(
      'res://sprites/character/run_0001.png'
    );
    expect(
      buildAnimationFrameResourcePath(explicitPath, 3, { clipName: 'Attack Combo!', extension: 'webp' })
    ).toBe('res://sprites/character/attack_combo_0003.webp');
    expect(buildAnimationFrameResourcePath(explicitPath, 2, { clipName: '   ' })).toBe(
      'res://sprites/character/frame_0002.png'
    );
  });

  it('creates sequence-first default resources', () => {
    const resource = createDefaultAnimationResource(
      'res://src/assets/animations/player/frame_0001.png',
      'idle'
    );

    expect(resource.texturePath).toBe('');
    expect(resource.clips[0]?.frames).toHaveLength(1);
    expect(resource.clips[0]?.frames[0]?.texturePath).toBe(
      'res://src/assets/animations/player/frame_0001.png'
    );
    expect(resource.clips[0]?.frames[0]?.anchor).toEqual({ x: 0.5, y: 0.5 });
  });
});
