import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { Align2DNodesCommand } from './Align2DNodesCommand';
import { Align2DNodesOperation } from './Align2DNodesOperation';

const createContext = (invokeAndPushResult: boolean): CommandContext => {
  const operationServiceMock: Pick<OperationService, 'invokeAndPush'> = {
    invokeAndPush: vi.fn(async () => invokeAndPushResult),
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === OperationService) {
        return operationServiceMock as T;
      }
      if (typeof token === 'function') {
        return {
          getActiveSceneGraph: () => ({ id: 'scene-1' }),
        } as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    state: {
      selection: {
        nodeIds: ['node-a', 'node-b'],
      },
    } as CommandContext['state'],
    snapshot: {
      scenes: { activeSceneId: 'scene-1' },
    } as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('Align2DNodesCommand', () => {
  it('dispatches Align2DNodesOperation through OperationService.invokeAndPush', async () => {
    const context = createContext(true);
    const command = new Align2DNodesCommand({ action: 'container-left' });

    const result = await command.execute(context);

    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );

    expect(result.didMutate).toBe(true);
    expect(service.invokeAndPush).toHaveBeenCalledTimes(1);
    expect(service.invokeAndPush).toHaveBeenCalledWith(expect.any(Align2DNodesOperation));

    const operation = (service.invokeAndPush as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Align2DNodesOperation
      | undefined;
    const params = operation as unknown as {
      params: { action: string; nodeIds?: string[] };
    };
    expect(params.params.action).toBe('container-left');
    expect(params.params.nodeIds).toEqual(['node-a', 'node-b']);
  });
});
