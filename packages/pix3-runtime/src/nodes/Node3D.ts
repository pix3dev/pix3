import { Euler, Vector3, type Material } from 'three';

import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';

export interface Node3DProps extends Omit<NodeBaseProps, 'type'> {
  position?: Vector3;
  rotation?: Euler;
  rotationOrder?: Euler['order'];
  scale?: Vector3;
  opacity?: number;
}

export class Node3D extends NodeBase {
  private _opacity: number;
  /** Opacity to restore on show() after a hide(). */
  private visibleOpacity: number;
  /** Materials whose opacity is driven by this node's opacity. */
  private readonly opacityMaterials: Set<Material> = new Set();
  private visibilityFade: {
    from: number;
    to: number;
    duration: number;
    elapsed: number;
    hideAfterComplete: boolean;
    onComplete?: () => void;
  } | null = null;

  constructor(props: Node3DProps, nodeType: string = 'Node3D') {
    super({ ...props, type: nodeType });

    if (props.position) {
      this.position.copy(props.position);
    }

    if (props.rotation) {
      this.rotation.copy(props.rotation);
    } else {
      this.rotation.set(0, 0, 0);
    }

    this.rotation.order = props.rotationOrder ?? this.rotation.order;

    if (props.scale) {
      this.scale.copy(props.scale);
    }

    this._opacity = Node3D.clampOpacity(props.opacity ?? 1);
    this.visibleOpacity = this._opacity > 0 ? this._opacity : 1;
  }

  /** Local opacity (0..1) applied to materials registered via registerOpacityMaterial. */
  get opacity(): number {
    return this._opacity;
  }

  set opacity(value: number) {
    const next = Node3D.clampOpacity(value);
    if (this._opacity === next) {
      return;
    }
    this._opacity = next;
    if (!this.visibilityFade && next > 0) {
      this.visibleOpacity = next;
    }
    this.applyOpacityToMaterials();
  }

  /**
   * Hide this node, optionally fading out over `fadeTime` seconds. When the
   * fade completes the node's visibility is set to false.
   */
  hide(fadeTime: number = 0, onComplete?: () => void): void {
    const duration = Node3D.toNonNegativeSeconds(fadeTime);
    if (this.opacity > 0) {
      this.visibleOpacity = this.opacity;
    }

    if (duration === 0) {
      this.visibilityFade = null;
      this.opacity = 0;
      this.setVisibleState(false);
      onComplete?.();
      return;
    }

    this.setVisibleState(true);
    this.visibilityFade = {
      from: this.opacity,
      to: 0,
      duration,
      elapsed: 0,
      hideAfterComplete: true,
      onComplete,
    };
  }

  /**
   * Show this node, optionally fading in over `fadeTime` seconds to the last
   * visible opacity.
   */
  show(fadeTime: number = 0, onComplete?: () => void): void {
    const duration = Node3D.toNonNegativeSeconds(fadeTime);
    const targetOpacity = this.visibleOpacity > 0 ? this.visibleOpacity : 1;

    this.setVisibleState(true);

    if (duration === 0) {
      this.visibilityFade = null;
      this.opacity = targetOpacity;
      onComplete?.();
      return;
    }

    this.visibilityFade = {
      from: this.opacity,
      to: targetOpacity,
      duration,
      elapsed: 0,
      hideAfterComplete: false,
      onComplete,
    };
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (!this.visibilityFade) {
      return;
    }

    const fade = this.visibilityFade;
    fade.elapsed = Math.min(fade.duration, fade.elapsed + Math.max(0, dt));
    const t = fade.duration > 0 ? fade.elapsed / fade.duration : 1;
    this.opacity = fade.from + (fade.to - fade.from) * t;

    if (fade.elapsed < fade.duration) {
      return;
    }

    this.opacity = fade.to;
    this.visibilityFade = null;
    if (fade.hideAfterComplete) {
      this.setVisibleState(false);
    }
    fade.onComplete?.();
  }

