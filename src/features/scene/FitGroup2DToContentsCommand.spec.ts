import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { Group2D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { FitGroup2DToContentsCommand } from './FitGroup2DToContentsCommand';
import { FitGroup2DToContentsOperation } from './FitGroup2DToContentsOperation';

const createContext = (
  nodes: NodeBase[],
  primaryNodeId: string | null,
  overrides: { isPlaying?: boolean; isReadOnly?: boolean } = {}
): CommandContext => {
  const nodeMap = new Map<string, NodeBase>();
  const visit = (current: readonly NodeBase[]) => {
    for (const node of current) {
      nodeMap.set(node.nodeId, node);
      visit(node.children.filter((child): child is NodeBase => child instanceof NodeBase));
    }
  };
  visit(nodes);

  const operationServiceMock: Pick<OperationService, 'invokeAndPush'> = {
    invokeAndPush: vi.fn(async () => true),
  };
  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph'> = {
    getActiveSceneGraph: () =>
      ({
        version: '1.0.0',
        rootNodes: nodes,
        nodeMap,
        metadata: {},
      }) as ReturnType<SceneManager['getActiveSceneGraph']>,
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === OperationService) {
        return operationServiceMock as T;
      }
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    state: {
      selection: { nodeIds: primaryNodeId ? [primaryNodeId] : [], primaryNodeId },
      ui: { isPlaying: overrides.isPlaying ?? false },
      collaboration: { isReadOnly: overrides.isReadOnly ?? false },
    } as CommandContext['state'],
    snapshot: { scenes: { activeSceneId: 'scene-1' } } as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

const createPopulatedGroup = (): { group: Group2D; child: Sprite2D } => {
  const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
  const child = new Sprite2D({ id: 'child', name: 'Child', width: 20, height: 20 });
  group.add(child);
  return { group, child };
};

describe('FitGroup2DToContentsCommand', () => {
  it('targets the primary selection when constructed without params', async () => {
    const { group } = createPopulatedGroup();
    const context = createContext([group], group.nodeId);
    const command = new FitGroup2DToContentsCommand();

    expect(command.preconditions(context).canExecute).toBe(true);

    const result = await command.execute(context);
    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );

    expect(result.didMutate).toBe(true);
    expect(service.invokeAndPush).toHaveBeenCalledWith(expect.any(FitGroup2DToContentsOperation));
    const operation = (service.invokeAndPush as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | FitGroup2DToContentsOperation
      | undefined;
    expect((operation as unknown as { params: { nodeId: string } }).params.nodeId).toBe(
      group.nodeId
    );
  });

  it('prefers explicit params over the selection', async () => {
    const { group } = createPopulatedGroup();
    const other = new Group2D({ id: 'other', name: 'Other', width: 10, height: 10 });
    const context = createContext([group, other], other.nodeId);

    const command = new FitGroup2DToContentsCommand({ nodeId: group.nodeId });
    expect(command.preconditions(context).canExecute).toBe(true);
    await command.execute(context);

    const service = context.container.getService<Pick<OperationService, 'invokeAndPush'>>(
      context.container.getOrCreateToken(OperationService)
    );
    const operation = (service.invokeAndPush as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((operation as unknown as { params: { nodeId: string } }).params.nodeId).toBe(
      group.nodeId
    );
  });

  it('is unavailable without a Group2D selection, for an empty group, and while playing', () => {
    const { group } = createPopulatedGroup();
    const sprite = new Sprite2D({ id: 'loose-sprite', name: 'Loose', width: 10, height: 10 });
    const emptyGroup = new Group2D({ id: 'empty', name: 'Empty', width: 10, height: 10 });

    expect(
      new FitGroup2DToContentsCommand().preconditions(createContext([group], null)).canExecute
    ).toBe(false);
    expect(
      new FitGroup2DToContentsCommand().preconditions(createContext([sprite], sprite.nodeId))
        .canExecute
    ).toBe(false);
    expect(
      new FitGroup2DToContentsCommand().preconditions(
        createContext([emptyGroup], emptyGroup.nodeId)
      ).canExecute
    ).toBe(false);
    expect(
      new FitGroup2DToContentsCommand().preconditions(
        createContext([group], group.nodeId, { isPlaying: true })
      ).canExecute
    ).toBe(false);
    expect(
      new FitGroup2DToContentsCommand().preconditions(
        createContext([group], group.nodeId, { isReadOnly: true })
      ).canExecute
    ).toBe(false);
  });
});
