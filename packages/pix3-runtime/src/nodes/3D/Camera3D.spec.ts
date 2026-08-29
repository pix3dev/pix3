import { describe, expect, it } from 'vitest';
import { Group, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { Camera3D } from './Camera3D';

describe('Camera3D', () => {
  it('creates a perspective camera by default', () => {
    const cameraNode = new Camera3D({ id: 'cam-default', name: 'Camera' });

    expect(cameraNode.projection).toBe('perspective');
    expect(cameraNode.camera).toBeInstanceOf(PerspectiveCamera);
    expect(cameraNode.fov).toBe(60);
  });

  it('creates an orthographic camera when requested', () => {
    const cameraNode = new Camera3D({
      id: 'cam-ortho',
      name: 'Camera',
      projection: 'orthographic',
      orthographicSize: 8,
    });

    expect(cameraNode.projection).toBe('orthographic');
    expect(cameraNode.camera).toBeInstanceOf(OrthographicCamera);
    expect(cameraNode.orthographicSize).toBe(8);
  });

  it('switching projection rebuilds the internal camera without losing node transform', () => {
    const cameraNode = new Camera3D({ id: 'cam-switch', name: 'Camera', fov: 70 });
    const initialCamera = cameraNode.camera;
    const expectedPosition = new Vector3(1, 2, 3);
    const expectedQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.75);

    cameraNode.position.copy(expectedPosition);
    cameraNode.quaternion.copy(expectedQuaternion);

    cameraNode.projection = 'orthographic';

    expect(cameraNode.camera).toBeInstanceOf(OrthographicCamera);
    expect(cameraNode.camera).not.toBe(initialCamera);
    expect(cameraNode.position.toArray()).toEqual(expectedPosition.toArray());
    expect(cameraNode.quaternion.equals(expectedQuaternion)).toBe(true);
  });

  it('preserves perspective fov while orthographic mode is active', () => {
    const cameraNode = new Camera3D({ id: 'cam-fov', name: 'Camera', fov: 55 });

    cameraNode.projection = 'orthographic';
    cameraNode.fov = 80;

    expect(cameraNode.camera).toBeInstanceOf(OrthographicCamera);
    expect(cameraNode.fov).toBe(80);

    cameraNode.projection = 'perspective';

    expect(cameraNode.camera).toBeInstanceOf(PerspectiveCamera);
    expect((cameraNode.camera as PerspectiveCamera).fov).toBe(80);
  });

  it('uses orthographic size to update the frustum from aspect ratio', () => {
    const cameraNode = new Camera3D({
      id: 'cam-size',
      name: 'Camera',
      projection: 'orthographic',
      orthographicSize: 10,
    });

    cameraNode.updateAspectRatio(2);

    const camera = cameraNode.camera as OrthographicCamera;
    expect(camera.top).toBe(5);
    expect(camera.bottom).toBe(-5);
    expect(camera.left).toBe(-10);
    expect(camera.right).toBe(10);
  });

  /**
   * `Object3D.lookAt` aims +Z at the target for anything that is not itself a camera, and this node
   * only *holds* one — so without the override the rendered camera faces exactly backwards and the
   * scene renders as the bare clear colour.
   */
  describe('lookAt', () => {
    const forwardOf = (node: Camera3D): Vector3 => {
      node.updateMatrixWorld(true);
      return new Vector3(0, 0, -1).applyQuaternion(
        node.camera.getWorldQuaternion(new Quaternion())
      );
    };

    it('points the camera at the target, not away from it', () => {
      const cameraNode = new Camera3D({ id: 'cam-look', name: 'Camera' });
      cameraNode.position.set(0, 4, -8);

      cameraNode.lookAt(0, 1.2, 2);

      const expected = new Vector3(0, 1.2, 2).sub(new Vector3(0, 4, -8)).normalize();
      const forward = forwardOf(cameraNode);
      expect(forward.x).toBeCloseTo(expected.x, 5);
      expect(forward.y).toBeCloseTo(expected.y, 5);
      expect(forward.z).toBeCloseTo(expected.z, 5);
    });

    it('accepts a Vector3 target, like the method it overrides', () => {
      const cameraNode = new Camera3D({ id: 'cam-look-vec', name: 'Camera' });
      cameraNode.position.set(0, 0, 5);

      cameraNode.lookAt(new Vector3(0, 0, 0));

      expect(forwardOf(cameraNode).z).toBeCloseTo(-1, 5);
    });

    it('still faces the world target when the camera sits under a rotated parent', () => {
      const parent = new Group();
      parent.rotation.y = Math.PI / 2;
      const cameraNode = new Camera3D({ id: 'cam-look-child', name: 'Camera' });
      parent.add(cameraNode);
      parent.updateMatrixWorld(true);

      cameraNode.lookAt(0, 0, -10);

      expect(forwardOf(cameraNode).z).toBeCloseTo(-1, 5);
    });
  });
});
