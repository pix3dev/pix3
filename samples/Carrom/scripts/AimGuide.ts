import { ColorRect2D, Script, Sprite2D } from '@pix3/runtime';

import {
  GUIDE_COLOUR_BLOCKED,
  GUIDE_COLOUR_HARD,
  GUIDE_COLOUR_SOFT,
  GUIDE_DOT_COUNT,
  GUIDE_DOT_SPACING,
  GUIDE_MAX_LENGTH,
  PULL_FULL_POWER,
  STRIKER_RADIUS,
  clamp,
  controllerOn,
  lerpHex,
  sweepCircle,
  type CarromControllerApi,
  type Point2,
} from './carrom-geometry';

/** Gap between the striker's edge and the first dot. */
const DOT_START_OFFSET = 8;
/** Length of the deflection arrow on the struck man. */
const DEFLECT_LENGTH = 80;
/** The tint effect the dots carry so their colour can follow the power. */
const TINT_EFFECT = 'core:tint';

/**
 * `user:AimGuide` — presentation only, on the `AimGuide` node.
 *
 * The line stops at the first thing the striker will actually hit: the engine
 * has no shape cast (`physics2d.raycast` is a zero-width ray), so the preview is
 * an analytic circle sweep from `carrom-geometry`, the SAME function the rest of
 * the game reasons with — what the player is shown is what the board will do.
 *
 * There is no vector primitive node either, so the line is a pool of dot
 * sprites, the rubber band is a rotated `ColorRect2D`, and the power colour
 * rides a `core:tint` shader effect (a `Sprite2D`'s tint is constructor-only:
 * its material is private and `color` is not in its property schema).
 */
export class AimGuide extends Script {
  private controller: CarromControllerApi | null = null;
  private dots: Sprite2D[] = [];
  private band: ColorRect2D | null = null;
  private ghost: Sprite2D | null = null;
  private deflect: ColorRect2D | null = null;

  onStart(): void {
    this.controller = controllerOn(this.findNode('GameRoot'));

    this.dots = [];
    for (let i = 0; i < GUIDE_DOT_COUNT; i++) {
      const node = this.findNode(`Dot${i}`);
      if (!(node instanceof Sprite2D)) {
        continue;
      }
      // Attached from script rather than authored so the effect cannot be lost
      // to a scene edit; re-attaching an existing effect is a no-op.
      node.getShaderEffectStack().attach(TINT_EFFECT, {
        params: { color: GUIDE_COLOUR_SOFT, amount: 1 },
      });
      this.dots.push(node);
    }

    const ghost = this.findNode('Ghost');
    this.ghost = ghost instanceof Sprite2D ? ghost : null;
    const band = this.findNode('RubberBand');
    this.band = band instanceof ColorRect2D ? band : null;
    const deflect = this.findNode('Deflect');
    this.deflect = deflect instanceof ColorRect2D ? deflect : null;

    this.hide();
  }

  /**
   * Draw the guide for a pull.
   *
   * @param origin  striker centre, board space
   * @param dir     unit shot direction (already cone-clamped)
   * @param power   0..1
   * @param pull    finger offset from the striker, board space
   * @param blocked true when the pull was outside the forward cone
   */
  show(origin: Point2, dir: Point2, power: number, pull: Point2, blocked: boolean): void {
    const host = this.node;
    if (!host) {
      return;
    }
    host.visible = true;

    const discs = this.controller?.sweepDiscs() ?? [];
    const preview = sweepCircle(origin, dir, STRIKER_RADIUS, discs);
    const reach = Math.min(preview?.t ?? GUIDE_MAX_LENGTH, GUIDE_MAX_LENGTH);
    const colour = blocked
      ? GUIDE_COLOUR_BLOCKED
      : lerpHex(GUIDE_COLOUR_SOFT, GUIDE_COLOUR_HARD, power);

    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      const along = STRIKER_RADIUS + DOT_START_OFFSET + i * GUIDE_DOT_SPACING;
      if (along > reach) {
        dot.visible = false;
        continue;
      }
      dot.visible = true;
      dot.position.set(origin.x + dir.x * along, origin.y + dir.y * along, dot.position.z);
      dot.getShaderEffectStack().setParam(TINT_EFFECT, 'color', colour);
    }

    this.drawBand(origin, pull, power, colour);
    this.drawImpact(preview);
  }

  hide(): void {
    const host = this.node;
    if (host) {
      host.visible = false;
    }
  }

  // -------------------------------------------------------------------------

  private drawBand(origin: Point2, pull: Point2, power: number, colour: string): void {
    const band = this.band;
    if (!band) {
      return;
    }
    const length = Math.hypot(pull.x, pull.y);
    if (length <= 4) {
      band.visible = false;
      return;
    }
    const shown = Math.min(length, PULL_FULL_POWER);
    band.visible = true;
    band.height = Math.max(1, shown);
    band.color = colour;
    band.opacity = 0.3 + 0.7 * clamp(power, 0, 1);
    // The rect's local +Y runs along the pull, and its origin is its centre.
    band.rotation.z = Math.atan2(pull.y, pull.x) - Math.PI / 2;
    band.position.set(
      origin.x + (pull.x / length) * (shown / 2),
      origin.y + (pull.y / length) * (shown / 2),
      band.position.z
    );
  }

  private drawImpact(preview: ReturnType<typeof sweepCircle>): void {
    const ghost = this.ghost;
    const deflect = this.deflect;
    const disc = preview && preview.kind === 'disc' ? preview.disc : null;

    if (!preview || !disc) {
      if (ghost) {
        ghost.visible = false;
      }
      if (deflect) {
        deflect.visible = false;
      }
      return;
    }

    if (ghost) {
      ghost.visible = true;
      ghost.position.set(preview.point.x, preview.point.y, ghost.position.z);
    }
    if (deflect) {
      const dx = disc.x - preview.point.x;
      const dy = disc.y - preview.point.y;
      const length = Math.hypot(dx, dy) || 1;
      deflect.visible = true;
      deflect.height = DEFLECT_LENGTH;
      deflect.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
      deflect.position.set(
        disc.x + (dx / length) * (DEFLECT_LENGTH / 2),
        disc.y + (dy / length) * (DEFLECT_LENGTH / 2),
        deflect.position.z
      );
    }
  }
}
