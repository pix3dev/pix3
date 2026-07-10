import { Color, Quaternion, SpotLight, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

const TARGET_DISTANCE = 5;

export interface SpotLightNodeProps extends Omit<Node3DProps, 'type'> {
  color?: string;
  intensity?: number;
  distance?: number;
  angle?: number;
  penumbra?: number;
  decay?: number;
  castShadow?: boolean;
}

export class SpotLightNode extends Node3D {
  readonly light: SpotLight;

  constructor(props: SpotLightNodeProps) {
    super(props, 'SpotLight');
    const color = new Color(props.color ?? '#ffffff').convertSRGBToLinear();
    const intensity = typeof props.intensity === 'number' ? props.intensity : 1;
    const distance = typeof props.distance === 'number' ? props.distance : 0;
    const angle = typeof props.angle === 'number' ? props.angle : Math.PI / 3;
    const penumbra = typeof props.penumbra === 'number' ? props.penumbra : 0;
    const decay = typeof props.decay === 'number' ? props.decay : 2;

    this.light = new SpotLight(color, intensity, distance, angle, penumbra, decay);
    this.light.castShadow = props.castShadow ?? true;
    this.add(this.light);
    this.add(this.light.target);

    // Initialize the aim target in local space (-Z) without lookAt(), which would
    // normalize the Euler angles set by super(props) and corrupt saved rotations.
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
      nodeType: 'SpotLight',
      properties: [
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Light' },
          getValue: (n: unknown) => '#' + (n as SpotLightNode).light.color.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.color.set(String(v)).convertSRGBToLinear();
          },
        }),
        defineProperty('intensity', 'number', {
          ui: { label: 'Intensity', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as SpotLightNode).light.intensity,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.intensity = Number(v);
          },
        }),
        defineProperty('distance', 'number', {
          ui: { label: 'Range', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as SpotLightNode).light.distance,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.distance = Number(v);
          },
        }),
        defineProperty('angle', 'number', {
          ui: { label: 'Angle', group: 'Light', unit: '°', step: 0.1, precision: 1 },
          getValue: (n: unknown) => ((n as SpotLightNode).light.angle * 180) / Math.PI,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.angle = (Number(v) * Math.PI) / 180;
          },
        }),
        defineProperty('penumbra', 'number', {
          ui: { label: 'Penumbra', group: 'Light', step: 0.01, precision: 2 },
          getValue: (n: unknown) => (n as SpotLightNode).light.penumbra,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.penumbra = Number(v);
          },
        }),
        defineProperty('decay', 'number', {
          ui: { label: 'Decay', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as SpotLightNode).light.decay,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.decay = Number(v);
          },
        }),
        defineProperty('castShadow', 'boolean', {
          ui: { label: 'Cast Shadow', group: 'Light' },
          getValue: (n: unknown) => (n as SpotLightNode).light.castShadow,
          setValue: (n: unknown, v: unknown) => {
            (n as SpotLightNode).light.castShadow = Boolean(v);
          },
        }),
      ],
      groups: { Light: { label: 'Light', expanded: true } },
    };

    return mergeSchemas(base, props);
  }
}
