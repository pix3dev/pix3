import { BufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Node3D } from '../Node3D';
import { Particles3D } from './Particles3D';

interface ParticlePrivate {
  active: boolean;
  position: Vector3;
  velocity: Vector3;
  trailHead: number;
  trailLen: number;
  trailTimer: number;
}

interface Particles3DPrivate {
  particles: ParticlePrivate[];
  activeCount: number;
  instancedMesh: InstancedMesh | null;
  renderRoot: { matrix: Matrix4; matrixAutoUpdate: boolean };
  trailMesh: { geometry: { getAttribute(name: string): BufferAttribute } } | null;
  trailData: Float32Array | null;
  deathScratch: number[];
}

function priv(node: Particles3D): Particles3DPrivate {
  return node as unknown as Particles3DPrivate;
}

function instancePosition(node: Particles3D, index: number): Vector3 {
  const mesh = priv(node).instancedMesh;
  if (!mesh) {
    throw new Error('instancedMesh missing');
  }
  const m = new Matrix4();
  mesh.getMatrixAt(index, m);
  return new Vector3().setFromMatrixPosition(m);
}

function activeParticles(node: Particles3D): ParticlePrivate[] {
  return priv(node).particles.filter(p => p.active);
}

const IDENTITY_QUAT = new Quaternion();

describe('Particles3D world-space simulation', () => {
  it('spawns particles in world coordinates and compensates renderRoot', () => {
    const root = new Node3D({ id: 'root', name: 'Root' });
    root.position.set(5, 0, 0);
    const node = new Particles3D({
      id: 'p',
      name: 'P',
      simulationSpace: 'world',
      emissionRate: 60,
      speed: 0,
      speedSpread: 0,
      gravity: { x: 0, y: 0, z: 0 },
      lifetime: 100,
      maxParticles: 8,
    });
    root.adoptChild(node);
    node.position.set(5, 0, 0);
    root.updateMatrixWorld(true);

    node.tick(1 / 60);
    expect(priv(node).activeCount).toBeGreaterThan(0);

    const spawned = instancePosition(node, 0);
    expect(spawned.x).toBeCloseTo(10, 3);
    expect(spawned.y).toBeCloseTo(0, 3);
    expect(spawned.z).toBeCloseTo(0, 3);

    // renderRoot.matrix ≈ matrixWorld⁻¹ → translation (-10, 0, 0).
    expect(priv(node).renderRoot.matrix.elements[12]).toBeCloseTo(-10, 3);

    // Move the emitter; already-spawned particle keeps its world position.
    node.position.set(0, 0, 0);
    node.tick(1 / 60);
    const after = instancePosition(node, 0);
    expect(after.x).toBeCloseTo(10, 3);
    expect(after.y).toBeCloseTo(0, 3);
    expect(after.z).toBeCloseTo(0, 3);
  });

  it('local mode keeps particles in node-local space (regression guard)', () => {
    const node = new Particles3D({
      id: 'p',
      name: 'P',
      emissionRate: 60,
      speed: 0,
      speedSpread: 0,
      gravity: { x: 0, y: 0, z: 0 },
      lifetime: 100,
      maxParticles: 8,
    });
    node.position.set(10, 0, 0);
    node.updateMatrixWorld(true);

    node.tick(1 / 60);
    expect(priv(node).activeCount).toBeGreaterThan(0);

    const spawned = instancePosition(node, 0);
    expect(spawned.x).toBeCloseTo(0, 3);
    expect(spawned.y).toBeCloseTo(0, 3);
    expect(spawned.z).toBeCloseTo(0, 3);
    expect(priv(node).renderRoot.matrix.elements[12]).toBeCloseTo(0, 6);
  });

  it('setSimulationSpace restarts the sim and resets renderRoot matrix state', () => {
    const node = new Particles3D({ id: 'p', name: 'P', emissionRate: 120, maxParticles: 8 });
    node.updateMatrixWorld(true);
    node.tick(1 / 60);
    expect(priv(node).activeCount).toBeGreaterThan(0);

    node.setSimulationSpace('world');
    expect(priv(node).activeCount).toBe(0);
    expect(priv(node).renderRoot.matrixAutoUpdate).toBe(false);

    node.setSimulationSpace('local');
    expect(priv(node).renderRoot.matrixAutoUpdate).toBe(true);
    expect(priv(node).renderRoot.matrix.elements[12]).toBeCloseTo(0, 6);
  });
});

