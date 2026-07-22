import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { UpdateObjectPropertyCommand } from './UpdateObjectPropertyCommand';
import { UpdateObjectPropertyOperation } from './UpdateObjectPropertyOperation';

const createContext = (
  invokeAndPushResult: boolean,
  invokeResult = { didMutate: true }
): CommandContext => {
  const invokeMock = vi.fn(async () => invokeResult);
  const operationServiceMock: Pick<OperationService, 'invokeAndPush' | 'invoke'> = {
    invokeAndPush: vi.fn(async () => invokeAndPushResult),
    invoke: invokeMock as unknown as OperationService['invoke'],
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
    state: {} as CommandContext['state'],
    snapshot: { scenes: { activeSceneId: 'scene-1' } } as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('UpdateObjectPropertyCommand', () => {
  it('executes UpdateObjectPropertyOperation through OperationService.invokeAndPush', async () => {
    const context = createContext(true);
    const command = new UpdateObjectPropertyCommand({
      nodeId: 'node-1',
      propertyPath: 'intensity',
      value: 2.5,
    });

    const result = await command.execute(context);

    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );

    expect(result.didMutate).toBe(true);
    expect(service.invokeAndPush).toHaveBeenCalledTimes(1);
    expect(service.invokeAndPush).toHaveBeenCalledWith(expect.any(UpdateObjectPropertyOperation));
  });

  it('uses OperationService.invoke for preview updates', async () => {
    const context = createContext(true);
    const command = new UpdateObjectPropertyCommand({
      nodeId: 'node-1',
      propertyPath: 'intensity',
      value: 2.5,
      historyMode: 'preview',
    });

    const result = await command.execute(context);

    const service = context.container.getService<
      Pick<OperationService, 'invoke' | 'invokeAndPush'>
    >(context.container.getOrCreateToken(OperationService));

    expect(result.didMutate).toBe(true);
    expect(service.invoke).toHaveBeenCalledTimes(1);
    expect(service.invokeAndPush).not.toHaveBeenCalled();
  });

  it('passes previousValue through to the operation for commit history', async () => {
    const context = createContext(true);
    const command = new UpdateObjectPropertyCommand({
      nodeId: 'node-1',
      propertyPath: 'intensity',
      value: 2.5,
      historyMode: 'commit',
      previousValue: 1.25,
    });

    await command.execute(context);

    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );
    const operation = (service.invokeAndPush as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | UpdateObjectPropertyOperation
      | undefined;

    expect(operation).toBeInstanceOf(UpdateObjectPropertyOperation);
    const params = operation as unknown as {
      params: { previousValue?: unknown; value: unknown; propertyPath: string };
    };
    expect(params.params.previousValue).toBe(1.25);
    expect(params.params.value).toBe(2.5);
    expect(params.params.propertyPath).toBe('intensity');
  });
});
