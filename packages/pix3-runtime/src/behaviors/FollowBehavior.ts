import { MathUtils, Euler, Quaternion, Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { NodeBase } from '../nodes/NodeBase';

interface FollowConfig {
  targetNodeId: string;
  positionSmoothing: number;
  rotationSmoothing: number;
  followPositionX: boolean;
  followPositionY: boolean;
  followPositionZ: boolean;
  followRotationX: boolean;
  followRotationY: boolean;
  followRotationZ: boolean;
}

export class FollowBehavior extends Script {
  private targetNode: NodeBase | null = null;
  private readonly targetWorldPosition = new Vector3();
  private readonly targetLocalPosition = new Vector3();
  private readonly targetWorldQuaternion = new Quaternion();
  private readonly targetLocalQuaternion = new Quaternion();
  private readonly parentWorldQuaternion = new Quaternion();
  private readonly parentWorldQuaternionInverse = new Quaternion();
  private readonly targetEuler = new Euler();

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      targetNodeId: '',
      positionSmoothing: 8,
      rotationSmoothing: 8,
      followPositionX: true,
      followPositionY: true,
      followPositionZ: true,
      followRotationX: false,
      followRotationY: true,
      followRotationZ: false,
    } satisfies FollowConfig;
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'FollowBehavior',
      properties: [
        {
          name: 'targetNodeId',
          type: 'node',
          ui: {
            label: 'Target Node',
            description: 'Node to follow',
            group: 'Target',
          },
          getValue: (component: unknown) => (component as FollowBehavior).getTargetNodeId(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as FollowBehavior;
            behavior.setTargetNodeId(typeof value === 'string' ? value : '');
          },
        },
        {
          name: 'positionSmoothing',
          type: 'number',
          ui: {
            label: 'Position Smoothing',
            description: 'Higher values follow position faster',
            group: 'Position',
            min: 0,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as FollowBehavior).getPositionSmoothing(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as FollowBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.config.positionSmoothing = parsed;
          },
        },
        {
          name: 'followPositionX',
          type: 'boolean',
          ui: {
            label: 'Follow Position X',
            group: 'Position',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isPositionAxisEnabled('x'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followPositionX = value;
            }
          },
        },
        {
          name: 'followPositionY',
          type: 'boolean',
          ui: {
            label: 'Follow Position Y',
            group: 'Position',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isPositionAxisEnabled('y'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followPositionY = value;
            }
          },
        },
        {
          name: 'followPositionZ',
          type: 'boolean',
          ui: {
            label: 'Follow Position Z',
            group: 'Position',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isPositionAxisEnabled('z'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followPositionZ = value;
            }
          },
        },
        {
          name: 'rotationSmoothing',
          type: 'number',
          ui: {
            label: 'Rotation Smoothing',
            description: 'Higher values follow rotation faster',
            group: 'Rotation',
            min: 0,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as FollowBehavior).getRotationSmoothing(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as FollowBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.config.rotationSmoothing = parsed;
          },
        },
        {
          name: 'followRotationX',
          type: 'boolean',
          ui: {
            label: 'Follow Rotation X',
            group: 'Rotation',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isRotationAxisEnabled('x'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followRotationX = value;
            }
          },
        },
        {
          name: 'followRotationY',
          type: 'boolean',
          ui: {
            label: 'Follow Rotation Y',
            group: 'Rotation',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isRotationAxisEnabled('y'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followRotationY = value;
            }
          },
        },
        {
          name: 'followRotationZ',
          type: 'boolean',
          ui: {
            label: 'Follow Rotation Z',
            group: 'Rotation',
          },
          getValue: (component: unknown) => (component as FollowBehavior).isRotationAxisEnabled('z'),
          setValue: (component: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (component as FollowBehavior).config.followRotationZ = value;
            }
          },
        },
      ],
      groups: {
        Target: {
          label: 'Target',
          expanded: true,
        },
        Position: {
          label: 'Position',
          expanded: true,
        },
        Rotation: {
          label: 'Rotation',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.targetNode = null;
    this.resolveTargetNode();
  }

  onUpdate(dt: number): void {
    if (!this.node || dt <= 0) {
      return;
    }

    if (!this.targetNode || !this.targetNode.parent) {
      this.resolveTargetNode();
    }

    if (!this.targetNode || this.targetNode === this.node) {
      return;
    }

    this.updatePosition(dt);
    this.updateRotation(dt);
  }

  private updatePosition(dt: number): void {
    if (!this.node || !this.targetNode) {
      return;
    }

    const followX = this.isPositionAxisEnabled('x');
    const followY = this.isPositionAxisEnabled('y');
    const followZ = this.isPositionAxisEnabled('z');

    if (!followX && !followY && !followZ) {
      return;
    }

    this.targetNode.getWorldPosition(this.targetWorldPosition);

    if (this.node.parent) {
      this.targetLocalPosition.copy(this.targetWorldPosition);
      this.node.parent.worldToLocal(this.targetLocalPosition);
    } else {
      this.targetLocalPosition.copy(this.targetWorldPosition);
    }

    const alpha = this.getDampingAlpha(this.getPositionSmoothing(), dt);

    const nextX = followX
      ? MathUtils.lerp(this.node.position.x, this.targetLocalPosition.x, alpha)
      : this.node.position.x;
    const nextY = followY
      ? MathUtils.lerp(this.node.position.y, this.targetLocalPosition.y, alpha)
      : this.node.position.y;
    const nextZ = followZ
      ? MathUtils.lerp(this.node.position.z, this.targetLocalPosition.z, alpha)
      : this.node.position.z;

    this.node.position.set(nextX, nextY, nextZ);
  }

  private updateRotation(dt: number): void {
    if (!this.node || !this.targetNode) {
      return;
    }

    const followX = this.isRotationAxisEnabled('x');
    const followY = this.isRotationAxisEnabled('y');
    const followZ = this.isRotationAxisEnabled('z');

    if (!followX && !followY && !followZ) {
      return;
    }

    this.targetNode.getWorldQuaternion(this.targetWorldQuaternion);

    if (this.node.parent) {
      this.node.parent.getWorldQuaternion(this.parentWorldQuaternion);
      this.parentWorldQuaternionInverse.copy(this.parentWorldQuaternion).invert();
      this.targetLocalQuaternion
        .copy(this.parentWorldQuaternionInverse)
        .multiply(this.targetWorldQuaternion);
    } else {
      this.targetLocalQuaternion.copy(this.targetWorldQuaternion);
    }

    this.targetEuler.setFromQuaternion(this.targetLocalQuaternion, this.node.rotation.order);

    const alpha = this.getDampingAlpha(this.getRotationSmoothing(), dt);

    const nextX = followX
      ? this.dampAngle(this.node.rotation.x, this.targetEuler.x, alpha)
      : this.node.rotation.x;
    const nextY = followY
      ? this.dampAngle(this.node.rotation.y, this.targetEuler.y, alpha)
      : this.node.rotation.y;
    const nextZ = followZ
      ? this.dampAngle(this.node.rotation.z, this.targetEuler.z, alpha)
      : this.node.rotation.z;

    this.node.rotation.set(nextX, nextY, nextZ, this.node.rotation.order);
  }

  private resolveTargetNode(): void {
    if (!this.node) {
      return;
    }

    const targetNodeId = this.getTargetNodeId();
    if (!targetNodeId) {
      this.targetNode = null;
      return;
    }

    this.targetNode = this.findNode(targetNodeId);
  }

  private getTargetNodeId(): string {
    const raw = this.config.targetNodeId;
    return typeof raw === 'string' ? raw : '';
  }

  private setTargetNodeId(nodeId: string): void {
    this.config.targetNodeId = nodeId;
    this.targetNode = null;
  }

  private getPositionSmoothing(): number {
    const raw = this.config.positionSmoothing;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
  }

  private getRotationSmoothing(): number {
    const raw = this.config.rotationSmoothing;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
  }

  private isPositionAxisEnabled(axis: 'x' | 'y' | 'z'): boolean {
    const key =
      axis === 'x' ? 'followPositionX' : axis === 'y' ? 'followPositionY' : 'followPositionZ';
    const raw = this.config[key];
    return typeof raw === 'boolean' ? raw : true;
  }

  private isRotationAxisEnabled(axis: 'x' | 'y' | 'z'): boolean {
    const key =
      axis === 'x' ? 'followRotationX' : axis === 'y' ? 'followRotationY' : 'followRotationZ';
    const raw = this.config[key];
    return typeof raw === 'boolean' ? raw : false;
  }

  private getDampingAlpha(smoothing: number, dt: number): number {
    if (smoothing <= 0) {
      return 1;
    }
    return 1 - Math.exp(-smoothing * dt);
  }

  private dampAngle(current: number, target: number, alpha: number): number {
    const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + delta * alpha;
  }
}