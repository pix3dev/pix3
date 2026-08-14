import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';

import { Checkbox2D, type Checkbox2DProps } from './Checkbox2D';
import { Group2D } from '../Group2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { InputService } from '../../../core/InputService';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

/** Every lifecycle signal the shared UIControl2D funnel emits, in the order it emits them. */
const FUNNEL_SIGNALS = ['pointerdown', 'pressed', 'pointerup', 'released', 'click'] as const;

/** Hover flag; protected on UIControl2D, but it is the state the funnel is judged by. */
const hoverOf = (checkbox: Checkbox2D): boolean =>
  (checkbox as unknown as { isHovering: boolean }).isHovering;

/** Records the funnel signals a control emits, in order. */
function recordSignals(checkbox: Checkbox2D): string[] {
  const seen: string[] = [];
  const listener = {};
  for (const name of FUNNEL_SIGNALS) {
    checkbox.connect(name, listener, () => seen.push(name));
  }
  return seen;
}

// Input 200x200 and no scene → the logical camera equals the input size, so screen (100,100) maps
// to world (0,0) — the control centre — and screen (10,10) to world (-90,90), well outside it.
function createInputService(): InputService {
  const input = new InputService();
  input.width = 200;
  input.height = 200;
  return input;
}

interface CheckboxInternals {
  boxMaterial: MeshBasicMaterial;
  checkMesh: Mesh | null;
  checkMaterial: MeshBasicMaterial | null;
  geometry: PlaneGeometry;
  checkGeometry: PlaneGeometry | null;
}

const internalsOf = (checkbox: Checkbox2D): CheckboxInternals =>
  checkbox as unknown as CheckboxInternals;

function createCheckbox(overrides: Partial<Checkbox2DProps> = {}): Checkbox2D {
  // No label: happy-dom has no canvas 2D context, and these tests exercise the box visuals.
  return new Checkbox2D({ id: 'cb', name: 'Checkbox', ...overrides });
}

function hexOf(style: string): number {
  return new Color(style).getHex();
}

describe('Checkbox2D script assignments (reactive schema properties)', () => {
  it('draws the checkmark and recolours the box when a script assigns checked', () => {
    // Only toggle() worked before; `checkbox.checked = true` changed the field and drew nothing.
    const checkbox = createCheckbox({ checkedColor: '#4a9eff', uncheckedColor: '#ffffff' });
    const internals = internalsOf(checkbox);
    expect(internals.checkMesh).toBeNull();

    checkbox.checked = true;

    expect(internals.checkMesh).not.toBeNull();
    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#4a9eff'));
  });

  it('removes the checkmark when a script unchecks', () => {
    const checkbox = createCheckbox({ checked: true });
    const internals = internalsOf(checkbox);
    expect(internals.checkMesh).not.toBeNull();

    checkbox.checked = false;

    expect(internals.checkMesh).toBeNull();
    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#ffffff'));
  });

  it('rebuilds the box and checkmark geometry when size changes', () => {
    const checkbox = createCheckbox({ checked: true, size: 30 });
    const internals = internalsOf(checkbox);

    checkbox.size = 50;

    expect(internals.geometry.parameters.width).toBe(50);
    // Checkmark tracks the box: 0.6 * size wide.
    expect(internals.checkGeometry?.parameters.width).toBe(30);
  });

  it('pushes colour assignments into the active materials', () => {
    const checkbox = createCheckbox({ checked: true });
    const internals = internalsOf(checkbox);

    checkbox.checkedColor = '#112233';
    checkbox.checkmarkColor = '#445566';

    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#112233'));
    expect(internals.checkMaterial?.color.getHex()).toBe(hexOf('#445566'));
  });

  it('installs reactive accessors for every own schema field', () => {
    const names = reactiveSchemaPropertyNames(createCheckbox());
    for (const expected of [
      'size',
      'checked',
      'uncheckedColor',
      'checkedColor',
      'checkmarkColor',
      'checkmarkAction',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    expect(names.has('label')).toBe(false);
  });
});

describe('Checkbox2D signal contract (click is the pointer, toggled is the state)', () => {
  /** Records both signals with the state each listener observes at the moment it runs. */
  function recordContract(checkbox: Checkbox2D): {
    order: string[];
    clickSaw: boolean[];
    toggledSaw: boolean[];
    payloads: unknown[];
  } {
    const order: string[] = [];
    const clickSaw: boolean[] = [];
    const toggledSaw: boolean[] = [];
    const payloads: unknown[] = [];
    const listener = {};
    checkbox.connect('click', listener, () => {
      order.push('click');
      clickSaw.push(checkbox.checked);
    });
    checkbox.connect('toggled', listener, (...args: unknown[]) => {
      order.push('toggled');
      toggledSaw.push(checkbox.checked);
      payloads.push(args[0]);
    });
    return { order, clickSaw, toggledSaw, payloads };
  }

  it('shows a click listener the OLD state and a toggled listener the NEW one', () => {
    // The trap this pins down: the funnel emits `click` and only then calls onClick(), which is what
    // flips `checked`. A game connecting `click` and reading `checked` applied the previous state —
    // inverted behaviour. `toggled` fires after the flip, with the new value as its payload.
    const checkbox = createCheckbox();
    const input = createInputService();
    checkbox.input = input;
    const seen = recordContract(checkbox);

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);
    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(seen.order).toEqual(['click', 'toggled']);
    expect(seen.clickSaw).toEqual([false]);
    expect(seen.toggledSaw).toEqual([true]);
    expect(seen.payloads).toEqual([true]);
    expect(checkbox.checked).toBe(true);
  });

  it('has the visuals and the virtual action in place by the time toggled fires', () => {
    const checkbox = createCheckbox({ checkmarkAction: 'Music' });
    const input = createInputService();
    checkbox.input = input;
    const internals = internalsOf(checkbox);
    const observed: Array<{ checkmark: boolean; axis: number }> = [];
    checkbox.connect('toggled', {}, () => {
      observed.push({ checkmark: internals.checkMesh !== null, axis: input.getAxis('Music') });
    });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);
    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(observed).toEqual([{ checkmark: true, axis: 1 }]);
  });

  it('emits toggled for a script assignment too, and stays silent when nothing changes', () => {
    const checkbox = createCheckbox();
    const payloads: unknown[] = [];
    checkbox.connect('toggled', {}, (...args: unknown[]) => payloads.push(args[0]));

    checkbox.checked = true;
    checkbox.checked = true; // no change → no signal
    checkbox.checked = false;

    expect(payloads).toEqual([true, false]);
  });

  it('emits toggled once per semantic toggle interaction', () => {
    const checkbox = createCheckbox();
    checkbox.input = createInputService();
    const payloads: unknown[] = [];
    checkbox.connect('toggled', {}, (...args: unknown[]) => payloads.push(args[0]));

    expect(checkbox.invokeInteraction('toggle')).toBe(true);

    expect(payloads).toEqual([true]);
  });
});

