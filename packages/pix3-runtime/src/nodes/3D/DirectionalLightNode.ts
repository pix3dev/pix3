import { Color, DirectionalLight, Vector3, Quaternion } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

const TARGET_DISTANCE = 5;

export interface DirectionalLightNodeProps extends Omit<Node3DProps, 'type'> {
  color?: string;
  intensity?: number;
  castShadow?: boolean;
  /** Half-size of the orthographic shadow camera frustum (left/right/top/bottom = ±shadowCameraSize). Default: 20. */
  shadowCameraSize?: number;
  /** Shadow map resolution in pixels (width and height). Default: 2048. */
  shadowMapSize?: number;
}

export class DirectionalLightNode extends Node3D {
  readonly light: DirectionalLight;

  constructor(props: DirectionalLightNodeProps) {
    super(props, 'DirectionalLight');
    const color = new Color(props.color ?? '#ffffff');
    const intensity = typeof props.intensity === 'number' ? props.intensity : 1;
    this.light = new DirectionalLight(color, intensity);
    this.light.castShadow = props.castShadow ?? true;
    this.light.position.set(0, 0, 0);

    const shadowSize = typeof props.shadowCameraSize === 'number' ? props.shadowCameraSize : 20;
    this.light.shadow.camera.left = -shadowSize;
    this.light.shadow.camera.right = shadowSize;
    this.light.shadow.camera.top = shadowSize;
    this.light.shadow.camera.bottom = -shadowSize;
    this.light.shadow.camera.near = 0.1;
    this.light.shadow.camera.far = 500;
    this.light.shadow.camera.updateProjectionMatrix();

    const mapRes = typeof props.shadowMapSize === 'number' ? props.shadowMapSize : 2048;
    this.light.shadow.mapSize.set(mapRes, mapRes);

    this.add(this.light);
    this.add(this.light.target);

    // Initialize target in local space (-Z direction) without calling lookAt(),
    // which would normalize the Euler angles set by super(props) and corrupt saved rotations.
    this.light.target.position.set(0, 0, -TARGET_DISTANCE);
    this.light.target.updateMatrixWorld(true);
  }

  getTargetPosition(): Vector3 {
    this.light.target.updateMatrixWorld(true);
    return this.light.target.getWorldPosition(new Vector3());
  }

  setTargetPosition(targetPos: Vector3): void {
    const worldPosition = this.getWorldPosition(new Vector3());
    const rawDirection = targetPos.clone().sub(worldPosition);
    const direction =
      rawDirection.lengthSq() > 1e-8
        ? rawDirection.normalize()
        : new Vector3(0, 0, 1).applyQuaternion(this.getWorldQuaternion(new Quaternion()));
    const constrainedTarget = worldPosition.add(direction.multiplyScalar(TARGET_DISTANCE));

    this.lookAt(constrainedTarget);

    const localTarget = constrainedTarget.clone();
    this.worldToLocal(localTarget);
    this.light.target.position.copy(localTarget);
    this.light.target.updateMatrixWorld(true);
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'DirectionalLight',
      properties: [
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Light' },
          getValue: (n: unknown) => '#' + (n as DirectionalLightNode).light.color.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as DirectionalLightNode).light.color.set(String(v));
          },
        }),
        defineProperty('intensity', 'number', {
          ui: { label: 'Intensity', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as DirectionalLightNode).light.intensity,
          setValue: (n: unknown, v: unknown) => {
            (n as DirectionalLightNode).light.intensity = Number(v);
          },
        }),
        defineProperty('castShadow', 'boolean', {
          ui: { label: 'Cast Shadow', group: 'Light' },
          getValue: (n: unknown) => (n as DirectionalLightNode).light.castShadow,
          setValue: (n: unknown, v: unknown) => {
            (n as DirectionalLightNode).light.castShadow = Boolean(v);
          },
        }),
        defineProperty('shadowCameraSize', 'number', {
          ui: {
            label: 'Shadow Area',
            group: 'Shadow',
            step: 1,
            precision: 0,
            description: 'Half-size of the shadow frustum (±units from center)',
          },
          getValue: (n: unknown) => (n as DirectionalLightNode).light.shadow.camera.right,
          setValue: (n: unknown, v: unknown) => {
            const node = n as DirectionalLightNode;
            const size = Math.max(0.1, Number(v));
            node.light.shadow.camera.left = -size;
            node.light.shadow.camera.right = size;
            node.light.shadow.camera.top = size;
            node.light.shadow.camera.bottom = -size;
            node.light.shadow.camera.updateProjectionMatrix();
          },
        }),
        defineProperty('shadowMapSize', 'number', {
          ui: {
            label: 'Shadow Map Res',
            group: 'Shadow',
            step: 256,
            precision: 0,
            description: 'Shadow map resolution (pixels)',
          },
          getValue: (n: unknown) => (n as DirectionalLightNode).light.shadow.mapSize.width,
          setValue: (n: unknown, v: unknown) => {
            const node = n as DirectionalLightNode;
            const res = Math.max(64, Number(v));
            node.light.shadow.mapSize.set(res, res);
          },
        }),
      ],
      groups: {
        Light: { label: 'Light', expanded: true },
        Shadow: { label: 'Shadow', expanded: false },
      },
    };

    return mergeSchemas(base, props);
  }
}
