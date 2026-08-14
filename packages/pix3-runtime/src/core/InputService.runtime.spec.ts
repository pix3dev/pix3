import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputService } from '@pix3/runtime';

describe('InputService pointer ownership', () => {
  let input: InputService;
  let element: HTMLDivElement;
  let captured: number[];
  let released: number[];

  /** The mocked rect below is 1:1 and offset by (10, 20), so input x = clientX - 10. */
  const dispatch = (type: string, pointerId: number, clientX: number, clientY: number): void => {
    element.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY }));
  };
  /** Frame events queued since the last frame. */
  const frameEvents = () => {
    input.beginFrame();
    return input.pointerEvents;
  };

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');
    captured = [];
    released = [];
    element.setPointerCapture = vi.fn((id: number) => void captured.push(id));
    element.releasePointerCapture = vi.fn((id: number) => void released.push(id));

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 10,
        top: 20,
        width: 300,
        height: 200,
        right: 310,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
      configurable: true,
    });

    input.attach(element);
  });

  afterEach(() => {
    input.detach();
  });

  // Replaces "locks to first pointer and ignores others until release". That test asserted the
  // defect this file now covers: a second finger was dropped on the floor, so "hold the stick,
  // tap fire" could not work in any game. What it *actually* pinned down — that the shared,
  // non-addressed state keeps following the first finger — is preserved below and in
  // "keeps the shared pointer state on the primary pointer", because the controls still read it.
  it('tracks every pointer that goes down, in press order, and reports each in the frame stream', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);

    expect(input.pointerDownCount).toBe(2);
    expect(input.getActivePointers().map(p => p.pointerId)).toEqual([1, 2]);
    expect(input.getActivePointers()[0]).toMatchObject({ pointerId: 1, x: 30, y: 40 });
    expect(input.getPointer(2)).toMatchObject({ pointerId: 2, x: 90, y: 100 });
    expect(input.getPointer(99)).toBeNull();

    expect(frameEvents()).toEqual([
      { type: 'down', pointerId: 1, x: 30, y: 40 },
      { type: 'down', pointerId: 2, x: 90, y: 100 },
    ]);
  });

  it('marks the oldest pointer primary and promotes the next one when it lifts', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    expect(input.getActivePointers().map(p => p.isPrimary)).toEqual([true, false]);

    dispatch('pointerup', 1, 40, 60);

    expect(input.getActivePointers().map(p => p.isPrimary)).toEqual([true]);
    expect(input.activePointerId).toBe(2);
    expect(input.isPointerDown).toBe(true);
    // The shared position follows the new primary, not the finger that left.
    expect(input.pointerPosition.x).toBe(90);
    expect(input.pointerPosition.y).toBe(100);
  });

  it('keeps the shared pointer state on the primary pointer, not on "whichever moved last"', () => {
    // `pointerPosition` and `activePointerId` stay primary-derived permanently — one `Vector2` can
    // only describe one finger, and letting it jump to whichever pointer moved last would make it
    // describe none of them reliably. (`isPointerDown` is the one that became "any pointer"; see
    // `InputService.derived.spec.ts`.)
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    dispatch('pointermove', 2, 200, 220);

    expect(input.activePointerId).toBe(1);
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerPosition.y).toBe(40);
    expect(input.getPointer(2)).toMatchObject({ x: 190, y: 200 });

    dispatch('pointermove', 1, 80, 100);
    expect(input.pointerPosition.x).toBe(70);
    expect(input.pointerPosition.y).toBe(80);
  });

  it('routes move/up to their own pointer only, including release in reverse order', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    frameEvents();

    dispatch('pointermove', 2, 110, 130);
    expect(input.getPointer(1)).toMatchObject({ x: 30, y: 40 });
    expect(input.getPointer(2)).toMatchObject({ x: 100, y: 110 });

    // Reverse-order release: the second finger up must not disturb the first.
    dispatch('pointerup', 2, 110, 130);
    expect(input.pointerDownCount).toBe(1);
    expect(input.getPointer(1)).toMatchObject({ x: 30, y: 40, isPrimary: true });
    expect(input.isPointerDown).toBe(true);
    expect(input.getButton('Action_Primary')).toBe(true);

    expect(frameEvents()).toEqual([
      { type: 'move', pointerId: 2, x: 100, y: 110 },
      { type: 'up', pointerId: 2, x: 100, y: 110 },
    ]);

    dispatch('pointerup', 1, 40, 60);
    expect(input.pointerDownCount).toBe(0);
    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('raises Action_Primary once for the whole gesture and drops it on the last release', () => {
    dispatch('pointerdown', 1, 40, 60);
    expect(input.getButton('Action_Primary')).toBe(true);

    dispatch('pointerdown', 2, 100, 120);
    input.setButton('Action_Primary', false); // a game consuming the tap
    dispatch('pointerup', 2, 100, 120);
    // Not re-raised and not cleared by a non-last release: it is one shared flag
    // meaning "something is down", owned by the 0→1 and →0 transitions only.
    expect(input.getButton('Action_Primary')).toBe(false);

    dispatch('pointerdown', 3, 100, 120);
    expect(input.getButton('Action_Primary')).toBe(false);

    dispatch('pointerup', 1, 40, 60);
    dispatch('pointerup', 3, 100, 120);
    expect(input.getButton('Action_Primary')).toBe(false);

    dispatch('pointerdown', 4, 40, 60);
    expect(input.getButton('Action_Primary')).toBe(true);
  });

  it('captures and releases each pointer individually', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    expect(captured).toEqual([1, 2]);

    dispatch('pointerup', 1, 40, 60);
    expect(released).toEqual([1]);
    dispatch('pointercancel', 2, 100, 120);
    expect(released).toEqual([1, 2]);
  });

  it('follows hover moves only while nothing is down', () => {
    dispatch('pointermove', 1, 40, 60);
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerEvents).toHaveLength(0);
    expect(frameEvents()).toHaveLength(0);

    dispatch('pointerdown', 1, 40, 60);
    // A hovering device that is not part of the gesture must not yank the position away.
    dispatch('pointermove', 7, 300, 300);
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerDownCount).toBe(1);
  });
});

