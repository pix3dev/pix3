import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { createInitialAppState } from '@/state/AppState';
import { ProjectService } from '@/services/project/ProjectService';
import { AddAutoloadOperation } from './AddAutoloadOperation';

describe('AddAutoloadOperation', () => {
  it('preserves default export scene path when adding autoloads', async () => {
    const state = createInitialAppState();
    state.project.manifest = {
      ...createDefaultProjectManifest(),
      defaultExportScenePath: 'src/assets/scenes/intro.pix3scene',
    };

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

    const result = await new AddAutoloadOperation({
      scriptPath: 'scripts/GameManager.ts',
      singleton: 'GameManager',
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(saveProjectManifest).toHaveBeenCalledTimes(1);
    expect(state.project.manifest?.defaultExportScenePath).toBe(
      'src/assets/scenes/intro.pix3scene'
    );
    expect(state.project.manifest?.autoloads).toEqual([
      {
        scriptPath: 'scripts/GameManager.ts',
        singleton: 'GameManager',
        enabled: true,
      },
    ]);
  });
});
