import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { RepeatWrapping } from 'three';
import type { Mesh, MeshBasicMaterial, Texture } from 'three';

const DIGIT_COUNT = 10;

interface DigitSlot {
  node: NodeBase;
  material: MeshBasicMaterial | null;
}

/**
 * Odometer component — handles a rolling mechanical counter made of digit strips.
 * Rotates each digit's texture UV offsets top-to-bottom to simulate a drum roll.
 * Uses a mapping for the texture ordering: top-to-bottom 0, 9, 8, 7, 6, 5, 4, 3, 2, 1.
 * It always rolls the shortest circular path (seamless transition at boundaries).
 */
export class Odometer extends Script {
  private digits: DigitSlot[] = [];
  private shown: number[] = []; // Stores the current physical strip positions (0..9)
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

  /** Helper to map a digit (0..9) to its physical row index (0..9) on the strip. */
  private getStripPosition(digit: number): number {
    return (10 - digit) % 10;
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
        this.shown[i] = this.getStripPosition(digit);
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
        const digit = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
        this.shown[i] = this.getStripPosition(digit);
      }
    }
  }

  onUpdate(dt: number): void {
    if (this.digits.length === 0) return;

    const count = this.digits.length;
    const clamped = Math.max(0, Math.min(Math.pow(10, count) - 1, Math.floor(this.targetValue)));

    for (let i = 0; i < count; i++) {
      const digit = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
      const targetPos = this.getStripPosition(digit); // Target physical row on the strip
      
      const slot = this.digits[i];
      if (!slot.material) {
        slot.material = this.resolveStripMaterial(slot.node);
        if (!slot.material) continue;
      }
      
      let shownPos = this.shown[i];
      
      // Calculate circular difference in physical strip coordinates (returns value in range [-5, 5))
      let diff = targetPos - shownPos;
      diff = ((diff + 5) % 10 + 10) % 10 - 5;
      
      if (Math.abs(diff) < 0.02) {
        shownPos = targetPos;
      } else {
        shownPos = (shownPos + diff * Math.min(1, dt * 14)) % 10;
        if (shownPos < 0) shownPos += 10;
      }
      this.shown[i] = shownPos;
      
      // Strip rows are top→bottom 0..9; UV origin is bottom-left.
      const map = slot.material.map;
      if (map) {
        map.repeat.y = 1 / DIGIT_COUNT;
        map.offset.y = 1 - (shownPos + 1) / DIGIT_COUNT;
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
          clone.wrapS = RepeatWrapping;
          clone.wrapT = RepeatWrapping;
          clone.needsUpdate = true;
          mat.map = clone;
          material = mat;
        }
      }
    });
    return material;
  }
}