describe('Checkbox2D pointer funnel (UIControl2D.updatePointerState)', () => {
  function createInteractive(overrides: Partial<Checkbox2DProps> = {}): {
    checkbox: Checkbox2D;
    input: InputService;
    signals: string[];
  } {
    const checkbox = createCheckbox(overrides);
    const input = createInputService();
    checkbox.input = input;
    return { checkbox, input, signals: recordSignals(checkbox) };
  }

  it('toggles on release inside the bounds and emits the lifecycle signals', () => {
    // Before the funnel the checkbox polled the pointer itself: it flipped on press-down and
    // emitted nothing at all, so game code had no signal to connect to.
    const { checkbox, input, signals } = createInteractive();

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);

    expect(checkbox.checked).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(checkbox.checked).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });

  it('tracks hover without a press', () => {
    const { checkbox, input, signals } = createInteractive();

    input.pointerPosition.set(100, 100);
    checkbox.tick(1 / 60);
    expect(hoverOf(checkbox)).toBe(true);

    input.pointerPosition.set(10, 10);
    checkbox.tick(1 / 60);
    expect(hoverOf(checkbox)).toBe(false);
    expect(signals).toEqual([]);
  });

  it('does not toggle when the pointer is released outside the bounds', () => {
    const { checkbox, input, signals } = createInteractive();

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);

    // Slide off, then let go: a cancelled press, not a click.
    input.pointerPosition.set(10, 10);
    checkbox.tick(1 / 60);
    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(checkbox.checked).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed']);
  });

  it('ignores the pointer entirely while disabled', () => {
    const { checkbox, input, signals } = createInteractive();
    checkbox.enabled = false;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);
    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(checkbox.checked).toBe(false);
    expect(hoverOf(checkbox)).toBe(false);
    expect(signals).toEqual([]);
  });

  it('pulses the virtual button for exactly one frame, released by the tick and not a timer', () => {
    // toggle() used to lower the button from a setTimeout(0) — wall-clock work that lands on an
    // arbitrary frame under a stepped or accelerated loop.
    const { checkbox, input } = createInteractive({ checkmarkAction: 'Music' });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    checkbox.tick(1 / 60);
    input.isPointerDown = false;
    checkbox.tick(1 / 60);

    expect(checkbox.checked).toBe(true);
    expect(input.getButton('Music')).toBe(true);
    expect(input.getAxis('Music')).toBe(1);

    checkbox.tick(1 / 60);

    expect(input.getButton('Music')).toBe(false);
    // The axis is a latch, not a pulse: it keeps reporting the current state.
    expect(input.getAxis('Music')).toBe(1);
  });

  it('is not toggled by a scroll drag that passes over it', () => {
    // The bug this normalization closes: a checkbox inside a scrolling list polled the pointer
    // directly, so dragging the list flipped whatever sat under the finger.
    const container = new ScrollContainer2D({
      id: 'list',
      name: 'List',
      width: 120,
      height: 120,
    });
    const content = new Group2D({
      id: 'list-content',
      name: 'List Content',
      width: 120,
      height: 320,
      position: new Vector2(0, 0),
    });
    // Big enough that a 30px drag stays inside the hit area — otherwise leaving the bounds, not
    // the scroll gate, would be what cancels the press.
    const checkbox = createCheckbox({ size: 100 });
    const signals = recordSignals(checkbox);
    content.adoptChild(checkbox);
    container.adoptChild(content);
    const input = createInputService();
    container.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    // Press landed before the drag was recognised — the gate has to undo it.
    expect(signals).toEqual(['pointerdown', 'pressed']);

    input.pointerPosition.set(100, 130);
    container.tick(1 / 60);
    expect(container.hasActivePointerCapture()).toBe(true);

    input.isPointerDown = false;
    container.tick(1 / 60);

    expect(checkbox.checked).toBe(false);
    expect(signals).not.toContain('click');
  });
});
