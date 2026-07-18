import { describe, it, expect } from 'vitest';
import { Mesh, MeshBasicMaterial, Scene, Texture, AdditiveBlending, type Blending } from 'three';
import { SHARED_UNIT_QUAD_GEOMETRY } from './shared-quad-geometry';
import { Batch2DSystem, BATCHABLE_2D_KEY, type OrderedMesh2D } from './batch-2d';

let orderCounter = 0;

function makeMesh(opts: {
  source?: Texture | null;
  batchable?: boolean;
  overlay?: boolean;
  visible?: boolean;
  blending?: Blending;
  opacity?: number;
}): OrderedMesh2D {
  const material = new MeshBasicMaterial({ transparent: true, depthTest: false });
  if (opts.source !== undefined && opts.source !== null) {
    material.map = opts.source;
  }
  if (opts.blending !== undefined) {
    material.blending = opts.blending;
  }
  if (opts.opacity !== undefined) {
    material.opacity = opts.opacity;
  }
  const mesh = new Mesh(SHARED_UNIT_QUAD_GEOMETRY, material);
  mesh.userData[BATCHABLE_2D_KEY] = opts.batchable ?? true;
  mesh.updateMatrixWorld(true);
  return {
    mesh,
    order: orderCounter++,
    overlay: opts.overlay ?? false,
    visible: opts.visible ?? true,
  };
}

/** A texture and a same-source clone (shares source.uuid → one batch key). */
function sharedSource(): [Texture, Texture] {
  const a = new Texture();
  return [a, a.clone()];
}

describe('Batch2DSystem segmentation', () => {
  it('merges a contiguous same-source run and suppresses its source materials', () => {
    const [t1, t2] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const a = makeMesh({ source: t1 });
    const b = makeMesh({ source: t2 });
    system.update([a, b]);

    expect(system.stats.batches).toBe(1);
    expect(system.stats.quads).toBe(2);
    expect(system.stats.passthrough).toBe(0);
    expect((a.mesh.material as MeshBasicMaterial).visible).toBe(false);
    expect((b.mesh.material as MeshBasicMaterial).visible).toBe(false);
    // Batch inherits the first member's stamped order (paint order B1).
    expect(system.activeBatchMeshes[0].renderOrder).toBe(a.order);
  });

  it('does not batch singletons of different sources (all passthrough)', () => {
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const a = makeMesh({ source: new Texture() });
    const b = makeMesh({ source: new Texture() });
    system.update([a, b]);

    expect(system.stats.batches).toBe(0);
    expect(system.stats.passthrough).toBe(2);
    expect((a.mesh.material as MeshBasicMaterial).visible).toBe(true);
    expect((b.mesh.material as MeshBasicMaterial).visible).toBe(true);
  });

  it('breaks a run at a non-batchable mesh and keeps contiguity elsewhere', () => {
    const [t1, t2] = sharedSource();
    const [t3, t4] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    // Run: A A | X(non-batchable) | B B  →  2 batches, 1 passthrough.
    const a1 = makeMesh({ source: t1 });
    const a2 = makeMesh({ source: t2 });
    const x = makeMesh({ source: new Texture(), batchable: false });
    const b1 = makeMesh({ source: t3 });
    const b2 = makeMesh({ source: t4 });
    system.update([a1, a2, x, b1, b2]);

    expect(system.stats.batches).toBe(2);
    expect(system.stats.quads).toBe(4);
    expect(system.stats.passthrough).toBe(1);
    expect((x.mesh.material as MeshBasicMaterial).visible).toBe(true);
  });

  it('does not merge across layer bands (main vs overlay)', () => {
    const [t1, t2] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const main = makeMesh({ source: t1, overlay: false });
    const overlay = makeMesh({ source: t2, overlay: true });
    system.update([main, overlay]);
    // Same source but different bands → two singleton runs → no batch.
    expect(system.stats.batches).toBe(0);
    expect(system.stats.passthrough).toBe(2);
  });

  it('excludes invisible, zero-opacity, and custom-blend meshes', () => {
    const [t1, t2] = sharedSource();
    const [t3, t4] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const invisible = makeMesh({ source: t1, visible: false });
    const zero = makeMesh({ source: t2, opacity: 0 });
    const add1 = makeMesh({ source: t3, blending: AdditiveBlending });
    const add2 = makeMesh({ source: t4, blending: AdditiveBlending });
    system.update([invisible, zero, add1, add2]);
    // None are batchable → no batches.
    expect(system.stats.batches).toBe(0);
  });

  it('restores materials that fall out of a batch on the next frame', () => {
    const [t1, t2] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const a = makeMesh({ source: t1 });
    const b = makeMesh({ source: t2 });
    system.update([a, b]);
    expect((a.mesh.material as MeshBasicMaterial).visible).toBe(false);

    // Next frame: only one of them present → no batch → materials restored.
    system.update([{ ...a }]);
    expect((a.mesh.material as MeshBasicMaterial).visible).toBe(true);
    expect((b.mesh.material as MeshBasicMaterial).visible).toBe(true);
    expect(system.stats.batches).toBe(0);
  });

  it('preserves paint order: batch block sorts before a later passthrough', () => {
    const [t1, t2] = sharedSource();
    const scene = new Scene();
    const system = new Batch2DSystem(scene);
    const a1 = makeMesh({ source: t1 });
    const a2 = makeMesh({ source: t2 });
    const solo = makeMesh({ source: new Texture() }); // singleton → passthrough
    system.update([a1, a2, solo]);
    const batchOrder = system.activeBatchMeshes[0].renderOrder;
    // The batch takes a1's order; the passthrough keeps its own higher stamp.
    expect(batchOrder).toBe(a1.order);
    expect(solo.order).toBeGreaterThan(batchOrder);
    expect((solo.mesh.material as MeshBasicMaterial).visible).toBe(true);
  });
});
