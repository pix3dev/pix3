import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';

import { Node3D, type Node3DProps } from '../Node3D';
import {
  asMaterialType,
  buildFamilyMaterial,
  GEOMETRY_MATERIAL_TYPES,
  materialFamilyOf,
  type GeometryMaterialType,
} from './material-family';
import type { PropertySchema } from '../../fw/property-schema';

const DEFAULT_GEOMETRY = new BoxGeometry(1, 1, 1);
/**
 * What an instanced mesh looks like when the scene authors no material at all.
 *
 * These are three's OWN `MeshStandardMaterial` defaults, not `GeometryMesh`'s (0.35 / 0.25): every
 * instanced mesh that predates the authored-material block rendered with a plain
 * `new MeshStandardMaterial({ color: '#ffffff' })`, and reading it back with different numbers
 * would restyle those scenes on load and then bake the new look in on the first save.
 */
const DEFAULT_MATERIAL_COLOR = '#ffffff';
const DEFAULT_ROUGHNESS = 1;
const DEFAULT_METALNESS = 0;
/** What a material outside the three known families reports as; `standard` is the node default. */
const UNKNOWN_FAMILY_REPORTS_AS: GeometryMaterialType = 'standard';
/** First slot of a one-or-many material, for the checks that only need a representative. */
const firstOf = (material: Material | Material[]): Material | undefined =>
  Array.isArray(material) ? material[0] : material;
const TRANSLATION_SCRATCH = new Vector3();
const ROTATION_SCRATCH = new Quaternion();
const SCALE_SCRATCH = new Vector3(1, 1, 1);
const MATRIX_SCRATCH = new Matrix4();
const COLOR_SCRATCH = new Color();

/**
 * The authored material, as it appears under `material:` in a `.pix3scene`.
 *
 * The same vocabulary `GeometryMesh` uses, minus the texture maps and shader effects — an
 * instanced mesh shares one material across every instance, so per-instance texturing is not a
 * thing this node can express, and the per-instance colour buffer covers the variation people
 * actually want. Maps can be added later without changing this shape.
 */
export interface InstancedMaterialConfig {
  /** Material family (see `GEOMETRY_MATERIAL_TYPES`). Defaults to `standard`. */
  type?: string;
  color?: string;
  /** `standard` only. */
  roughness?: number;
  /** `standard` only. */
  metalness?: number;
}

export interface InstancedMesh3DProps extends Omit<Node3DProps, 'type'> {
  maxInstances: number;
  geometry?: BufferGeometry;
  /**
   * A ready three.js material, for code that builds its own. Takes precedence over
   * {@link InstancedMesh3DProps.materialConfig} — a caller holding a real material means it.
   */
  material?: Material | Material[];
  /**
   * The authored material. This is the scene-file path: before it existed the loader built no
   * material at all, so every scene-authored instanced mesh silently rendered as shared white PBR,
   * unreachable from the inspector and untouched by the project's mobile material policy.
   */
  materialConfig?: InstancedMaterialConfig;
  castShadow?: boolean;
  receiveShadow?: boolean;
  enablePerInstanceColor?: boolean;
  frustumCulled?: boolean;
}

export interface InstanceTransformArrayView {
  readonly count: number;
  readonly positions?: Float32Array;
  readonly rotations?: Float32Array;
  readonly scales?: Float32Array;
}

export interface InstanceColorArrayView {
  readonly count: number;
  readonly colors: Float32Array;
}

export interface InstanceMatrixArrayView {
  readonly count: number;
  readonly matrices: Float32Array;
}

export interface InstancedWriteOptions {
  markTransformDirty?: boolean;
  markColorDirty?: boolean;
  computeBoundingSphere?: boolean;
  visibleCount?: number;
}

export interface InstancedMeshRaycastHit {
  node: InstancedMesh3D;
  object: InstancedMesh;
  instanceId: number;
  distance: number;
  point: Vector3;
}

export class InstancedMesh3D extends Node3D {
  readonly mesh: InstancedMesh;
  readonly maxInstances: number;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly enablePerInstanceColor: boolean;

