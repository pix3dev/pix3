import { Mesh, MeshBasicMaterial } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import { SHARED_UNIT_QUAD_GEOMETRY } from '../../core/shared-quad-geometry';
import { BATCHABLE_2D_KEY } from '../../core/batch-2d';

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
  private material: MeshBasicMaterial;

  constructor(props: ColorRect2DProps) {
    super(props, 'ColorRect2D');
    this.width = props.width ?? 100;
    this.height = props.height ?? 100;
    this.color = props.color ?? '#ffffff';
    this.opacity = props.opacity ?? 1.0;
    this.isContainer = false;

    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.material, 1);

    // Size is mesh.scale over the shared unit quad (see SHARED_UNIT_QUAD_GEOMETRY).
    this.mesh = new Mesh(SHARED_UNIT_QUAD_GEOMETRY, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.mesh.scale.set(this.width, this.height, 1);
    this.mesh.userData[BATCHABLE_2D_KEY] = true;
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
            n.updateSize();
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
            n.updateSize();
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

  private updateSize(): void {
    // Size is mesh.scale over the shared unit quad — no geometry churn on resize.
    this.mesh.scale.set(this.width, this.height, 1);
  }

  protected override disposeResources(): void {
    // Dispose only the material — the geometry is the shared unit quad.
    this.material.dispose();
  }
}