describe('InputService pointer cancellation', () => {
  let input: InputService;
  let element: HTMLDivElement;
  let released: number[];

  const dispatch = (type: string, pointerId: number, clientX = 40, clientY = 60): void => {
    element.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY }));
  };
  const frameEvents = () => {
    input.beginFrame();
    return input.pointerEvents;
  };

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');
    released = [];
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn((id: number) => void released.push(id));

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 10,
        top: 20,
        width: 300,
        height: 200,
        right: 310,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
      configurable: true,
    });

    input.attach(element);
  });

  afterEach(() => {
    input.detach();
  });

  it('reports pointercancel as its own event type, never as an up', () => {
    // A press that was taken away is not a completed tap: folding the two together is why a finger
    // dragged off the edge of the screen over a button still clicked it.
    dispatch('pointerdown', 1);
    frameEvents();

    dispatch('pointercancel', 1, 50, 70);

    expect(frameEvents()).toEqual([{ type: 'cancel', pointerId: 1, x: 40, y: 50 }]);
    expect(input.pointerDownCount).toBe(0);
    expect(input.isPointerDown).toBe(false);
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('treats pointerleave for a held pointer as a cancel and for an unknown one as nothing', () => {
    dispatch('pointerleave', 3, 500, 500);
    expect(frameEvents()).toHaveLength(0);
    expect(input.pointerDownCount).toBe(0);

    dispatch('pointerdown', 1);
    dispatch('pointerdown', 2, 100, 120);
    frameEvents();

    dispatch('pointerleave', 2, 100, 120);
    expect(frameEvents()).toEqual([{ type: 'cancel', pointerId: 2, x: 90, y: 100 }]);
    // Only the finger that left the canvas ends; the other one keeps going.
    expect(input.pointerDownCount).toBe(1);
    expect(input.activePointerId).toBe(1);
  });

  it('cancels every held pointer when the input lock is taken', () => {
    dispatch('pointerdown', 1);
    dispatch('pointerdown', 2, 100, 120);

    input.lock();

    // The queued gesture is dropped (that is the lock), but a control holding a finger still has
    // to hear that the finger went away, or it stays pressed behind the lock.
    expect(frameEvents()).toEqual([
      { type: 'cancel', pointerId: 1, x: 30, y: 40 },
      { type: 'cancel', pointerId: 2, x: 90, y: 100 },
    ]);
    expect(released).toEqual([1, 2]);
    expect(input.pointerDownCount).toBe(0);
    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('cancels every held pointer when the window loses focus', () => {
    // Alt-tab / app switch / OS notification: no pointerup is ever delivered, so without this the
    // finger stays down forever.
    dispatch('pointerdown', 1);
    dispatch('pointerdown', 2, 100, 120);
    frameEvents();

    window.dispatchEvent(new Event('blur'));

    expect(frameEvents()).toEqual([
      { type: 'cancel', pointerId: 1, x: 30, y: 40 },
      { type: 'cancel', pointerId: 2, x: 90, y: 100 },
    ]);
    expect(released).toEqual([1, 2]);
    expect(input.pointerDownCount).toBe(0);
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('drops every held pointer on detach, without leaking events into the next scene', () => {
    dispatch('pointerdown', 1);
    dispatch('pointerdown', 2, 100, 120);

    input.detach();

    expect(released).toEqual([1, 2]);
    expect(input.pointerDownCount).toBe(0);
    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    input.beginFrame();
    expect(input.pointerEvents).toHaveLength(0);
  });

  it('emits down/up for an ordinary single-finger tap (the unchanged repertoire)', () => {
    dispatch('pointerdown', 1);
    dispatch('pointermove', 1, 50, 70);
    dispatch('pointerup', 1, 50, 70);

    expect(frameEvents()).toEqual([
      { type: 'down', pointerId: 1, x: 30, y: 40 },
      { type: 'move', pointerId: 1, x: 40, y: 50 },
      { type: 'up', pointerId: 1, x: 40, y: 50 },
    ]);
    expect(input.pointerPosition.x).toBe(40);
  });
});

describe('InputService per-pointer UI hover', () => {
  it('answers per pointer and keeps the aggregate', () => {
    const input = new InputService();

    input.registerHover('fire-button', 2);

    expect(input.isHoveringUI).toBe(true);
    expect(input.isPointerOverUI(2)).toBe(true);
    // The reason the addressed form exists: the thumb on the fire button must not veto the finger
    // dragging the joystick, which is what gating on `isHoveringUI` does.
    expect(input.isPointerOverUI(1)).toBe(false);

    input.beginFrame();
    expect(input.isHoveringUI).toBe(false);
    expect(input.isPointerOverUI(2)).toBe(false);
  });

  it('attributes a hover registered without a pointer id to the primary pointer', () => {
    // What an un-migrated control means: it hit-tested against `pointerPosition`, which is the
    // primary pointer's.
    const input = new InputService();
    const element = document.createElement('div');
    input.attach(element);
    element.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 4 }));

    input.registerHover('legacy-control');

    expect(input.isPointerOverUI(4)).toBe(true);
    expect(input.isPointerOverUI(5)).toBe(false);
    input.detach();
  });

  it('registers only the aggregate when nothing is down (mouse hover)', () => {
    const input = new InputService();
    input.registerHover('menu-item');
    expect(input.isHoveringUI).toBe(true);
    expect(input.isPointerOverUI(1)).toBe(false);
  });
});

describe('InputService pointer ownership (single-pointer repertoire)', () => {
  let input: InputService;
  let element: HTMLDivElement;

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 10,
        top: 20,
        width: 300,
        height: 200,
        right: 310,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
      configurable: true,
    });

    input.attach(element);
  });

  afterEach(() => {
    input.detach();
  });

  it('allows a new pointer after release', () => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 5, clientX: 50, clientY: 50 })
    );
    element.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 5, clientX: 50, clientY: 50 })
    );

    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 9, clientX: 70, clientY: 80 })
    );

    expect(input.activePointerId).toBe(9);
    expect(input.isPointerDown).toBe(true);
  });

  it('maps pointer coordinates to canvas buffer pixels', () => {
    input.detach();

    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;

    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({
        left: 10,
        top: 20,
        width: 300,
        height: 200,
        right: 310,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
      configurable: true,
    });

    input.attach(canvas);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 160, clientY: 120 })
    );

    expect(input.width).toBe(600);
    expect(input.height).toBe(400);
    expect(input.pointerPosition.x).toBe(300);
    expect(input.pointerPosition.y).toBe(200);
  });
});
