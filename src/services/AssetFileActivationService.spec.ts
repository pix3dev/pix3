import { describe, expect, it, vi } from 'vitest';

import { AssetFileActivationService, type AssetActivation } from './AssetFileActivationService';

describe('AssetFileActivationService', () => {
  it('routes .pix3anim assets to an animation editor tab', async () => {
    const service = new AssetFileActivationService();
    const editorTabService = {
      focusOrOpenAnimation: vi.fn().mockResolvedValue(undefined),
      focusOrOpenCode: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
    });

    const payload: AssetActivation = {
      name: 'walk.pix3anim',
      path: 'assets/walk.pix3anim',
      kind: 'file',
      resourcePath: 'res://assets/walk.pix3anim',
      extension: 'pix3anim',
    };

    await service.handleActivation(payload);

    expect(editorTabService.focusOrOpenAnimation).toHaveBeenCalledWith(
      'res://assets/walk.pix3anim'
    );
  });

  it('opens image assets in the Sprite Editor instead of creating a node', async () => {
    const service = new AssetFileActivationService();
    const editorTabService = {
      focusOrOpenSpriteEditor: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
    });

    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']) {
      await service.handleActivation({
        name: `hero.${extension}`,
        path: `textures/hero.${extension}`,
        kind: 'file',
        resourcePath: `res://textures/hero.${extension}`,
        extension,
      });
    }

    expect(editorTabService.focusOrOpenSpriteEditor).toHaveBeenCalledTimes(6);
    expect(editorTabService.focusOrOpenSpriteEditor).toHaveBeenCalledWith('res://textures/hero.png');
    expect(editorTabService.focusOrOpenSpriteEditor).toHaveBeenCalledWith(
      'res://textures/hero.avif'
    );
  });

  it('routes .ts, .js, and .json assets to code tabs', async () => {
    const service = new AssetFileActivationService();
    const editorTabService = {
      focusOrOpenAnimation: vi.fn().mockResolvedValue(undefined),
      focusOrOpenCode: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
    });

    const payloads: AssetActivation[] = [
      {
        name: 'player.ts',
        path: 'scripts/player.ts',
        kind: 'file',
        resourcePath: 'res://scripts/player.ts',
        extension: 'ts',
      },
      {
        name: 'bootstrap.js',
        path: 'scripts/bootstrap.js',
        kind: 'file',
        resourcePath: 'res://scripts/bootstrap.js',
        extension: 'js',
      },
      {
        name: 'config.json',
        path: 'config.json',
        kind: 'file',
        resourcePath: 'res://config.json',
        extension: 'json',
      },
    ];

    for (const payload of payloads) {
      await service.handleActivation(payload);
    }

    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(1, 'res://scripts/player.ts');
    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(
      2,
      'res://scripts/bootstrap.js'
    );
    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(3, 'res://config.json');
  });

  it('routes markdown and plain-text assets to code tabs', async () => {
    const service = new AssetFileActivationService();
    const editorTabService = {
      focusOrOpenAnimation: vi.fn().mockResolvedValue(undefined),
      focusOrOpenCode: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
    });

    const payloads: AssetActivation[] = [
      {
        name: 'README.md',
        path: 'README.md',
        kind: 'file',
        resourcePath: 'res://README.md',
        extension: 'md',
      },
      {
        name: 'notes.txt',
        path: 'docs/notes.txt',
        kind: 'file',
        resourcePath: 'res://docs/notes.txt',
        extension: 'txt',
      },
      {
        name: 'settings.yaml',
        path: 'settings.yaml',
        kind: 'file',
        resourcePath: 'res://settings.yaml',
        extension: 'yaml',
      },
    ];

    for (const payload of payloads) {
      await service.handleActivation(payload);
    }

    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(1, 'res://README.md');
    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(2, 'res://docs/notes.txt');
    expect(editorTabService.focusOrOpenCode).toHaveBeenNthCalledWith(3, 'res://settings.yaml');
  });

  it('does not route unsupported binary assets to code tabs', async () => {
    const service = new AssetFileActivationService();
    const editorTabService = {
      focusOrOpenAnimation: vi.fn().mockResolvedValue(undefined),
      focusOrOpenCode: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
    });

    await service.handleActivation({
      name: 'sound.wav',
      path: 'audio/sound.wav',
      kind: 'file',
      resourcePath: 'res://audio/sound.wav',
      extension: 'wav',
    });

    expect(editorTabService.focusOrOpenCode).not.toHaveBeenCalled();
  });
});
