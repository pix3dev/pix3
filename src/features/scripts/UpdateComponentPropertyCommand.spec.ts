import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { UpdateComponentPropertyCommand } from './UpdateComponentPropertyCommand';
import { UpdateComponentPropertyOperation } from './UpdateComponentPropertyOperation';

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
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    state: {} as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('UpdateComponentPropertyCommand', () => {
  it('executes UpdateComponentPropertyOperation through OperationService', async () => {
    const context = createContext(true);
    const command = new UpdateComponentPropertyCommand({
      nodeId: 'node-1',
      componentId: 'component-1',
      propertyName: 'rotationSpeed',
      value: 2.5,
    });

    const result = await command.execute(context);

    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );

    expect(result.didMutate).toBe(true);
    expect(service.invokeAndPush).toHaveBeenCalledTimes(1);
    expect(service.invokeAndPush).toHaveBeenCalledWith(
      expect.any(UpdateComponentPropertyOperation)
    );
  });

  it('uses OperationService.invoke for preview updates', async () => {
    const context = createContext(true);
    const command = new UpdateComponentPropertyCommand({
      nodeId: 'node-1',
      componentId: 'component-1',
      propertyName: 'rotationSpeed',
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

  it('returns didMutate=false when operation was not pushed', async () => {
    const context = createContext(false);
    const command = new UpdateComponentPropertyCommand({
      nodeId: 'node-1',
      componentId: 'component-1',
      propertyName: 'rotationSpeed',
      value: 2.5,
    });

    const result = await command.execute(context);

    expect(result.didMutate).toBe(false);
  });
});