  private readonly matrixBuffer: Float32Array;
  private readonly colorBuffer: Float32Array | null;
  /** Authored material family; decides what is built and what round-trips. */
  private _materialType: GeometryMaterialType;
  /** True while the mesh renders a material this node built and therefore owns. */
  private _ownsMaterial: boolean;
  private transformsDirty = false;
  private colorsDirty = false;
  private boundsDirty = false;

  constructor(props: InstancedMesh3DProps) {
    super(props, 'InstancedMesh3D');

    const maxInstances = Math.floor(props.maxInstances);
    if (!Number.isFinite(maxInstances) || maxInstances <= 0) {
      throw new Error('[InstancedMesh3D] maxInstances must be a positive integer.');
    }

    this.maxInstances = maxInstances;
    this.castShadow = props.castShadow ?? false;
    this.receiveShadow = props.receiveShadow ?? false;
    this.enablePerInstanceColor = props.enablePerInstanceColor ?? false;

    const geometry = props.geometry ?? DEFAULT_GEOMETRY;
    const config = props.materialConfig ?? {};
    this._ownsMaterial = props.material === undefined;
    const material =
      props.material ??
      buildFamilyMaterial(asMaterialType(config.type), {
        color: new Color(config.color ?? DEFAULT_MATERIAL_COLOR),
        roughness: typeof config.roughness === 'number' ? config.roughness : DEFAULT_ROUGHNESS,
        metalness: typeof config.metalness === 'number' ? config.metalness : DEFAULT_METALNESS,
      });
    // A material handed in by code decides the family that is REPORTED and SERIALIZED: keeping the
    // authored `type` here would make the node claim a family it is not rendering.
    this._materialType =
      (props.material ? materialFamilyOf(firstOf(props.material)) : null) ??
      asMaterialType(config.type);
    this.mesh = new InstancedMesh(geometry, material, maxInstances);
    this.mesh.name = `${this.name}-mesh`;
    this.mesh.castShadow = this.castShadow;
    this.mesh.receiveShadow = this.receiveShadow;
    this.mesh.frustumCulled = props.frustumCulled ?? false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.matrixBuffer = this.mesh.instanceMatrix.array as Float32Array;

    if (this.enablePerInstanceColor) {
      this.colorBuffer = new Float32Array(maxInstances * 3);
      this.mesh.instanceColor = new InstancedBufferAttribute(this.colorBuffer, 3);
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
      COLOR_SCRATCH.toArray(this.colorBuffer, 0);
    } else {
      this.colorBuffer = null;
    }

    this.add(this.mesh);
  }

