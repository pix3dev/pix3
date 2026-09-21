import { Vector3 } from 'three';

import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { ShakeBehavior, type ShakeOptions } from '../behaviors/ShakeBehavior';
import { PunchScaleBehavior, type PunchScaleOptions } from '../behaviors/PunchScaleBehavior';
import { PopInBehavior, type PopInOptions } from '../behaviors/PopInBehavior';
import {
  FloatText2D,
  ParticleBurst2D,
  type BurstOptions,
  type FloatTextStyleOptions,
  type JuicePoint2D,
} from './juice-transients';
import { Trail2D, type TrailOptions } from './trail-2d';
import type { SceneService } from './SceneService';
import type { FlashOptions } from './SceneService';

/**
 * Target of a juice effect: a node instance, a node query (id / name / path),
 * the literal `'camera'` to hit the active 3D camera (falling back to the active
 * 2D camera in pure-2D scenes), or `'camera2d'` to hit the active 2D camera.
 */
export type JuiceTarget = NodeBase | string;

/** Where a transient 2D effect appears: a node, a node query, or a 2D world point. */
export type JuiceAnchor = JuiceTarget | JuicePoint2D;

/** Options for {@link JuiceApi.floatText} — the style fields plus a spawn anchor. */
export interface FloatTextOptions extends FloatTextStyleOptions {
  /**
   * Node / node query / 2D world point the popup spawns at. Omitted spawns it at
   * the host root's origin (screen centre in a camera-less 2D scene).
   */
  at?: JuiceAnchor;
}

function isJuicePoint(value: unknown): value is JuicePoint2D {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as JuicePoint2D).x === 'number' &&
    typeof (value as JuicePoint2D).y === 'number' &&
    !(value instanceof NodeBase)
  );
}

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
 *
 * {@link burst} and {@link floatText} work differently from the transform
 * effects: instead of a reusable component on an existing node they spawn a
 * short-lived 2D node that frees itself (see `./juice-transients`).
 */
export class JuiceApi {
  /** Monotonic id source for spawned transients (burst / floatText). */
  private transientCounter = 0;

  /** Targets already complained about; see {@link warnOnce}. */
  private readonly warned = new Set<string>();

  constructor(private readonly scene: SceneService) {}

