import { describe, expect, it } from 'vitest';
import {
  createDefaultProjectManifest,
  createDefaultQualitySettings,
  normalizeProjectManifest,
} from './ProjectManifest';

describe('ProjectManifest', () => {
  it('normalizes default export scene path from resource path input', () => {
    const manifest = normalizeProjectManifest({
      ...createDefaultProjectManifest(),
      defaultExportScenePath: '  res://src/assets/scenes/main.pix3scene  ',
    });

    expect(manifest.defaultExportScenePath).toBe('src/assets/scenes/main.pix3scene');
  });

  it('omits empty default export scene path values', () => {
    const manifest = normalizeProjectManifest({
      ...createDefaultProjectManifest(),
      defaultExportScenePath: '   ',
    });

    expect(manifest.defaultExportScenePath).toBeUndefined();
  });

  it('defaults projectType, targetPlatform and quality for legacy manifests', () => {
    const manifest = normalizeProjectManifest({
      version: '1.0.0',
      autoloads: [],
      viewportBaseSize: { width: 1280, height: 720 },
    });

    expect(manifest.projectType).toBe('3d');
    expect(manifest.targetPlatform).toBe('universal');
    expect(manifest.quality).toEqual(createDefaultQualitySettings('universal'));
  });

  it('derives quality defaults from the target platform', () => {
    const manifest = normalizeProjectManifest({
      targetPlatform: 'mobile',
    });

    expect(manifest.quality).toEqual({ antialias: false, shadows: false, maxPixelRatio: 2 });
  });

  it('keeps explicit quality overrides and clamps the pixel ratio', () => {
    const manifest = normalizeProjectManifest({
      targetPlatform: 'mobile',
      quality: { antialias: true, maxPixelRatio: 99 },
    });

    expect(manifest.quality.antialias).toBe(true);
    // shadows falls back to the mobile default
    expect(manifest.quality.shadows).toBe(false);
    expect(manifest.quality.maxPixelRatio).toBe(4);
  });

  it('rejects unknown projectType and targetPlatform values', () => {
    const manifest = normalizeProjectManifest({
      projectType: 'vr',
      targetPlatform: 'console',
    });

    expect(manifest.projectType).toBe('3d');
    expect(manifest.targetPlatform).toBe('universal');
  });

  it('defaults textureFiltering to linear and accepts nearest', () => {
    expect(normalizeProjectManifest({}).textureFiltering).toBe('linear');
    expect(normalizeProjectManifest({ textureFiltering: 'NEAREST' }).textureFiltering).toBe(
      'nearest'
    );
    expect(normalizeProjectManifest({ textureFiltering: 'bogus' }).textureFiltering).toBe('linear');
  });
});
