import { describe, expect, it } from 'vitest';

import { NodeBase } from './NodeBase';

const makeNode = (id: string, name: string): NodeBase => new NodeBase({ id, name });

/**
 * Build a small tree:
 *   root
 *   ├─ ui        (UI)
 *   │  └─ panel  (Panel)
 *   │     └─ title (Title)
 *   └─ world     (World)
 */
const buildTree = () => {
  const root = makeNode('root-id', 'Root');
  const ui = makeNode('ui-id', 'UI');
  const panel = makeNode('panel-id', 'Panel');
  const title = makeNode('title-id', 'Title');
  const world = makeNode('world-id', 'World');

  root.adoptChild(ui);
  ui.adoptChild(panel);
  panel.adoptChild(title);
  root.adoptChild(world);

  return { root, ui, panel, title, world };
};

describe('NodeBase addressing', () => {
  it('finds descendants by id', () => {
    const { root, title } = buildTree();
    expect(root.findById('title-id')).toBe(title);
    expect(root.findById('missing')).toBeNull();
  });

  it('finds the first descendant by name', () => {
    const { root, panel } = buildTree();
    expect(root.findByName('Panel')).toBe(panel);
    expect(root.findByName('Nope')).toBeNull();
  });

  it('returns only direct children from getChildByName', () => {
    const { root, ui } = buildTree();
    expect(root.getChildByName('UI')).toBe(ui);
    // Title is a deep descendant, not a direct child of root.
    expect(root.getChildByName('Title')).toBeNull();
  });

  it('resolves a slash-separated path of child names', () => {
    const { root, panel, title } = buildTree();
    expect(root.findByPath('UI/Panel')).toBe(panel);
    expect(root.findByPath('UI/Panel/Title')).toBe(title);
    expect(root.findByPath('UI/Missing')).toBeNull();
    expect(root.findByPath('')).toBeNull();
  });

  it('findNode resolves id, name, or path', () => {
    const { root, title, world } = buildTree();
    // by id
    expect(root.findNode('world-id')).toBe(world);
    // by name
    expect(root.findNode('Title')).toBe(title);
    // by path
    expect(root.findNode('UI/Panel/Title')).toBe(title);
    expect(root.findNode('UI/Nope')).toBeNull();
  });
});
