import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasTexture, Color, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

import { InventorySlot2D, type InventorySlot2DProps } from './InventorySlot2D';
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
