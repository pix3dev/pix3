import { BoxGeometry, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { InstancedMesh3D } from './InstancedMesh3D';

describe('InstancedMesh3D', () => {
  it('initializes empty instance buffers with the requested capacity', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 8,
    });

    expect(node.visibleInstanceCount).toBe(0);
    expect(node.getInstanceMatrixBuffer()).toHaveLength(8 * 16);
    expect(node.getInstanceColorBuffer()).toBeNull();
  });

  it('writes transforms and flushes batched GPU updates', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 2,
      enablePerInstanceColor: true,
      geometry: new BoxGeometry(1, 1, 1),
      material: new MeshStandardMaterial(),
    });

    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const rotations = new Float32Array([
      0,
      0,
      0,
      1,
      0,
      Math.sin(Math.PI / 4),
      0,
      Math.cos(Math.PI / 4),
    ]);
    const scales = new Float32Array([1, 1, 1, 2, 2, 2]);
    const colors = new Float32Array([1, 0, 0, 0, 1, 0]);

    node.writeTransforms({ count: 2, positions, rotations, scales }, { visibleCount: 2 });
    node.writeColors({ count: 2, colors });

    const matrixVersionBefore = node.mesh.instanceMatrix.version;
    const colorVersionBefore = node.mesh.instanceColor?.version ?? 0;
    node.flush();

    expect(node.visibleInstanceCount).toBe(2);
    expect(node.mesh.instanceMatrix.version).toBeGreaterThan(matrixVersionBefore);
    expect(node.mesh.instanceColor?.version ?? 0).toBeGreaterThan(colorVersionBefore);

    const expectedPosition = new Vector3(4, 5, 6);
    const expectedRotation = new Quaternion(0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4));
    const expectedScale = new Vector3(2, 2, 2);
    const expectedMatrix = new Matrix4();
    node.mesh.getMatrixAt(1, expectedMatrix);
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    expectedMatrix.decompose(position, rotation, scale);

    expect(position.toArray()).toEqual(expectedPosition.toArray());
    expect(scale.x).toBeCloseTo(expectedScale.x, 5);
    expect(scale.y).toBeCloseTo(expectedScale.y, 5);
    expect(scale.z).toBeCloseTo(expectedScale.z, 5);
    expect(rotation.angleTo(expectedRotation)).toBeLessThan(1e-6);
  });

  it('rejects color writes when per-instance color support is disabled', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
    });

    expect(() =>
      node.writeColors({
        count: 1,
        colors: new Float32Array([1, 1, 1]),
      })
    ).toThrow(/Per-instance colors are disabled/);
  });
});
