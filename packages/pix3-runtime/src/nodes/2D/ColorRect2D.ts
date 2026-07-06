import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';

export interface ColorRect2DProps extends Omit<Node2DProps, 'type'> {
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
}

export class ColorRect2D extends Node2D {
  width: number;
  height: number;
  color: string;

  private mesh: Mesh;
  private geometry: PlaneGeometry;
  private material: MeshBasicMaterial;

  constructor(props: ColorRect2DProps) {
    super(props, 'ColorRect2D');
    this.width = props.width ?? 100;
    this.height = props.height ?? 100;
    this.color = props.color ?? '#ffffff';
    this.opacity = props.opacity ?? 1.0;
    this.isContainer = false;

    this.geometry = new PlaneGeometry(this.width, this.height);
    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.material, 1);

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.add(this.mesh);
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();
    return {
      ...baseSchema,
      nodeType: 'ColorRect2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: { label: 'Width', group: 'Size', min: 0, step: 1 },
          getValue: (node: unknown) => (node as ColorRect2D).width,
          setValue: (node: unknown, value: unknown) => {
            const n = node as ColorRect2D;
            n.width = Number(value);
            n.updateGeometry();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: { label: 'Height', group: 'Size', min: 0, step: 1 },
          getValue: (node: unknown) => (node as ColorRect2D).height,
          setValue: (node: unknown, value: unknown) => {
            const n = node as ColorRect2D;
            n.height = Number(value);
            n.updateGeometry();
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: { label: 'Color', group: 'Style' },
          getValue: (node: unknown) => (node as ColorRect2D).color,
          setValue: (node: unknown, value: unknown) => {
            const n = node as ColorRect2D;
            n.color = String(value);
            n.material.color.set(n.color);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Size: { label: 'Size', expanded: true },
        Style: { label: 'Style', expanded: true },
      },
    };
  }

  private updateGeometry(): void {
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(this.width, this.height);
    this.mesh.geometry = this.geometry;
  }

  protected override disposeResources(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
