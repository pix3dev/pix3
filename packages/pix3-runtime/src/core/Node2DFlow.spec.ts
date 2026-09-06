import { describe, expect, it } from 'vitest';

import { Group2D } from '../nodes/2D/Group2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';

/**
 * Flow is the half of layout the anchors could not do. An anchor pins ONE node to an edge of its
 * parent — perfect for a close button, useless for a column of settings rows, where each row has
 * to know where the previous one ended. These pin the arithmetic, in the engine's own coordinate
 * convention: a child's position is its CENTRE, the origin is the container's centre, y points UP.
 */
const row = (name: string, height: number, width = 200): ColorRect2D =>
  new ColorRect2D({ id: name, name, width, height });

const container = (flow: Record<string, unknown>): Group2D =>
  new Group2D({
    id: 'box',
    name: 'Box',
    width: 300,
    height: 300,
    flow: flow as never,
  });

describe('Node2D flow layout', () => {
  it('stacks a column from the top padding, in tree order', () => {
    const box = container({ enabled: true, direction: 'vertical', gap: 10, paddingY: 8 });
    const a = row('A', 40);
    const b = row('B', 40);
    const c = row('C', 40);
    box.add(a, b, c);

    box.applyFlowLayout();

    // Top of the box is +150; the first row's centre sits 8 + 20 below it.
    expect(a.position.y).toBeCloseTo(150 - 8 - 20);
    expect(b.position.y).toBeCloseTo(a.position.y - 40 - 10);
    expect(c.position.y).toBeCloseTo(b.position.y - 40 - 10);
  });

  it('runs a row rightwards from the left padding', () => {
    const box = container({ enabled: true, direction: 'horizontal', gap: 6, paddingX: 4 });
    const a = row('A', 30, 50);
    const b = row('B', 30, 50);
    box.add(a, b);

    box.applyFlowLayout();

    expect(a.position.x).toBeCloseTo(-150 + 4 + 25);
    expect(b.position.x).toBeCloseTo(a.position.x + 50 + 6);
  });

  it('places the cross axis by align', () => {
    const start = container({ enabled: true, align: 'start', paddingX: 10 });
    const child = row('A', 40, 100);
    start.add(child);
    start.applyFlowLayout();
    expect(child.position.x).toBeCloseTo(-150 + 10 + 50);

    const centred = container({ enabled: true, align: 'center' });
    const centredChild = row('B', 40, 100);
    centred.add(centredChild);
    centred.applyFlowLayout();
    expect(centredChild.position.x).toBeCloseTo(0);
  });

  it('grows the container to the content when autoSize is on', () => {
    const box = container({
      enabled: true,
      direction: 'vertical',
      gap: 10,
      paddingY: 8,
      autoSize: true,
    });
    box.add(row('A', 40), row('B', 40), row('C', 40));

    box.applyFlowLayout();

    // 8 + 40 + 10 + 40 + 10 + 40 + 8
    expect(box.height).toBeCloseTo(156);
  });

  it('leaves children where they were authored when the flow is off', () => {
    const box = container({ enabled: false });
    const child = row('A', 40);
    child.position.set(12, 34, 0);
    box.add(child);

    box.applyFlowLayout();

    expect(child.position.x).toBe(12);
    expect(child.position.y).toBe(34);
  });

  it('skips a hidden child rather than leaving a hole', () => {
    const box = container({ enabled: true, direction: 'vertical', gap: 0, paddingY: 0 });
    const a = row('A', 40);
    const hidden = row('Hidden', 40);
    hidden.visible = false;
    const c = row('C', 40);
    box.add(a, hidden, c);

    box.applyFlowLayout();

    expect(c.position.y).toBeCloseTo(a.position.y - 40);
  });

  it("leaves the cross axis to a child's own anchor", () => {
    // A settings row: the column decides how far down the toggle sits, its own anchor keeps it
    // pinned to the right edge — the split the flow exists for.
    const box = container({ enabled: true, direction: 'vertical', align: 'start', paddingX: 10 });
    const pinned = row('Toggle', 40, 100);
    pinned.position.set(100, 0, 0);
    pinned.setLayoutConfig({ enabled: true, horizontalAlign: 'right', verticalAlign: 'top' });
    box.add(pinned);

    box.applyFlowLayout();

    expect(pinned.position.x).toBeCloseTo(100);
    expect(pinned.position.y).toBeCloseTo(150 - 20);
  });

  it('does not let a child anchor re-shift the main axis when the container grows', () => {
    const box = container({ enabled: true, direction: 'vertical', gap: 0, paddingY: 0 });
    const a = row('A', 40);
    a.setLayoutConfig({ enabled: true, horizontalAlign: 'center', verticalAlign: 'top' });
    const b = row('B', 40);
    box.add(a, b);
    box.applyAnchoredLayoutRecursive({ width: 300, height: 300 }, { width: 300, height: 300 });

    // The container is 100 taller than authored; the column re-lays out against the new top,
    // and the top-anchored row must land there ONCE, not be pushed a second time by its anchor.
    box.height = 400;
    box.applyAnchoredLayoutRecursive({ width: 300, height: 400 }, { width: 300, height: 300 });

    expect(a.position.y).toBeCloseTo(200 - 20);
    expect(b.position.y).toBeCloseTo(a.position.y - 40);
  });

  it('serializes only when enabled', () => {
    expect(container({ enabled: false }).serializeFlow()).toBeUndefined();
    const on = container({ enabled: true, direction: 'horizontal', gap: 12, align: 'end' });
    expect(on.serializeFlow()).toMatchObject({
      enabled: true,
      direction: 'horizontal',
      gap: 12,
      align: 'end',
    });
  });
});
