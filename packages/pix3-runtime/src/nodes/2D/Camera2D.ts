import { Vector2, Vector3 } from 'three';

import { Node2D, type Node2DProps } from '../Node2D';
import { NodeBase } from '../NodeBase';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';
import { clampRange, dampingAlpha, deadzoneGoal } from '../../core/camera-math';
import { shakeNoise, type ShakeOptions } from '../../behaviors/ShakeBehavior';

/** Default configuration values for a freshly created 2D camera. */
export const CAMERA2D_DEFAULTS = {
  priority: 10,
  zoom: 1,
  followDamping: 8,
  shakeAmplitude: 8,
  shakeFrequency: 24,
  shakeDuration: 0.35,
  shakeDecay: 1.5,
} as const;

/** Framing solved for the current frame by {@link Camera2D.computeView}. */
export interface Camera2DView {
  x: number;
  y: number;
  zoom: number;
}

export interface Camera2DProps extends Omit<Node2DProps, 'type'> {
  priority?: number;
  zoom?: number;
  offset?: { x: number; y: number };
  followTargetId?: string;
  followDamping?: number;
  followOffset?: { x: number; y: number };
  deadzone?: { x: number; y: number };
  limitsEnabled?: boolean;
  limitsCenter?: { x: number; y: number };
  limitsSize?: { x: number; y: number };
  shakeAmplitude?: number;
  shakeFrequency?: number;
  shakeDuration?: number;
  shakeDecay?: number;
}

/**
 * A 2D game camera (Godot-style `Camera2D`). Like {@link ../3D/VirtualCamera3D}
 * it does NOT render — it *describes* how the shared 2D orthographic pass should
 * be framed. Each frame {@link SceneRunner} picks the highest-priority visible
 * `Camera2D` (see {@link findActiveCamera2D}) and applies its {@link computeView}
 * (pan / zoom / clamped limits) plus its {@link getShakeOffset} to the ortho
 * camera. With no `Camera2D` in the scene the 2D pass keeps its default identity
 * framing, so existing 2D scenes / playable ads are unaffected.
 *
 * Every knob is a flat property-schema entry, so the keyframe timeline animates
 * `position`, `offset`, `zoom`, `priority`, etc. with no animation code —
 * switching cameras is "raise this one's priority above that one".
 *
 * Solving is driven by the runtime tick (play mode only): {@link tick} calls
 * {@link solve} on the running clone, so the authored graph is never mutated and
 * the editor viewport (which owns its own free-navigation ortho camera) is
 * unaffected. Shake is advanced in the tick too, so it respects the global
 * `Time.scale` — a hitstop freezes it, slow-mo stretches it.
 *
 * NOTE (v1): screen-anchored HUD shares the same ortho camera and therefore pans
 * / zooms with the world. A `CanvasLayer2D` (routed to a separate fixed overlay
 * camera) is the intended way to pin a HUD; this node never touches that camera.
 */
export class Camera2D extends Node2D {
  private priorityValue: number;
  private zoomValue: number;
  private readonly offset = new Vector2();
  private followTargetId: string;
  private followDampingValue: number;
  private readonly followOffset = new Vector2();
  private readonly deadzone = new Vector2();
  private limitsEnabledValue: boolean;
  private readonly limitsCenter = new Vector2();
  private readonly limitsSize = new Vector2(1000, 1000);

  private shakeAmplitudeValue: number;
  private shakeFrequencyValue: number;
  private shakeDurationValue: number;
  private shakeDecayValue: number;
  private shakeActive = false;
  private shakeElapsed = 0;
  private readonly shakeOffset = new Vector2();

  // Scratch objects reused across frames (no per-frame allocation in solve()).
  private readonly scratchWorld = new Vector3();
  private readonly scratchTarget = new Vector3();
  private readonly scratchLocal = new Vector3();

  constructor(props: Camera2DProps) {
    super(props, 'Camera2D');

    const d = CAMERA2D_DEFAULTS;
    this.priorityValue = props.priority ?? d.priority;
    this.zoomValue = Math.max(0.01, props.zoom ?? d.zoom);
    if (props.offset) {
      this.offset.set(props.offset.x, props.offset.y);
    }
    this.followTargetId = props.followTargetId ?? '';
    this.followDampingValue = Math.max(0, props.followDamping ?? d.followDamping);
    if (props.followOffset) {
      this.followOffset.set(props.followOffset.x, props.followOffset.y);
    }
    if (props.deadzone) {
      this.deadzone.set(Math.max(0, props.deadzone.x), Math.max(0, props.deadzone.y));
    }
    this.limitsEnabledValue = props.limitsEnabled ?? false;
    if (props.limitsCenter) {
      this.limitsCenter.set(props.limitsCenter.x, props.limitsCenter.y);
    }
    if (props.limitsSize) {
      this.limitsSize.set(Math.max(0, props.limitsSize.x), Math.max(0, props.limitsSize.y));
    }
    this.shakeAmplitudeValue = Math.max(0, props.shakeAmplitude ?? d.shakeAmplitude);
    this.shakeFrequencyValue = Math.max(0, props.shakeFrequency ?? d.shakeFrequency);
    this.shakeDurationValue = Math.max(0, props.shakeDuration ?? d.shakeDuration);
    this.shakeDecayValue = Math.max(0, props.shakeDecay ?? d.shakeDecay);
  }

