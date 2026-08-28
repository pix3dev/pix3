import {
  BoxGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';

import { InstancedMesh3D } from './InstancedMesh3D';

describe('InstancedMesh3D — authored material', () => {
  /**
   * The defect this covers: the loader built no material for this node at all, so every
   * scene-authored instanced mesh rendered as one shared white PBR material — invisible in the
   * inspector, and past the reach of the project's mobile material policy. `materialConfig` is the
   * scene-file path, and it must produce a material this node owns.
   */
  it('builds the authored family and colour', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 4,
      materialConfig: { type: 'lambert', color: '#4e8df5' },
    });

    expect(node.mesh.material).toBeInstanceOf(MeshLambertMaterial);
    expect(node.materialType).toBe('lambert');
    expect(node.color).toBe('#4e8df5');
  });

  it('falls back to standard white when the scene authors no material', () => {
    const node = new InstancedMesh3D({ id: 'instanced', name: 'Instanced', maxInstances: 1 });

    expect(node.mesh.material).toBeInstanceOf(MeshStandardMaterial);
    expect(node.materialType).toBe('standard');
    expect(node.color).toBe('#ffffff');
  });

  it('round-trips through serializeMaterialConfig, PBR values and all', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      materialConfig: { type: 'standard', color: '#12ab34', roughness: 0.75, metalness: 0.1 },
    });

    expect(node.serializeMaterialConfig()).toEqual({
      type: 'standard',
      color: '#12ab34',
      roughness: 0.75,
      metalness: 0.1,
    });
  });

  it('drops roughness/metalness for families that have none', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      materialConfig: { type: 'basic', color: '#101010' },
    });

    expect(node.mesh.material).toBeInstanceOf(MeshBasicMaterial);
    expect(node.serializeMaterialConfig()).toEqual({ type: 'basic', color: '#101010' });
  });

  it('swaps the family in place, carrying the colour and freeing the old material', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      materialConfig: { type: 'standard', color: '#4e8df5' },
    });
    const previous = node.mesh.material as MeshStandardMaterial;
    let disposed = false;
    previous.addEventListener('dispose', () => {
      disposed = true;
    });

    node.materialType = 'basic';

    expect(node.mesh.material).toBeInstanceOf(MeshBasicMaterial);
    expect(node.color).toBe('#4e8df5');
    expect(disposed).toBe(true);
  });

  /**
   * Authored colour converts EXACTLY once: `Color.set` already takes the sRGB hex into the working
   * space and `getHexString` already brings it back. A manual conversion on either side is the
   * drift that used to darken a light's hex on every save (see color-convention.spec).
   */
  it('reads back the exact hex it was authored with', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      materialConfig: { color: '#a8d8f0' },
    });

    node.color = '#7f3fbf';
    expect(node.color).toBe('#7f3fbf');
  });

  it('keeps a caller-supplied material, and replaces it only when the family is asked to change', () => {
    const supplied = new MeshStandardMaterial({ color: '#ff0000' });
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      material: supplied,
      materialConfig: { type: 'lambert' },
    });

    expect(node.mesh.material).toBe(supplied);
    // The family REPORTED is the one being rendered, not the one authored beside it — otherwise
    // the node saves `lambert` while drawing PBR.
    expect(node.materialType).toBe('standard');

    node.materialType = 'lambert';
    expect(node.mesh.material).toBeInstanceOf(MeshLambertMaterial);
    expect(node.color).toBe('#ff0000');
  });

  /**
   * The node with no authored material must look EXACTLY as it did before the material block
   * existed — a plain `new MeshStandardMaterial({ color: '#ffffff' })`. Adopting GeometryMesh's
   * 0.35/0.25 here would restyle every pre-existing instanced mesh on load and then bake the new
   * numbers into the scene file on the first save.
   */
  it("defaults to three's own PBR values, not GeometryMesh's", () => {
    const node = new InstancedMesh3D({ id: 'instanced', name: 'Instanced', maxInstances: 1 });
    const material = node.mesh.material as MeshStandardMaterial;
    const untouched = new MeshStandardMaterial({ color: '#ffffff' });

    expect(material.roughness).toBe(untouched.roughness);
    expect(material.metalness).toBe(untouched.metalness);
    expect(node.serializeMaterialConfig()).toEqual({
      type: 'standard',
      color: '#ffffff',
      roughness: untouched.roughness,
      metalness: untouched.metalness,
    });
  });

  /**
   * `setMaterial` is the code path (DeepCore rebuilds walls through it). Before the authored block
   * the node rendered a shared singleton, so overwriting it leaked nothing; now the node owns what
   * it renders, and a swap that neither frees the old material nor re-reads the family leaves the
   * node saving a material it stopped rendering at load.
   */
  it('takes ownership on setMaterial: frees the old one and re-reads the family', () => {
    const node = new InstancedMesh3D({
      id: 'instanced',
      name: 'Instanced',
      maxInstances: 1,
      materialConfig: { type: 'standard', color: '#4e8df5' },
    });
    const built = node.mesh.material as MeshStandardMaterial;
    let disposed = false;
    built.addEventListener('dispose', () => {
      disposed = true;
    });

    node.setMaterial(new MeshBasicMaterial({ color: '#00ff00' }));

    expect(disposed).toBe(true);
    expect(node.materialType).toBe('basic');
    expect(node.serializeMaterialConfig()).toEqual({ type: 'basic', color: '#00ff00' });
  });

  it('does not dispose a material that is being re-set', () => {
    const node = new InstancedMesh3D({ id: 'instanced', name: 'Instanced', maxInstances: 1 });
    const material = new MeshLambertMaterial();
    let disposed = false;
    material.addEventListener('dispose', () => {
      disposed = true;
    });

    node.setMaterial(material);
    node.setMaterial(material);

    expect(disposed).toBe(false);
    expect(node.mesh.material).toBe(material);
  });

  describe('multi-slot meshes (geometry groups)', () => {
    const multiSlot = (): InstancedMesh3D => {
      const node = new InstancedMesh3D({ id: 'instanced', name: 'Instanced', maxInstances: 1 });
      node.setMaterial([
        new MeshStandardMaterial({ color: '#ff0000' }),
        new MeshStandardMaterial({ color: '#00ff00' }),
      ]);
      return node;
    };

    it('rebuilds every slot when the family changes', () => {
      const node = multiSlot();

      node.materialType = 'basic';

      const slots = node.mesh.material as MeshBasicMaterial[];
      expect(slots).toHaveLength(2);
      expect(slots.every(slot => slot instanceof MeshBasicMaterial)).toBe(true);
      // Each slot keeps ITS colour — collapsing to the first would repaint half the mesh.
      expect(`#${slots[0].color.getHexString()}`).toBe('#ff0000');
      expect(`#${slots[1].color.getHexString()}`).toBe('#00ff00');
    });

    it('paints every slot when the colour is set', () => {
      const node = multiSlot();

      node.color = '#0000ff';

      const slots = node.mesh.material as MeshStandardMaterial[];
      expect(slots.map(slot => `#${slot.color.getHexString()}`)).toEqual(['#0000ff', '#0000ff']);
    });

    /**
     * The authored block describes ONE material, so writing it for a multi-slot mesh would discard
     * every other slot on the next load. No block is the honest answer — and what the file carried
     * before the block existed.
     */
    it('refuses to serialize, rather than describing the first slot only', () => {
      expect(multiSlot().serializeMaterialConfig()).toBeNull();
    });
  });
});

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
