import { Matrix4, Quaternion, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { NodeBase } from '../NodeBase';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';
import { EASING_NAMES, isKeyframeEasing, type KeyframeEasing } from '../../animation/easing';
import { clampRange, dampingAlpha, deadzoneGoal } from '../../core/camera-math';

const WORLD_UP = new Vector3(0, 1, 0);

/** Default configuration values for a freshly created virtual camera. */
export const VIRTUAL_CAMERA_DEFAULTS = {
  priority: 10,
  fov: 60,
  orthographicSize: 5,
  followDamping: 8,
  rotationDamping: 8,
  lookAtWeight: 1,
  blendDuration: 1,
  blendEasing: 'cubicInOut' as KeyframeEasing,
} as const;

export interface VirtualCamera3DProps extends Omit<Node3DProps, 'type'> {
  priority?: number;
  fov?: number;
  orthographicSize?: number;
  followTargetId?: string;
  followDamping?: number;
  followOffset?: { x: number; y: number; z: number };
  deadzone?: { x: number; y: number; z: number };
  lookAtTargetId?: string;
  lookAtWeight?: number;
  rotationDamping?: number;
  confinerEnabled?: boolean;
  confinerCenter?: { x: number; y: number; z: number };
  confinerSize?: { x: number; y: number; z: number };
  blendDuration?: number;
  blendEasing?: KeyframeEasing;
}

/**
 * A lightweight "virtual camera" (Cinemachine-lite). It does NOT render — it
 * only describes a desired framing (position via follow, orientation via
 * look-at, plus FOV / ortho size). A {@link CameraBrainBehavior} attached to a
 * real `Camera3D` selects the highest-priority live virtual camera each frame
 * and blends the render camera toward it.
 *
 * Because every knob is exposed through the property schema, the keyframe
 * timeline can animate `priority`, `fov`, `position`, etc. with no animation
 * code — switching cameras is "raise this one's priority above that one".
 *
 * Solving is driven exclusively by the brain (single authority): the brain
 * calls {@link solve} on every virtual camera each frame — including standby
 * ones, so a camera is already framed when it is cut to — then reads the winner
 * via {@link getDesiredWorldPosition} / {@link getDesiredWorldQuaternion}. A
 * virtual camera with no brain in the scene simply sits at its authored pose.
 */
export class VirtualCamera3D extends Node3D {
  private priorityValue: number;
  private fovValue: number;
  private orthographicSizeValue: number;
  private followTargetId: string;
  private followDampingValue: number;
  private readonly followOffset = new Vector3();
  private readonly deadzone = new Vector3();
  private lookAtTargetId: string;
  private lookAtWeightValue: number;
  private rotationDampingValue: number;
  private confinerEnabledValue: boolean;
  private readonly confinerCenter = new Vector3();
  private readonly confinerSize = new Vector3(10, 10, 10);
  private blendDurationValue: number;
  private blendEasingValue: KeyframeEasing;

  /** Authored local rotation captured on the first solve, used as the stable
   * base for weighted look-at blending (the live rotation is mutated each
   * frame, so we can't read the authored value from it after frame 1). */
  private authoredQuaternion: Quaternion | null = null;

  // Scratch objects reused across frames (no per-frame allocation in solve()).
  private readonly scratchWorldPos = new Vector3();
  private readonly scratchTargetPos = new Vector3();
  private readonly scratchDesired = new Vector3();
  private readonly scratchLocal = new Vector3();
  private readonly scratchLookMatrix = new Matrix4();
  private readonly scratchLookQuat = new Quaternion();
  private readonly scratchBlendQuat = new Quaternion();
  private readonly scratchCurrentQuat = new Quaternion();
  private readonly scratchParentQuat = new Quaternion();

  constructor(props: VirtualCamera3DProps) {
    super(props, 'VirtualCamera3D');

    const d = VIRTUAL_CAMERA_DEFAULTS;
    this.priorityValue = props.priority ?? d.priority;
    this.fovValue = props.fov ?? d.fov;
    this.orthographicSizeValue = Math.max(0.0001, props.orthographicSize ?? d.orthographicSize);
    this.followTargetId = props.followTargetId ?? '';
    this.followDampingValue = Math.max(0, props.followDamping ?? d.followDamping);
    if (props.followOffset) {
      this.followOffset.set(props.followOffset.x, props.followOffset.y, props.followOffset.z);
    }
    if (props.deadzone) {
      this.deadzone.set(
        Math.max(0, props.deadzone.x),
        Math.max(0, props.deadzone.y),
        Math.max(0, props.deadzone.z)
      );
    }
    this.lookAtTargetId = props.lookAtTargetId ?? '';
    this.lookAtWeightValue = clamp01(props.lookAtWeight ?? d.lookAtWeight);
    this.rotationDampingValue = Math.max(0, props.rotationDamping ?? d.rotationDamping);
    this.confinerEnabledValue = props.confinerEnabled ?? false;
    if (props.confinerCenter) {
      this.confinerCenter.set(
        props.confinerCenter.x,
        props.confinerCenter.y,
        props.confinerCenter.z
      );
    }
    if (props.confinerSize) {
      this.confinerSize.set(
        Math.max(0, props.confinerSize.x),
        Math.max(0, props.confinerSize.y),
        Math.max(0, props.confinerSize.z)
      );
    }
    this.blendDurationValue = Math.max(0, props.blendDuration ?? d.blendDuration);
    this.blendEasingValue = props.blendEasing ?? d.blendEasing;
  }

  // ── Public accessors (read by the brain / schema) ──────────────────────────

  get priority(): number {
    return this.priorityValue;
  }
  set priority(value: number) {
    const next = Number(value);
    this.priorityValue = Number.isFinite(next) ? next : this.priorityValue;
  }

  get fov(): number {
    return this.fovValue;
  }
  set fov(value: number) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) {
      this.fovValue = next;
    }
  }

  get orthographicSize(): number {
    return this.orthographicSizeValue;
  }
  set orthographicSize(value: number) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) {
      this.orthographicSizeValue = next;
    }
  }

  get blendDuration(): number {
    return this.blendDurationValue;
  }
  set blendDuration(value: number) {
    const next = Number(value);
    this.blendDurationValue = Number.isFinite(next) ? Math.max(0, next) : this.blendDurationValue;
  }

  get blendEasing(): KeyframeEasing {
    return this.blendEasingValue;
  }
  set blendEasing(value: KeyframeEasing) {
    if (isKeyframeEasing(value)) {
      this.blendEasingValue = value;
    }
  }

  /**
   * Solve this camera's framing for the current frame. Mutates the node's own
   * local transform (so its gizmo tracks the target in play mode) and lazily
   * captures the authored rotation for weighted look-at blending. Cheap and
   * safe to call every frame for standby cameras.
   */
  solve(dt: number): void {
    if (this.authoredQuaternion === null) {
      this.authoredQuaternion = this.getWorldQuaternion(new Quaternion());
    }

    this.solveFollow(dt);
    this.applyConfiner();
    this.solveLookAt(dt);
  }

  /** World position after the last {@link solve}. */
  getDesiredWorldPosition(out: Vector3): Vector3 {
    return this.getWorldPosition(out);
  }

  /** World orientation after the last {@link solve}. */
  getDesiredWorldQuaternion(out: Quaternion): Quaternion {
    return this.getWorldQuaternion(out);
  }

  /**
   * Authored configuration as a plain object for scene serialization. Keys match
   * the loader's expected property names one-to-one. Transform (position /
   * rotation / scale) is serialized separately by the generic Node3D path.
   */
  serializeConfig(): Record<string, unknown> {
    return {
      priority: this.priorityValue,
      fov: this.fovValue,
      orthographicSize: this.orthographicSizeValue,
      followTargetId: this.followTargetId,
      followDamping: this.followDampingValue,
      followOffset: [this.followOffset.x, this.followOffset.y, this.followOffset.z],
      deadzone: [this.deadzone.x, this.deadzone.y, this.deadzone.z],
      lookAtTargetId: this.lookAtTargetId,
      lookAtWeight: this.lookAtWeightValue,
      rotationDamping: this.rotationDampingValue,
      confinerEnabled: this.confinerEnabledValue,
      confinerCenter: [this.confinerCenter.x, this.confinerCenter.y, this.confinerCenter.z],
      confinerSize: [this.confinerSize.x, this.confinerSize.y, this.confinerSize.z],
      blendDuration: this.blendDurationValue,
      blendEasing: this.blendEasingValue,
    };
  }

  private resolveTarget(id: string): NodeBase | null {
    if (!id) {
      return null;
    }
    // Prefer the injected scene service (scene-wide lookup); fall back to a
    // search from this node's root so previews without a service still work.
    if (this.scene) {
      return this.scene.findNode(id);
    }
    let root: NodeBase = this;
    while (root.parentNode) {
      root = root.parentNode;
    }
    return root.findNode(id);
  }

  private solveFollow(dt: number): void {
    const target = this.resolveTarget(this.followTargetId);
    if (!target || target === this) {
      // No follow target: position is left to authored / keyframed values.
      return;
    }

    target.getWorldPosition(this.scratchTargetPos);
    // Desired world position = target + world-space offset.
    this.scratchDesired.copy(this.scratchTargetPos).add(this.followOffset);

    this.getWorldPosition(this.scratchWorldPos);

    // Per-axis world-space deadzone: only chase the component of the error that
    // exceeds the deadzone half-extent, keeping the target parked at the box edge.
    const goalX = deadzoneGoal(this.scratchWorldPos.x, this.scratchDesired.x, this.deadzone.x);
    const goalY = deadzoneGoal(this.scratchWorldPos.y, this.scratchDesired.y, this.deadzone.y);
    const goalZ = deadzoneGoal(this.scratchWorldPos.z, this.scratchDesired.z, this.deadzone.z);

    const alpha = dampingAlpha(this.followDampingValue, dt);
    const nextX = this.scratchWorldPos.x + (goalX - this.scratchWorldPos.x) * alpha;
    const nextY = this.scratchWorldPos.y + (goalY - this.scratchWorldPos.y) * alpha;
    const nextZ = this.scratchWorldPos.z + (goalZ - this.scratchWorldPos.z) * alpha;

    this.setWorldPosition(nextX, nextY, nextZ);
  }

  private applyConfiner(): void {
    if (!this.confinerEnabledValue) {
      return;
    }

    this.getWorldPosition(this.scratchWorldPos);
    const hx = this.confinerSize.x / 2;
    const hy = this.confinerSize.y / 2;
    const hz = this.confinerSize.z / 2;
    const clampedX = clampRange(this.scratchWorldPos.x, this.confinerCenter.x, hx);
    const clampedY = clampRange(this.scratchWorldPos.y, this.confinerCenter.y, hy);
    const clampedZ = clampRange(this.scratchWorldPos.z, this.confinerCenter.z, hz);

    if (
      clampedX !== this.scratchWorldPos.x ||
      clampedY !== this.scratchWorldPos.y ||
      clampedZ !== this.scratchWorldPos.z
    ) {
      this.setWorldPosition(clampedX, clampedY, clampedZ);
    }
  }

  private solveLookAt(dt: number): void {
    const target = this.resolveTarget(this.lookAtTargetId);
    if (!target || target === this || this.authoredQuaternion === null) {
      // No look-at target: orientation stays authored / keyframed.
      return;
    }

    this.getWorldPosition(this.scratchWorldPos);
    target.getWorldPosition(this.scratchTargetPos);

    if (this.scratchWorldPos.distanceToSquared(this.scratchTargetPos) < 1e-10) {
      return;
    }

    // Look-at orientation (camera looks down -Z toward the target).
    this.scratchLookMatrix.lookAt(this.scratchWorldPos, this.scratchTargetPos, WORLD_UP);
    this.scratchLookQuat.setFromRotationMatrix(this.scratchLookMatrix);

    // Blend authored orientation → full look-at by weight, then damp the live
    // world orientation toward that blended goal.
    this.scratchBlendQuat
      .copy(this.authoredQuaternion)
      .slerp(this.scratchLookQuat, this.lookAtWeightValue);

    this.getWorldQuaternion(this.scratchCurrentQuat);
    const alpha = dampingAlpha(this.rotationDampingValue, dt);
    this.scratchCurrentQuat.slerp(this.scratchBlendQuat, alpha);

    this.setWorldQuaternion(this.scratchCurrentQuat);
  }

  private setWorldPosition(x: number, y: number, z: number): void {
    this.scratchLocal.set(x, y, z);
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      this.parent.worldToLocal(this.scratchLocal);
    }
    this.position.copy(this.scratchLocal);
    this.updateWorldMatrix(true, false);
  }

  private setWorldQuaternion(worldQuat: Quaternion): void {
    if (this.parent) {
      this.parent.getWorldQuaternion(this.scratchParentQuat);
      this.scratchParentQuat.invert().multiply(worldQuat);
      this.quaternion.copy(this.scratchParentQuat);
    } else {
      this.quaternion.copy(worldQuat);
    }
    this.updateWorldMatrix(true, false);
  }

  override get treeIcon(): string {
    return 'camera';
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();

    const vcamProps = {
      nodeType: 'VirtualCamera3D',
      properties: [
        defineProperty('priority', 'number', {
          ui: {
            label: 'Priority',
            description: 'Highest-priority live virtual camera wins (animatable)',
            group: 'Virtual Camera',
            step: 1,
            precision: 0,
          },
          getValue: node => (node as VirtualCamera3D).priority,
          setValue: (node, value) => {
            (node as VirtualCamera3D).priority = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) },
        }),
        defineProperty('fov', 'number', {
          ui: {
            label: 'Field of View',
            group: 'Virtual Camera',
            unit: '°',
            step: 0.1,
            precision: 1,
          },
          getValue: node => (node as VirtualCamera3D).fov,
          setValue: (node, value) => {
            (node as VirtualCamera3D).fov = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) && Number(value) > 0 },
        }),
        defineProperty('orthographicSize', 'number', {
          ui: {
            label: 'Orthographic Size',
            description: 'Applied when the render camera is orthographic',
            group: 'Virtual Camera',
            step: 0.1,
            precision: 2,
          },
          getValue: node => (node as VirtualCamera3D).orthographicSize,
          setValue: (node, value) => {
            (node as VirtualCamera3D).orthographicSize = Number(value);
          },
          validation: { validate: value => Number.isFinite(Number(value)) && Number(value) > 0 },
        }),
        defineProperty('followTargetId', 'node', {
          ui: {
            label: 'Follow Target',
            description: 'Node whose position this camera follows (empty = authored position)',
            group: 'Follow',
          },
          getValue: node => (node as VirtualCamera3D).followTargetId,
          setValue: (node, value) => {
            (node as VirtualCamera3D).followTargetId = typeof value === 'string' ? value : '';
          },
        }),
        defineProperty('followOffset', 'vector3', {
          ui: { label: 'Follow Offset', group: 'Follow', step: 0.01, precision: 2 },
          getValue: node => vectorValue((node as VirtualCamera3D).followOffset),
          setValue: (node, value) => copyVector((node as VirtualCamera3D).followOffset, value),
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
          getValue: node => (node as VirtualCamera3D).followDampingValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as VirtualCamera3D).followDampingValue = n;
            }
          },
        }),
        defineProperty('deadzone', 'vector3', {
          ui: {
            label: 'Deadzone',
            description: 'World half-extents the target can move within before the camera follows',
            group: 'Follow',
            min: 0,
            step: 0.01,
            precision: 2,
          },
          getValue: node => vectorValue((node as VirtualCamera3D).deadzone),
          setValue: (node, value) => copyVector((node as VirtualCamera3D).deadzone, value, 0),
        }),
        defineProperty('lookAtTargetId', 'node', {
          ui: {
            label: 'Look At Target',
            description: 'Node this camera orients toward (empty = authored rotation)',
            group: 'Look At',
          },
          getValue: node => (node as VirtualCamera3D).lookAtTargetId,
          setValue: (node, value) => {
            (node as VirtualCamera3D).lookAtTargetId = typeof value === 'string' ? value : '';
          },
        }),
        defineProperty('lookAtWeight', 'number', {
          ui: {
            label: 'Look At Weight',
            description: '0 = keep authored rotation, 1 = fully track the target',
            group: 'Look At',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: node => (node as VirtualCamera3D).lookAtWeightValue,
          setValue: (node, value) => {
            (node as VirtualCamera3D).lookAtWeightValue = clamp01(Number(value));
          },
        }),
        defineProperty('rotationDamping', 'number', {
          ui: {
            label: 'Rotation Damping',
            description: 'Higher = snappier aim (0 = instant)',
            group: 'Look At',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: node => (node as VirtualCamera3D).rotationDampingValue,
          setValue: (node, value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) {
              (node as VirtualCamera3D).rotationDampingValue = n;
            }
          },
        }),
        defineProperty('confinerEnabled', 'boolean', {
          ui: {
            label: 'Confiner',
            description: 'Clamp the camera position inside an axis-aligned box',
            group: 'Confiner',
          },
          getValue: node => (node as VirtualCamera3D).confinerEnabledValue,
          setValue: (node, value) => {
            (node as VirtualCamera3D).confinerEnabledValue = Boolean(value);
          },
        }),
        defineProperty('confinerCenter', 'vector3', {
          ui: {
            label: 'Confiner Center',
            group: 'Confiner',
            step: 0.01,
            precision: 2,
            readOnly: target => !(target as VirtualCamera3D).confinerEnabledValue,
          },
          getValue: node => vectorValue((node as VirtualCamera3D).confinerCenter),
          setValue: (node, value) => copyVector((node as VirtualCamera3D).confinerCenter, value),
        }),
        defineProperty('confinerSize', 'vector3', {
          ui: {
            label: 'Confiner Size',
            group: 'Confiner',
            min: 0,
            step: 0.01,
            precision: 2,
            readOnly: target => !(target as VirtualCamera3D).confinerEnabledValue,
          },
          getValue: node => vectorValue((node as VirtualCamera3D).confinerSize),
          setValue: (node, value) => copyVector((node as VirtualCamera3D).confinerSize, value, 0),
        }),
        defineProperty('blendDuration', 'number', {
          ui: {
            label: 'Blend In',
            description:
              'Seconds to blend the render camera toward this one when it becomes active',
            group: 'Blend',
            min: 0,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: node => (node as VirtualCamera3D).blendDuration,
          setValue: (node, value) => {
            (node as VirtualCamera3D).blendDuration = Number(value);
          },
        }),
        defineProperty('blendEasing', 'enum', {
          ui: { label: 'Blend Easing', group: 'Blend', options: [...EASING_NAMES] },
          getValue: node => (node as VirtualCamera3D).blendEasing,
          setValue: (node, value) => {
            (node as VirtualCamera3D).blendEasing = value as KeyframeEasing;
          },
        }),
      ],
      groups: {
        'Virtual Camera': { label: 'Virtual Camera', expanded: true },
        Follow: { label: 'Follow', expanded: true },
        'Look At': { label: 'Look At', expanded: true },
        Confiner: { label: 'Confiner', expanded: false },
        Blend: { label: 'Blend', expanded: false },
      },
    } as PropertySchema;

    return mergeSchemas(base, vcamProps);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function vectorValue(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

function copyVector(target: Vector3, value: unknown, min = Number.NEGATIVE_INFINITY): void {
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  const nx = Number(v?.x);
  const ny = Number(v?.y);
  const nz = Number(v?.z);
  target.set(
    Number.isFinite(nx) ? Math.max(min, nx) : target.x,
    Number.isFinite(ny) ? Math.max(min, ny) : target.y,
    Number.isFinite(nz) ? Math.max(min, nz) : target.z
  );
}
