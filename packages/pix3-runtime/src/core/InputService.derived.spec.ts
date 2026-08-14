import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InputService } from './InputService';
import { Button2D } from '../nodes/2D/UI/Button2D';

/**
 * The **derived, non-addressed** pointer state — the last step of the multi-touch contract.
 *
 * Step 1 deliberately left `isPointerDown` reading as the primary pointer's state so controls that
 * still polled the global flag would not regress ("the button will not release while a second
 * finger is on screen"). Steps 2–3 took that dependency away, so the flag now means what every
 * other multi-touch API means by it: **the pointer map is not empty**.
 *
 * What stays primary-derived, and why, is as much a part of the contract as what changed:
 * `pointerPosition` is one `Vector2` and can only ever hold one finger's coordinates, and
 * `activePointerId` is `@deprecated` compatibility. Both keep following the oldest finger, with
 * promotion when it lifts.
 */
describe('InputService derived pointer state', () => {
  let input: InputService;
  let element: HTMLDivElement;

  /** The mocked rect is 1:1 and offset by (10, 20), so input x = clientX - 10. */
  const dispatch = (type: string, pointerId: number, clientX = 40, clientY = 60): void =>
    void element.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY }));
  const frameEvents = () => {
    input.beginFrame();
    return input.pointerEvents;
  };

  beforeEach(() => {
    input = new InputService();
    element = document.createElement('div');
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
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

  it('keeps isPointerDown true while ANY finger remains, including after the primary lifts', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);

    // The oldest finger — the one the shared state describes — leaves first. Under the old
    // primary-derived reading this is the moment the flag was ambiguous.
    dispatch('pointerup', 1, 40, 60);

    expect(input.isPointerDown).toBe(true);
    expect(input.pointerDownCount).toBe(1);
    // `activePointerId` and `pointerPosition` stay primary-derived: the survivor is promoted.
    expect(input.activePointerId).toBe(2);
    expect(input.pointerPosition.x).toBe(90);
    // One shared flag for the whole gesture: still held, because something still is.
    expect(input.getButton('Action_Primary')).toBe(true);

    dispatch('pointerup', 2, 100, 120);

    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('holds Action_Primary until the last terminal, whichever kind it is', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    dispatch('pointerdown', 3, 200, 150);

    // A finger dragged off the edge of the screen ends as a cancel, not a completed tap — and
    // ending one finger must not disturb the other two.
    dispatch('pointerleave', 2, 100, 120);
    expect(input.isPointerDown).toBe(true);
    expect(input.getButton('Action_Primary')).toBe(true);
    expect(input.getActivePointers().map(p => p.pointerId)).toEqual([1, 3]);

    dispatch('pointercancel', 1, 40, 60);
    expect(input.isPointerDown).toBe(true);
    expect(input.getButton('Action_Primary')).toBe(true);
    expect(input.activePointerId).toBe(3);

    dispatch('pointerup', 3, 200, 150);
    expect(input.isPointerDown).toBe(false);
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('clears every derived value when the lock is taken mid two-finger gesture, and starts clean after unlock', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);

    input.lock();

    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.pointerDownCount).toBe(0);
    expect(input.getButton('Action_Primary')).toBe(false);
    // Both fingers are told they went away — a control holding one must not stay pressed
    // behind the lock.
    expect(frameEvents()).toEqual([
      { type: 'cancel', pointerId: 1, x: 30, y: 40 },
      { type: 'cancel', pointerId: 2, x: 90, y: 100 },
    ]);

    // The physical fingers are still on the glass; their releases arrive while locked and must
    // change nothing, because the pointers no longer exist as far as the engine is concerned.
    dispatch('pointerup', 1, 40, 60);
    dispatch('pointerup', 2, 100, 120);
    expect(frameEvents()).toHaveLength(0);
    expect(input.isPointerDown).toBe(false);

    input.unlock();

    // A finger landing after the lock lifts is an ordinary first finger: primary, and it raises
    // the shared flag again (the 0→1 transition), with no residue of the cancelled gesture.
    dispatch('pointerdown', 3, 100, 120);

    expect(input.isLocked).toBe(false);
    expect(input.pointerDownCount).toBe(1);
    expect(input.isPointerDown).toBe(true);
    expect(input.activePointerId).toBe(3);
    expect(input.getActivePointers()).toEqual([{ pointerId: 3, x: 90, y: 100, isPrimary: true }]);
    expect(input.getButton('Action_Primary')).toBe(true);
    expect(frameEvents()).toEqual([{ type: 'down', pointerId: 3, x: 90, y: 100 }]);
  });

  it('clears every derived value when the window blurs with two fingers held', () => {
    dispatch('pointerdown', 1, 40, 60);
    dispatch('pointerdown', 2, 100, 120);
    frameEvents();

    // Alt-tab / app switch: no pointerup is ever delivered for either finger.
    window.dispatchEvent(new Event('blur'));

    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.pointerDownCount).toBe(0);
    expect(input.getButton('Action_Primary')).toBe(false);
    // The position is left where it was, exactly as after an ordinary release — a mouse keeps its
    // last known spot.
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerPosition.y).toBe(40);
    expect(frameEvents()).toEqual([
      { type: 'cancel', pointerId: 1, x: 30, y: 40 },
      { type: 'cancel', pointerId: 2, x: 90, y: 100 },
    ]);

    dispatch('pointerdown', 5, 100, 120);
    expect(input.activePointerId).toBe(5);
    expect(input.isPointerDown).toBe(true);
    expect(input.getButton('Action_Primary')).toBe(true);
  });
});

/**
 * The fallback pseudo-pointer in `UIControl2D.collectCandidatePointers` (`LEGACY_POINTER_ID`) is
 * what keeps the un-addressed surface usable: with the pointer map empty, a control synthesises one
 * candidate from `pointerPosition` + `isPointerDown`. Every existing control spec and the agent
 * harness drive controls that way, so switching `isPointerDown` to "any pointer" had to leave it
 * intact — with the map empty there is no "any" to differ from "primary", which is precisely why
 * the fallback survives the change.
 */
describe('UIControl2D legacy pseudo-pointer after the derived switch', () => {
  it('still runs the full funnel for a control driven by assigning the shared fields', () => {
    const button = new Button2D({ id: 'btn', name: 'Button', width: 80, height: 40 });
    const input = new InputService();
    input.width = 200;
    input.height = 200;
    button.input = input;

    const seen: string[] = [];
    const listener = {};
    for (const name of ['pointerdown', 'pressed', 'pointerup', 'released', 'click']) {
      button.connect(name, listener, () => seen.push(name));
    }

    // Screen (100,100) is the button centre under the no-scene mapping (world = input size).
    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    button.tick(1 / 60);
    expect(seen).toEqual(['pointerdown', 'pressed']);
    // No real pointer exists, so the hover can only be attributed to the aggregate.
    expect(input.isHoveringUI).toBe(true);
    expect(input.pointerDownCount).toBe(0);

    input.isPointerDown = false;
    button.tick(1 / 60);
    expect(seen).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });
});
