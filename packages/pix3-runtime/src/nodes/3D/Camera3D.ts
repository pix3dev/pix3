import { PerspectiveCamera, OrthographicCamera, Camera, Vector3, Quaternion } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';

export const TARGET_DISTANCE = 3;

export interface Camera3DProps extends Omit<Node3DProps, 'type'> {
  projection?: 'perspective' | 'orthographic';
  fov?: number;
  near?: number;
  far?: number;
  orthographicSize?: number;
}

export class Camera3D extends Node3D {
  camera: Camera;
  private targetDistance = TARGET_DISTANCE;
  private shakeRafId: number | null = null;
  private projectionMode: 'perspective' | 'orthographic';
  private perspectiveFov: number;
  private orthographicSizeValue: number;

  constructor(props: Camera3DProps) {
    super(props, 'Camera3D');

    this.projectionMode = props.projection ?? 'perspective';
    this.perspectiveFov = props.fov ?? 60;
    this.orthographicSizeValue = props.orthographicSize ?? 5;

    this.camera = new PerspectiveCamera();
    this.add(this.camera);
    this.rebuildCamera({
      projection: this.projectionMode,
      fov: this.perspectiveFov,
      near: props.near ?? 0.1,
      far: props.far ?? 1000,
      orthographicSize: this.orthographicSizeValue,
    });
  }

  getTargetPosition(): Vector3 {
    const worldPosition = this.getWorldPosition(new Vector3());
    const worldQuaternion = this.getWorldQuaternion(new Quaternion());
    const forward = new Vector3(0, 0, -1).applyQuaternion(worldQuaternion);
    return worldPosition.add(forward.multiplyScalar(this.targetDistance));
  }

