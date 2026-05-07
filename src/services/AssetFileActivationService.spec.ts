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
});
