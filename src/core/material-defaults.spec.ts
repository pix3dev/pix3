import { afterEach, describe, expect, it } from 'vitest';
import { appState } from '@/state';
import type { ProjectManifest } from '@/core/ProjectManifest';
import { defaultMaterialTypeForProject } from './material-defaults';

const withTargetPlatform = (targetPlatform: ProjectManifest['targetPlatform']): void => {
  appState.project.manifest = { targetPlatform } as ProjectManifest;
};

afterEach(() => {
  appState.project.manifest = null;
});

describe('default material family for new geometry', () => {
  it('gives a mobile project the cheap lit material', () => {
    withTargetPlatform('mobile');
    expect(defaultMaterialTypeForProject()).toBe('lambert');
  });

  it('treats universal as mobile — a universal build still runs on phones', () => {
    withTargetPlatform('universal');
    expect(defaultMaterialTypeForProject()).toBe('lambert');
  });

  it('spends PBR only where the project asked for a desktop look', () => {
    withTargetPlatform('desktop');
    expect(defaultMaterialTypeForProject()).toBe('standard');
  });

  it('defaults to the cheap material when no project is open', () => {
    // Creation paths run before a manifest exists (fresh project, tests, headless tooling); the
    // safe-to-be-wrong answer is the cheaper one.
    expect(defaultMaterialTypeForProject()).toBe('lambert');
  });
});