  setTargetPosition(targetPos: Vector3): void {
    const worldPosition = this.getWorldPosition(new Vector3());
    const rawDirection = targetPos.clone().sub(worldPosition);
    const nextDistance = rawDirection.length();
    if (nextDistance > 1e-6) {
      this.targetDistance = nextDistance;
    }
    const worldDirection =
      rawDirection.lengthSq() > 1e-8
        ? rawDirection.normalize()
        : new Vector3(0, 0, -1).applyQuaternion(this.getWorldQuaternion(new Quaternion()));

    const localDirection = worldDirection.clone();
    const parent = this.parent;
    if (parent) {
      const parentWorldQuaternion = parent.getWorldQuaternion(new Quaternion());
      localDirection.applyQuaternion(parentWorldQuaternion.invert());
    }
    localDirection.normalize();

    const localQuaternion = new Quaternion().setFromUnitVectors(
      new Vector3(0, 0, -1),
      localDirection
    );
    this.quaternion.copy(localQuaternion);

    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);
  }

  /**
   * Get the stored field of view in degrees.
   * Orthographic mode preserves the value so switching back restores it.
   */
  get fov(): number {
    return this.perspectiveFov;
  }

  /**
   * Set the stored field of view in degrees.
   * In orthographic mode the value is preserved for later perspective use.
   */
  set fov(value: number) {
    this.perspectiveFov = Number(value);
    if (this.camera instanceof PerspectiveCamera) {
      this.camera.fov = this.perspectiveFov;
      this.camera.updateProjectionMatrix();
    }
  }

  get projection(): 'perspective' | 'orthographic' {
    return this.projectionMode;
  }

  set projection(value: 'perspective' | 'orthographic') {
    this.rebuildCamera({ projection: value });
  }

  get near(): number {
    return (this.camera as PerspectiveCamera | OrthographicCamera).near;
  }

  set near(value: number) {
    const nextValue = Number(value);
    if (this.camera instanceof PerspectiveCamera || this.camera instanceof OrthographicCamera) {
      this.camera.near = nextValue;
      this.camera.updateProjectionMatrix();
    }
  }

  get far(): number {
    return (this.camera as PerspectiveCamera | OrthographicCamera).far;
  }

  set far(value: number) {
    const nextValue = Number(value);
    if (this.camera instanceof PerspectiveCamera || this.camera instanceof OrthographicCamera) {
      this.camera.far = nextValue;
      this.camera.updateProjectionMatrix();
    }
  }

  get orthographicSize(): number {
    return this.orthographicSizeValue;
  }

  set orthographicSize(value: number) {
    const nextValue = Math.max(0.0001, Number(value));
    this.orthographicSizeValue = nextValue;
    if (this.camera instanceof OrthographicCamera) {
      this.applyOrthographicSize(this.camera, nextValue);
    }
  }

  updateAspectRatio(aspect: number): void {
    if (this.camera instanceof PerspectiveCamera) {
      if (this.camera.aspect !== aspect) {
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
      }
      return;
    }

    if (this.camera instanceof OrthographicCamera) {
      const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
      const halfHeight = this.orthographicSize / 2;
      const halfWidth = halfHeight * safeAspect;
      if (
        this.camera.left !== -halfWidth ||
        this.camera.right !== halfWidth ||
        this.camera.top !== halfHeight ||
        this.camera.bottom !== -halfHeight
      ) {
        this.camera.left = -halfWidth;
        this.camera.right = halfWidth;
        this.camera.top = halfHeight;
        this.camera.bottom = -halfHeight;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  shake(intensity: number = 0.2, duration: number = 0.35): void {
    if (intensity <= 0 || duration <= 0) {
      return;
    }

    this.stopShake();
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startTime) / 1000;
      const progress = Math.min(1, elapsed / duration);

      if (progress >= 1) {
        this.stopShake();
        return;
      }

      const damping = 1 - progress;
      const amount = intensity * damping;

      this.camera.position.set(
        (Math.random() * 2 - 1) * amount,
        (Math.random() * 2 - 1) * amount,
        (Math.random() * 2 - 1) * amount * 0.35
      );

      this.shakeRafId = requestAnimationFrame(tick);
    };

    this.shakeRafId = requestAnimationFrame(tick);
  }

  private stopShake(): void {
    if (this.shakeRafId !== null) {
      cancelAnimationFrame(this.shakeRafId);
      this.shakeRafId = null;
    }
    this.camera.position.set(0, 0, 0);
  }

  private rebuildCamera(next: {
    projection?: 'perspective' | 'orthographic';
    fov?: number;
    near?: number;
    far?: number;
    orthographicSize?: number;
  }): void {
    const projection = next.projection ?? this.projectionMode;
    const near = next.near ?? this.near ?? 0.1;
    const far = next.far ?? this.far ?? 1000;

    this.projectionMode = projection;
    this.perspectiveFov = next.fov ?? this.perspectiveFov ?? 60;
    this.orthographicSizeValue = Math.max(
      0.0001,
      next.orthographicSize ?? this.orthographicSizeValue ?? 5
    );

    const previousCamera = this.camera;
    const nextCamera =
      projection === 'perspective'
        ? new PerspectiveCamera(this.perspectiveFov, 1, near, far)
        : new OrthographicCamera(-1, 1, 1, -1, near, far);

    nextCamera.layers.mask = previousCamera.layers.mask;
    nextCamera.position.copy(previousCamera.position);
    nextCamera.quaternion.copy(previousCamera.quaternion);
    nextCamera.scale.copy(previousCamera.scale);
    nextCamera.visible = previousCamera.visible;
    nextCamera.name = previousCamera.name;
    nextCamera.matrixAutoUpdate = previousCamera.matrixAutoUpdate;
    nextCamera.matrix.copy(previousCamera.matrix);
    nextCamera.matrixWorld.copy(previousCamera.matrixWorld);
    nextCamera.matrixWorldAutoUpdate = previousCamera.matrixWorldAutoUpdate;
    nextCamera.matrixWorldNeedsUpdate = previousCamera.matrixWorldNeedsUpdate;

    this.remove(previousCamera);
    this.camera = nextCamera;
    this.add(this.camera);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);

    if (this.camera instanceof OrthographicCamera) {
      this.applyOrthographicSize(this.camera, this.orthographicSizeValue);
    } else if (this.camera instanceof PerspectiveCamera) {
      this.camera.fov = this.perspectiveFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private applyOrthographicSize(camera: OrthographicCamera, size: number): void {
    const halfHeight = Math.max(0.0001, size) / 2;
    camera.left = -halfHeight;
    camera.right = halfHeight;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();

    const cameraProps = {
      nodeType: 'Camera3D',
      properties: [
        defineProperty('projection', 'enum', {
          ui: {
            label: 'Projection',
            group: 'Camera',
            options: ['perspective', 'orthographic'],
          },
          getValue: (node: unknown) => (node as Camera3D).projection,
          setValue: (node: unknown, value: unknown) => {
            (node as Camera3D).projection =
              value === 'orthographic' ? 'orthographic' : 'perspective';
          },
        }),
        defineProperty('fov', 'number', {
          getValue: (node: unknown) => (node as Camera3D).fov,
          setValue: (node: unknown, value: unknown) => {
            (node as Camera3D).fov = Number(value);
          },
          validation: {
            validate: value => Number.isFinite(Number(value)) && Number(value) > 0,
          },
          ui: {
            label: 'Field of View',
            group: 'Camera',
            unit: '°',
            step: 0.1,
            precision: 1,
            readOnly: target => (target as Camera3D).projection !== 'perspective',
          },
        }),
        defineProperty('orthographicSize', 'number', {
          ui: {
            label: 'Orthographic Size',
            group: 'Camera',
            step: 0.1,
            precision: 2,
            readOnly: target => (target as Camera3D).projection !== 'orthographic',
          },
          getValue: (node: unknown) => (node as Camera3D).orthographicSize,
          setValue: (node: unknown, value: unknown) => {
            (node as Camera3D).orthographicSize = Number(value);
          },
          validation: {
            validate: value => Number.isFinite(Number(value)) && Number(value) > 0,
          },
        }),
        defineProperty('near', 'number', {
          ui: { label: 'Near Plane', group: 'Camera', step: 0.01, precision: 2 },
          getValue: (node: unknown) => (node as Camera3D).near,
          setValue: (node: unknown, value: unknown) => {
            (node as Camera3D).near = Number(value);
          },
          validation: {
            validate: value => Number.isFinite(Number(value)) && Number(value) > 0,
          },
        }),
        defineProperty('far', 'number', {
          ui: { label: 'Far Plane', group: 'Camera', step: 1, precision: 0 },
          getValue: (node: unknown) => (node as Camera3D).far,
          setValue: (node: unknown, value: unknown) => {
            (node as Camera3D).far = Number(value);
          },
          validation: {
            validate: value => Number.isFinite(Number(value)) && Number(value) > 0,
          },
        }),
      ],
      groups: {
        Camera: { label: 'Camera', expanded: true },
      },
    } as PropertySchema;

    return mergeSchemas(base, cameraProps);
  }
}
