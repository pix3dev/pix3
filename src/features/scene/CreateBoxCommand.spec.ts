import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { CreateBoxCommand } from './CreateBoxCommand';

const createContext = (
  invokeAndPushResult: boolean,
  primaryNodeId: string | null
): CommandContext => {
  const operationServiceMock: Pick<OperationService, 'invokeAndPush'> = {
    invokeAndPush: vi.fn(async () => invokeAndPushResult),
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
    state: {
      selection: {
        primaryNodeId,
      },
    } as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('CreateBoxCommand', () => {
  it('returns created node id from selection after a successful operation', async () => {
    const command = new CreateBoxCommand();
    const context = createContext(true, 'child-node-1');

    const result = await command.execute(context);

    expect(result.didMutate).toBe(true);
    expect(result.payload.nodeId).toBe('child-node-1');
  });

  it('returns empty node id when operation did not mutate state', async () => {
    const command = new CreateBoxCommand();
    const context = createContext(false, 'child-node-1');

    const result = await command.execute(context);

    expect(result.didMutate).toBe(false);
    expect(result.payload.nodeId).toBe('');
  });
});
