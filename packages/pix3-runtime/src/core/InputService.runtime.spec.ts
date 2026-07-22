import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputService } from '@pix3/runtime';

describe('InputService pointer ownership', () => {
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

  it('locks to first pointer and ignores others until release', () => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 40, clientY: 60 })
    );

    expect(input.activePointerId).toBe(1);
    expect(input.isPointerDown).toBe(true);
    expect(input.getButton('Action_Primary')).toBe(true);
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerPosition.y).toBe(40);

    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 2, clientX: 100, clientY: 120 })
    );
    element.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 2, clientX: 200, clientY: 220 })
    );

    expect(input.activePointerId).toBe(1);
    expect(input.pointerPosition.x).toBe(30);
    expect(input.pointerPosition.y).toBe(40);

    element.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 80, clientY: 100 })
    );

    expect(input.pointerPosition.x).toBe(70);
    expect(input.pointerPosition.y).toBe(80);

    element.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 2, clientX: 80, clientY: 100 })
    );
    expect(input.isPointerDown).toBe(true);
    expect(input.activePointerId).toBe(1);

    element.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 1, clientX: 90, clientY: 110 })
    );

    expect(input.isPointerDown).toBe(false);
    expect(input.activePointerId).toBeNull();
    expect(input.getButton('Action_Primary')).toBe(false);
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
