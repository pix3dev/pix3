import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button2D } from './Button2D';
import { Slider2D } from './Slider2D';
import { Group2D } from '../Group2D';
import { Label2D } from './Label2D';
import { Bar2D } from './Bar2D';
import { CanvasLayer2D } from '../CanvasLayer2D';
import { ColorRect2D } from '../ColorRect2D';
import { InputService } from '../../../core/InputService';

/**
 * Pointer OWNERSHIP in the control funnel: a control follows at most one pointer, and while it owns
 * one the others do not exist for it.
 *
 * Everything here drives a real `InputService` through real `PointerEvent`s, because the whole
 * point is behaviour that only exists when several pointers are alive at once — a control reading
 * the shared `isPointerDown` cannot tell any of these cases apart. The single-pointer repertoire
 * (tap, slide-in, slide-off, drag, hover) is covered by the existing per-control specs and stays
 * untouched: ownership must not change what one finger does.
 */

/** The element rect is 1:1 at the origin, so client coordinates ARE input coordinates. */
const INPUT_SIZE = 200;
/** Screen (100,100) is world (0,0) under the no-scene fallback mapping (world = input size). */
const worldToScreenX = (worldX: number): number => worldX + INPUT_SIZE / 2;

const FUNNEL_SIGNALS = ['pointerdown', 'pressed', 'pointerup', 'released', 'click'] as const;

interface SignalSource {
  connect(signal: string, owner: object, handler: () => void): unknown;
}

function recordSignals(node: SignalSource): string[] {
  const seen: string[] = [];
  const listener = {};
  for (const name of FUNNEL_SIGNALS) {
    node.connect(name, listener, () => seen.push(name));
  }
  return seen;
}

const hovering = (button: Button2D): boolean =>
  (button as unknown as { isHovering: boolean }).isHovering;