  /**
   * Register a material whose opacity should track this node's opacity.
   * Subclasses call this for the materials they own (e.g. a sprite plane).
   */
  protected registerOpacityMaterial(material: Material, baseOpacity?: number): void {
    if (baseOpacity !== undefined) {
      material.userData.__pix3BaseOpacity = Node3D.clampOpacity(baseOpacity);
    } else if (typeof material.userData.__pix3BaseOpacity !== 'number') {
      material.userData.__pix3BaseOpacity = Node3D.clampOpacity(material.opacity);
    }

    if (material.userData.__pix3OriginalTransparent === undefined) {
      material.userData.__pix3OriginalTransparent = material.transparent;
    }

    this.opacityMaterials.add(material);
    this.applyOpacityToMaterial(material);
  }

  private applyOpacityToMaterials(): void {
    for (const material of this.opacityMaterials) {
      this.applyOpacityToMaterial(material);
    }
  }

  private applyOpacityToMaterial(material: Material): void {
    const baseRaw = material.userData.__pix3BaseOpacity;
    const base =
      typeof baseRaw === 'number'
        ? Node3D.clampOpacity(baseRaw)
        : Node3D.clampOpacity(material.opacity);
    material.opacity = base * this._opacity;

    const originalTransparent = material.userData.__pix3OriginalTransparent;
    material.transparent = Boolean(originalTransparent) || material.opacity < 1;
    material.needsUpdate = true;
  }

  private setVisibleState(value: boolean): void {
    this.visible = value;
    this.properties.visible = value;
  }

  private static clampOpacity(value: number): number {
    const safe = Number.isFinite(value) ? value : 1;
    return Math.max(0, Math.min(1, safe));
  }

  private static toNonNegativeSeconds(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  get treeColor(): string {
    return '#fe9ebeff'; // pink
  }

  get treeIcon(): string {
    return 'box';
  }

  /**
   * Get the property schema for Node3D.
   * Extends NodeBase schema with 3D-specific transform properties.
   */
  static getPropertySchema(): PropertySchema {
    const baseSchema = NodeBase.getPropertySchema();

    return {
      nodeType: 'Node3D',
      extends: 'NodeBase',
      properties: [
        ...baseSchema.properties,
        {
          name: 'position',
          type: 'vector3',
          ui: {
            label: 'Position',
            group: 'Transform',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const n = node as Node3D;
            return { x: n.position.x, y: n.position.y, z: n.position.z };
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node3D;
            const v = value as { x: number; y: number; z: number };
            n.position.x = v.x;
            n.position.y = v.y;
            n.position.z = v.z;
          },
        },
        {
          name: 'rotation',
          type: 'euler',
          ui: {
            label: 'Rotation',
            description: 'Pitch (X), Yaw (Y), Roll (Z)',
            group: 'Transform',
            step: 0.1,
            precision: 1,
            unit: '°',
          },
          getValue: (node: unknown) => {
            const n = node as Node3D;
            return {
              x: n.rotation.x * (180 / Math.PI),
              y: n.rotation.y * (180 / Math.PI),
              z: n.rotation.z * (180 / Math.PI),
            };
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node3D;
            const v = value as { x: number; y: number; z: number };
            n.rotation.x = v.x * (Math.PI / 180);
            n.rotation.y = v.y * (Math.PI / 180);
            n.rotation.z = v.z * (Math.PI / 180);
          },
        },
        {
          name: 'scale',
          type: 'vector3',
          ui: {
            label: 'Scale',
            group: 'Transform',
            step: 0.01,
            precision: 2,
            min: 0,
          },
          getValue: (node: unknown) => {
            const n = node as Node3D;
            return { x: n.scale.x, y: n.scale.y, z: n.scale.z };
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node3D;
            const v = value as { x: number; y: number; z: number };
            n.scale.x = v.x;
            n.scale.y = v.y;
            n.scale.z = v.z;
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Transform: {
          label: 'Transform',
          description: '3D position, rotation, and scale',
          expanded: true,
        },
      },
    };
  }
}
