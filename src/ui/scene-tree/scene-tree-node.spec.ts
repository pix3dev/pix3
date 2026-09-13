import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { html, render } from 'lit';

import { ServiceContainer } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService } from '@/services/editor/IconService';
import type { SceneTreeNode } from './scene-tree-node';

class CommandDispatcherStub {
  // Typed with the argument the row actually passes, so the assertions below can read which
  // COMMAND a click dispatched — the two eyes in this panel drive two different ones.
  execute = vi.fn(async (_command: { metadata?: { id?: string } }) => undefined);
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

interface RowOptions {
  readonly peekHiddenNodeIds?: Set<string>;
  readonly peekHiddenAncestor?: boolean;
}

const mountRow = async (node: SceneTreeNode, options: RowOptions = {}): Promise<TestRow> => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    html`<pix3-scene-tree-node
      .node=${node}
      .level=${1}
      .peekHiddenNodeIds=${options.peekHiddenNodeIds ?? new Set<string>()}
      .peekHiddenAncestor=${options.peekHiddenAncestor ?? false}
    ></pix3-scene-tree-node>`,
    host
  );
  const row = host.querySelector('pix3-scene-tree-node') as TestRow;
  await row.updateComplete;
  return row;
};

const eyeOf = (row: TestRow): HTMLButtonElement =>
  row.querySelector('.tree-node__button--visible') as HTMLButtonElement;

const dispatcher = (): CommandDispatcherStub =>
  ServiceContainer.getInstance().getService<CommandDispatcherStub>(
    ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
  );

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

/**
 * Peek lives in the viewport strip, but the row it masks is in this panel — and a row showing an
 * open eye over a branch the viewport is not drawing is the panel contradicting the canvas beside
 * it. See `docs/pix3-specification.md`, "Editor Peek".
 */
describe('Scene tree row — the Peek mask', () => {
  it('reports a masked branch as off screen and says who hid it', async () => {
    const row = await mountRow(baseNode(), { peekHiddenNodeIds: new Set(['node-1']) });

    expect(row.querySelector('.tree-node__content--peek-hidden')).not.toBeNull();
    expect(eyeOf(row).querySelector('[data-icon="eye-off"]')).not.toBeNull();
    // Not the accent-filled `--active` treatment: this is a per-user view mask, not authored state.
    expect(eyeOf(row).classList.contains('tree-node__button--active')).toBe(false);
    expect(eyeOf(row).classList.contains('tree-node__button--peek')).toBe(true);
    expect(row.querySelector('[role="treeitem"]')?.getAttribute('title')).toContain(
      'hidden by Peek'
    );
  });

  it("clears the mask from the masked root's eye instead of editing the scene file", async () => {
    const row = await mountRow(baseNode(), { peekHiddenNodeIds: new Set(['node-1']) });
    dispatcher().execute.mockClear();

    eyeOf(row).click();
    await row.updateComplete;

    const command = dispatcher().execute.mock.calls[0]?.[0];
    expect(command?.metadata?.id).toBe('viewport.peek-show');
  });

  it('shows a descendant as off screen but keeps its eye on its own authored visibility', async () => {
    const row = await mountRow(baseNode(), { peekHiddenAncestor: true });
    dispatcher().execute.mockClear();

    expect(eyeOf(row).querySelector('[data-icon="eye-off"]')).not.toBeNull();
    expect(eyeOf(row).classList.contains('tree-node__button--peek')).toBe(false);

    eyeOf(row).click();
    await row.updateComplete;

    // Un-masking somebody else's branch from a row that does not show the mask would be an edit
    // the user cannot see coming, so this stays the ordinary property write.
    const command = dispatcher().execute.mock.calls[0]?.[0];
    expect(command?.metadata?.id).toBe('scene.update-object-property');
  });

  it('leaves an unmasked row alone', async () => {
    const row = await mountRow(baseNode());

    expect(row.querySelector('.tree-node__content--peek-hidden')).toBeNull();
    expect(eyeOf(row).querySelector('[data-icon="eye"]')).not.toBeNull();
  });
});
