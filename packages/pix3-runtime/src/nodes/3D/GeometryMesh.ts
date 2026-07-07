import {
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  CylinderGeometry,
  ConeGeometry,
  TorusGeometry,
  Mesh,
  MeshStandardMaterial,
  Color,
  BufferGeometry,
  Material,
} from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

/** Supported primitive kinds. `size` is interpreted per-shape (see buildGeometry). */
export const GEOMETRY_KINDS = ['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus'] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

export interface GeometryMeshProps extends Omit<Node3DProps, 'type'> {
  geometry?: string;
  size?: [number, number, number];
  material?: { color?: string; roughness?: number; metalness?: number };
}

export class GeometryMesh extends Node3D {
  private _geometry?: BufferGeometry;
  private _material?: Material;
  /** Authored geometry kind / size, kept so serialization survives round-trips
   * (the three.js BufferGeometry doesn't carry the authored primitive name). */
  private _geometryKind: GeometryKind;
  private _size: [number, number, number];

  constructor(props: GeometryMeshProps) {
    super(props, 'GeometryMesh');

    const geometryKind = normalizeGeometryKind(props.geometry);
    const size = props.size ?? [1, 1, 1];
    this._geometryKind = geometryKind;
    this._size = [size[0], size[1], size[2]];

    const geometry = GeometryMesh.buildGeometry(geometryKind, this._size);

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

  /**
   * Build a primitive geometry from a kind + `size`. `size` is a single
   * `[x, y, z]` vector interpreted per-shape so one editable field works for
   * every primitive:
   * - box: full extents (x, y, z)
   * - sphere: diameter = x
   * - plane: a horizontal floor of x by z (rotated into the XZ plane)
   * - cylinder / cone: diameter = x, height = y
   * - torus: outer diameter = x, tube thickness scales with y
   */
  private static buildGeometry(kind: GeometryKind, size: [number, number, number]): BufferGeometry {
    const x = Math.max(0.0001, size[0]);
    const y = Math.max(0.0001, size[1]);
    const z = Math.max(0.0001, size[2]);
    switch (kind) {
      case 'sphere':
        return new SphereGeometry(x / 2, 32, 16);
      case 'plane': {
        const plane = new PlaneGeometry(x, z);
        plane.rotateX(-Math.PI / 2); // lie flat as a floor
        return plane;
      }
      case 'cylinder':
        return new CylinderGeometry(x / 2, x / 2, y, 32);
      case 'cone':
        return new ConeGeometry(x / 2, y, 32);
      case 'torus': {
        const radius = x / 2;
        const tube = Math.max(0.02, Math.min(radius * 0.6, y * 0.25));
        return new TorusGeometry(radius, tube, 20, 40);
      }
      case 'box':
      default:
        return new BoxGeometry(x, y, z);
    }
  }

  /** Swap the child mesh's geometry to match the current kind + size. */
  private rebuildGeometry(): void {
    const next = GeometryMesh.buildGeometry(this._geometryKind, this._size);
    const old = this._geometry;
    const mesh = this._mesh;
    if (mesh) {
      mesh.geometry = next;
    }
    this._geometry = next;
    try {
      old?.dispose();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  get geometryKind(): GeometryKind {
    return this._geometryKind;
  }
  set geometryKind(value: string) {
    const next = normalizeGeometryKind(value);
    if (next !== this._geometryKind) {
      this._geometryKind = next;
      this.rebuildGeometry();
    }
  }

  /** Current `[x, y, z]` size vector (see {@link buildGeometry} for per-shape meaning). */
  get size(): [number, number, number] {
    return [this._size[0], this._size[1], this._size[2]];
  }
  set size(value: [number, number, number]) {
    this._size = [
      Number.isFinite(value[0]) ? value[0] : this._size[0],
      Number.isFinite(value[1]) ? value[1] : this._size[1],
      Number.isFinite(value[2]) ? value[2] : this._size[2],
    ];
    this.rebuildGeometry();
  }

  /**
   * Authored configuration as a plain object for scene serialization. Reads the
   * LIVE material so inspector edits (which mutate the three.js material in
   * place, not `node.properties`) survive save and the play-mode serialize→parse
   * clone. Keys match the loader's expected property names one-to-one; the
   * transform is serialized separately by the generic Node3D path.
   */
  serializeConfig(): Record<string, unknown> {
    const mat = this._stdMaterial;
    const material: Record<string, unknown> = { type: 'standard' };
    if (mat) {
      material.color = '#' + mat.color.clone().convertLinearToSRGB().getHexString();
      material.roughness = mat.roughness;
      material.metalness = mat.metalness;
    }
    return {
      geometry: this._geometryKind,
      size: [this._size[0], this._size[1], this._size[2]],
      material,
    };
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
        defineProperty('geometry', 'enum', {
          ui: { label: 'Shape', group: 'Geometry', options: [...GEOMETRY_KINDS] },
          getValue: (n: unknown) => (n as GeometryMesh).geometryKind,
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).geometryKind = String(v);
          },
        }),
        defineProperty('size', 'vector3', {
          ui: {
            label: 'Size',
            description: 'Interpreted per shape (box: extents, sphere: diameter, etc.)',
            group: 'Geometry',
            min: 0,
            step: 0.01,
            precision: 2,
          },
          getValue: (n: unknown) => {
            const s = (n as GeometryMesh)._size;
            return { x: s[0], y: s[1], z: s[2] };
          },
          setValue: (n: unknown, v: unknown) => {
            const vec = v as { x?: unknown; y?: unknown; z?: unknown };
            (n as GeometryMesh).size = [Number(vec?.x), Number(vec?.y), Number(vec?.z)];
          },
        }),
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
      groups: {
        Geometry: { label: 'Geometry', expanded: true },
        Material: { label: 'Material', expanded: true },
      },
    };

    return mergeSchemas(base, props);
  }
}

function normalizeGeometryKind(value: unknown): GeometryKind {
  const kind = typeof value === 'string' ? value.toLowerCase() : '';
  return (GEOMETRY_KINDS as readonly string[]).includes(kind) ? (kind as GeometryKind) : 'box';
}
