import { Script, Sprite2D } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { DIGIT_ROWS, digitForSlot, digitStripRegion, stripPositionForDigit } from './odometerRegion';

interface DigitSlot {
  sprite: Sprite2D;
}

/**
 * Odometer component — a rolling mechanical counter made of digit strips.
 * Each digit is a Sprite2D showing `number_indicator.png` (a vertical strip of
 * ten cells). We crop the strip to one cell with `Sprite2D.setTextureRegion`,
 * scrolling the crop top-to-bottom to simulate a drum roll (shortest circular
 * path, seamless at the boundary).
 *
 * Play mode drives the crop here in `onUpdate`; the editor preview is handled
 * per-digit by `OdometerDigit.tickEditorPreview`. Both build the crop through
 * the shared `digitStripRegion` helper so edit and play modes match exactly.
 */
export class Odometer extends Script {
  private digits: DigitSlot[] = [];
  private shown: number[] = []; // current physical strip positions (0..9, fractional while rolling)
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
    // Digit slots = the child Sprite2D nodes, most significant first.
    this.digits = this.node.children
      .filter((c): c is Sprite2D => c instanceof Sprite2D)
      .map(sprite => ({ sprite }));
    this.shown = this.digits.map(() => 0);
    this.targetValue = Number(this.config.initialValue ?? 0);

    // Sync shown state instantly with the initial value so it doesn't roll from 0.
    this.snapTo(this.targetValue);

    // Every digit shares `number_indicator.png`. `setTextureRegion` mutates the
    // texture's own offset/repeat, so a SHARED cached texture would make all
    // digits show the last-applied crop. Give each sprite its own texture clone
    // (shares the GPU image, independent crop) before we start cropping.
    const loader = this.scene?.getAssetLoader();
    this.digits.forEach((slot, index) => {
      const url = slot.sprite.texture?.url;
      if (!url || !loader) return;
      void loader
        .loadTexture(url)
        .then(tex => {
          const clone = tex.clone();
          clone.needsUpdate = true;
          slot.sprite.setTexture(clone);
          slot.sprite.setTextureRegion(digitStripRegion(this.shown[index]));
        })
        .catch(() => undefined);
    });

    this.applyCrops();
  }

  /** Sets the new value to roll towards. */
  public setValue(value: number): void {
    this.targetValue = value;
  }

  /** Instantly sets the value without animation. */
  public setValueInstant(value: number): void {
    this.targetValue = value;
    this.snapTo(value);
    this.applyCrops();
  }

  private snapTo(value: number): void {
    const count = this.digits.length;
    for (let i = 0; i < count; i++) {
      this.shown[i] = stripPositionForDigit(digitForSlot(value, i, count));
    }
  }

  private applyCrops(): void {
    for (let i = 0; i < this.digits.length; i++) {
      this.digits[i].sprite.setTextureRegion(digitStripRegion(this.shown[i]));
    }
  }

  onUpdate(dt: number): void {
    const count = this.digits.length;
    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const digit = digitForSlot(this.targetValue, i, count);
      const targetPos = stripPositionForDigit(digit); // target physical row on the strip

      let shownPos = this.shown[i];

      // Circular difference in strip coordinates, in range [-5, 5).
      let diff = targetPos - shownPos;
      diff = ((diff + 5) % DIGIT_ROWS + DIGIT_ROWS) % DIGIT_ROWS - 5;

      if (Math.abs(diff) < 0.02) {
        shownPos = targetPos;
      } else {
        shownPos = (shownPos + diff * Math.min(1, dt * 14)) % DIGIT_ROWS;
        if (shownPos < 0) shownPos += DIGIT_ROWS;
      }
      this.shown[i] = shownPos;

      this.digits[i].sprite.setTextureRegion(digitStripRegion(shownPos));
    }
  }
}
