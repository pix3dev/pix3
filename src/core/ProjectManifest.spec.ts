import { describe, expect, it } from 'vitest';
import {
  createDefaultExportSettings,
  createDefaultProjectManifest,
  createDefaultQualitySettings,
  createProjectId,
  getProjectId,
  normalizeProjectManifest,
  resolveExportSettings,
  withProjectId,
} from './ProjectManifest';

describe('ProjectManifest', () => {
  it('normalizes export path lists and strips the res:// scheme', () => {
    const manifest = normalizeProjectManifest({
      ...createDefaultProjectManifest(),
      export: {
        pruneUnusedAssets: true,
        extraRootScenePaths: ['res://scenes/level-2.pix3scene'],
        includeGlobs: ['  res://src/assets/audio/**  ', './src/assets/fonts/**', '', 42],
        excludeGlobs: ['scratch/**', 'scratch/**'],
      },
    });

    expect(manifest.export).toEqual({
      pruneUnusedAssets: true,
      extraRootScenePaths: ['scenes/level-2.pix3scene'],
      includeGlobs: ['src/assets/audio/**', 'src/assets/fonts/**'],
      excludeGlobs: ['scratch/**'],
    });
  });

  it('keeps an all-default or absent export block out of the manifest', () => {
    expect(createDefaultProjectManifest().export).toBeUndefined();
    expect(
      normalizeProjectManifest({
        ...createDefaultProjectManifest(),
        export: { pruneUnusedAssets: false, includeGlobs: [], excludeGlobs: [] },
      }).export
    ).toBeUndefined();
  });

  it('resolves export settings defensively for partial or absent manifests', () => {
    const empty = createDefaultExportSettings();

    expect(resolveExportSettings(null)).toEqual(empty);
    expect(resolveExportSettings({})).toEqual(empty);
    // A manifest straight off disk has not been normalized yet.
    expect(resolveExportSettings({ export: { excludeGlobs: 'nope' } })).toEqual(empty);
    expect(resolveExportSettings({ export: { excludeGlobs: ['scratch/**'] } })).toEqual({
      ...empty,
      excludeGlobs: ['scratch/**'],
    });
    // Pruning must never be inferred from a truthy-ish value.
    expect(resolveExportSettings({ export: { pruneUnusedAssets: 'yes' } })).toEqual(empty);
  });

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

  it('keeps metadata.projectId through normalize, and mints UUIDs', () => {
    const id = createProjectId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createProjectId()).not.toBe(id);

    const manifest = withProjectId(
      normalizeProjectManifest({ metadata: { projectName: 'G', templateId: 't' } }),
      id
    );
    expect(Object.keys(manifest.metadata ?? {})).toEqual([
      'projectName',
      'templateId',
      'projectId',
    ]);
    expect(getProjectId(normalizeProjectManifest(JSON.parse(JSON.stringify(manifest))))).toBe(id);
    expect(getProjectId(createDefaultProjectManifest())).toBeNull();
    expect(getProjectId(normalizeProjectManifest({ metadata: { projectId: '  ' } }))).toBeNull();
  });
});
