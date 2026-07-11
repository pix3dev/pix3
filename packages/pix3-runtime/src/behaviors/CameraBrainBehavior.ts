import { Quaternion, Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import { Camera3D } from '../nodes/3D/Camera3D';
import { VirtualCamera3D } from '../nodes/3D/VirtualCamera3D';
import { NodeBase } from '../nodes/NodeBase';
import { applyEasing, type KeyframeEasing } from '../animation/easing';
import type { PropertySchema } from '../fw/property-schema';

/**
 * Cinemachine-lite "brain". Attach to a `Camera3D` (the single render camera).
 * Each frame it solves every {@link VirtualCamera3D} in the scene, picks the
 * highest-priority visible one, and drives the host camera toward it — cutting
 * with an eased blend (using the target camera's own blend settings) whenever
 * the active virtual camera changes.
 *
 * The host camera is the only camera that renders; virtual cameras never do.
 * When no virtual camera is present the brain leaves the host camera untouched,
 * so a plain `Camera3D` keeps working exactly as before.
 */
export class CameraBrainBehavior extends Script {
  private currentActiveId: string | null = null;

  private blending = false;
  private blendElapsed = 0;
  private blendDuration = 0;
  private blendEasing: KeyframeEasing = 'linear';
  /**
   * One-shot blend override consumed by the next {@link beginBlend} (whenever the
   * active virtual camera changes). Set by {@link overrideNextBlend}; the Cutscene
   * Director uses it to force a specific blend into and out of a cinematic vcam,
   * winning even when `blendEnabled` is off.
   */
  private pendingBlendOverride: { duration: number; easing?: KeyframeEasing } | null = null;
  private readonly blendFromPos = new Vector3();
  private readonly blendFromQuat = new Quaternion();
  private blendFromFov = 60;
  private blendFromOrtho = 5;

  private readonly targetPos = new Vector3();
  private readonly targetQuat = new Quaternion();
  private readonly outPos = new Vector3();
  private readonly outQuat = new Quaternion();
  private readonly parentQuat = new Quaternion();
  private readonly localPos = new Vector3();

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      blendEnabled: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'CameraBrainBehavior',
      properties: [
        {
          name: 'blendEnabled',
          type: 'boolean',
          ui: {
            label: 'Blend On Switch',
            description: 'Ease between cameras on activation. Off = hard cut.',
            group: 'Camera Brain',
          },
          getValue: c => (c as CameraBrainBehavior).config.blendEnabled !== false,
          setValue: (c, v) => {
            (c as CameraBrainBehavior).config.blendEnabled = Boolean(v);
          },
        },
      ],
      groups: { 'Camera Brain': { label: 'Camera Brain', expanded: true } },
    };
  }

  onStart(): void {
    this.currentActiveId = null;
    this.blending = false;
    this.pendingBlendOverride = null;
  }

  /**
   * Force the next camera-activation blend to use `durationSec` (and optionally
   * `easing`), regardless of the target vcam's own blend settings or the
   * `blendEnabled` flag. Consumed once, by the next {@link beginBlend}. A duration
   * of 0 makes the next switch a hard cut. Used by the Cutscene Director to
   * smooth the cut into and out of a cinematic virtual camera.
   */
  overrideNextBlend(durationSec: number, easing?: KeyframeEasing): void {
    this.pendingBlendOverride = { duration: Math.max(0, durationSec), easing };
  }

  onUpdate(dt: number): void {
    const host = this.node;
    if (!(host instanceof Camera3D)) {
      return;
    }

    const cameras = this.collectVirtualCameras();
    // Solve every camera (standby included) so a camera is already framed when
    // it is cut to.
    for (const cam of cameras) {
      cam.solve(dt);
    }

    const active = this.pickActive(cameras);
    if (!active) {
      // No virtual camera drives the scene — leave the host camera as authored.
      this.currentActiveId = null;
      this.blending = false;
      return;
    }

    if (active.nodeId !== this.currentActiveId) {
      this.beginBlend(host, active);
      this.currentActiveId = active.nodeId;
    }

    active.getDesiredWorldPosition(this.targetPos);
    active.getDesiredWorldQuaternion(this.targetQuat);
    const targetFov = active.fov;
    const targetOrtho = active.orthographicSize;

    if (this.blending) {
      this.blendElapsed += Math.max(0, dt);
      const raw = this.blendDuration > 0 ? this.blendElapsed / this.blendDuration : 1;
      const e = applyEasing(this.blendEasing, raw);
      this.outPos.copy(this.blendFromPos).lerp(this.targetPos, e);
      this.outQuat.copy(this.blendFromQuat).slerp(this.targetQuat, e);
      const fov = this.blendFromFov + (targetFov - this.blendFromFov) * e;
      const ortho = this.blendFromOrtho + (targetOrtho - this.blendFromOrtho) * e;
      this.applyToHost(host, this.outPos, this.outQuat, fov, ortho);
      if (raw >= 1) {
        this.blending = false;
      }
    } else {
      this.applyToHost(host, this.targetPos, this.targetQuat, targetFov, targetOrtho);
    }
  }

  private beginBlend(host: Camera3D, active: VirtualCamera3D): void {
    // An explicit one-shot override (Cutscene Director) beats both the vcam's own
    // blend settings and the authored `blendEnabled` flag; consume it here.
    const override = this.pendingBlendOverride;
    this.pendingBlendOverride = null;
    const blendEnabled = this.config.blendEnabled !== false;
    const duration = override ? override.duration : blendEnabled ? active.blendDuration : 0;
    if (duration <= 0) {
      this.blending = false;
      return;
    }

    // Snapshot the current render-camera pose so the blend starts from where we
    // visually are (works for camera → camera and initial authored → camera).
    host.getWorldPosition(this.blendFromPos);
    host.getWorldQuaternion(this.blendFromQuat);
    this.blendFromFov = host.fov;
    this.blendFromOrtho = host.orthographicSize;
    this.blendElapsed = 0;
    this.blendDuration = duration;
    this.blendEasing = override?.easing ?? active.blendEasing;
    this.blending = true;
  }

  private applyToHost(
    host: Camera3D,
    worldPos: Vector3,
    worldQuat: Quaternion,
    fov: number,
    orthographicSize: number
  ): void {
    // Convert the desired world pose into the host's local space (the host is
    // usually a scene-root child, so this is normally identity).
    this.localPos.copy(worldPos);
    if (host.parent) {
      host.parent.updateWorldMatrix(true, false);
      host.parent.worldToLocal(this.localPos);
      host.parent.getWorldQuaternion(this.parentQuat);
      this.parentQuat.invert().multiply(worldQuat);
      host.quaternion.copy(this.parentQuat);
    } else {
      host.quaternion.copy(worldQuat);
    }
    host.position.copy(this.localPos);
    host.fov = fov;
    host.orthographicSize = orthographicSize;
  }

  private pickActive(cameras: VirtualCamera3D[]): VirtualCamera3D | null {
    let best: VirtualCamera3D | null = null;
    for (const cam of cameras) {
      if (!cam.visible) {
        continue;
      }
      if (best === null || cam.priority > best.priority) {
        best = cam;
      }
    }
    return best;
  }

  private collectVirtualCameras(): VirtualCamera3D[] {
    const roots = this.scene?.getRootNodes() ?? this.rootsFromHost();
    const out: VirtualCamera3D[] = [];
    const stack: NodeBase[] = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node instanceof VirtualCamera3D) {
        out.push(node);
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
    return out;
  }

  private rootsFromHost(): NodeBase[] {
    let root = this.node;
    while (root?.parentNode) {
      root = root.parentNode;
    }
    return root ? [root] : [];
  }
}
