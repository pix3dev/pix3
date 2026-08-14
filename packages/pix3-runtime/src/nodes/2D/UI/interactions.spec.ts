import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';

import { Button2D } from './Button2D';
import { Checkbox2D } from './Checkbox2D';
import { InventorySlot2D } from './InventorySlot2D';
import { Joystick2D } from './Joystick2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { Slider2D } from './Slider2D';
import { Group2D } from '../Group2D';
import { InputService } from '../../../core/InputService';
import { isInteractive, type Interactive } from '../../../fw/interactive';

/**
 * The semantic channel is only worth anything if invoking an interaction is indistinguishable from
 * performing the gesture. So nearly every test here runs BOTH: the real pointer through `tick()`,
 * and `invokeInteraction`, then compares what a game could observe — signal order, virtual
 * buttons/axes, node state. A regression that turns an interaction into a direct handler call
 * shows up as a missing signal, not as a silent pass.
 */

/** Every lifecycle signal the shared UIControl2D funnel emits, in the order it emits them. */
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

// Input 200x200 and no scene → the logical camera equals the input size, so screen (100,100) maps
// to world (0,0): the origin, where these nodes sit by default.
function createInputService(): InputService {
  const input = new InputService();
  input.width = 200;
  input.height = 200;
  return input;
}

/** Screen Y for a world Y, under the mapping above (screen Y grows downward). */
const screenY = (worldY: number): number => 100 - worldY;

describe('Interactive contract', () => {
  it('is recognised on every control that implements it', () => {
    const nodes = [
      new Button2D({ id: 'b', name: 'B' }),
      new Checkbox2D({ id: 'c', name: 'C' }),
      new Slider2D({ id: 's', name: 'S' }),
      new InventorySlot2D({ id: 'i', name: 'I' }),
      new ScrollContainer2D({ id: 'sc', name: 'SC' }),
      new Joystick2D({ id: 'j', name: 'J' }),
    ];
    for (const node of nodes) {
      expect(isInteractive(node), `${node.name} should be Interactive`).toBe(true);
      expect(node.getInteractions().length).toBeGreaterThan(0);
    }
    expect(isInteractive({})).toBe(false);
    expect(isInteractive(null)).toBe(false);
  });

  it('returns false for an unknown interaction instead of throwing', () => {
    // A listing is a promise about this frame; an agent may hold a stale one.
    const nodes: Interactive[] = [
      new Button2D({ id: 'b', name: 'B' }),
      new Checkbox2D({ id: 'c', name: 'C' }),
      new Slider2D({ id: 's', name: 'S' }),
      new InventorySlot2D({ id: 'i', name: 'I' }),
      new ScrollContainer2D({ id: 'sc', name: 'SC' }),
      new Joystick2D({ id: 'j', name: 'J' }),
    ];
    for (const node of nodes) {
      expect(node.invokeInteraction('doesNotExist')).toBe(false);
      expect(node.invokeInteraction('click', { bogus: 'arg' })).not.toBe(undefined);
    }
  });

  it('declares argument metadata with the property-schema vocabulary', () => {
    const slider = new Slider2D({ id: 's', name: 'S', minValue: 0, maxValue: 10 });
    const setValue = slider.getInteractions().find(entry => entry.name === 'setValue');
    expect(setValue?.args?.[0]).toMatchObject({ name: 'value', type: 'number' });
    expect(setValue?.args?.[0].ui?.max).toBe(10);
  });
});

