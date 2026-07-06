import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';

import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';

const DEFAULT_GEOMETRY = new BoxGeometry(1, 1, 1);
const DEFAULT_MATERIAL = new MeshStandardMaterial({ color: '#ffffff' });
const TRANSLATION_SCRATCH = new Vector3();
const ROTATION_SCRATCH = new Quaternion();
const SCALE_SCRATCH = new Vector3(1, 1, 1);
const MATRIX_SCRATCH = new Matrix4();
const COLOR_SCRATCH = new Color();

export interface InstancedMesh3DProps extends Omit<Node3DProps, 'type'> {
  maxInstances: number;
  geometry?: BufferGeometry;
  material?: Material | Material[];
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
    const material = props.material ?? DEFAULT_MATERIAL;
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
    // Only dispose owned geometry/material — the module-level DEFAULT_* singletons
    // are shared across every InstancedMesh3D and must not be disposed. (Does not
    // call super.disposeResources(), whose generic pass would hit those defaults.)
    if (this.mesh.geometry !== DEFAULT_GEOMETRY) {
      this.mesh.geometry.dispose();
    }
    const material = this.mesh.material;
    const materials = Array.isArray(material) ? material : [material];
    for (const entry of materials) {
      if (entry && entry !== DEFAULT_MATERIAL) {
        entry.dispose();
      }
    }
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

  setMaterial(material: Material | Material[]): void {
    this.mesh.material = material;
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
