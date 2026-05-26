import { describe, expect, it } from 'vitest';

import {
  ASSET_RESOURCE_MIME,
  ASSET_PATH_MIME,
  classifySceneCreateAssetResource,
  deriveAssetNodeName,
  getDroppedAssetResourcePath,
  hasAssetDragData,
  toProjectResourcePath,
} from './asset-drag-drop';

describe('asset-drag-drop', () => {
  it('normalizes project paths into res:// resource paths', () => {
    expect(toProjectResourcePath('./assets/hero.png')).toBe('res://assets/hero.png');
    expect(toProjectResourcePath('\\assets\\hero.png')).toBe('res://assets/hero.png');
  });

  it('extracts the preferred dropped asset resource path from data transfer payloads', () => {
    const transfer = {
      types: [ASSET_RESOURCE_MIME, ASSET_PATH_MIME],
      getData: (type: string) => {
        if (type === ASSET_RESOURCE_MIME) {
          return 'res://assets/walk.pix3anim';
        }

        if (type === ASSET_PATH_MIME) {
          return 'assets/fallback.png';
        }

        return '';
      },
    };

    expect(getDroppedAssetResourcePath(transfer as DataTransfer)).toBe('res://assets/walk.pix3anim');
  });

  it('falls back to text/uri-list when custom asset MIME data is unavailable', () => {
    const transfer = {
      types: ['text/uri-list'],
      getData: (type: string) => {
        if (type === 'text/uri-list') {
          return 'res://assets/hero.png';
        }

        return '';
      },
    };

    expect(getDroppedAssetResourcePath(transfer as DataTransfer)).toBe('res://assets/hero.png');
  });

  it('detects asset drags from dataTransfer.types before drop data is readable', () => {
    const transfer = {
      types: [ASSET_RESOURCE_MIME],
      getData: () => '',
    };

    expect(hasAssetDragData(transfer as DataTransfer)).toBe(true);
  });

  it('treats uri-list payloads as asset drags during dragover', () => {
    const transfer = {
      types: ['text/uri-list'],
      getData: () => '',
    };

    expect(hasAssetDragData(transfer as DataTransfer)).toBe(true);
  });

  it('classifies supported scene-create asset types and derives node names from file names', () => {
    expect(classifySceneCreateAssetResource('res://assets/hero.png')).toBe('image');
    expect(classifySceneCreateAssetResource('res://animations/walk.pix3anim')).toBe('animation');
    expect(classifySceneCreateAssetResource('res://models/crate.glb')).toBe('model');
    expect(classifySceneCreateAssetResource('res://prefabs/shop.pix3scene')).toBe('prefab');
    expect(classifySceneCreateAssetResource('res://scripts/player.ts')).toBeNull();

    expect(deriveAssetNodeName('res://models/crate.glb', 'Model')).toBe('crate');
    expect(deriveAssetNodeName('res://animations/walk.pix3anim', 'AnimatedSprite2D')).toBe('walk');
  });
});