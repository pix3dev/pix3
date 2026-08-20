import { Color, AmbientLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

export interface AmbientLightNodeProps extends Omit<Node3DProps, 'type'> {
  color?: string;
  intensity?: number;
}

export class AmbientLightNode extends Node3D {
  readonly light: AmbientLight;

  constructor(props: AmbientLightNodeProps) {
    super(props, 'AmbientLight');
    const color = new Color(props.color ?? '#ffffff');
    const intensity = typeof props.intensity === 'number' ? props.intensity : 0.5;
    this.light = new AmbientLight(color, intensity);
    this.add(this.light);
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'AmbientLight',
      properties: [
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Light' },
          getValue: (n: unknown) => '#' + (n as AmbientLightNode).light.color.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as AmbientLightNode).light.color.set(String(v));
          },
        }),
        defineProperty('intensity', 'number', {
          ui: { label: 'Intensity', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as AmbientLightNode).light.intensity,
          setValue: (n: unknown, v: unknown) => {
            (n as AmbientLightNode).light.intensity = Number(v);
          },
        }),
      ],
      groups: { Light: { label: 'Light', expanded: true } },
    };

    return mergeSchemas(base, props);
  }
}