describe('UIControl2D pointer ownership (multi-touch)', () => {
  let input: InputService;
  let element: HTMLDivElement;

  const down = (pointerId: number, x: number, y: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId, clientX: x, clientY: y })
    );
  const move = (pointerId: number, x: number, y: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointermove', { pointerId, clientX: x, clientY: y })
    );
  const up = (pointerId: number, x: number, y: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y })
    );
  const cancel = (pointerId: number, x: number, y: number): void =>
    void element.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId, clientX: x, clientY: y })
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

  /** 100x40 at the origin → world x ±50, y ±20 → screen x 50..150, y 80..120. */
  function createButton(): { button: Button2D; signals: string[] } {
    const button = new Button2D({ id: 'btn', name: 'Btn', buttonAction: 'Submit' });
    button.input = input;
    return { button, signals: recordSignals(button) };
  }

  it('does not pass an opening press to a newly revealed overlapping close button', () => {
    const { button: opener } = createButton();
    const closer = new Button2D({ id: 'close', name: 'Close' });
    closer.input = input;
    closer.visible = false;
    const close = vi.fn(() => {
      closer.visible = false;
    });
    closer.onPressed = close;
    opener.onPressed = () => {
      closer.visible = true;
      opener.visible = false;
    };

    down(1, 100, 100);
    frame(opener, closer);
    frame(opener, closer);
    expect(closer.visible).toBe(true);
    expect(close).not.toHaveBeenCalled();

    up(1, 100, 100);
    frame(opener, closer);
    expect(close).not.toHaveBeenCalled();

    // Mouse ids are reused: a fresh press at the same point must close immediately.
    down(1, 100, 100);
    frame(opener, closer);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('allows a second finger to press an overlay while the opening finger is still held', () => {
    const { button: opener } = createButton();
    const closer = new Button2D({ id: 'close', name: 'Close' });
    closer.input = input;
    closer.visible = false;
    const close = vi.fn();
    closer.onPressed = close;
    opener.onPressed = () => {
      closer.visible = true;
      opener.visible = false;
    };
    down(1, 100, 100);
    frame(opener, closer);
    expect(close).not.toHaveBeenCalled();
    down(2, 100, 100);
    frame(opener, closer);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('routes the next press to the visible overlay rather than the opener underneath it', () => {
    const root = new Group2D({ id: 'root' });
    const { button: opener } = createButton();
    const closer = new Button2D({ id: 'close', name: 'Close' });
    closer.input = input;
    closer.visible = false;
    root.add(opener, closer);
    const open = vi.fn(() => {
      closer.visible = true;
    });
    const close = vi.fn(() => {
      closer.visible = false;
    });
    opener.onPressed = open;
    closer.onPressed = close;
    down(1, 100, 100);
    frame(root);
    frame(root);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    up(1, 100, 100);
    frame(root);
    down(1, 100, 100);
    frame(root);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not let a decorative label or bar inside a button intercept its press', () => {
    const { button } = createButton();
    button.add(new Label2D({ id: 'caption', label: '', width: 100, height: 40 }));
    button.add(new Bar2D({ id: 'bar', width: 100, height: 40 }));
    const press = vi.fn();
    button.onPressed = press;
    down(1, 100, 100);
    frame(button);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('clears background hover and blocks presses while a modal backdrop is visible', () => {
    const root = new Group2D({ id: 'root' });
    const { button } = createButton();
    const backdrop = new ColorRect2D({
      id: 'backdrop',
      width: 200,
      height: 200,
      blocksPointerInput: true,
    });
    backdrop.input = input;
    backdrop.visible = false;
    root.add(button, backdrop);
    const press = vi.fn();
    const exit = vi.fn();
    button.onPressed = press;
    button.onHoverExit = exit;
    move(1, 100, 100);
    frame(root);
    expect(hovering(button)).toBe(true);
    backdrop.visible = true;
    frame(root);
    expect(hovering(button)).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    down(1, 100, 100);
    frame(root);
    up(1, 100, 100);
    frame(root);
    expect(press).not.toHaveBeenCalled();
    backdrop.visible = false;
    frame(root);
    expect(hovering(button)).toBe(true);
  });

  it('lets modal controls above the blocker hover and press while keeping underlying buttons inert', () => {
    const root = new Group2D({ id: 'root' });
    const { button: background } = createButton();
    const backdrop = new ColorRect2D({
      id: 'backdrop',
      width: 200,
      height: 200,
      blocksPointerInput: true,
    });
    backdrop.input = input;
    const close = new Button2D({ id: 'close' });
    close.input = input;
    root.add(background, backdrop, close);
    const press = vi.fn();
    close.onPressed = press;
    move(1, 100, 100);
    frame(root);
    expect(hovering(background)).toBe(false);
    expect(hovering(close)).toBe(true);
    down(1, 100, 100);
    frame(root);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('ignores a blocker whose ancestor is hidden', () => {
    const root = new Group2D({ id: 'root' });
    const { button } = createButton();
    const modal = new Group2D({ id: 'modal' });
    const backdrop = new ColorRect2D({
      id: 'backdrop',
      width: 200,
      height: 200,
      blocksPointerInput: true,
    });
    backdrop.input = input;
    modal.add(backdrop);
    root.add(button, modal);
    modal.visible = false;
    move(1, 100, 100);
    frame(root);
    expect(hovering(button)).toBe(true);
    modal.visible = true;
    frame(root);
    expect(hovering(button)).toBe(false);
  });

  it.each(['cancel', 'blur'] as const)('releases the gesture reservation on %s', terminal => {
    const root = new Group2D({ id: 'root' });
    const { button: opener } = createButton();
    const closer = new Button2D({ id: 'close' });
    closer.input = input;
    closer.visible = false;
    root.add(opener, closer);
    opener.onPressed = () => {
      closer.visible = true;
    };
    const close = vi.fn();
    closer.onPressed = close;
    down(1, 100, 100);
    frame(root);
    if (terminal === 'cancel') cancel(1, 100, 100);
    else window.dispatchEvent(new Event('blur'));
    frame(root);
    expect(close).not.toHaveBeenCalled();
    down(1, 100, 100);
    frame(root);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['z', 'overlay'] as const)('honours the %s paint band over later tree order', band => {
    const root = new Group2D({ id: 'root' });
    const higher = new Button2D({ id: 'higher' });
    const lower = new Button2D({ id: 'lower' });
    higher.input = input;
    lower.input = input;
    if (band === 'z') {
      higher.zIndex = 1;
      root.add(higher, lower);
    } else {
      const overlay = new CanvasLayer2D({ id: 'overlay' });
      overlay.add(higher);
      root.add(overlay, lower);
    }
    const higherPress = vi.fn();
    const lowerPress = vi.fn();
    higher.onPressed = higherPress;
    lower.onPressed = lowerPress;
    down(1, 100, 100);
    frame(root);
    expect(higherPress).toHaveBeenCalledTimes(1);
    expect(lowerPress).not.toHaveBeenCalled();
  });

  it('ignores a second finger inside a button it already holds, and claims it after the first lifts', () => {
    const { button, signals } = createButton();

    down(1, 100, 100);
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    // Second finger, same button. It must not re-press, re-signal, or steal the press.
    down(2, 120, 105);
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);
    expect(input.getButton('Submit')).toBe(true);

    // The owner lifts inside the bounds: a completed click, even though finger 2 is still down.
    up(1, 100, 100);
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
    expect(input.getButton('Submit')).toBe(false);

    // Free again: the finger that was ignored is claimed on the very next tick, exactly as if it
    // had just landed. Ownership delays a second finger, it does not discard it.
    frame(button);
    expect(signals).toEqual([
      'pointerdown',
      'pressed',
      'pointerup',
      'released',
      'click',
      'pointerdown',
      'pressed',
    ]);
    expect(input.getButton('Submit')).toBe(true);
  });

  it('cancels — never clicks — when the owning finger is cancelled while another is held', () => {
    const { button, signals } = createButton();

    down(1, 100, 100);
    down(2, 10, 190); // second finger in empty space, held throughout
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    // `pointercancel` (finger dragged off the screen edge, an OS gesture, a lock) is not a release:
    // a press that was taken away must not read as a completed tap.
    cancel(1, 100, 100);
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);
    expect(input.getButton('Submit')).toBe(false);

    // And the surviving finger, which never touched the button, must not press it either.
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);
  });

  it('cancels when the owned pointer disappears with no terminal event at all', () => {
    const { button, signals } = createButton();

    down(1, 100, 100);
    frame(button);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    // The input lock drops every pointer; the cancel it queues is consumed by the frame the lock
    // happened in, so by this tick the owned pointer is simply gone. Silence must not invent a
    // click the user never made.
    input.lock();
    input.beginFrame();
    input.beginFrame();
    button.tick(1 / 60);

    expect(signals).toEqual(['pointerdown', 'pressed']);
    expect(input.getButton('Submit')).toBe(false);
  });

  /** 100x20 at the origin → world x ±50 → screen x 50..150; value 0..100 across that span. */
  function createSlider(): Slider2D {
    const slider = new Slider2D({
      id: 'sld',
      name: 'Sld',
      width: 100,
      height: 20,
      minValue: 0,
      maxValue: 100,
      value: 0,
    });
    slider.input = input;
    return slider;
  }

  it('keeps a capturing drag on its own finger, outside the track, while another finger taps the track', () => {
    const slider = createSlider();

    down(1, worldToScreenX(0), 100);
    frame(slider);
    expect(slider.value).toBe(50);
    expect(slider.isDragging).toBe(true);

    // Past the right edge of the track: a capturing control follows its finger out of bounds.
    move(1, worldToScreenX(90), 10);
    frame(slider);
    expect(slider.value).toBe(100);

    // A second finger taps *inside* the track, where it would set the value to 10 if the drag could
    // be stolen. It cannot: the slider is following finger 1 and nothing else exists for it.
    down(2, worldToScreenX(-40), 100);
    frame(slider);
    expect(slider.value).toBe(100);

    up(2, worldToScreenX(-40), 100);
    frame(slider);
    expect(slider.value).toBe(100);
    expect(slider.isDragging).toBe(true);

    // Only its own finger ends the drag.
    up(1, worldToScreenX(90), 10);
    frame(slider);
    expect(slider.isDragging).toBe(false);
    expect(slider.value).toBe(100);
  });

  it('attributes hover to the finger that is actually over the control', () => {
    const { button } = createButton();

    down(1, 100, 100); // on the button
    down(2, 10, 190); // empty space
    frame(button);

    expect(input.isHoveringUI).toBe(true);
    expect(input.isPointerOverUI(1)).toBe(true);
    // The whole reason `isPointerOverUI` exists: a thumb elsewhere is not "over UI" just because
    // another finger rests on a button, so a gesture gated on it can still run.
    expect(input.isPointerOverUI(2)).toBe(false);
  });

  it('lets two controls be held by two fingers at the same time', () => {
    const left = new Button2D({ id: 'l', name: 'L', buttonAction: 'Left', width: 60, height: 40 });
    const right = new Button2D({
      id: 'r',
      name: 'R',
      buttonAction: 'Right',
      width: 60,
      height: 40,
    });
    left.position.set(-60, 0, 0);
    right.position.set(60, 0, 0);
    left.input = input;
    right.input = input;

    down(1, worldToScreenX(-60), 100);
    down(2, worldToScreenX(60), 100);
    frame(left, right);

    expect(input.getButton('Left')).toBe(true);
    expect(input.getButton('Right')).toBe(true);

    // Releasing one leaves the other held — the case a single shared `isPointerDown` can never
    // express, and the reason this contract exists.
    up(1, worldToScreenX(-60), 100);
    frame(left, right);
    expect(input.getButton('Left')).toBe(false);
    expect(input.getButton('Right')).toBe(true);
  });
});
