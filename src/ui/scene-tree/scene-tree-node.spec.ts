import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { html, render } from 'lit';

import { ServiceContainer } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService } from '@/services/editor/IconService';
import type { SceneTreeNode } from './scene-tree-node';

class CommandDispatcherStub {
  execute = vi.fn(async () => undefined);
  executeById = vi.fn(async () => true);
}

class IconServiceStub {
  // The icon NAME is what the assertions are about, so it travels into the DOM.
  getIcon = vi.fn((name: string) => html`<svg data-icon=${name}></svg>`);
}

const baseNode = (overrides: Partial<SceneTreeNode> = {}): SceneTreeNode => ({
  id: 'node-1',
  name: 'spawner',
  type: 'Sprite2D',
  treeColor: '#ffffff',
  treeIcon: 'image',
  instancePath: null,
  properties: {},
  children: [],
  isContainer: false,
  scripts: [],
  ...overrides,
});

type TestRow = HTMLElement & { updateComplete: Promise<unknown> };

const mountRow = async (node: SceneTreeNode): Promise<TestRow> => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(html`<pix3-scene-tree-node .node=${node} .level=${1}></pix3-scene-tree-node>`, host);
  const row = host.querySelector('pix3-scene-tree-node') as TestRow;
  await row.updateComplete;
  return row;
};

beforeAll(async () => {
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(CommandDispatcher),
    CommandDispatcherStub as unknown as Parameters<typeof container.addService>[1],
    'singleton'
  );
  container.addService(
    container.getOrCreateToken(IconService),
    IconServiceStub as unknown as Parameters<typeof container.addService>[1],
    'singleton'
  );
  await import('./scene-tree-node');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Scene tree row — inert nodes', () => {
  /**
   * The whole point of the badge: a node with an unrecognised `type:` loads as a bare `NodeBase`
   * and does nothing, while its row looks exactly like a working node's. The tree is where people
   * look first when "the node is there but has no effect", and until now only the agent lint knew.
   */
  it('marks an inert node and says why', async () => {
    const row = await mountRow(
      baseNode({
        type: 'DirectionalLight3D',
        isInert: true,
        inertReason: 'Unknown node type "DirectionalLight3D" … Did you mean "DirectionalLight"?',
      })
    );

    const badge = row.querySelector('.tree-node__inert-badge');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toContain('DirectionalLight3D');
    expect(badge?.querySelector('[data-icon="alert-triangle"]')).not.toBeNull();
  });

  it('folds the reason into the row tooltip, ahead of every other note', async () => {
    const row = await mountRow(
      baseNode({
        type: 'DirectionalLight3D',
        isInert: true,
        inertReason: 'Unknown node type "DirectionalLight3D" — it does nothing.',
        isPrefabChild: true,
      })
    );

    const tooltip = row.querySelector('[role="treeitem"]')?.getAttribute('title') ?? '';
    expect(tooltip).toContain('it does nothing');
    expect(tooltip).not.toContain('part of prefab instance');
  });

  it('leaves a normal node unmarked', async () => {
    const row = await mountRow(baseNode());

    expect(row.querySelector('.tree-node__inert-badge')).toBeNull();
    expect(row.querySelector('[role="treeitem"]')?.getAttribute('title')).toBe(
      'spawner · Sprite2D'
    );
  });
});
