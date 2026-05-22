import { describe, expect, it } from 'vitest';
import { createDefaultProjectManifest, normalizeProjectManifest } from './ProjectManifest';

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
});