import { Bar2D, Script } from '@pix3/runtime';

import {
  BOARD_HALF,
  MIN_POWER,
  PULL_DEAD_ZONE,
  PULL_FULL_POWER,
  STRIKER_RADIUS,
  clamp,
  clampForwardCone,
  controllerOn,
  forwardSign,
  type CarromControllerApi,
  type Point2,
} from './carrom-geometry';
import type { AimGuide } from './AimGuide';

/** How far a pointer must travel before the gesture commits to slide or aim. */
const MODE_LOCK_DISTANCE = 12;
/** A down within this of the striker's edge counts as "on the striker". */
const STRIKER_GRAB_SLOP = 18;

type GestureMode = 'undecided' | 'slide' | 'aim';

/**
 * `user:ShotInput` — the human gesture, on `GameRoot`.
 *
 * Two gestures share one finger and are told apart once, at the first real
 * movement: a mostly-horizontal drag that STARTED on the striker slides it
 * along the baseline; anything else is a pull-back aim from wherever the finger
 * happens to be. Aiming from anywhere is what makes a 52 px striker usable
 * under a thumb — dragging the striker itself would hide it.
 *
 * Only one pointer is ever owned (the first one down); the rest are ignored, so
 * a stray palm cannot steal a shot mid-pull.
 */
export class ShotInput extends Script {
  private controller: CarromControllerApi | null = null;
  private guide: AimGuide | null = null;
  private powerBar: Bar2D | null = null;

  private pointerId: number | null = null;
  private mode: GestureMode = 'undecided';
  private downPoint: Point2 = { x: 0, y: 0 };
  private lastPoint: Point2 = { x: 0, y: 0 };
  private startedOnStriker = false;

  private aimDir: Point2 = { x: 0, y: 1 };
  private aimPower = 0;

  onStart(): void {
    this.controller = controllerOn(this.node);
    const guideNode = this.findNode('AimGuide');
    const guide = guideNode?.components.find(component => component.type === 'user:AimGuide');
    this.guide = (guide as AimGuide | undefined) ?? null;
    const bar = this.findNode('PowerBar');
    this.powerBar = bar instanceof Bar2D ? bar : null;
  }

  onUpdate(): void {
    const input = this.input;
    const controller = this.controller;
    if (!input || !controller) {
      return;
    }

    // A gesture only survives while the game is still waiting for this shot.
    if (this.pointerId !== null && controller.state !== 'AIM') {
      this.cancelGesture();
    }

    for (const event of input.pointerEvents) {
      if (this.pointerId === null) {
        if (event.type === 'down') {
          this.tryStart(event.pointerId, controller);
        }
        continue;
      }
      if (event.pointerId !== this.pointerId) {
        continue;
      }

      if (event.type === 'cancel') {
        this.cancelGesture();
        continue;
      }
      if (event.type === 'up') {
        this.release(controller);
        continue;
      }
      if (event.type === 'move') {
        const point = this.worldPoint(event.pointerId);
        if (point) {
          this.lastPoint = point;
        }
        this.drive(controller);
      }
    }

    // A finger that is held still emits no `move`, but the striker may have been
    // repositioned by the previous frame; keep the guide honest either way.
    if (this.pointerId !== null && this.mode === 'aim') {
      this.drive(controller);
    }
  }

  override onDetach(): void {
    this.cancelGesture();
    super.onDetach();
  }

  // -------------------------------------------------------------------------

  private tryStart(pointerId: number, controller: CarromControllerApi): void {
    if (controller.state !== 'AIM') {
      return;
    }
    if (this.input?.isPointerOverUI(pointerId)) {
      return; // the Restart button wins this finger
    }
    const point = this.worldPoint(pointerId);
    if (!point) {
      return;
    }
    if (Math.abs(point.x) > BOARD_HALF || Math.abs(point.y) > BOARD_HALF) {
      return;
    }

    const striker = controller.strikerPosition();
    this.pointerId = pointerId;
    this.mode = 'undecided';
    this.downPoint = point;
    this.lastPoint = point;
    this.startedOnStriker =
      Math.hypot(point.x - striker.x, point.y - striker.y) <= STRIKER_RADIUS + STRIKER_GRAB_SLOP;
    this.aimPower = 0;
  }

  private drive(controller: CarromControllerApi): void {
    const dx = this.lastPoint.x - this.downPoint.x;
    const dy = this.lastPoint.y - this.downPoint.y;

    if (this.mode === 'undecided') {
      if (Math.hypot(dx, dy) <= MODE_LOCK_DISTANCE) {
        return;
      }
      // Locked once, for the rest of the gesture: a pull that starts as an aim
      // must not turn into a slide because the finger drifted sideways.
      this.mode = this.startedOnStriker && Math.abs(dx) > 2 * Math.abs(dy) ? 'slide' : 'aim';
    }

    if (this.mode === 'slide') {
      controller.placeStriker(this.lastPoint.x);
      return;
    }

    const striker = controller.strikerPosition();
    const pullX = this.lastPoint.x - striker.x;
    const pullY = this.lastPoint.y - striker.y;
    const pullLength = Math.hypot(pullX, pullY);
    const sign = forwardSign(controller.shooter);
    const raw: Point2 =
      pullLength > 1e-6 ? { x: -pullX / pullLength, y: -pullY / pullLength } : { x: 0, y: sign };
    const cone = clampForwardCone(raw, controller.shooter);

    this.aimDir = { x: cone.x, y: cone.y };
    this.aimPower = clamp((pullLength - PULL_DEAD_ZONE) / PULL_FULL_POWER, 0, 1);

    this.guide?.show(striker, this.aimDir, this.aimPower, { x: pullX, y: pullY }, cone.clamped);
    if (this.powerBar) {
      this.powerBar.visible = true;
      this.powerBar.value = this.aimPower;
    }
  }

  private release(controller: CarromControllerApi): void {
    const mode = this.mode;
    const dir = this.aimDir;
    const power = this.aimPower;
    this.endGesture();
    if (mode !== 'aim' || power < MIN_POWER) {
      return;
    }
    controller.requestShot(dir, power);
  }

  private cancelGesture(): void {
    this.endGesture();
  }

  private endGesture(): void {
    this.pointerId = null;
    this.mode = 'undecided';
    this.startedOnStriker = false;
    this.aimPower = 0;
    this.guide?.hide();
    if (this.powerBar) {
      this.powerBar.visible = false;
      this.powerBar.value = 0;
    }
  }

  /**
   * That finger's position in board space. `getPointer2DWorldPosition` only
   * answers for a pointer that is still down, so an `up` frame falls back to the
   * last point the gesture saw.
   */
  private worldPoint(pointerId: number): Point2 | null {
    const scene = this.scene;
    if (!scene) {
      return null;
    }
    const addressed = scene.getPointer2DWorldPosition(pointerId);
    if (addressed) {
      return { x: addressed.x, y: addressed.y };
    }
    const primary = scene.getPointer2DWorldPosition();
    return primary ? { x: primary.x, y: primary.y } : null;
  }
}
