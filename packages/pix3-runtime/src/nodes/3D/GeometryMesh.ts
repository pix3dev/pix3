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
  Float32BufferAttribute,
  Material,
  type Texture,
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
  material?: {
    color?: string;
    roughness?: number;
    metalness?: number;
    /** res:// path of a baked ambient-occlusion map (see the AO baker). */
    aoMap?: string;
    /** 0..1 strength of the AO map (default 1). */
    aoMapIntensity?: number;
  };
}

export class GeometryMesh extends Node3D {
  private _geometry?: BufferGeometry;
  private _material?: Material;
  /** Authored geometry kind / size, kept so serialization survives round-trips
   * (the three.js BufferGeometry doesn't carry the authored primitive name). */
  private _geometryKind: GeometryKind;
  private _size: [number, number, number];
  /** res:// path of the baked AO map, kept for serialization (the runtime
   * Texture is loaded async by the loader / assigned by the AO baker). */
  private _aoMapSrc: string;
  /** Authored AO-map strength. Kept separate from the live
   * `material.aoMapIntensity` so runtime suppression (when realtime SSAO wins
   * the AO-mode cascade) can zero the effect without losing the authored value
   * on save. */
  private _aoMapIntensity = 1;
  /** When true, the baked AO map is suppressed at render time (SSAO is driving
   * AO instead). Runtime-only — never serialized. */
  private _aoSuppressed = false;

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
    this._aoMapIntensity =
      typeof mat.aoMapIntensity === 'number' ? clamp01Number(mat.aoMapIntensity) : 1;
    material.aoMapIntensity = this._aoMapIntensity;

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${this.name}-Mesh`;
    this.add(mesh);

    this._geometry = geometry;
    this._material = material;
    this._aoMapSrc = typeof mat.aoMap === 'string' ? mat.aoMap : '';
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
    // The lightmap UV set lives on the geometry, so a rebuilt shape needs it
    // regenerated when an AO map is in use.
    if (this._stdMaterial?.aoMap) {
      GeometryMesh.applyLightmapUV(this._geometryKind, next);
    }
    try {
      old?.dispose();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  /**
   * Ensure the dedicated lightmap UV set (`uv1`) exists on the current geometry.
   * The AO baker calls this before baking — the UV must exist before the texture
   * does. Idempotent.
   */
  ensureLightmapUV(): void {
    GeometryMesh.applyLightmapUV(this._geometryKind, this._geometry);
  }

  /** The child render mesh (exposed for the AO baker to read geometry/matrix). */
  get renderMesh(): Mesh | undefined {
    return this._mesh;
  }

  /**
   * Assign (or clear) the baked ambient-occlusion map. The AO map samples the
   * dedicated lightmap UV set (channel 1 / `uv1`), which is generated lazily so
   * a mesh with no AO pays no extra attribute cost.
   */
  setAOMap(texture: Texture | null): void {
    const mat = this._stdMaterial;
    if (!mat) {
      return;
    }
    if (texture) {
      texture.channel = 1;
      texture.flipY = false;
      GeometryMesh.applyLightmapUV(this._geometryKind, this._geometry);
    }
    mat.aoMap = texture;
    mat.needsUpdate = true;
  }

  /** Authored strength of the AO map (0..1). Unaffected by runtime suppression. */
  get aoMapIntensity(): number {
    return this._aoMapIntensity;
  }
  set aoMapIntensity(value: number) {
    this._aoMapIntensity = clamp01Number(value);
    const mat = this._stdMaterial;
    if (mat && !this._aoSuppressed) {
      mat.aoMapIntensity = this._aoMapIntensity;
    }
  }

  /**
   * Runtime-only: suppress (or restore) the baked AO map's contribution without
   * touching the authored intensity. Used by the AO-mode cascade so a scene set
   * to realtime SSAO doesn't double up with its baked maps.
   */
  setAOSuppressed(suppressed: boolean): void {
    this._aoSuppressed = suppressed;
    const mat = this._stdMaterial;
    if (mat) {
      mat.aoMapIntensity = suppressed ? 0 : this._aoMapIntensity;
    }
  }

  /** res:// path of the baked AO map, or '' when none. Set by the AO baker. */
  get aoMapSrc(): string {
    return this._aoMapSrc;
  }
  set aoMapSrc(value: string) {
    this._aoMapSrc = typeof value === 'string' ? value : '';
  }

  /**
   * Generate a deterministic, non-overlapping lightmap UV set (`uv1`) for a
   * primitive. A box needs a real 6-face atlas (its base `uv` overlaps faces);
   * the other primitives already have a unique [0,1] layout, so their base `uv`
   * is copied. Idempotent and cheap.
   */
  private static applyLightmapUV(kind: GeometryKind, geometry?: BufferGeometry): void {
    if (!geometry) {
      return;
    }
    const uv = geometry.getAttribute('uv');
    if (!uv) {
      return;
    }

    if (kind === 'box') {
      // BoxGeometry: 24 verts, 4 per face, faces in constructor order; each
      // face's base uv spans [0,1]. Pack the 6 faces into a 3x2 atlas with a
      // small inset so filtering doesn't bleed between cells.
      const cols = 3;
      const rows = 2;
      const cw = 1 / cols;
      const ch = 1 / rows;
      const inset = 0.04;
      const out = new Float32Array(uv.count * 2);
      for (let i = 0; i < uv.count; i += 1) {
        const face = Math.floor(i / 4) % 6;
        const col = face % cols;
        const row = Math.floor(face / cols);
        const u = uv.getX(i);
        const v = uv.getY(i);
        out[i * 2] = (col + inset + u * (1 - 2 * inset)) * cw;
        out[i * 2 + 1] = (row + inset + v * (1 - 2 * inset)) * ch;
      }
      geometry.setAttribute('uv1', new Float32BufferAttribute(out, 2));
      return;
    }

    // Other primitives: reuse the base UV as the lightmap UV.
    geometry.setAttribute('uv1', new Float32BufferAttribute(uv.array.slice(0), uv.itemSize));
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
    if (this._aoMapSrc) {
      material.aoMap = this._aoMapSrc;
      material.aoMapIntensity = this._aoMapIntensity;
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
        defineProperty('aoMapIntensity', 'number', {
          ui: {
            label: 'AO Intensity',
            description: 'Strength of the baked ambient-occlusion map (0 = off)',
            group: 'Material',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as GeometryMesh)._stdMaterial?.aoMap,
          },
          getValue: (n: unknown) => (n as GeometryMesh).aoMapIntensity,
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).aoMapIntensity = Number(v);
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

function clamp01Number(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 1;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
