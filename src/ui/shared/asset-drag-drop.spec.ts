import { describe, expect, it } from 'vitest';

import {
  ASSET_RESOURCE_MIME,
  ASSET_PATH_MIME,
  GENERATION_DRAG_MIME,
  classifySceneCreateAssetResource,
  deriveAssetNodeName,
  getDroppedAssetResourcePath,
  getGenerationDragData,
  hasAssetDragData,
  hasGenerationDragData,
  setGenerationDragData,
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

    expect(getDroppedAssetResourcePath(transfer as unknown as DataTransfer)).toBe(
      'res://assets/walk.pix3anim'
    );
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

    expect(getDroppedAssetResourcePath(transfer as unknown as DataTransfer)).toBe(
      'res://assets/hero.png'
    );
  });

  it('detects asset drags from dataTransfer.types before drop data is readable', () => {
    const transfer = {
      types: [ASSET_RESOURCE_MIME],
      getData: () => '',
    };

    expect(hasAssetDragData(transfer as unknown as DataTransfer)).toBe(true);
  });

  it('treats uri-list payloads as asset drags during dragover', () => {
    const transfer = {
      types: ['text/uri-list'],
      getData: () => '',
    };

    expect(hasAssetDragData(transfer as unknown as DataTransfer)).toBe(true);
  });

  it('round-trips a generation drag payload through the data transfer', () => {
    const store = new Map<string, string>();
    const transfer = {
      types: [] as string[],
      effectAllowed: 'none',
      setData: (type: string, value: string) => {
        store.set(type, value);
        if (!transfer.types.includes(type)) {
          transfer.types.push(type);
        }
      },
      getData: (type: string) => store.get(type) ?? '',
    };

    setGenerationDragData(transfer as unknown as DataTransfer, {
      id: 'gen-123',
      suggestedName: 'hero.png',
    });

    expect(transfer.effectAllowed).toBe('copy');
    expect(hasGenerationDragData(transfer as unknown as DataTransfer)).toBe(true);
    expect(getGenerationDragData(transfer as unknown as DataTransfer)).toEqual({
      id: 'gen-123',
      suggestedName: 'hero.png',
    });
    // The plain-text mirror lets non-Pix3 drop targets receive a sensible name.
    expect(transfer.getData('text/plain')).toBe('hero.png');
  });

  it('rejects generation payloads without an id and non-generation drags', () => {
    const emptyTransfer = { types: [] as string[], getData: () => '' };
    expect(hasGenerationDragData(emptyTransfer as unknown as DataTransfer)).toBe(false);
    expect(getGenerationDragData(emptyTransfer as unknown as DataTransfer)).toBeNull();

    const malformedTransfer = {
      types: [GENERATION_DRAG_MIME],
      getData: (type: string) => (type === GENERATION_DRAG_MIME ? '{"suggestedName":"x.png"}' : ''),
    };
    expect(getGenerationDragData(malformedTransfer as unknown as DataTransfer)).toBeNull();
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