  // ── Public accessors (read by the schema / runner) ──────────────────────────

  get priority(): number {
    return this.priorityValue;
  }
  set priority(value: number) {
    const next = Number(value);
    this.priorityValue = Number.isFinite(next) ? next : this.priorityValue;
  }

  get zoom(): number {
    return this.zoomValue;
  }
  set zoom(value: number) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) {
      this.zoomValue = next;
    }
  }

  get limitsEnabled(): boolean {
    return this.limitsEnabledValue;
  }
  set limitsEnabled(value: boolean) {
    this.limitsEnabledValue = Boolean(value);
  }

  // ── Solve / apply ───────────────────────────────────────────────────────────

  override tick(dt: number): void {
    super.tick(dt);
    this.solve(dt);
  }

  /**
   * Advance the camera one frame: damp toward the follow target (if any), then
   * advance the shake envelope. Mutates the node's own transform (so a gizmo
   * tracks the target) but never touches the ortho camera — {@link computeView}
   * / {@link getShakeOffset} apply the result at render time. Runs on the running
   * clone only (via {@link tick}), so play-mode isolation is automatic.
   */
  solve(dt: number): void {
    this.solveFollow(dt);
    this.advanceShake(dt);
  }

  /**
   * Pure framing solve: the clamped world-space center + zoom for a given
   * visible size (the runner's logical camera size). Does NOT include shake.
   * Side-effect-free apart from refreshing this node's world matrix, so it is
   * safe to unit-test without a runner.
   */
  computeView(viewSize: { width: number; height: number }): Camera2DView {
    this.updateWorldMatrix(true, false);
    this.getWorldPosition(this.scratchWorld);

    let cx = this.scratchWorld.x + this.offset.x;
    let cy = this.scratchWorld.y + this.offset.y;
    const zoom = Math.max(0.01, this.zoomValue);

    if (this.limitsEnabledValue) {
      const halfW = viewSize.width / 2 / zoom;
      const halfH = viewSize.height / 2 / zoom;
      // Slack the center may travel within so the view edge never crosses the
      // bounds. Degenerate bounds (smaller than the view) → free = 0 → the
      // center pins to limitsCenter (bounds sit centered, no NaN/oscillation).
      const freeX = Math.max(0, this.limitsSize.x / 2 - halfW);
      const freeY = Math.max(0, this.limitsSize.y / 2 - halfH);
      cx = clampRange(cx, this.limitsCenter.x, freeX);
      cy = clampRange(cy, this.limitsCenter.y, freeY);
    }

    return { x: cx, y: cy, zoom };
  }

  /** Last solved additive shake offset (zero when idle). */
  getShakeOffset(out: Vector2): Vector2 {
    return out.copy(this.shakeOffset);
  }

  /** Start (or restart) a shake. Omitted options fall back to authored knobs. */
  shake(options: ShakeOptions = {}): void {
    if (options.amplitude != null && Number.isFinite(options.amplitude)) {
      this.shakeAmplitudeValue = Math.max(0, options.amplitude);
    }
    if (options.frequency != null && Number.isFinite(options.frequency)) {
      this.shakeFrequencyValue = Math.max(0, options.frequency);
    }
    if (options.duration != null && Number.isFinite(options.duration)) {
      this.shakeDurationValue = Math.max(0, options.duration);
    }
    if (options.decay != null && Number.isFinite(options.decay)) {
      this.shakeDecayValue = Math.max(0, options.decay);
    }
    this.shakeElapsed = 0;
    this.shakeActive = true;
  }

  /** Stop shaking immediately and clear the offset. */
  stopShake(): void {
    this.shakeActive = false;
    this.shakeOffset.set(0, 0);
  }

  private advanceShake(dt: number): void {
    if (!this.shakeActive) {
      this.shakeOffset.set(0, 0);
      return;
    }

    this.shakeElapsed += Math.max(0, dt);
    const duration = this.shakeDurationValue;
    if (duration > 0 && this.shakeElapsed >= duration) {
      this.shakeActive = false;
      this.shakeOffset.set(0, 0);
      return;
    }

    const progress = duration > 0 ? this.shakeElapsed / duration : 0;
    const damp = Math.pow(Math.max(0, 1 - progress), this.shakeDecayValue);
    const amp = this.shakeAmplitudeValue * damp;
    const phase = this.shakeElapsed * this.shakeFrequencyValue;
    this.shakeOffset.set(shakeNoise(phase, 0) * amp, shakeNoise(phase, 100) * amp);
  }

  private solveFollow(dt: number): void {
    const target = this.resolveTarget(this.followTargetId);
    if (!target || target === this) {
      return;
    }

    target.getWorldPosition(this.scratchTarget);
    const desiredX = this.scratchTarget.x + this.followOffset.x;
    const desiredY = this.scratchTarget.y + this.followOffset.y;

    this.updateWorldMatrix(true, false);
    this.getWorldPosition(this.scratchWorld);

    const goalX = deadzoneGoal(this.scratchWorld.x, desiredX, this.deadzone.x);
    const goalY = deadzoneGoal(this.scratchWorld.y, desiredY, this.deadzone.y);

    const alpha = dampingAlpha(this.followDampingValue, dt);
    const nextX = this.scratchWorld.x + (goalX - this.scratchWorld.x) * alpha;
    const nextY = this.scratchWorld.y + (goalY - this.scratchWorld.y) * alpha;

    this.setWorldPosition2D(nextX, nextY);
  }

  private setWorldPosition2D(x: number, y: number): void {
    this.scratchLocal.set(x, y, 0);
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      this.parent.worldToLocal(this.scratchLocal);
    }
    this.position.x = this.scratchLocal.x;
    this.position.y = this.scratchLocal.y;
    this.updateWorldMatrix(true, false);
  }

  private resolveTarget(id: string): NodeBase | null {
    if (!id) {
      return null;
    }
    if (this.scene) {
      return this.scene.findNode(id);
    }
    let root: NodeBase = this;
    while (root.parentNode) {
      root = root.parentNode;
    }
    return root.findNode(id);
  }

  serializeConfig(): Record<string, unknown> {
    return {
      priority: this.priorityValue,
      zoom: this.zoomValue,
      offset: [this.offset.x, this.offset.y],
      followTargetId: this.followTargetId,
      followDamping: this.followDampingValue,
      followOffset: [this.followOffset.x, this.followOffset.y],
      deadzone: [this.deadzone.x, this.deadzone.y],
      limitsEnabled: this.limitsEnabledValue,
      limitsCenter: [this.limitsCenter.x, this.limitsCenter.y],
      limitsSize: [this.limitsSize.x, this.limitsSize.y],
      shakeAmplitude: this.shakeAmplitudeValue,
      shakeFrequency: this.shakeFrequencyValue,
      shakeDuration: this.shakeDurationValue,
      shakeDecay: this.shakeDecayValue,
    };
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();

    const camProps = {
      nodeType: 'Camera2D',
      properties: [
        defineProperty('priority', 'number', {
          ui: {
            label: 'Priority',
            description: 'Highest-priority visible Camera2D drives the 2D view (animatable)',
            group: 'Camera',
            step: 1,
            precision: 0,
          },
          getValue: node => (node as Camera2D).priority,
          setValue: (node, value) => {
            (node as Camera2D).priority = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) },
        }),
        defineProperty('zoom', 'number', {
          ui: {
            label: 'Zoom',
            description: '>1 magnifies (zooms in), <1 zooms out',
            group: 'Camera',
            min: 0.01,
            step: 0.05,
            precision: 2,
          },
          getValue: node => (node as Camera2D).zoom,
          setValue: (node, value) => {
            (node as Camera2D).zoom = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) && Number(value) > 0 },
        }),
        defineProperty('offset', 'vector2', {
          ui: {
            label: 'Offset',
            description: 'Framing offset added to position (never written by follow / shake)',
            group: 'Camera',
            step: 1,
            precision: 0,
          },
          getValue: node => vec2Value((node as Camera2D).offset),
          setValue: (node, value) => copyVec2((node as Camera2D).offset, value),
        }),
        defineProperty('followTargetId', 'node', {
          ui: {
            label: 'Follow Target',
            description: 'Node whose position this camera follows (empty = authored position)',
            group: 'Follow',
          },
          getValue: node => (node as Camera2D).followTargetId,
          setValue: (node, value) => {
            (node as Camera2D).followTargetId = typeof value === 'string' ? value : '';
          },
        }),
        defineProperty('followOffset', 'vector2', {
          ui: { label: 'Follow Offset', group: 'Follow', step: 1, precision: 0 },
          getValue: node => vec2Value((node as Camera2D).followOffset),
          setValue: (node, value) => copyVec2((node as Camera2D).followOffset, value),
        }),
        defineProperty('followDamping', 'number', {
          ui: {
            label: 'Follow Damping',
            description: 'Higher = snappier follow (0 = instant)',
            group: 'Follow',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: node => (node as Camera2D).followDampingValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as Camera2D).followDampingValue = n;
            }
          },
        }),
        defineProperty('deadzone', 'vector2', {
          ui: {
            label: 'Deadzone',
            description: 'World half-extents the target can move within before the camera follows',
            group: 'Follow',
            min: 0,
            step: 1,
            precision: 0,
          },
          getValue: node => vec2Value((node as Camera2D).deadzone),
          setValue: (node, value) => copyVec2((node as Camera2D).deadzone, value, 0),
        }),
        defineProperty('limitsEnabled', 'boolean', {
          ui: {
            label: 'Limits',
            description: 'Clamp the visible view inside an axis-aligned world box',
            group: 'Limits',
          },
          getValue: node => (node as Camera2D).limitsEnabledValue,
          setValue: (node, value) => {
            (node as Camera2D).limitsEnabledValue = Boolean(value);
          },
        }),
        defineProperty('limitsCenter', 'vector2', {
          ui: {
            label: 'Limits Center',
            group: 'Limits',
            step: 1,
            precision: 0,
            readOnly: target => !(target as Camera2D).limitsEnabledValue,
          },
          getValue: node => vec2Value((node as Camera2D).limitsCenter),
          setValue: (node, value) => copyVec2((node as Camera2D).limitsCenter, value),
        }),
        defineProperty('limitsSize', 'vector2', {
          ui: {
            label: 'Limits Size',
            group: 'Limits',
            min: 0,
            step: 1,
            precision: 0,
            readOnly: target => !(target as Camera2D).limitsEnabledValue,
          },
          getValue: node => vec2Value((node as Camera2D).limitsSize),
          setValue: (node, value) => copyVec2((node as Camera2D).limitsSize, value, 0),
        }),
        defineProperty('shakeAmplitude', 'number', {
          ui: { label: 'Shake Amplitude', group: 'Shake', min: 0, step: 0.5, precision: 2 },
          getValue: node => (node as Camera2D).shakeAmplitudeValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as Camera2D).shakeAmplitudeValue = n;
            }
          },
        }),
        defineProperty('shakeFrequency', 'number', {
          ui: { label: 'Shake Frequency', group: 'Shake', min: 0, step: 1, precision: 1 },
          getValue: node => (node as Camera2D).shakeFrequencyValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as Camera2D).shakeFrequencyValue = n;
            }
          },
        }),
        defineProperty('shakeDuration', 'number', {
          ui: {
            label: 'Shake Duration',
            group: 'Shake',
            min: 0,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: node => (node as Camera2D).shakeDurationValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as Camera2D).shakeDurationValue = n;
            }
          },
        }),
        defineProperty('shakeDecay', 'number', {
          ui: {
            label: 'Shake Decay',
            description: 'Falloff power (0 = steady, 1 = linear, >1 = punchy tail)',
            group: 'Shake',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: node => (node as Camera2D).shakeDecayValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as Camera2D).shakeDecayValue = n;
            }
          },
        }),
      ],
      groups: {
        Camera: { label: 'Camera', expanded: true },
        Follow: { label: 'Follow', expanded: true },
        Limits: { label: 'Limits', expanded: false },
        Shake: { label: 'Shake', expanded: false },
      },
    } as PropertySchema;

    return mergeSchemas(base, camProps);
  }
}

/**
 * Select the active `Camera2D` from a scene tree: the highest-`priority` visible
 * one, first-in-DFS on ties. Returns null when none exist (identity framing).
 */
export function findActiveCamera2D(roots: readonly NodeBase[]): Camera2D | null {
  let best: Camera2D | null = null;

  const visit = (nodes: readonly NodeBase[]): void => {
    for (const node of nodes) {
      if (node instanceof Camera2D && node.visible) {
        if (best === null || node.priority > best.priority) {
          best = node;
        }
      }
      const children = node.children.filter((c): c is NodeBase => c instanceof NodeBase);
      if (children.length > 0) {
        visit(children);
      }
    }
  };

  visit(roots);
  return best;
}

function vec2Value(v: Vector2): { x: number; y: number } {
  return { x: v.x, y: v.y };
}

function copyVec2(target: Vector2, value: unknown, min = Number.NEGATIVE_INFINITY): void {
  const v = value as { x?: unknown; y?: unknown };
  const nx = Number(v?.x);
  const ny = Number(v?.y);
  target.set(
    Number.isFinite(nx) ? Math.max(min, nx) : target.x,
    Number.isFinite(ny) ? Math.max(min, ny) : target.y
  );
}