describe('Particles3D trails', () => {
  it('samples a ring buffer that grows to the segment cap and rebuilds geometry', () => {
    const node = new Particles3D({
      id: 'p',
      name: 'P',
      emissionRate: 60,
      speed: 2,
      speedSpread: 0,
      lifetime: 100,
      maxParticles: 4,
      trailEnabled: true,
      trailSegments: 4,
      trailLifetime: 0.3,
    });
    node.updateMatrixWorld(true);

    for (let i = 0; i < 20; i += 1) {
      node.tick(0.05);
    }

    const particle = priv(node).particles[0];
    expect(particle.active).toBe(true);
    expect(particle.trailLen).toBe(4);

    node.syncRenderState(IDENTITY_QUAT, new Vector3(10, 10, 10));
    const mesh = priv(node).trailMesh;
    expect(mesh).not.toBeNull();
    const posAttr = mesh!.geometry.getAttribute('position');
    const colAttr = mesh!.geometry.getAttribute('color');
    expect(posAttr.array.length).toBe(4 * 4 * 2 * 3);
    expect(colAttr.itemSize).toBe(4);

    // At least one ribbon vertex is visible (alpha > 0) on the live strip.
    let maxAlpha = 0;
    for (let i = 3; i < colAttr.array.length; i += 4) {
      maxAlpha = Math.max(maxAlpha, colAttr.array[i]);
    }
    expect(maxAlpha).toBeGreaterThan(0);

    // restart() collapses trails to fully transparent.
    node.restart();
    node.syncRenderState(IDENTITY_QUAT, new Vector3(10, 10, 10));
    let sumAlpha = 0;
    for (let i = 3; i < colAttr.array.length; i += 4) {
      sumAlpha += colAttr.array[i];
    }
    expect(sumAlpha).toBe(0);
    expect(priv(node).particles[0].trailLen).toBe(0);
  });

  it('setTrailSegments reallocates trail buffers', () => {
    const node = new Particles3D({
      id: 'p',
      name: 'P',
      maxParticles: 4,
      trailEnabled: true,
      trailSegments: 4,
    });
    expect(priv(node).trailData!.length).toBe(4 * 4 * 3);

    node.setTrailSegments(8);
    expect(node.trailSegments).toBe(8);
    expect(priv(node).trailData!.length).toBe(4 * 8 * 3);
    const posAttr = priv(node).trailMesh!.geometry.getAttribute('position');
    expect(posAttr.array.length).toBe(4 * 8 * 2 * 3);
  });

  it('clamps trailSegments to the 2..64 range', () => {
    const node = new Particles3D({ id: 'p', name: 'P', trailSegments: 999 });
    expect(node.trailSegments).toBe(64);
    node.setTrailSegments(0);
    expect(node.trailSegments).toBe(2);
  });
});

describe('Particles3D sub-emitters', () => {
  it('bursts particles into the referenced emitter at each death', () => {
    const root = new Node3D({ id: 'root', name: 'Root' });
    const parent = new Particles3D({
      id: 'parent',
      name: 'Parent',
      emissionRate: 60,
      speed: 0,
      speedSpread: 0,
      gravity: { x: 0, y: 0, z: 0 },
      lifetime: 0.05,
      maxParticles: 8,
      subEmitterId: 'sub',
      subEmitterBurstCount: 5,
      subEmitterInheritVelocity: 0,
    });
    const target = new Particles3D({
      id: 'sub',
      name: 'Sub',
      emissionRate: 0,
      speed: 0,
      maxParticles: 16,
    });
    root.adoptChild(parent);
    root.adoptChild(target);
    parent.position.set(3, 0, 0);
    root.updateMatrixWorld(true);

    for (let i = 0; i < 3; i += 1) {
      parent.tick(0.05);
    }

    const bursted = activeParticles(target);
    expect(bursted.length).toBeGreaterThanOrEqual(5);
    expect(bursted.length).toBeLessThanOrEqual(16);
    for (const p of bursted) {
      expect(p.position.x).toBeCloseTo(3, 2);
      expect(p.position.y).toBeCloseTo(0, 2);
      expect(p.position.z).toBeCloseTo(0, 2);
    }
  });

  it('emitBurstAt spawns min(count, freeSlots) with velocity bias', () => {
    const node = new Particles3D({
      id: 'burst',
      name: 'Burst',
      emissionRate: 0,
      speed: 0,
      speedSpread: 0,
      maxParticles: 8,
    });
    node.updateMatrixWorld(true);

    node.emitBurstAt(new Vector3(1, 2, 3), 3, new Vector3(0, 5, 0));
    const spawned = activeParticles(node);
    expect(spawned.length).toBe(3);
    for (const p of spawned) {
      expect(p.position.x).toBeCloseTo(1, 4);
      expect(p.position.y).toBeCloseTo(2, 4);
      expect(p.position.z).toBeCloseTo(3, 4);
      expect(p.velocity.y).toBeCloseTo(5, 4);
    }
  });

  it('does not emit during constructor prewarm and self-reference is safe', () => {
    const node = new Particles3D({
      id: 'self',
      name: 'Self',
      emissionRate: 60,
      speed: 0,
      lifetime: 0.05,
      maxParticles: 8,
      prewarm: true,
      playing: true,
      subEmitterId: 'self',
      subEmitterBurstCount: 4,
    });

    // Prewarm ran in the constructor without throwing; deferred deaths were
    // discarded (isPrewarming guard) and the pool stayed bounded.
    expect(priv(node).deathScratch.length).toBe(0);
    expect(priv(node).activeCount).toBeLessThanOrEqual(8);
  });
});
