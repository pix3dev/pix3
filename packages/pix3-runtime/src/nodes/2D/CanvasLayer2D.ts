import { Group2D, type Group2DProps } from './Group2D';
import type { PropertySchema } from '../../fw/property-schema';

export type CanvasLayer2DProps = Group2DProps;

/**
 * Godot-style `CanvasLayer`: a clean UI overlay band. Its subtree is routed to
 * `LAYER_2D_OVERLAY` and drawn by a separate, always-identity orthographic
 * camera AFTER the post-processing composer, so:
 *
 *  - **Fixed HUD** — it ignores any {@link ./Camera2D} pan/zoom (which only
 *    drives the main 2D pass), staying pinned in design-space coordinates.
 *  - **Never post-processed** — bloom / vignette / chromatic-aberration and any
 *    other screen effect leave it untouched (e.g. a restart dialog shown crisp
 *    over a blurred game-over scene).
 *
 * Unlike Godot's CanvasLayer this does NOT break inheritance: an ancestor's
 * transform, opacity, and visibility still flow into the overlay subtree — only
 * the render *camera* differs. Author a CanvasLayer2D at the scene root for a
 * fully independent layer.
 *
 * In the editor it renders as an ordinary Group2D container (the overlay
 * behavior is a play-mode render concern).
 */
export class CanvasLayer2D extends Group2D {
  constructor(props: CanvasLayer2DProps) {
    super(props, 'CanvasLayer2D');
    this.isCanvasLayer = true;
  }

  static override getPropertySchema(): PropertySchema {
    return { ...Group2D.getPropertySchema(), nodeType: 'CanvasLayer2D', extends: 'Group2D' };
  }
}
