import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasTexture, Color, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';

import { InventorySlot2D, type InventorySlot2DProps } from './InventorySlot2D';
import { Group2D } from '../Group2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { InputService } from '../../../core/InputService';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

interface SlotInternals {
  slotGeometry: PlaneGeometry;
  borderGeometry: PlaneGeometry | null;
  slotMaterial: MeshBasicMaterial;
  borderMaterial: MeshBasicMaterial | null;
  quantityMesh: Mesh | null;
  quantityTexture: CanvasTexture | null;
}

const internalsOf = (slot: InventorySlot2D): SlotInternals => slot as unknown as SlotInternals;

function createSlot(overrides: Partial<InventorySlot2DProps> = {}): InventorySlot2D {
  return new InventorySlot2D({ id: 'slot', name: 'Slot', ...overrides });
}

function hexOf(style: string): number {
  return new Color(style).getHex();
}

describe('InventorySlot2D script assignments (reactive schema properties)', () => {
  // happy-dom has no canvas 2D context, and the quantity badge is drawn onto one.
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
      if (kind !== '2d') {
        return null;
      }
      return {
        setTransform: () => {},
        scale: () => {},
        fillRect: () => {},
        fillText: () => {},
        measureText: () => ({ width: 10 }),
        fillStyle: '',
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('creates and removes the quantity badge when a script assigns quantity', () => {
    const slot = createSlot({ quantity: 0 });
    const internals = internalsOf(slot);
    expect(internals.quantityMesh).toBeNull();

    slot.quantity = 5;
    expect(internals.quantityMesh).not.toBeNull();

    slot.quantity = 0;
    expect(internals.quantityMesh).toBeNull();
  });

  it('repaints the badge onto a fresh canvas texture when quantity changes', () => {
    const slot = createSlot({ quantity: 5 });
    const internals = internalsOf(slot);
    const before = internals.quantityTexture;
    expect(before).not.toBeNull();

    slot.quantity = 7;

    expect(internals.quantityTexture).not.toBe(before);
    // And the existing badge mesh must SAMPLE the new texture: it used to keep the first one, which
    // had just been disposed, so the number on screen never changed after the first draw.
    const material = internals.quantityMesh?.material as { map?: unknown } | undefined;
    expect(material?.map).toBe(internals.quantityTexture);
  });

  it('clamps a negative quantity to zero and hides the badge', () => {
    const slot = createSlot({ quantity: 5 });

    slot.quantity = -3;

    expect(slot.quantity).toBe(0);
    expect(internalsOf(slot).quantityMesh).toBeNull();
  });

  it('removes the badge when showQuantity is turned off', () => {
    const slot = createSlot({ quantity: 5 });
    const internals = internalsOf(slot);
    expect(internals.quantityMesh).not.toBeNull();

    slot.showQuantity = false;
    expect(internals.quantityMesh).toBeNull();

    slot.showQuantity = true;
    expect(internals.quantityMesh).not.toBeNull();
  });

  it('rebuilds the backdrop and border geometry when width changes', () => {
    const slot = createSlot();
    const internals = internalsOf(slot);

    slot.width = 100;

    expect(internals.slotGeometry.parameters.width).toBe(100);
    expect(internals.borderGeometry?.parameters.width).toBe(100);
  });

  it('pushes colour assignments into the materials while unselected', () => {
    const slot = createSlot();
    const internals = internalsOf(slot);

    slot.backdropColor = '#123456';
    slot.borderColor = '#654321';

    expect(internals.slotMaterial.color.getHex()).toBe(hexOf('#123456'));
    expect(internals.borderMaterial?.color.getHex()).toBe(hexOf('#654321'));
  });

  it('installs reactive accessors for every own schema field', () => {
    const names = reactiveSchemaPropertyNames(createSlot());
    for (const expected of [
      'width',
      'height',
      'quantity',
      'showQuantity',
      'backdropColor',
      'borderColor',
      'selectionColor',
      'selectedAction',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
  });
});

describe('InventorySlot2D pointer funnel (UIControl2D.updatePointerState)', () => {
  /** Every lifecycle signal the shared UIControl2D funnel emits, in the order it emits them. */
  const FUNNEL_SIGNALS = ['pointerdown', 'pressed', 'pointerup', 'released', 'click'] as const;

  function recordSignals(slot: InventorySlot2D): string[] {
    const seen: string[] = [];
    const listener = {};
    for (const name of FUNNEL_SIGNALS) {
      slot.connect(name, listener, () => seen.push(name));
    }
    return seen;
  }

  // Input 200x200 and no scene → the logical camera equals the input size, so screen (100,100) maps
  // to world (0,0) — the slot centre — and screen (10,10) lands far outside a 60x60 slot.
  function createInteractive(overrides: Partial<InventorySlot2DProps> = {}): {
    slot: InventorySlot2D;
    input: InputService;
    signals: string[];
  } {
    const slot = createSlot(overrides);
    const input = new InputService();
    input.width = 200;
    input.height = 200;
    slot.input = input;
    return { slot, input, signals: recordSignals(slot) };
  }

  it('activates on release inside the bounds and emits the lifecycle signals', () => {
    // Before the funnel the slot polled the pointer itself: it selected on press-down and emitted
    // nothing, so a shop script had no signal to connect to.
    const { slot, input, signals } = createInteractive({ selectedAction: 'PickSlot' });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    slot.tick(1 / 60);

    expect(slot.selected).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    input.isPointerDown = false;
    slot.tick(1 / 60);

    expect(slot.selected).toBe(true);
    expect(input.getButton('PickSlot')).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });

  it('shows a click listener the OLD selection and a toggled listener the NEW one', () => {
    // Same split as Checkbox2D: `click` is the pointer signal (emitted before onClick() selects),
    // `toggled` is the state signal (emitted after, with the new value).
    const { slot, input } = createInteractive({ selectedAction: 'PickSlot' });
    const order: string[] = [];
    const clickSaw: boolean[] = [];
    const toggledSaw: boolean[] = [];
    const payloads: unknown[] = [];
    const listener = {};
    slot.connect('click', listener, () => {
      order.push('click');
      clickSaw.push(slot.selected);
    });
    slot.connect('toggled', listener, (...args: unknown[]) => {
      order.push('toggled');
      toggledSaw.push(slot.selected);
      payloads.push(args[0]);
    });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    slot.tick(1 / 60);
    input.isPointerDown = false;
    slot.tick(1 / 60);

    expect(order).toEqual(['click', 'toggled']);
    expect(clickSaw).toEqual([false]);
    expect(toggledSaw).toEqual([true]);
    expect(payloads).toEqual([true]);
  });

  it('emits toggled with false when a second click deselects', () => {
    const { slot, input } = createInteractive();
    const payloads: unknown[] = [];
    slot.connect('toggled', {}, (...args: unknown[]) => payloads.push(args[0]));

    input.pointerPosition.set(100, 100);
    for (const down of [true, false, true, false]) {
      input.isPointerDown = down;
      slot.tick(1 / 60);
    }

    expect(payloads).toEqual([true, false]);
    expect(slot.selected).toBe(false);
  });

  it('does not activate when the pointer is released outside the bounds', () => {
    const { slot, input, signals } = createInteractive();

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    slot.tick(1 / 60);

    input.pointerPosition.set(10, 10);
    slot.tick(1 / 60);
    input.isPointerDown = false;
    slot.tick(1 / 60);

    expect(slot.selected).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed']);
  });

  it('ignores the pointer entirely while disabled', () => {
    const { slot, input, signals } = createInteractive();
    slot.enabled = false;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    slot.tick(1 / 60);
    input.isPointerDown = false;
    slot.tick(1 / 60);

    expect(slot.selected).toBe(false);
    expect(signals).toEqual([]);
  });

  it('is not activated by a scroll drag that passes over it', () => {
    // Slots live in scrolling inventories, which is exactly where press-down activation misfired:
    // flicking the list selected whatever was under the finger.
    const container = new ScrollContainer2D({ id: 'bag', name: 'Bag', width: 120, height: 120 });
    const content = new Group2D({
      id: 'bag-content',
      name: 'Bag Content',
      width: 120,
      height: 320,
      position: new Vector2(0, 0),
    });
    // Big enough that a 30px drag stays inside the hit area — otherwise leaving the bounds, not
    // the scroll gate, would be what cancels the press.
    const slot = createSlot({ width: 100, height: 100 });
    const signals = recordSignals(slot);
    content.adoptChild(slot);
    container.adoptChild(content);
    const input = new InputService();
    input.width = 200;
    input.height = 200;
    container.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    input.pointerPosition.set(100, 130);
    container.tick(1 / 60);
    expect(container.hasActivePointerCapture()).toBe(true);

    input.isPointerDown = false;
    container.tick(1 / 60);

    expect(slot.selected).toBe(false);
    expect(signals).not.toContain('click');
  });
});
