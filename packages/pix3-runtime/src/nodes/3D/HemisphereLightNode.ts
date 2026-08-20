import { Color, HemisphereLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

export interface HemisphereLightNodeProps extends Omit<Node3DProps, 'type'> {
  skyColor?: string;
  groundColor?: string;
  intensity?: number;
}

export class HemisphereLightNode extends Node3D {
  readonly light: HemisphereLight;

  constructor(props: HemisphereLightNodeProps) {
    super(props, 'HemisphereLight');
    const skyColor = new Color(props.skyColor ?? '#ffffff');
    const groundColor = new Color(props.groundColor ?? '#444444');
    const intensity = typeof props.intensity === 'number' ? props.intensity : 0.5;
    this.light = new HemisphereLight(skyColor, groundColor, intensity);
    this.add(this.light);
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'HemisphereLight',
      properties: [
        defineProperty('skyColor', 'color', {
          ui: { label: 'Sky Color', group: 'Light' },
          getValue: (n: unknown) => '#' + (n as HemisphereLightNode).light.color.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as HemisphereLightNode).light.color.set(String(v));
          },
        }),
        defineProperty('groundColor', 'color', {
          ui: { label: 'Ground Color', group: 'Light' },
          getValue: (n: unknown) =>
            '#' + (n as HemisphereLightNode).light.groundColor.getHexString(),
          setValue: (n: unknown, v: unknown) => {
            (n as HemisphereLightNode).light.groundColor.set(String(v));
          },
        }),
        defineProperty('intensity', 'number', {
          ui: { label: 'Intensity', group: 'Light', step: 0.1, precision: 2 },
          getValue: (n: unknown) => (n as HemisphereLightNode).light.intensity,
          setValue: (n: unknown, v: unknown) => {
            (n as HemisphereLightNode).light.intensity = Number(v);
          },
        }),
      ],
      groups: { Light: { label: 'Light', expanded: true } },
    };

    return mergeSchemas(base, props);
  }
}