describe('Button2D interactions', () => {
  function createButton(): { button: Button2D; input: InputService; signals: string[] } {
    const button = new Button2D({ id: 'btn', name: 'Btn', buttonAction: 'Submit' });
    const input = createInputService();
    button.input = input;
    return { button, input, signals: recordSignals(button) };
  }

  it('click emits exactly what a real tap emits', () => {
    const real = createButton();
    real.input.pointerPosition.set(100, 100);
    real.input.isPointerDown = true;
    real.button.tick(1 / 60);
    real.input.isPointerDown = false;
    real.button.tick(1 / 60);

    const semantic = createButton();
    expect(semantic.button.invokeInteraction('click')).toBe(true);

    expect(real.signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
    expect(semantic.signals).toEqual(real.signals);
    // The virtual button was pulsed and lowered, exactly as the tap left it.
    expect(semantic.input.getButton('Submit')).toBe(false);
  });

  it('press holds across the frames that follow, and release completes the click', () => {
    // The point of a latch: a real finger re-asserts itself every frame, so a semantic hold must
    // too — otherwise the very next tick reads the (up, elsewhere) physical pointer and cancels.
    const { button, input, signals } = createButton();

    expect(button.invokeInteraction('press')).toBe(true);
    expect(input.getButton('Submit')).toBe(true);

    button.tick(1 / 60);
    button.tick(1 / 60);
    expect(input.getButton('Submit')).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    expect(button.invokeInteraction('release')).toBe(true);
    expect(input.getButton('Submit')).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);

    // Released: back on real input, which is up and elsewhere.
    button.tick(1 / 60);
    expect(signals).toHaveLength(5);
  });

  it('keeps a semantic hold through a finger that is not pressing this control', () => {
    // Replaces "a real finger takes the control back from a semantic hold", which asserted the
    // single-pointer rule "any real finger wins". Multi-touch makes that rule wrong in the most
    // ordinary case there is: a thumb on the joystick would drop the semantic hold on the fire
    // button, so an input aimed somewhere else would cancel this control's press.
    const { button, input, signals } = createButton();
    button.invokeInteraction('press');

    // A finger in empty space, far from the button.
    input.pointerPosition.set(10, 190);
    input.isPointerDown = true;
    button.tick(1 / 60);
    button.tick(1 / 60);

    expect(input.getButton('Submit')).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed']);
  });

  it('hands a semantic hold to a real finger that presses the control itself', () => {
    // The one genuine conflict: a finger that would CLAIM this control (down, inside its bounds).
    // Two pointers driving one control is exactly what ownership exists to prevent, so the physical
    // one takes over — seamlessly, since the control is already pressed.
    const { button, input, signals } = createButton();
    button.invokeInteraction('press');

    input.pointerPosition.set(100, 100); // screen centre = the button's world origin
    input.isPointerDown = true;
    button.tick(1 / 60);
    expect(input.getButton('Submit')).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    // Lifting the finger completes the press it inherited — the latch is gone, so nothing re-holds.
    input.isPointerDown = false;
    button.tick(1 / 60);
    expect(input.getButton('Submit')).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });

  it('hover stays on the control so its hover visual is observable', () => {
    const { button } = createButton();
    const material = (
      button as unknown as { buttonMaterial: { color: { getHexString(): string } } }
    ).buttonMaterial;

    expect(button.invokeInteraction('hover')).toBe(true);
    expect(material.color.getHexString()).toBe('5a5a5a'); // hoverColor
    button.tick(1 / 60);
    expect(material.color.getHexString()).toBe('5a5a5a');

    expect(button.invokeInteraction('release')).toBe(true);
    button.tick(1 / 60);
    expect(material.color.getHexString()).toBe('4a4a4a'); // backgroundColor
  });

  it('rejects every interaction while disabled', () => {
    const { button, signals } = createButton();
    button.enabled = false;

    for (const name of ['hover', 'press', 'release', 'click']) {
      expect(button.invokeInteraction(name), name).toBe(false);
    }
    expect(signals).toEqual([]);
  });

  it('rejects an interaction while an ancestor scroll container holds the gesture', () => {
    // Same gate a finger hits: a list being dragged owns the pointer, control underneath included.
    const { container, content, input } = createScrollList();
    const button = new Button2D({ id: 'btn', name: 'Btn' });
    const signals = recordSignals(button);
    content.adoptChild(button);
    button.input = input;

    // Claim the gesture with a real drag.
    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    input.pointerPosition.set(100, 70);
    container.tick(1 / 60);
    expect(container.hasActivePointerCapture()).toBe(true);
    // The real drag pressed the button before the list claimed the gesture; the claim cancelled it
    // silently. What matters is that the invocation adds nothing on top of that.
    const before = [...signals];

    expect(button.invokeInteraction('click')).toBe(false);
    expect(signals).toEqual(before);
    expect(signals).not.toContain('click');
  });
});

