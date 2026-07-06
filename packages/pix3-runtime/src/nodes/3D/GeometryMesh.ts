import { BoxGeometry, Mesh, MeshStandardMaterial, Color, BufferGeometry, Material } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

export interface GeometryMeshProps extends Omit<Node3DProps, 'type'> {
  geometry?: string;
  size?: [number, number, number];
  material?: { color?: string; roughness?: number; metalness?: number };
}

export class GeometryMesh extends Node3D {
  private _geometry?: BufferGeometry;
  private _material?: Material;

  constructor(props: GeometryMeshProps) {
    super(props, 'GeometryMesh');

    const geometryKind = (props.geometry ?? 'box').toLowerCase();
    const size = props.size ?? [1, 1, 1];

    let geometry: BufferGeometry;
    switch (geometryKind) {
      case 'box':
      default:
        geometry = new BoxGeometry(size[0], size[1], size[2]);
        break;
    }

    const mat = props.material ?? {};
    const color = new Color(mat.color ?? '#4e8df5').convertSRGBToLinear();
    const roughness = typeof mat.roughness === 'number' ? mat.roughness : 0.35;
    const metalness = typeof mat.metalness === 'number' ? mat.metalness : 0.25;

    const material = new MeshStandardMaterial({ color, roughness, metalness });

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${this.name}-Mesh`;
    this.add(mesh);

    this._geometry = geometry;
    this._material = material;
  }

  protected override disposeResources(): void {
    try {
      this._geometry?.dispose();
      // eslint-disable-next-line no-empty
    } catch {}
    try {
      (this._material as unknown as { dispose?: () => void })?.dispose?.();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  private get _mesh(): Mesh | undefined {
    return (this.children as unknown as Mesh[]).find((c) => c instanceof Mesh);
  }

  private get _stdMaterial(): MeshStandardMaterial | undefined {
    const mat = this._mesh?.material;
    return mat instanceof MeshStandardMaterial ? mat : undefined;
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'GeometryMesh',
      properties: [
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Material' },
          getValue: (n: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            return mat ? '#' + mat.color.clone().convertLinearToSRGB().getHexString() : '#4e8df5';
          },
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            if (mat) mat.color.set(String(v)).convertSRGBToLinear();
          },
        }),
        defineProperty('roughness', 'number', {
          ui: { label: 'Roughness', group: 'Material', step: 0.01, precision: 2, min: 0, max: 1 },
          getValue: (n: unknown) => (n as GeometryMesh)._stdMaterial?.roughness ?? 0.35,
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            if (mat) mat.roughness = Number(v);
          },
        }),
        defineProperty('metalness', 'number', {
          ui: { label: 'Metalness', group: 'Material', step: 0.01, precision: 2, min: 0, max: 1 },
          getValue: (n: unknown) => (n as GeometryMesh)._stdMaterial?.metalness ?? 0.25,
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            if (mat) mat.metalness = Number(v);
          },
        }),
      ],
      groups: { Material: { label: 'Material', expanded: true } },
    };

    return mergeSchemas(base, props);
  }
}
