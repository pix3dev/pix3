import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Vector3,
  Vector4,
} from 'three';

import {
  computeWorldBounds,
  fitOrthoToBounds,
  generateSphereDirections,
  viewProjectionMatrix,
} from './ao-bake-math';

describe('ao-bake-math', () => {
  describe('generateSphereDirections', () => {
    it('returns the requested count of unit vectors', () => {
      const dirs = generateSphereDirections(64);
      expect(dirs).toHaveLength(64);
      for (const d of dirs) {
        expect(d.length()).toBeCloseTo(1, 5);
      }
    });

    it('is roughly balanced over the sphere (mean near origin)', () => {
      const dirs = generateSphereDirections(256);
      const mean = dirs
        .reduce((acc, d) => acc.add(d), new Vector3())
        .multiplyScalar(1 / dirs.length);
      expect(mean.length()).toBeLessThan(0.1);
    });

    it('is deterministic', () => {
      const a = generateSphereDirections(16);
      const b = generateSphereDirections(16);
      for (let i = 0; i < a.length; i += 1) {
        expect(a[i].equals(b[i])).toBe(true);
      }
    });
  });

  describe('computeWorldBounds', () => {
    it('unions the world AABBs of the given meshes', () => {
      const a = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
      a.position.set(0, 1, 0);
      const b = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
      b.position.set(10, 1, 0);
      const bounds = computeWorldBounds([a, b]);
      expect(bounds.min.x).toBeCloseTo(-1);
      expect(bounds.max.x).toBeCloseTo(11);
      expect(bounds.min.y).toBeCloseTo(0);
      expect(bounds.max.y).toBeCloseTo(2);
    });

    it('returns an empty box for no objects', () => {
      expect(computeWorldBounds([]).isEmpty()).toBe(true);
    });
  });

  describe('fitOrthoToBounds', () => {
    it('projects every corner of the bounds inside the clip cube', () => {
      const bounds = new Box3(new Vector3(-3, 0, -2), new Vector3(3, 4, 2));
      const dirs = generateSphereDirections(24);
      for (const dir of dirs) {
        const camera = new OrthographicCamera();
        fitOrthoToBounds(camera, bounds, dir);
        const vp = viewProjectionMatrix(camera);
        for (let xi = 0; xi < 2; xi += 1) {
          for (let yi = 0; yi < 2; yi += 1) {
            for (let zi = 0; zi < 2; zi += 1) {
              const corner = new Vector4(
                xi ? bounds.max.x : bounds.min.x,
                yi ? bounds.max.y : bounds.min.y,
                zi ? bounds.max.z : bounds.min.z,
                1
              ).applyMatrix4(vp);
              // Orthographic → w stays 1; clip coords must be within [-1, 1].
              expect(Math.abs(corner.x)).toBeLessThanOrEqual(1.0001);
              expect(Math.abs(corner.y)).toBeLessThanOrEqual(1.0001);
              expect(corner.z).toBeGreaterThanOrEqual(-1.0001);
              expect(corner.z).toBeLessThanOrEqual(1.0001);
            }
          }
        }
      }
    });
  });
});