  protected override disposeResources(): void {
    // Frees the instanceMatrix / instanceColor GPU buffers.
    this.mesh.dispose();
    // Only dispose owned geometry — `DEFAULT_GEOMETRY` is shared across every InstancedMesh3D and
    // must not be disposed. (Does not call super.disposeResources(), whose generic pass would hit
    // it.) The material is always this node's own: either one built here from the authored config,
    // or one handed in by the caller, which the node has taken over for its lifetime.
    if (this.mesh.geometry !== DEFAULT_GEOMETRY) {
      this.mesh.geometry.dispose();
    }
    const material = this.mesh.material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      entry?.dispose();
    }
  }

  /** Every material slot the mesh renders with (one, unless the geometry has groups). */
  private get materialSlots(): Material[] {
    const material = this.mesh.material;
    return Array.isArray(material) ? material.filter(Boolean) : material ? [material] : [];
  }

  /** The slot the single-value accessors read; `null` when the mesh has no material at all. */
  private get singleMaterial(): Material | null {
    return this.materialSlots[0] ?? null;
  }

  /** The authored material family. */
  get materialType(): GeometryMaterialType {
    return this._materialType;
  }

  /**
   * Swap the material family in place, carrying the colour over.
   *
   * A caller-supplied material is replaced too: asking for a family is asking for that family, and
   * silently keeping the old material would be the same class of quiet no-op this whole change is
   * about. Roughness/metalness only exist on `standard`, so they come back at their defaults.
   */
  set materialType(value: GeometryMaterialType) {
    const next = asMaterialType(value);
    if (next === this._materialType && this._ownsMaterial) {
      return;
    }
    // Rebuilt slot by slot: a multi-material mesh (geometry groups) collapsed to one slot here
    // would stop drawing most of itself, and the dropped materials would leak.
    const previous = this.materialSlots;
    const rebuilt = previous.map(slot =>
      buildFamilyMaterial(next, {
        color: this.colorOf(slot)?.clone() ?? new Color(DEFAULT_MATERIAL_COLOR),
        ...this.pbrOf(slot),
      })
    );
    this._materialType = next;
    this.mesh.material = Array.isArray(this.mesh.material)
      ? rebuilt
      : (rebuilt[0] ??
        buildFamilyMaterial(next, {
          color: new Color(DEFAULT_MATERIAL_COLOR),
          roughness: DEFAULT_ROUGHNESS,
          metalness: DEFAULT_METALNESS,
        }));
    this._ownsMaterial = true;
    // Dispose only after the replacement is in place, so a throw above cannot leave the mesh
    // rendering a freed material.
    for (const slot of previous) {
      slot.dispose();
    }
  }

  /** Material colour as an authored `#rrggbb` — the same convention every other node serializes. */
  get color(): string {
    const color = this.colorOf(this.singleMaterial);
    return color ? `#${color.getHexString()}` : DEFAULT_MATERIAL_COLOR;
  }

  set color(value: string) {
    // Every slot, not just the first: the getter reports one colour, so leaving the others behind
    // would make the node describe itself wrongly. `Color.set` converts the authored sRGB hex into
    // the working space on its own (`ColorManagement` is three's default) — never convert here too.
    for (const slot of this.materialSlots) {
      this.colorOf(slot)?.set(value);
    }
  }

  /**
   * The authored material, in the shape a `.pix3scene` carries it — or `null` when this node's
   * material is not expressible in it.
   *
   * A multi-slot mesh is exactly that case: the block describes ONE material, so writing it would
   * quietly discard every slot but the first on the next load. Such a mesh is built by code, which
   * rebuilds it on load anyway, so the honest serialization is no block at all — which is also what
   * the file carried before this block existed.
   */
  serializeMaterialConfig(): InstancedMaterialConfig | null {
    if (Array.isArray(this.mesh.material) || !this.singleMaterial) {
      return null;
    }
    const config: InstancedMaterialConfig = { type: this._materialType, color: this.color };
    // Only `standard` has these, and writing them for the other families would resurrect PBR
    // values on a round-trip through a mesh that has no use for them.
    if (this._materialType === 'standard') {
      Object.assign(config, this.pbrOf(this.singleMaterial));
    }
    return config;
  }

  /** A material's `color`, when it has one (every family here does; a custom one may not). */
  private colorOf(material: Material | null): Color | null {
    const color = (material as (Material & { color?: unknown }) | null)?.color;
    return color instanceof Color ? color : null;
  }

  /** A material's PBR pair, defaulted for the families that do not carry them. */
  private pbrOf(material: Material | null): { roughness: number; metalness: number } {
    const std = material as (Material & { roughness?: number; metalness?: number }) | null;
    return {
      roughness: typeof std?.roughness === 'number' ? std.roughness : DEFAULT_ROUGHNESS,
      metalness: typeof std?.metalness === 'number' ? std.metalness : DEFAULT_METALNESS,
    };
  }

  get visibleInstanceCount(): number {
    return this.mesh.count;
  }

  set visibleInstanceCount(value: number) {
    this.mesh.count = this.clampVisibleCount(value);
  }

  setGeometry(geometry: BufferGeometry): void {
    this.mesh.geometry = geometry;
    this.boundsDirty = true;
  }

  /**
   * Replace the material from code. The node owns whatever it renders, so the material being
   * replaced is disposed and the reported family is re-read from the new one — without both, a mesh
   * swapped to `basic` at runtime kept leaking a standard material and went on **saving**
   * `type: standard`, describing a material it had not rendered since load.
   */
  setMaterial(material: Material | Material[]): void {
    const previous = this.materialSlots;
    this.mesh.material = material;
    this._materialType = materialFamilyOf(firstOf(material)) ?? UNKNOWN_FAMILY_REPORTS_AS;
    this._ownsMaterial = false;
    for (const slot of previous) {
      if (!(Array.isArray(material) ? material.includes(slot) : material === slot)) {
        slot.dispose();
      }
    }
  }

  writeMatrices(data: InstanceMatrixArrayView, options: InstancedWriteOptions = {}): void {
    const count = this.validateCount(data.count);
    const requiredLength = count * 16;
    if (data.matrices.length < requiredLength) {
      throw new Error('[InstancedMesh3D] Matrices array is smaller than count * 16.');
    }

    this.matrixBuffer.set(data.matrices.subarray(0, requiredLength), 0);
    this.applyWriteOptions(count, options, true, false);
  }

  writeTransforms(data: InstanceTransformArrayView, options: InstancedWriteOptions = {}): void {
    const count = this.validateCount(data.count);
    this.validateOptionalArrayLength(data.positions, count * 3, 'positions');
    this.validateOptionalArrayLength(data.rotations, count * 4, 'rotations');
    this.validateOptionalArrayLength(data.scales, count * 3, 'scales');

    for (let index = 0; index < count; index += 1) {
      const positionOffset = index * 3;
      const rotationOffset = index * 4;
      const matrixOffset = index * 16;

      if (data.positions) {
        TRANSLATION_SCRATCH.set(
          data.positions[positionOffset] ?? 0,
          data.positions[positionOffset + 1] ?? 0,
          data.positions[positionOffset + 2] ?? 0
        );
      } else {
        TRANSLATION_SCRATCH.set(0, 0, 0);
      }

      if (data.rotations) {
        ROTATION_SCRATCH.set(
          data.rotations[rotationOffset] ?? 0,
          data.rotations[rotationOffset + 1] ?? 0,
          data.rotations[rotationOffset + 2] ?? 0,
          data.rotations[rotationOffset + 3] ?? 1
        );
      } else {
        ROTATION_SCRATCH.set(0, 0, 0, 1);
      }

      if (data.scales) {
        SCALE_SCRATCH.set(
          data.scales[positionOffset] ?? 1,
          data.scales[positionOffset + 1] ?? 1,
          data.scales[positionOffset + 2] ?? 1
        );
      } else {
        SCALE_SCRATCH.set(1, 1, 1);
      }

      MATRIX_SCRATCH.compose(TRANSLATION_SCRATCH, ROTATION_SCRATCH, SCALE_SCRATCH);
      MATRIX_SCRATCH.toArray(this.matrixBuffer, matrixOffset);
    }

    this.applyWriteOptions(count, options, true, false);
  }

  writeColors(data: InstanceColorArrayView, options: InstancedWriteOptions = {}): void {
    if (!this.colorBuffer || !this.mesh.instanceColor) {
      throw new Error(
        '[InstancedMesh3D] Per-instance colors are disabled. Enable enablePerInstanceColor first.'
      );
    }

    const count = this.validateCount(data.count);
    const requiredLength = count * 3;
    if (data.colors.length < requiredLength) {
      throw new Error('[InstancedMesh3D] Colors array is smaller than count * 3.');
    }

    this.colorBuffer.set(data.colors.subarray(0, requiredLength), 0);
    this.applyWriteOptions(count, options, false, true);
  }

  markTransformsDirty(): void {
    this.transformsDirty = true;
  }

  markColorsDirty(): void {
    if (!this.colorBuffer) {
      return;
    }
    this.colorsDirty = true;
  }

  flush(): void {
    if (this.transformsDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.transformsDirty = false;
    }

    if (this.colorsDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorsDirty = false;
    }

    if (this.boundsDirty) {
      this.mesh.computeBoundingBox();
      this.mesh.computeBoundingSphere();
      this.boundsDirty = false;
    }
  }

  clearInstances(): void {
    this.mesh.count = 0;
  }

  getInstanceMatrixBuffer(): Float32Array {
    return this.matrixBuffer;
  }

  getInstanceColorBuffer(): Float32Array | null {
    return this.colorBuffer;
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node3D.getPropertySchema();

    return {
      nodeType: 'InstancedMesh3D',
      extends: 'Node3D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'maxInstances',
          type: 'number',
          ui: {
            label: 'Max Instances',
            group: 'Rendering',
            readOnly: true,
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).maxInstances,
          setValue: () => {
            // Immutable after construction.
          },
        },
        {
          name: 'materialType',
          type: 'enum',
          ui: {
            label: 'Material Type',
            description:
              'standard = PBR (desktop-class cost), lambert = diffuse-only (the mobile default), basic = unlit',
            group: 'Material',
            options: [...GEOMETRY_MATERIAL_TYPES],
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).materialType,
          setValue: (node: unknown, value: unknown) => {
            (node as InstancedMesh3D).materialType = String(value) as GeometryMaterialType;
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: {
            label: 'Color',
            description: 'Shared by every instance; per-instance colour multiplies it',
            group: 'Material',
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).color,
          setValue: (node: unknown, value: unknown) => {
            (node as InstancedMesh3D).color = String(value);
          },
        },
        {
          name: 'castShadow',
          type: 'boolean',
          ui: {
            label: 'Cast Shadow',
            group: 'Rendering',
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).mesh.castShadow,
          setValue: (node: unknown, value: unknown) => {
            (node as InstancedMesh3D).mesh.castShadow = !!value;
          },
        },
        {
          name: 'receiveShadow',
          type: 'boolean',
          ui: {
            label: 'Receive Shadow',
            group: 'Rendering',
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).mesh.receiveShadow,
          setValue: (node: unknown, value: unknown) => {
            (node as InstancedMesh3D).mesh.receiveShadow = !!value;
          },
        },
        {
          name: 'enablePerInstanceColor',
          type: 'boolean',
          ui: {
            label: 'Per-Instance Color',
            group: 'Rendering',
            readOnly: true,
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).enablePerInstanceColor,
          setValue: () => {
            // Immutable after construction.
          },
        },
        {
          name: 'visibleInstanceCount',
          type: 'number',
          ui: {
            label: 'Visible Instances',
            group: 'Debug',
            readOnly: true,
          },
          getValue: (node: unknown) => (node as InstancedMesh3D).visibleInstanceCount,
          setValue: () => {
            // Runtime-only debug field.
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Material: {
          label: 'Material',
          description: 'The one material every instance renders with',
          expanded: true,
        },
        Rendering: {
          label: 'Rendering',
          description: 'Instanced mesh rendering options',
          expanded: true,
        },
        Debug: {
          label: 'Debug',
          description: 'Runtime-only instancing diagnostics',
          expanded: false,
        },
      },
    };
  }

  private applyWriteOptions(
    count: number,
    options: InstancedWriteOptions,
    transformWrite: boolean,
    colorWrite: boolean
  ): void {
    if (options.visibleCount !== undefined) {
      this.visibleInstanceCount = options.visibleCount;
    } else if (this.mesh.count < count) {
      this.visibleInstanceCount = count;
    }

    if (transformWrite && options.markTransformDirty !== false) {
      this.transformsDirty = true;
    }

    if (colorWrite && options.markColorDirty !== false) {
      this.colorsDirty = true;
    }

    if (options.computeBoundingSphere) {
      this.boundsDirty = true;
    }
  }

  private validateCount(count: number): number {
    const normalizedCount = Math.floor(count);
    if (!Number.isFinite(normalizedCount) || normalizedCount < 0) {
      throw new Error('[InstancedMesh3D] Instance count must be a non-negative integer.');
    }
    if (normalizedCount > this.maxInstances) {
      throw new Error(
        `[InstancedMesh3D] Instance count ${normalizedCount} exceeds maxInstances ${this.maxInstances}.`
      );
    }
    return normalizedCount;
  }

  private clampVisibleCount(value: number): number {
    const normalizedValue = Math.floor(value);
    if (!Number.isFinite(normalizedValue) || normalizedValue < 0) {
      throw new Error('[InstancedMesh3D] visibleInstanceCount must be a non-negative integer.');
    }

    return Math.min(normalizedValue, this.maxInstances);
  }

  private validateOptionalArrayLength(
    value: Float32Array | undefined,
    requiredLength: number,
    label: string
  ): void {
    if (value && value.length < requiredLength) {
      throw new Error(`[InstancedMesh3D] ${label} array is smaller than required stride.`);
    }
  }
}
