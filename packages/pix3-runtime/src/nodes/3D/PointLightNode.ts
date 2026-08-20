import { Color, PointLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

export interface PointLightNodeProps extends Omit<Node3DProps, 'type'> {
  color?: string;
  intensity?: number;
  distance?: number;
  decay?: number;
  castShadow?: boolean;
}

export class PointLightNode extends Node3D {
  readonly light: PointLight;

  constructor(props: PointLightNodeProps) {
    super(props, 'PointLight');
    const color = new Color(props.color ?? '#ffffff');
    const intensity = typeof props.intensity === 'number' ? props.intensity : 1;
    const distance = typeof props.distance === 'number' ? props.distance : 0;
    const decay = typeof props.decay === 'number' ? props.decay : 2;

    this.light = new PointLight(color, intensity, distance, decay);
    this.light.castShadow = props.castShadow ?? true;
    this.add(this.light);
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'PointLight',
      properties: [
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Light' },
          getValue: (n: unknown) => '#' + (n as PointLightNode).light.color.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as PointLightNode).light.color.set(String(v));
          },
        }),
        defineProperty('intensity', 'number', {
          ui: { label: 'Intensity', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as PointLightNode).light.intensity,
          setValue: (n: unknown, v: unknown) => {
            (n as PointLightNode).light.intensity = Number(v);
          },
        }),
        defineProperty('distance', 'number', {
          ui: { label: 'Range', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as PointLightNode).light.distance,
          setValue: (n: unknown, v: unknown) => {
            (n as PointLightNode).light.distance = Number(v);
          },
        }),
        defineProperty('decay', 'number', {
          ui: { label: 'Decay', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as PointLightNode).light.decay,
          setValue: (n: unknown, v: unknown) => {
            (n as PointLightNode).light.decay = Number(v);
          },
        }),
        defineProperty('castShadow', 'boolean', {
          ui: { label: 'Cast Shadow', group: 'Light' },
          getValue: (n: unknown) => (n as PointLightNode).light.castShadow,
          setValue: (n: unknown, v: unknown) => {
            (n as PointLightNode).light.castShadow = Boolean(v);
          },
        }),
      ],
      groups: { Light: { label: 'Light', expanded: true } },
    };

    return mergeSchemas(base, props);
  }
}
