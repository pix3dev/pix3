import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';

import { Button2D } from './Button2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { Group2D } from '../Group2D';
import { InputService } from '../../../core/InputService';

/**
 * Pointer OWNERSHIP in the scroll container: the list follows the finger that started the gesture,
 * and while it is scrolling it takes the pointer away from every control inside it — for ALL
 * fingers, which is what every native scroller does and the reason a flick over an inventory must
 * not select a row.
 *
 * Real `InputService` + real `PointerEvent`s throughout: none of this is expressible with the shared
 * `isPointerDown`. Single-finger scrolling (wheel, drag, inertia, clipping, serialization) lives in
 * `ScrollContainer2D.spec.ts` and is untouched.
 */

const INPUT_SIZE = 200;
const screenX = (worldX: number): number => worldX + INPUT_SIZE / 2;
const screenY = (worldY: number): number => INPUT_SIZE / 2 - worldY;

const FUNNEL_SIGNALS = ['pointerdown', 'pressed', 'pointerup', 'released', 'click'] as const;

describe('ScrollContainer2D pointer ownership (multi-touch)', () => {
  let input: InputService;
  let element: HTMLDivElement;

  const down = (pointerId: number, worldX: number, worldY: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId,
        clientX: screenX(worldX),
        clientY: screenY(worldY),
      })
    );
  const move = (pointerId: number, worldX: number, worldY: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId,
        clientX: screenX(worldX),
        clientY: screenY(worldY),
      })
    );
  const up = (pointerId: number, worldX: number, worldY: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId,
        clientX: screenX(worldX),
        clientY: screenY(worldY),
      })
    );

  const frame = (...nodes: { tick(dt: number): void }[]): void => {
    input.beginFrame();
    for (const node of nodes) node.tick(1 / 60);
  };

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: INPUT_SIZE,
        height: INPUT_SIZE,
        right: INPUT_SIZE,
        bottom: INPUT_SIZE,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    input.attach(element);
  });

  afterEach(() => {
    input.detach();
  });

  /**
   * A 120x120 viewport (world x/y ±60) over 320 units of content — max scrollY 100 — with an
   * 80x40 row at the origin (world x ±40, y ±20).
   */
  function createList(): { container: ScrollContainer2D; row: Button2D; signals: string[] } {
    const container = new ScrollContainer2D({
      id: 'list',
      name: 'List',
      width: 120,
      height: 120,
      dragThreshold: 6,
    });
    const content = new Group2D({
      id: 'content',
      name: 'Content',
      width: 120,
      height: 320,
      position: new Vector2(0, 0),
    });
    const row = new Button2D({
      id: 'row',
      name: 'Row',
      width: 80,
      height: 40,
      buttonAction: 'Buy',
    });
    content.adoptChild(row);
    container.adoptChild(content);
    container.input = input;

    const signals: string[] = [];
    const owner = {};
    for (const name of FUNNEL_SIGNALS) {
      row.connect(name, owner, () => signals.push(name));
    }
    return { container, row, signals };
  }

  it('lets a second finger tap a row while the first rests in the list below the drag threshold', () => {
    const { container, signals } = createList();

    // Finger 1 inside the viewport, below the row, and it never travels far enough to claim a drag.
    down(1, 0, -50);
    frame(container);
    move(1, 0, -47);
    frame(container);
    expect(container.hasActivePointerCapture()).toBe(false);

    down(2, 0, 0);
    frame(container);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    up(2, 0, 0);
    frame(container);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
    expect(container.scrollY).toBe(0);
  });

  it('cancels a row pressed by a second finger once the list is being dragged, with no click', () => {
    const { container, signals } = createList();

    // Dragging upward (the content follows the finger) past the 6-unit threshold.
    down(1, 0, -50);
    frame(container);
    move(1, 0, -30); // 20 units of travel: the frame that claims the gesture
    frame(container);
    move(1, 0, -10); // and 20 units of actual scrolling
    frame(container);
    expect(container.hasActivePointerCapture()).toBe(true);
    const scrolledByFingerOne = container.scrollY;
    expect(scrolledByFingerOne).toBeGreaterThan(0);

    // A second finger on the row inside the scrolling list: the gate takes the pointer away before
    // the row can even press, so nothing is emitted at all — a cancellation is not a completed tap.
    down(2, 0, 0);
    frame(container);
    expect(signals).toEqual([]);

    // …and it must not add to the scroll either: the list follows finger 1 and nothing else.
    move(2, 0, 20);
    frame(container);
    expect(signals).toEqual([]);
    expect(container.scrollY).toBe(scrolledByFingerOne);

    up(2, 0, 20);
    frame(container);
    expect(signals).toEqual([]);
    expect(signals).not.toContain('click');

    // Only the owning finger ends the gesture.
    expect(container.hasActivePointerCapture()).toBe(true);
    up(1, 0, -10);
    frame(container);
    expect(container.hasActivePointerCapture()).toBe(false);
  });

  it('keeps following its own finger out of the viewport while another finger sits inside it', () => {
    const { container } = createList();

    down(1, 0, -50);
    frame(container);
    move(1, 0, -30);
    frame(container);
    move(1, 0, -10);
    frame(container);
    const afterThreshold = container.scrollY;
    expect(afterThreshold).toBeCloseTo(20, 5);

    // Finger 2 parks inside the viewport and stays put; finger 1 drags on, past the top edge (the
    // viewport is world y ±60). The exact figure is the assertion: the list must move by finger 1's
    // 75 units of travel, not by the 60 that separate it from the finger sitting inside the bounds —
    // "it scrolled more" would be satisfied by following the wrong finger.
    down(2, 0, 50);
    frame(container);
    move(1, 0, 65);
    frame(container);

    expect(container.scrollY).toBeCloseTo(afterThreshold + 75, 5);
    expect(container.hasActivePointerCapture()).toBe(true);
  });
});