  /**
   * Smooth positional shake on a node (or the active camera via `'camera'` /
   * `'camera2d'`). The 2D camera has its own built-in additive shake (not a
   * `ShakeBehavior` component), so those targets fire-and-forget and return null.
   *
   * **`null` is not a failure signal for the camera targets** — they return it on success too. A
   * shake that found no camera used to be indistinguishable from one that worked, so a scene
   * missing its Camera2D just quietly had no juice and nothing ever said so. It now warns instead
   * (once per target, so a per-frame call cannot flood the log).
   */
  shake(target: JuiceTarget, options: ShakeOptions = {}): ShakeBehavior | null {
    if (typeof target === 'string') {
      const key = target.toLowerCase();
      if (key === 'camera2d') {
        const camera2d = this.scene.getActiveCamera2D();
        if (!camera2d) {
          this.warnOnce(
            'camera2d',
            "juice.shake('camera2d') found no active Camera2D — nothing shook. Add a Camera2D to " +
              'the scene, or shake a node instead.'
          );
          return null;
        }
        camera2d.shake(options);
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

  /**
   * One-shot 2D particle burst at a node (or a 2D world point). A transient
   * play-mode visual: it spawns into the 2D tree, animates through `node.tick`
   * (so a hitstop freezes it), and frees itself when the last particle dies —
   * nothing to author, nothing to clean up.
   *
   * ```ts
   * this.scene.juice.burst('bumper-a');                                  // already juicy
   * this.scene.juice.burst(ball, { colors: ['#ffcf33', '#ff4d6d'], count: 24 });
   * this.scene.juice.burst({ x: 0, y: -220 }, { spread: Math.PI / 3, speed: 500 });
   * ```
   *
   * Returns null when the target cannot be resolved or the scene has no 2D node
   * to host the effect.
   */
  burst(target: JuiceAnchor, options: BurstOptions = {}): ParticleBurst2D | null {
    const anchor = this.resolveAnchorNode(target, 'burst');
    if (anchor === undefined) {
      return null;
    }
    const host = this.resolve2DHost(anchor);
    if (!host) {
      console.warn('[JuiceApi] burst: the scene has no 2D node to host the effect.');
      return null;
    }

    const burst = new ParticleBurst2D(
      { id: this.nextTransientId('burst'), name: 'JuiceBurst' },
      options
    );
    host.adoptChild(burst);
    const local = this.resolveHostLocalPoint(host, anchor, target);
    burst.position.set(local.x, local.y, 0);
    return burst;
  }

  /**
   * Floating text popup ("+100", "MISS!", a combo counter). Same transient
   * lifecycle as {@link burst}: pops in, rises, fades, frees itself — and never
   * takes part in picking, so a popup drifting over a button can't eat the tap.
   *
   * ```ts
   * this.scene.juice.floatText('+100', { at: 'bumper-a', color: '#ffcf33', glow: true });
   * ```
   */
  floatText(text: string, options: FloatTextOptions = {}): FloatText2D | null {
    const label = typeof text === 'string' ? text : String(text ?? '');
    if (label.length === 0) {
      return null;
    }

    const anchor =
      options.at === undefined ? null : this.resolveAnchorNode(options.at, 'floatText');
    if (anchor === undefined) {
      return null;
    }
    const host = this.resolve2DHost(anchor);
    if (!host) {
      console.warn('[JuiceApi] floatText: the scene has no 2D node to host the popup.');
      return null;
    }

    const popup = new FloatText2D(
      { id: this.nextTransientId('float-text'), name: 'JuiceFloatText' },
      label,
      options
    );
    host.adoptChild(popup);
    if (options.at !== undefined) {
      const local = this.resolveHostLocalPoint(host, anchor, options.at);
      popup.position.set(local.x, local.y, 0);
    }
    return popup;
  }

  /**
   * A fading motion ribbon that follows a node — the "this thing is fast" read a
   * ball, a dash or a projectile gets for one line of script.
   *
   * Same transient lifecycle as {@link burst}: a runtime-only 2D node spawned into
   * the target's 2D root, ticked through `node.tick` (so a hitstop freezes it) and
   * never pickable. It keeps following until `trail.stop()`, then fades out over
   * `lifeSec` and frees itself; freeing the target does the same.
   *
   * ```ts
   * this.trail = this.scene.juice.trail(this.node, { colors: ['#ffcf33', '#ff4d6d'], widthPx: 18 });
   * // ... later, when the ball is gone:
   * this.trail?.stop();
   * ```
   *
   * Returns null when the target cannot be resolved or the scene has no 2D node to
   * host the ribbon.
   */
  trail(target: JuiceTarget, options: TrailOptions = {}): Trail2D | null {
    const node = this.resolveNode(target);
    if (!node) {
      return null;
    }
    const host = this.resolve2DHost(node);
    if (!host) {
      console.warn('[JuiceApi] trail: the scene has no 2D node to host the ribbon.');
      return null;
    }

    const trail = new Trail2D(
      { id: this.nextTransientId('trail'), name: 'JuiceTrail' },
      node,
      options
    );
    host.adoptChild(trail);
    return trail;
  }

  /**
   * The node a transient effect is anchored to: the resolved node, `null` for a
   * literal point (no node involved), or `undefined` when a query missed — which
   * the callers turn into a null return.
   */
  private resolveAnchorNode(target: JuiceAnchor, label: string): NodeBase | null | undefined {
    if (isJuicePoint(target)) {
      return null;
    }
    const node = this.resolveNode(target);
    if (!node) {
      console.warn(`[JuiceApi] ${label}: target "${String(target)}" not found.`);
      return undefined;
    }
    return node;
  }

  /**
   * The 2D node a transient effect is parented to. Anchored effects go to the
   * TOP-MOST `Node2D` ancestor of their anchor: that keeps them in the anchor's
   * band (a HUD anchor keeps its popup in the un-bloomed `CanvasLayer2D` overlay)
   * and, being the last child of a root, they paint above that root's content
   * without touching anyone's `zIndex`. It also decouples their lifetime from the
   * anchor — a burst outlives the brick it was spawned on.
   *
   * Unanchored effects fall back to the last 2D root that is NOT a CanvasLayer2D
   * (game content, so they bloom), or any 2D root when the scene is HUD-only.
   */
  private resolve2DHost(anchor: NodeBase | null): Node2D | null {
    if (anchor) {
      let host: Node2D | null = null;
      let current: import('three').Object3D | null = anchor;
      while (current) {
        if (current instanceof Node2D) {
          host = current;
        }
        current = current.parent;
      }
      if (host) {
        return host;
      }
    }

    let content: Node2D | null = null;
    let fallback: Node2D | null = null;
    for (const root of this.scene.getRootNodes()) {
      if (root instanceof Node2D) {
        fallback = root;
        if (!root.isCanvasLayer) {
          content = root;
        }
      }
    }
    return content ?? fallback;
  }

  /** Anchor position expressed in the host's local space (the spawn position). */
  private resolveHostLocalPoint(
    host: Node2D,
    anchor: NodeBase | null,
    target: JuiceAnchor
  ): Vector3 {
    const world = new Vector3();
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(world);
    } else if (isJuicePoint(target)) {
      world.set(target.x, target.y, 0);
    }
    // worldToLocal reads matrixWorld, which is a frame behind whenever the host
    // moved this tick — refresh it so a burst never lands at last frame's offset.
    host.updateWorldMatrix(true, false);
    return host.worldToLocal(world);
  }

  private nextTransientId(kind: string): string {
    this.transientCounter += 1;
    // Colon-namespaced for the same reason spawned prefabs are: authored ids never
    // contain one, so a transient can never collide with a node lookup by id.
    return `juice:${kind}:${this.transientCounter}`;
  }

  private resolveNode(target: JuiceTarget): NodeBase | null {
    if (target instanceof NodeBase) {
      return target;
    }
    if (typeof target === 'string') {
      const resolved =
        target.toLowerCase() === 'camera'
          ? this.scene.getActiveCamera()
          : this.scene.findNode(target);
      if (!resolved) {
        // Every juice method returns null for an unresolved target, and callers reasonably ignore
        // the return value — juice is decoration. Without this, a renamed node turns its effects
        // off permanently and silently, which reads as "the juice API does not work".
        this.warnOnce(target, `juice: no node named "${target}" — the effect did nothing.`);
      }
      return resolved;
    }
    return null;
  }

  /**
   * Log a given complaint once per key.
   *
   * Juice calls sit in gameplay code and run every frame; an un-deduplicated warning would bury the
   * console (and the agent-facing log channel) under thousands of identical lines, which is the
   * same "noise trains you to ignore it" failure as staying silent, only louder.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(`[Juice] ${message}`);
  }
}
