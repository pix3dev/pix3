import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { createInitialAppState } from '@/state/AppState';
import { ProjectService } from '@/services/project/ProjectService';
import { UpdateProjectSettingsOperation } from './UpdateProjectSettingsOperation';

describe('UpdateProjectSettingsOperation', () => {
  it('persists normalized default export scene path in project manifest', async () => {
    const state = createInitialAppState();
    state.project.projectName = 'Before Name';
    state.project.localAbsolutePath = '/before/path';
    state.project.manifest = createDefaultProjectManifest();

    const saveProjectManifest = vi.fn(async () => undefined);
    const projectServiceMock = {
      saveProjectManifest,
    } satisfies Pick<ProjectService, 'saveProjectManifest'>;

    const container = {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(token: unknown): T => {
        if (token === ProjectService) {
          return projectServiceMock as T;
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    };

    const context = {
      state,
      snapshot: {
        project: {
          ...state.project,
        },
      },
      container: container as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext;

    const operation = new UpdateProjectSettingsOperation({
      defaultExportScenePath: '  res://src/assets/scenes/intro.pix3scene  ',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(saveProjectManifest).toHaveBeenCalledTimes(1);
    expect(state.project.manifest?.defaultExportScenePath).toBe(
      'src/assets/scenes/intro.pix3scene'
    );
  });

  it('does not mutate project state when manifest persistence fails', async () => {
    const state = createInitialAppState();
    state.project.projectName = 'Before Name';
    state.project.localAbsolutePath = '/before/path';
    state.project.manifest = createDefaultProjectManifest();

    const saveProjectManifest = vi.fn(async () => {
      throw new Error('disk failure');
    });
    const projectServiceMock = {
      saveProjectManifest,
    } satisfies Pick<ProjectService, 'saveProjectManifest'>;

    const container = {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(token: unknown): T => {
        if (token === ProjectService) {
          return projectServiceMock as T;
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    };

    const context = {
      state,
      snapshot: {
        project: {
          ...state.project,
        },
      },
      container: container as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext;

    const operation = new UpdateProjectSettingsOperation({
      projectName: 'After Name',
      localAbsolutePath: '/after/path',
      viewportBaseWidth: 800,
      viewportBaseHeight: 600,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(false);
    expect(saveProjectManifest).toHaveBeenCalledTimes(1);
    expect(state.project.projectName).toBe('Before Name');
    expect(state.project.localAbsolutePath).toBe('/before/path');
    expect(state.project.manifest?.viewportBaseSize.width).toBe(1920);
    expect(state.project.manifest?.viewportBaseSize.height).toBe(1080);
  });
});
