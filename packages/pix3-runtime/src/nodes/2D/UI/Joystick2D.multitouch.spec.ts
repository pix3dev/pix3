import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button2D } from './Button2D';
import { Joystick2D } from './Joystick2D';
import { InputService } from '../../../core/InputService';

/**
 * Pointer OWNERSHIP in the joystick's drag machine: a stick captures the finger that started the
 * drag and, until that finger ends, reads nothing else.
 *
 * Everything here drives a real `InputService` through real `PointerEvent`s, because these are all
 * behaviours that only exist with several pointers alive at once — a stick reading the shared
 * `isPointerDown` / `isHoveringUI` cannot tell any of these cases apart. The single-finger
 * repertoire (press in the base, drag, release, floating recentre, fade) is covered by
 * `Joystick2D.spec.ts`, `core/Joystick2D.runtime.spec.ts` and `interactions.spec.ts`, and stays
 * untouched: ownership must not change what one finger does.
 */

/** The element rect is 1:1 at the origin, so client coordinates ARE input coordinates. */
const INPUT_SIZE = 200;
/** No scene → world size equals input size, so screen (100,100) is world (0,0). */
const screenX = (worldX: number): number => worldX + INPUT_SIZE / 2;
const screenY = (worldY: number): number => INPUT_SIZE / 2 - worldY;

describe('Joystick2D pointer ownership (multi-touch)', () => {
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
  const cancel = (pointerId: number, worldX: number, worldY: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointercancel', {
        pointerId,
        clientX: screenX(worldX),
        clientY: screenY(worldY),
      })
    );

  /** One game frame: publish the queued pointer events, then tick the nodes, as SceneRunner does. */
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

  function createStick(options: {
    id: string;
    x: number;
    horizontal: string;
    vertical: string;
    floating?: boolean;
  }): Joystick2D {
    const joystick = new Joystick2D({
      id: options.id,
      name: options.id,
      radius: 30,
      axisHorizontal: options.horizontal,
      axisVertical: options.vertical,
      floating: options.floating ?? false,
    });
    joystick.position.set(options.x, 0, 0);
    joystick.input = input;
    return joystick;
  }

  /** 60x40 at world (60,0) → world x 30..90, y ±20. Far from every stick used here. */
  function createButton(): { button: Button2D; clicks: string[] } {
    const button = new Button2D({
      id: 'fire',
      name: 'Fire',
      width: 60,
      height: 40,
      buttonAction: 'Fire',
    });
    button.position.set(60, 0, 0);
    button.input = input;
    const clicks: string[] = [];
    const owner = {};
    button.connect('click', owner, () => clicks.push('click'));
    return { button, clicks };
  }

  it('holds its axis through another finger pressing and releasing a button', () => {
    const stick = createStick({ id: 'move', x: -60, horizontal: 'MoveX', vertical: 'MoveY' });
    const { button, clicks } = createButton();

    down(1, -60, 0);
    frame(stick, button);
    move(1, -40, 0);
    frame(stick, button);

    const held = input.getAxis('MoveX');
    expect(held).toBeCloseTo(20 / 30, 5);

    // Second finger, on the fire button. The stick must not so much as twitch, and the button must
    // complete its click while the stick is still held — the gesture pair this contract exists for.
    down(2, 60, 0);
    frame(stick, button);
    expect(input.getAxis('MoveX')).toBe(held);
    expect(input.getButton('Fire')).toBe(true);

    up(2, 60, 0);
    frame(stick, button);
    expect(clicks).toEqual(['click']);
    expect(input.getAxis('MoveX')).toBe(held);
    expect(input.getAxis('MoveY')).toBe(0);

    // Only its own finger ends the drag.
    up(1, -40, 0);
    frame(stick, button);
    expect(input.getAxis('MoveX')).toBe(0);
  });

  it('ignores a second finger that lands inside the base it is already driving', () => {
    const stick = createStick({ id: 'move', x: 0, horizontal: 'MoveX', vertical: 'MoveY' });

    down(1, 0, 0);
    frame(stick);
    move(1, 15, 0);
    frame(stick);
    expect(input.getAxis('MoveX')).toBeCloseTo(0.5, 5);

    // A thumb landing in the base and travelling the other way would flip the axis if the stick
    // read "whatever pointer is around" instead of the one it captured.
    down(2, -15, 0);
    frame(stick);
    move(2, -30, 0);
    frame(stick);
    expect(input.getAxis('MoveX')).toBeCloseTo(0.5, 5);
  });

  it('drives two sticks with two fingers, and a release zeroes only the stick that ended', () => {
    const left = createStick({ id: 'left', x: -60, horizontal: 'MoveX', vertical: 'MoveY' });
    const right = createStick({ id: 'right', x: 60, horizontal: 'AimX', vertical: 'AimY' });

    down(1, -60, 0);
    down(2, 60, 0);
    frame(left, right);

    move(1, -60, 20); // left stick: straight up
    move(2, 90, 0); // right stick: hard right (clamped to the radius)
    frame(left, right);

    expect(input.getAxis('MoveY')).toBeCloseTo(20 / 30, 5);
    expect(input.getAxis('MoveX')).toBeCloseTo(0, 5);
    expect(input.getAxis('AimX')).toBeCloseTo(1, 5);
    expect(input.getAxis('AimY')).toBeCloseTo(0, 5);

    up(1, -60, 20);
    frame(left, right);

    expect(input.getAxis('MoveY')).toBe(0);
    expect(input.getAxis('AimX')).toBeCloseTo(1, 5);
  });

  it('cancelling the finger that drives a stick returns its axes to neutral', () => {
    const stick = createStick({ id: 'move', x: 0, horizontal: 'MoveX', vertical: 'MoveY' });

    down(1, 0, 0);
    frame(stick);
    move(1, 22, 0);
    frame(stick);
    expect(input.getAxis('MoveX')).toBeGreaterThan(0.5);

    // A finger dragged off the edge of the screen is a `pointercancel`. Leaving the axes pushed here
    // is the bug that keeps a character running forever.
    cancel(1, 22, 0);
    frame(stick);

    expect(input.getAxis('MoveX')).toBe(0);
    expect(input.getAxis('MoveY')).toBe(0);
  });

  it('starts a floating stick under a second finger while the first one holds a button', () => {
    const stick = createStick({
      id: 'float',
      x: 0,
      horizontal: 'MoveX',
      vertical: 'MoveY',
      floating: true,
    });
    const { button } = createButton();

    // The button ticks first, so its hover is registered against finger 1 before the stick looks.
    down(1, 60, 0);
    frame(button, stick);
    expect(input.getButton('Fire')).toBe(true);
    // Finger 1 is over UI, so it may not summon the stick.
    expect(input.isPointerOverUI(1)).toBe(true);
    expect(input.getAxis('MoveX')).toBe(0);
    expect(input.getAxis('MoveY')).toBe(0);

    // Finger 2 lands in empty space. Under the old `isHoveringUI` aggregate this was impossible:
    // the button's hover blocked every finger, so the stick could never start.
    down(2, -50, -50);
    frame(button, stick);
    expect(stick.position.x).toBeCloseTo(-50, 5);
    expect(stick.position.y).toBeCloseTo(-50, 5);

    move(2, -50, -20);
    frame(button, stick);

    expect(input.getAxis('MoveY')).toBeCloseTo(1, 5);
    expect(input.getAxis('MoveX')).toBeCloseTo(0, 5);
    // …and the button never let go.
    expect(input.getButton('Fire')).toBe(true);
  });
});
