import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import type { Mesh, MeshBasicMaterial, Texture } from 'three';

const DIGIT_COUNT = 10;

interface DigitSlot {
  node: NodeBase;
  material: MeshBasicMaterial | null;
}

/**
 * Odometer component — handles a rolling mechanical counter made of digit strips.
 * Rotates each digit's texture UV offsets top-to-bottom (0..9) to simulate a drum roll.
 */
export class Odometer extends Script {
  private digits: DigitSlot[] = [];
  private shown: number[] = [];
  private targetValue = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      initialValue: 0,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Odometer',
      properties: [
        {
          name: 'initialValue',
          type: 'number',
          ui: { label: 'Initial Value', group: 'Odometer' },
          getValue: (c: unknown) => (c as Odometer).config.initialValue,
          setValue: (c: unknown, v: unknown) => {
            (c as Odometer).config.initialValue = Number(v);
          },
        },
      ],
      groups: { Odometer: { label: 'Odometer', expanded: true } },
    };
  }

  onStart(): void {
    // Find all children nodes that represent the digit slots (most significant first).
    this.digits = this.node.children
      .filter((c): c is NodeBase => !!(c as NodeBase).nodeId)
      .map(node => ({ node, material: null }));
    this.shown = this.digits.map(() => 0);
    this.targetValue = Number(this.config.initialValue ?? 0);

    // Sync shown state instantly with initial value so it doesn't roll from 0 on load
    const count = this.digits.length;
    if (count > 0) {
      const clamped = Math.max(0, Math.min(Math.pow(10, count) - 1, Math.floor(this.targetValue)));
      for (let i = 0; i < count; i++) {
        const digit = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
        this.shown[i] = digit;
      }
    }
  }

  /** Sets the new value to roll towards. */
  public setValue(value: number): void {
    this.targetValue = value;
  }

  /** Instantly sets the value without animation. */
  public setValueInstant(value: number): void {
    this.targetValue = value;
    const count = this.digits.length;
    if (count > 0) {
      const clamped = Math.max(0, Math.min(Math.pow(10, count) - 1, Math.floor(value)));
      for (let i = 0; i < count; i++) {
        this.shown[i] = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
      }
    }
  }

  onUpdate(dt: number): void {
    if (this.digits.length === 0) return;

    const count = this.digits.length;
    const clamped = Math.max(0, Math.min(Math.pow(10, count) - 1, Math.floor(this.targetValue)));

    for (let i = 0; i < count; i++) {
      const digit = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
      const slot = this.digits[i];
      if (!slot.material) {
        slot.material = this.resolveStripMaterial(slot.node);
        if (!slot.material) continue;
      }
      
      const target = digit;
      let shown = this.shown[i];
      const diff = target - shown;
      shown = Math.abs(diff) < 0.02 ? target : shown + diff * Math.min(1, dt * 14);
      this.shown[i] = shown;
      
      // Strip rows are top→bottom 0..9; UV origin is bottom-left.
      const map = slot.material.map;
      if (map) {
        map.repeat.y = 1 / DIGIT_COUNT;
        map.offset.y = 1 - (shown + 1) / DIGIT_COUNT;
      }
    }
  }

  /** Clone the digit-strip texture per window so each digit scrolls independently. */
  private resolveStripMaterial(node: NodeBase): MeshBasicMaterial | null {
    let material: MeshBasicMaterial | null = null;
    node.traverse(obj => {
      const mesh = obj as Mesh;
      if (!material && mesh.isMesh) {
        const mat = mesh.material as MeshBasicMaterial;
        if (mat.map) {
          const clone: Texture = mat.map.clone();
          clone.needsUpdate = true;
          mat.map = clone;
          material = mat;
        }
      }
    });
    return material;
  }
}
