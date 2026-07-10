import { NodeBase } from '../nodes/NodeBase';
import { ShakeBehavior, type ShakeOptions } from '../behaviors/ShakeBehavior';
import { PunchScaleBehavior, type PunchScaleOptions } from '../behaviors/PunchScaleBehavior';
import { PopInBehavior, type PopInOptions } from '../behaviors/PopInBehavior';
import type { SceneService } from './SceneService';
import type { FlashOptions } from './SceneService';

/**
 * Target of a juice effect: a node instance, a node query (id / name / path),
 * the literal `'camera'` to hit the active 3D camera (falling back to the active
 * 2D camera in pure-2D scenes), or `'camera2d'` to hit the active 2D camera.
 */
export type JuiceTarget = NodeBase | string;

/**
 * Fire-and-forget "juice" primitives, reachable from scripts as
 * `this.scene.juice` (P0.3). Each transform effect is backed by the same
 * `core:*` behavior a designer can attach in the inspector, so calling the API
 * and dropping a preset produce identical results. The effect component is
 * created once per node and reused across calls (no per-call allocation, no
 * pile-up), and — being ticked through `node.tick` — respects the global
 * `Time.scale` (hitstop freezes it, slow-mo stretches it).
 *
 * The classic "juicy hit" is three calls:
 * ```ts
 * this.scene.time.hitstop(80);
 * this.scene.juice.shake('camera', { amplitude: 12 });
 * this.scene.juice.flash();
 * ```
 */
export class JuiceApi {
  constructor(private readonly scene: SceneService) {}

  /**
   * Smooth positional shake on a node (or the active camera via `'camera'` /
   * `'camera2d'`). The 2D camera has its own built-in additive shake (not a
   * `ShakeBehavior` component), so those targets fire-and-forget and return null.
   */
  shake(target: JuiceTarget, options: ShakeOptions = {}): ShakeBehavior | null {
    if (typeof target === 'string') {
      const key = target.toLowerCase();
      if (key === 'camera2d') {
        this.scene.getActiveCamera2D()?.shake(options);
        return null;
      }
      // `'camera'` in a pure-2D scene (no active Camera3D) targets the 2D camera.
      if (key === 'camera' && !this.scene.getActiveCamera()) {
        const camera2d = this.scene.getActiveCamera2D();
        if (camera2d) {
          camera2d.shake(options);
          return null;
        }
      }
    }

    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(ShakeBehavior);
    if (!effect) {
      effect = new ShakeBehavior('core:Shake', 'core:Shake');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Squash-and-stretch scale punch on a node. */
  punchScale(target: JuiceTarget, options: PunchScaleOptions = {}): PunchScaleBehavior | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(PunchScaleBehavior);
    if (!effect) {
      effect = new PunchScaleBehavior('core:PunchScale', 'core:PunchScale');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Spawn pop-in: scale a node from `from`× up to its authored scale. */
  popIn(target: JuiceTarget, options: PopInOptions = {}): PopInBehavior | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    let effect = node.getComponent(PopInBehavior);
    if (!effect) {
      effect = new PopInBehavior('core:PopIn', 'core:PopIn');
      effect.config.playOnStart = false;
      effect.config.triggerEvent = '';
      node.addComponent(effect);
    }
    effect.play(options);
    return effect;
  }

  /** Full-screen impact flash (see {@link SceneService.flash}). */
  flash(options: FlashOptions = {}): void {
    this.scene.flash(options);
  }

  private resolveNode(target: JuiceTarget): NodeBase | null {
    if (target instanceof NodeBase) {
      return target;
    }
    if (typeof target === 'string') {
      if (target.toLowerCase() === 'camera') {
        return this.scene.getActiveCamera();
      }
      return this.scene.findNode(target);
    }
    return null;
  }
}
