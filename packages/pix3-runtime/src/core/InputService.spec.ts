import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputService } from './InputService';

describe('InputService lock (Cutscene Director input freeze)', () => {
  let input: InputService;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    input = new InputService();
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    input.attach(canvas);
  });

  afterEach(() => {
    input.detach();
    canvas.remove();
  });

  it('counts nested locks and only unlocks at depth 0', () => {
    expect(input.isLocked).toBe(false);
    input.lock();
    input.lock();
    expect(input.isLocked).toBe(true);
    input.unlock();
    expect(input.isLocked).toBe(true); // still depth 1
    input.unlock();
    expect(input.isLocked).toBe(false);
    // Extra unlock floors at 0, never goes negative.
    input.unlock();
    expect(input.isLocked).toBe(false);
  });

  it('drops keydown/pointerdown while locked and records no frame events', () => {
    input.lock();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(input.getButton('Key_Space')).toBe(false);

    canvas.dispatchEvent(new Event('pointerdown'));
    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();

    input.beginFrame();
    expect(input.pointerEvents).toHaveLength(0);
    expect(input.keyEvents).toHaveLength(0);
  });

  it('clears held Action_Primary and pointer state on the 0→1 transition', () => {
    // Simulate a live press before the lock.
    input.isPointerDown = true;
    input.activePointerId = 1;
    input.setButton('Action_Primary', true);

    input.lock();

    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.getButton('Action_Primary')).toBe(false);
  });

  it('does not leave a key stuck when it is pressed and released entirely during a lock', () => {
    input.lock();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    input.unlock();
    expect(input.getButton('Key_KeyW')).toBe(false);
  });

  it('drops a key that was already held when the lock is taken (gameplay goes quiet)', () => {
    // Player is holding a movement key before the cutscene starts.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    expect(input.getButton('Key_KeyW')).toBe(true);

    input.lock();
    // The held key is force-released, so gameplay polling getButton goes quiet.
    expect(input.getButton('Key_KeyW')).toBe(false);

    // Its keyup during the lock is swallowed, so it stays false — no stuck key.
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    input.unlock();
    expect(input.getButton('Key_KeyW')).toBe(false);

    // A key still physically held re-asserts via the OS key-repeat keydown.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    expect(input.getButton('Key_KeyW')).toBe(true);
  });

  it('swallows the wheel gesture while locked (preventDefault, no accumulation) and clears wheelDelta on lock', () => {
    // A pre-lock wheel is accumulated on the next frame.
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }));
    input.beginFrame();
    expect(input.wheelDelta.y).toBe(40);

    input.lock();
    // lock() clears the accumulated + pending wheel deltas.
    expect(input.wheelDelta.y).toBe(0);

    const wheel = new WheelEvent('wheel', { deltaY: 120 });
    const prevented = vi.spyOn(wheel, 'preventDefault');
    canvas.dispatchEvent(wheel);
    expect(prevented).toHaveBeenCalled(); // page must not scroll behind a cutscene
    input.beginFrame();
    expect(input.wheelDelta.y).toBe(0); // ...but nothing is accumulated
  });

  it('resets the lock depth on detach so a stopped scene never leaks a lock', () => {
    input.lock();
    input.lock();
    expect(input.isLocked).toBe(true);
    input.detach();
    expect(input.isLocked).toBe(false);
  });

  it('lets input through again once unlocked', () => {
    input.lock();
    input.unlock();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(input.getButton('Key_Space')).toBe(true);
  });
});

describe('InputService pointer capture (synthetic events)', () => {
  it('swallows a NotFoundError from set/releasePointerCapture and still tracks the pointer', () => {
    const input = new InputService();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    // A synthetic PointerEvent (automation / agent harness) has no live pointer, so the DOM
    // throws NotFoundError — which must not escape as an uncaught runtime error during play.
    canvas.setPointerCapture = () => {
      throw new DOMException('No active pointer with the given id is found.', 'NotFoundError');
    };
    canvas.releasePointerCapture = () => {
      throw new DOMException('No active pointer with the given id is found.', 'NotFoundError');
    };
    input.attach(canvas);

    const down = new Event('pointerdown');
    Object.defineProperty(down, 'pointerId', { value: 7 });
    expect(() => canvas.dispatchEvent(down)).not.toThrow();
    expect(input.isPointerDown).toBe(true);
    expect(input.activePointerId).toBe(7);

    const up = new Event('pointerup');
    Object.defineProperty(up, 'pointerId', { value: 7 });
    expect(() => canvas.dispatchEvent(up)).not.toThrow();
    expect(input.activePointerId).toBeNull();

    input.detach();
    canvas.remove();
  });
});
