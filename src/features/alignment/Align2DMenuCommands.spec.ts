import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { Group2D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';

import type { CommandContext } from '@/core/command';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { createAlign2DMenuCommands, type Align2DMenuCommand } from './Align2DMenuCommands';
import { canRunAlign2DAction, computeAlign2DCapabilities } from './align-2d-capabilities';
import { ALIGN_2D_ACTION_LABELS, type Align2DActionId } from './types';

const actionOf = (command: Align2DMenuCommand): Align2DActionId =>
  (command as unknown as { action: Align2DActionId }).action;

const collectNodeMap = (nodes: readonly NodeBase[]): Map<string, NodeBase> => {
  const nodeMap = new Map<string, NodeBase>();
  const visit = (current: readonly NodeBase[]) => {
    for (const node of current) {
      nodeMap.set(node.nodeId, node);
      visit(node.children);
    }
  };
  visit(nodes);
  return nodeMap;
};

const sprite = (id: string, x: number): Sprite2D =>
  new Sprite2D({ id, name: id, width: 20, height: 20, position: new Vector2(x, 0) });

/**
 * A context whose `SceneManager` answers with `rootNodes` — or with no scene at all when
 * `rootNodes` is null.
 */
const createContext = (
  rootNodes: NodeBase[] | null,
  selectedNodeIds: readonly string[]
): CommandContext => {
  const sceneGraph =
    rootNodes === null
      ? null
      : {
          version: '1.0.0',
          description: 'Scene',
          metadata: {},
          rootNodes,
          nodeMap: collectNodeMap(rootNodes),
        };

  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph' | 'getSceneGraph'> = {
    getActiveSceneGraph: () => sceneGraph,
    getSceneGraph: () => sceneGraph,
  } as Pick<SceneManager, 'getActiveSceneGraph' | 'getSceneGraph'>;

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    hasService: (token: unknown): boolean => token === SceneManager,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    state: { selection: { nodeIds: [...selectedNodeIds] } } as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: container as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

const registryWithMenuCommands = (commands: Align2DMenuCommand[]): CommandRegistry => {
  const registry = new CommandRegistry(new KeybindingService());
  registry.registerMany(...commands);
  return registry;
};

describe('Align2D menu commands — grouping', () => {
  const commands = createAlign2DMenuCommands();

  it('renders as two labelled groups under Node, and adds no top-level section', () => {
    const sections = registryWithMenuCommands(commands).buildMenuSections();

    expect(sections.map(section => section.id)).toEqual(['node']);
    const [node] = sections;
    // Nothing is added at the parent level — Group/Fit/Publish keep that band to themselves.
    expect(node.items).toEqual([]);
    expect(node.groups.map(group => ({ id: group.id, label: group.label }))).toEqual([
      { id: 'node/align', label: 'Align' },
      { id: 'node/distribute', label: 'Distribute' },
    ]);
  });

  it('puts the container band before the selection-bounds band, each in its own band', () => {
    const [node] = registryWithMenuCommands(commands).buildMenuSections();
    const align = node.groups.find(group => group.id === 'node/align');

    expect(align?.items.map(item => [item.label, item.menuOrder])).toEqual([
      ['Align Left to Container', 100],
      ['Align Horizontal Center to Container', 110],
      ['Align Right to Container', 120],
      ['Align Top to Container', 130],
      ['Align Vertical Center to Container', 140],
      ['Align Bottom to Container', 150],
      ['Align Left to Selection Bounds', 200],
      ['Align Horizontal Center to Selection Bounds', 210],
      ['Align Right to Selection Bounds', 220],
      ['Align Top to Selection Bounds', 230],
      ['Align Vertical Center to Selection Bounds', 240],
      ['Align Bottom to Selection Bounds', 250],
    ]);

    // The dropdown draws its separator where the hundreds digit changes, so the two bands are
    // exactly the two blocks a user sees.
    expect(align?.items.map(item => Math.floor((item.menuOrder ?? 0) / 100))).toEqual([
      1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    ]);
  });

  it('lists the four distribution rows in one band', () => {
    const [node] = registryWithMenuCommands(commands).buildMenuSections();
    const distribute = node.groups.find(group => group.id === 'node/distribute');

    expect(distribute?.items.map(item => [item.label, item.menuOrder])).toEqual([
      ['Distribute Horizontal Gaps', 100],
      ['Distribute Centers Horizontally', 110],
      ['Distribute Vertical Gaps', 120],
      ['Distribute Centers Vertically', 130],
    ]);
  });

  it('covers all sixteen actions once, and reads them from the shared label table', () => {
    expect(commands).toHaveLength(16);
    expect(new Set(commands.map(actionOf)).size).toBe(16);

    for (const command of commands) {
      expect(command.metadata.title).toBe(ALIGN_2D_ACTION_LABELS[actionOf(command)]);
      expect(command.metadata.id).toBe(`scene.align-2d.${actionOf(command)}`);
      // Figma's Alt+A/D/W/S collide with Chrome and the Windows layout switcher: the slot is the
      // user's to bind.
      expect(command.metadata.keybinding).toBeUndefined();
    }
  });
});

describe('Align2D menu commands — preconditions mirror the toolbar', () => {
  const commands = createAlign2DMenuCommands();

  /** How the viewport toolbar decides whether a button's group is usable. */
  const toolbarAllows = (
    action: Align2DActionId,
    rootNodes: NodeBase[],
    selectedNodeIds: readonly string[]
  ): boolean =>
    canRunAlign2DAction(
      action,
      computeAlign2DCapabilities({ nodeMap: collectNodeMap(rootNodes) }, selectedNodeIds)
    );

  const menuAllows = (
    command: Align2DMenuCommand,
    rootNodes: NodeBase[] | null,
    selectedNodeIds: readonly string[]
  ): boolean => command.preconditions(createContext(rootNodes, selectedNodeIds)).canExecute;

  it('blocks every row when there is no active scene', () => {
    for (const command of commands) {
      expect(menuAllows(command, null, ['sprite-a'])).toBe(false);
    }
  });

  it('blocks every row when nothing is selected', () => {
    const nodes = [sprite('sprite-a', 0)];
    for (const command of commands) {
      expect(menuAllows(command, nodes, [])).toBe(false);
    }
  });

  it.each([
    ['one selected node', 1],
    ['two selected nodes', 2],
    ['three selected nodes', 3],
  ])('agrees with the toolbar for %s', (_label, count) => {
    const group = new Group2D({
      id: 'group',
      name: 'Group',
      width: 200,
      height: 120,
      position: new Vector2(0, 0),
    });
    const sprites = [sprite('sprite-a', -40), sprite('sprite-b', 0), sprite('sprite-c', 40)];
    for (const child of sprites) {
      group.add(child);
    }
    const selected = sprites.slice(0, count).map(node => node.nodeId);

    for (const command of commands) {
      expect(menuAllows(command, [group], selected)).toBe(
        toolbarAllows(actionOf(command), [group], selected)
      );
    }
  });

  it('greys exactly the rows the toolbar would not offer for a single selected node', () => {
    const nodes = [sprite('sprite-a', 0)];
    const selected = [nodes[0].nodeId];

    const allowed = commands.filter(command => menuAllows(command, nodes, selected)).map(actionOf);

    // One node has a container to align against, but no selection bounds and nothing to
    // distribute — which is exactly the one toolbar group that stays on screen.
    expect(allowed).toEqual([
      'container-left',
      'container-center-x',
      'container-right',
      'container-top',
      'container-center-y',
      'container-bottom',
    ]);
  });

  it('explains why a blocked row is blocked', () => {
    const nodes = [sprite('sprite-a', 0)];
    const distribute = commands.find(command => actionOf(command) === 'distribute-gap-x');
    const result = distribute?.preconditions(createContext(nodes, [nodes[0].nodeId]));

    expect(result).toMatchObject({
      canExecute: false,
      reason: 'Select at least three 2D nodes to distribute them',
      scope: 'selection',
    });
  });
});
