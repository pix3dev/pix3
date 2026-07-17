import { Script, Sprite2D } from '@pix3/runtime';
import type { EditorPreviewContext } from '@pix3/runtime';
import { Odometer } from './Odometer';
import { digitForSlot, digitStripRegion, stripPositionForDigit } from './odometerRegion';

/**
 * OdometerDigit — editor-preview companion for a single odometer digit sprite.
 *
 * In play mode the parent Odometer drives the digit crop, so this script does
 * nothing at runtime. In the editor there is no live tick, so each digit sprite
 * would otherwise show the whole squished ten-cell strip. Here `tickEditorPreview`
 * crops the sprite to the digit its slot would display for the parent Odometer's
 * Initial Value — using the SAME `digitStripRegion` helper as play mode.
 */
export class OdometerDigit extends Script {
  tickEditorPreview(_dt: number, ctx: EditorPreviewContext): void {
    if (!(this.node instanceof Sprite2D)) return;
    const stripPos = stripPositionForDigit(this.resolveDigit());
    ctx.setAppearanceOverride({ textureRegion: digitStripRegion(stripPos) });
  }

  /** Digit this slot shows for the parent Odometer's initial value. */
  private resolveDigit(): number {
    const parent = this.node.parentNode;
    if (!parent) return 0;
    const slots = parent.children.filter((c): c is Sprite2D => c instanceof Sprite2D);
    const index = slots.indexOf(this.node as Sprite2D);
    if (index < 0) return 0;
    const odo = parent.getComponent(Odometer);
    const value = odo ? Number(odo.config.initialValue ?? 0) : 0;
    return digitForSlot(value, index, slots.length);
  }
}