describe('Checkbox2D interactions', () => {
  function createCheckbox(checked = false): {
    checkbox: Checkbox2D;
    input: InputService;
    signals: string[];
  } {
    const checkbox = new Checkbox2D({ id: 'cb', name: 'CB', checked, checkmarkAction: 'Music' });
    const input = createInputService();
    checkbox.input = input;
    return { checkbox, input, signals: recordSignals(checkbox) };
  }

  it('toggle flips the box exactly like a tap does', () => {
    const real = createCheckbox();
    real.input.pointerPosition.set(100, 100);
    real.input.isPointerDown = true;
    real.checkbox.tick(1 / 60);
    real.input.isPointerDown = false;
    real.checkbox.tick(1 / 60);

    const semantic = createCheckbox();
    expect(semantic.checkbox.invokeInteraction('toggle')).toBe(true);

    expect(real.checkbox.checked).toBe(true);
    expect(semantic.checkbox.checked).toBe(true);
    expect(semantic.signals).toEqual(real.signals);
    // Same virtual axis pulse the tap produced.
    expect(semantic.input.getAxis('Music')).toBe(1);
    expect(semantic.input.getButton('Music')).toBe(true);
    semantic.checkbox.tick(1 / 60);
    expect(semantic.input.getButton('Music')).toBe(false);
  });

  it('setChecked clicks only when the state has to change', () => {
    const { checkbox, signals } = createCheckbox();

    expect(checkbox.invokeInteraction('setChecked', { checked: true })).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);

    // Already there: accepted, but no gesture is invented.
    expect(checkbox.invokeInteraction('setChecked', { checked: true })).toBe(true);
    expect(signals).toHaveLength(5);

    // Model JSON spells booleans as strings often enough to matter.
    expect(checkbox.invokeInteraction('setChecked', { checked: 'false' })).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it('rejects a missing argument and rejects everything while disabled', () => {
    const { checkbox, signals } = createCheckbox();
    expect(checkbox.invokeInteraction('setChecked')).toBe(false);

    checkbox.enabled = false;
    expect(checkbox.invokeInteraction('toggle')).toBe(false);
    // Even the redundant write is refused: a disabled control accepts nothing.
    expect(checkbox.invokeInteraction('setChecked', { checked: false })).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(signals).toEqual([]);
  });
});

describe('Slider2D interactions', () => {
  function createSlider(): { slider: Slider2D; input: InputService; signals: string[] } {
    const slider = new Slider2D({ id: 'sl', name: 'SL', axisName: 'Volume' });
    const input = createInputService();
    slider.input = input;
    return { slider, input, signals: recordSignals(slider) };
  }

  it('setValue moves the value without pretending a gesture happened', () => {
    const { slider, input, signals } = createSlider();

    expect(slider.invokeInteraction('setValue', { value: 25 })).toBe(true);

    expect(slider.value).toBe(25);
    expect(input.getAxis('Volume')).toBe(0.25);
    // No pointer touched the track, so no lifecycle signal may claim one did.
    expect(signals).toEqual([]);
  });

  it('dragTo reaches the same value through the same drag a finger runs', () => {
    const real = createSlider();
    // Press at the handle (value 50 → world x 0 → screen 100), drag right to screen 150 (world +50
    // → 75), release there.
    real.input.pointerPosition.set(100, 100);
    real.input.isPointerDown = true;
    real.slider.tick(1 / 60);
    real.input.pointerPosition.set(150, 100);
    real.slider.tick(1 / 60);
    real.input.isPointerDown = false;
    real.slider.tick(1 / 60);

    const semantic = createSlider();
    expect(semantic.slider.invokeInteraction('dragTo', { value: 75 })).toBe(true);

    expect(real.slider.value).toBe(75);
    expect(semantic.slider.value).toBe(75);
    expect(semantic.signals).toEqual(real.signals);
    expect(semantic.signals).toContain('click');
    expect(semantic.input.getAxis('Volume')).toBe(0.75);
    // The drag ended: the slider is back on real input and not stuck holding itself.
    expect(semantic.slider.isDragging).toBe(false);
  });

  it('dragTo clamps to the range and coerces a stringified number', () => {
    const { slider } = createSlider();
    expect(slider.invokeInteraction('dragTo', { value: '999' })).toBe(true);
    expect(slider.value).toBe(100);
  });

  it('rejects both value interactions while disabled', () => {
    const { slider, signals } = createSlider();
    slider.enabled = false;

    expect(slider.invokeInteraction('setValue', { value: 10 })).toBe(false);
    expect(slider.invokeInteraction('dragTo', { value: 10 })).toBe(false);
    expect(slider.value).toBe(50);
    expect(signals).toEqual([]);
  });

  it('rejects a drag while an ancestor scroll container holds the gesture', () => {
    const { container, content, input } = createScrollList();
    const slider = new Slider2D({ id: 'sl', name: 'SL' });
    content.adoptChild(slider);
    slider.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    input.pointerPosition.set(100, 70);
    container.tick(1 / 60);
    expect(container.hasActivePointerCapture()).toBe(true);

    expect(slider.invokeInteraction('dragTo', { value: 90 })).toBe(false);
    expect(slider.invokeInteraction('setValue', { value: 90 })).toBe(false);
    expect(slider.value).toBe(50);
  });
});

describe('InventorySlot2D interactions', () => {
  function createSlot(): { slot: InventorySlot2D; input: InputService; signals: string[] } {
    const slot = new InventorySlot2D({ id: 'slot', name: 'Slot', selectedAction: 'PickSlot' });
    const input = createInputService();
    slot.input = input;
    return { slot, input, signals: recordSignals(slot) };
  }

  it('activate selects the slot exactly like a tap does', () => {
    const real = createSlot();
    real.input.pointerPosition.set(100, 100);
    real.input.isPointerDown = true;
    real.slot.tick(1 / 60);
    real.input.isPointerDown = false;
    real.slot.tick(1 / 60);

    const semantic = createSlot();
    expect(semantic.slot.invokeInteraction('activate')).toBe(true);

    expect(real.slot.selected).toBe(true);
    expect(semantic.slot.selected).toBe(true);
    expect(semantic.signals).toEqual(real.signals);
    expect(semantic.input.getButton('PickSlot')).toBe(true);
  });

  it('rejects activation inside a scrolling list, like a flick over it does', () => {
    // The bug this gate exists for: flicking an inventory selected whatever was under the finger.
    const { container, content, input } = createScrollList();
    const slot = new InventorySlot2D({ id: 'slot', name: 'Slot' });
    const signals = recordSignals(slot);
    content.adoptChild(slot);
    slot.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    input.pointerPosition.set(100, 70);
    container.tick(1 / 60);

    const before = [...signals];

    expect(slot.invokeInteraction('activate')).toBe(false);
    expect(slot.selected).toBe(false);
    expect(signals).toEqual(before);
    expect(signals).not.toContain('click');
  });
});

/** A 220x120 scroll viewport holding 320 units of content — max scrollY 100. */
function createScrollList(overrides: { dragScrollEnabled?: boolean } = {}): {
  container: ScrollContainer2D;
  content: Group2D;
  input: InputService;
} {
  const container = new ScrollContainer2D({
    id: 'list',
    name: 'List',
    width: 220,
    height: 120,
    dragThreshold: 6,
    ...overrides,
  });
  const content = new Group2D({
    id: 'content',
    name: 'Content',
    width: 220,
    height: 320,
    position: new Vector2(0, 0),
  });
  container.adoptChild(content);
  const input = createInputService();
  container.input = input;
  return { container, content, input };
}

describe('ScrollContainer2D interactions', () => {
  it('scrollBy travels exactly as far as the equivalent finger drag', () => {
    const real = createScrollList();
    // Press, cross the 6-unit threshold, then travel 40 world units upward on screen.
    real.input.pointerPosition.set(100, screenY(0));
    real.input.isPointerDown = true;
    real.container.tick(1 / 60);
    real.input.pointerPosition.set(100, screenY(7));
    real.container.tick(1 / 60);
    real.input.pointerPosition.set(100, screenY(47));
    real.container.tick(1 / 60);
    real.input.pointerPosition.set(100, screenY(47));
    real.container.tick(1 / 60);
    real.input.isPointerDown = false;
    real.container.tick(1 / 60);

    const semantic = createScrollList();
    expect(semantic.container.invokeInteraction('scrollBy', { delta: 40 })).toBe(true);

    expect(real.container.scrollY).toBeCloseTo(40, 5);
    expect(semantic.container.scrollY).toBeCloseTo(real.container.scrollY, 5);
    // The gesture ended: no capture left behind, and the content actually moved.
    expect(semantic.container.hasActivePointerCapture()).toBe(false);
    expect(semantic.content.position.y).toBeCloseTo(40, 5);
  });

  it('scrollBy does not leave a drift behind (the drag settles before release)', () => {
    const { container } = createScrollList();
    container.invokeInteraction('scrollBy', { delta: 40 });

    for (let frame = 0; frame < 30; frame += 1) {
      container.tick(1 / 60);
    }
    expect(container.scrollY).toBeCloseTo(40, 5);
  });

  it('scrollTo lands on an absolute offset and clamps to the scrollable range', () => {
    const { container } = createScrollList();

    expect(container.invokeInteraction('scrollTo', { offset: 60 })).toBe(true);
    expect(container.scrollY).toBeCloseTo(60, 5);

    expect(container.invokeInteraction('scrollTo', { offset: 999 })).toBe(true);
    expect(container.scrollY).toBeCloseTo(100, 5); // max scroll
  });

  it('fling releases while moving and lets inertia carry the list', () => {
    const { container } = createScrollList();

    expect(container.invokeInteraction('fling', { velocity: 300 })).toBe(true);
    const atRelease = container.scrollY;

    container.tick(1 / 60);
    container.tick(1 / 60);
    expect(container.scrollY).toBeGreaterThan(atRelease);

    for (let frame = 0; frame < 120; frame += 1) {
      container.tick(1 / 60);
    }
    const settled = container.scrollY;
    container.tick(1 / 60);
    expect(container.scrollY).toBeCloseTo(settled, 5);
  });

  it('reports the refusal when drag scrolling is switched off', () => {
    const { container } = createScrollList({ dragScrollEnabled: false });

    expect(container.invokeInteraction('scrollBy', { delta: 40 })).toBe(false);
    expect(container.scrollY).toBe(0);
    expect(container.invokeInteraction('scrollBy')).toBe(false);
  });

  it('scrolls nothing, but accepts the gesture, when the content already fits', () => {
    const container = new ScrollContainer2D({ id: 'l', name: 'L', width: 220, height: 320 });
    container.adoptChild(new Group2D({ id: 'c', name: 'C', width: 220, height: 100 }));
    container.input = createInputService();

    expect(container.invokeInteraction('scrollBy', { delta: 40 })).toBe(true);
    expect(container.scrollY).toBe(0);
  });
});

describe('Joystick2D interactions', () => {
  function createJoystick(props: { floating?: boolean } = {}): {
    joystick: Joystick2D;
    input: InputService;
  } {
    const joystick = new Joystick2D({
      id: 'stick',
      name: 'Stick',
      radius: 50,
      axisHorizontal: 'Horizontal',
      axisVertical: 'Vertical',
      ...props,
    });
    const input = createInputService();
    joystick.input = input;
    return { joystick, input };
  }

  const handleOf = (joystick: Joystick2D): { position: { x: number; y: number } } =>
    (joystick as unknown as { handleMesh: { position: { x: number; y: number } } }).handleMesh;

  it('setStick pushes the axes exactly as far as a real touch drag does', () => {
    const real = createJoystick();
    // Touch the centre (starts the drag), then move to the right edge of the base.
    real.input.pointerPosition.set(100, 100);
    real.input.isPointerDown = true;
    real.joystick.tick(1 / 60);
    real.input.pointerPosition.set(150, 100);
    real.joystick.tick(1 / 60);

    const semantic = createJoystick();
    expect(semantic.joystick.invokeInteraction('setStick', { dir: 'right', magnitude: 1 })).toBe(
      true
    );

    expect(real.input.getAxis('Horizontal')).toBeCloseTo(1, 5);
    expect(semantic.input.getAxis('Horizontal')).toBeCloseTo(1, 5);
    expect(semantic.input.getAxis('Vertical')).toBeCloseTo(0, 5);
    expect(handleOf(semantic.joystick).position.x).toBeCloseTo(50, 5);
  });

  it('holds the stick across the frames that follow, until released', () => {
    const { joystick, input } = createJoystick();
    joystick.invokeInteraction('setStick', { dir: 'up', magnitude: 0.5 });

    expect(input.getAxis('Vertical')).toBeCloseTo(0.5, 5);
    joystick.tick(1 / 60);
    joystick.tick(1 / 60);
    // A stick is held, not tapped: an un-latched implementation zeroes here on the next tick.
    expect(input.getAxis('Vertical')).toBeCloseTo(0.5, 5);

    expect(joystick.invokeInteraction('releaseStick')).toBe(true);
    expect(input.getAxis('Vertical')).toBe(0);
    expect(handleOf(joystick).position.y).toBe(0);

    joystick.tick(1 / 60);
    expect(input.getAxis('Vertical')).toBe(0);
  });

  it('accepts an angle in degrees and clamps the magnitude', () => {
    const { joystick, input } = createJoystick();

    expect(joystick.invokeInteraction('setStick', { dir: 90 })).toBe(true);
    expect(input.getAxis('Vertical')).toBeCloseTo(1, 5);
    expect(input.getAxis('Horizontal')).toBeCloseTo(0, 5);

    expect(joystick.invokeInteraction('setStick', { dir: 'left', magnitude: 5 })).toBe(true);
    expect(input.getAxis('Horizontal')).toBeCloseTo(-1, 5);
  });

  it('drives a floating joystick through its own recentring path', () => {
    const { joystick, input } = createJoystick({ floating: true });

    expect(joystick.invokeInteraction('setStick', { dir: 'down', magnitude: 1 })).toBe(true);
    expect(input.getAxis('Vertical')).toBeCloseTo(-1, 5);

    expect(joystick.invokeInteraction('releaseStick')).toBe(true);
    expect(input.getAxis('Vertical')).toBe(0);
  });

  it('rejects a direction it cannot resolve', () => {
    const { joystick, input } = createJoystick();

    expect(joystick.invokeInteraction('setStick', { dir: 'sideways' })).toBe(false);
    expect(joystick.invokeInteraction('setStick', {})).toBe(false);
    expect(input.getAxis('Horizontal')).toBe(0);
  });

  it('gives the stick back to a real finger', () => {
    const { joystick, input } = createJoystick();
    joystick.invokeInteraction('setStick', { dir: 'right', magnitude: 1 });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    joystick.tick(1 / 60);
    input.isPointerDown = false;
    joystick.tick(1 / 60);

    expect(input.getAxis('Horizontal')).toBe(0);
  });
});
