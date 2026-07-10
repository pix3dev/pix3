import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three';

import { coerceTextureResource, type TextureResourceRef } from '../../core/TextureResource';
import type { NodeBase } from '../NodeBase';
import type { PropertySchema } from '../../fw/property-schema';
import { Node3D, type Node3DProps } from '../Node3D';

export type ParticleEmitterShape = 'point' | 'sphere' | 'box';
export type ParticleRenderShape = 'plane' | 'sphere' | 'cube';

export interface Particles3DProps extends Omit<Node3DProps, 'type'> {
  texture?: TextureResourceRef | null;
  texturePath?: string | null;
  emitterShape?: ParticleEmitterShape;
  emitterRadius?: number;
  emitterBoxSize?: { x: number; y: number; z: number };
  particleShape?: ParticleRenderShape;
  emissionRate?: number;
  maxParticles?: number;
  lifetime?: number;
  speed?: number;
  speedSpread?: number;
  gravity?: { x: number; y: number; z: number };
  particleSize?: number;
  sizeRandomness?: number;
  startColor?: string;
  endColor?: string;
  startAlpha?: number;
  endAlpha?: number;
  billboard?: boolean;
  playing?: boolean;
  loop?: boolean;
  prewarm?: boolean;
  preview?: boolean;
  disableRotation?: boolean;
  simulationSpace?: 'local' | 'world';
  trailEnabled?: boolean;
  trailLifetime?: number;
  trailWidth?: number;
  trailSegments?: number;
  trailFade?: number;
  subEmitterId?: string;
  subEmitterBurstCount?: number;
  subEmitterInheritVelocity?: number;
}

interface ParticleState {
  active: boolean;
  age: number;
  lifetime: number;
  position: Vector3;
  velocity: Vector3;
  size: number;
  rotation: number;
  angularVelocity: number;
  trailHead: number;
  trailLen: number;
  trailTimer: number;
}

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const ZERO_VECTOR = new Vector3(0, 0, 0);
const MIN_TRAIL_SEGMENTS = 2;
const MAX_TRAIL_SEGMENTS = 64;

export class Particles3D extends Node3D {
  texture: TextureResourceRef | null;
  emitterShape: ParticleEmitterShape;
  emitterRadius: number;
  emitterBoxSize: { x: number; y: number; z: number };
  particleShape: ParticleRenderShape;
  emissionRate: number;
  maxParticles: number;
  lifetime: number;
  speed: number;
  speedSpread: number;
  gravity: { x: number; y: number; z: number };
  particleSize: number;
  sizeRandomness: number;
  startColor: string;
  endColor: string;
  startAlpha: number;
  endAlpha: number;
  billboard: boolean;
  playing: boolean;
  loop: boolean;
  prewarm: boolean;
  preview: boolean;
  disableRotation: boolean;
  simulationSpace: 'local' | 'world';
  trailEnabled: boolean;
  trailLifetime: number;
  trailWidth: number;
  trailSegments: number;
  trailFade: number;
  subEmitterId: string;
  subEmitterBurstCount: number;
  subEmitterInheritVelocity: number;

  private particles: ParticleState[] = [];
  private emissionAccumulator = 0;
  private activeCount = 0;
  private isPrewarming = false;

  private readonly renderRoot: Mesh;
  private instancedMesh: InstancedMesh | null = null;
  private readonly material: MeshBasicMaterial;
  private instanceColorAttr: InstancedBufferAttribute;
  private instanceAlphaAttr: InstancedBufferAttribute;

  // Trail rendering (allocated only while trailEnabled).
  private trailMesh: Mesh | null = null;
  private trailMaterial: MeshBasicMaterial | null = null;
  private trailData: Float32Array | null = null; // ring buffer of sim-space sample positions
  private trailPositions: Float32Array | null = null;
  private trailColors: Float32Array | null = null;
  private trailIndices: Uint32Array | null = null;

  // Sub-emitter resolution cache (mirrors VirtualCamera3D.resolveTarget).
  private subEmitterCacheId = '';
  private subEmitterCache: Particles3D | null = null;
  private readonly deathScratch: number[] = [];

  private readonly startColorVec = new Color();
  private readonly endColorVec = new Color();
  private readonly tempColor = new Color();
  private readonly tempMatrix = new Matrix4();
  private readonly tempMatInv = new Matrix4();
  private readonly tempScale = new Vector3(1, 1, 1);
  private readonly tempQuat = new Quaternion();
  private readonly tempQuatWorld = new Quaternion();
  private readonly tempQuatNode = new Quaternion();
  private readonly tempQuatRot = new Quaternion();
  private readonly tempVelocity = new Vector3();
  private readonly tempDirection = new Vector3();
  // Dedicated scratch so sub-emission never aliases spawn/billboard scratch.
  private readonly tempDeathPos = new Vector3();
  private readonly tempDeathVel = new Vector3();
  private readonly tempBurstPos = new Vector3();
  private readonly tempBurstVel = new Vector3();
  private readonly tempCamSim = new Vector3();
  private readonly tempTrailP = new Vector3();
  private readonly tempTrailPrev = new Vector3();
  private readonly tempTrailNext = new Vector3();
  private readonly tempTrailDir = new Vector3();
  private readonly tempTrailView = new Vector3();
  private readonly tempTrailSide = new Vector3();

  constructor(props: Particles3DProps) {
    super(props, 'Particles3D');

    this.texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
    this.emitterShape = props.emitterShape ?? 'point';
    this.emitterRadius = Math.max(0, props.emitterRadius ?? 0.5);
    this.emitterBoxSize = props.emitterBoxSize ?? { x: 1, y: 1, z: 1 };
    this.particleShape = props.particleShape ?? 'plane';
    this.emissionRate = Math.max(0, props.emissionRate ?? 24);
    this.maxParticles = Math.max(1, Math.floor(props.maxParticles ?? 512));
    this.lifetime = Math.max(0.01, props.lifetime ?? 2);
    this.speed = Math.max(0, props.speed ?? 2);
    this.speedSpread = Math.max(0, props.speedSpread ?? 0.5);
    this.gravity = props.gravity ?? { x: 0, y: 0, z: 0 };
    this.particleSize = Math.max(0.001, props.particleSize ?? 0.2);
    this.sizeRandomness = MathUtils.clamp(props.sizeRandomness ?? 0.2, 0, 1);
    this.startColor = props.startColor ?? '#ffffff';
    this.endColor = props.endColor ?? '#ffd24d';
    this.startAlpha = MathUtils.clamp(props.startAlpha ?? 1, 0, 1);
    this.endAlpha = MathUtils.clamp(props.endAlpha ?? 0, 0, 1);
    this.billboard = props.billboard ?? true;
    this.playing = props.playing ?? true;
    this.loop = props.loop ?? true;
    this.prewarm = props.prewarm ?? false;
    this.preview = props.preview ?? false;
    this.disableRotation = props.disableRotation ?? false;
    this.simulationSpace = props.simulationSpace ?? 'local';
    this.trailEnabled = props.trailEnabled ?? false;
    this.trailLifetime = Math.max(0.05, props.trailLifetime ?? 0.3);
    this.trailWidth = MathUtils.clamp(props.trailWidth ?? 0.05, 0.001, 2);
    this.trailSegments = MathUtils.clamp(
      Math.floor(props.trailSegments ?? 16),
      MIN_TRAIL_SEGMENTS,
      MAX_TRAIL_SEGMENTS
    );
    this.trailFade = MathUtils.clamp(props.trailFade ?? 1, 0, 1);
    this.subEmitterId = props.subEmitterId ?? '';
    this.subEmitterBurstCount = MathUtils.clamp(
      Math.floor(props.subEmitterBurstCount ?? 8),
      0,
      128
    );
    this.subEmitterInheritVelocity = MathUtils.clamp(props.subEmitterInheritVelocity ?? 0, 0, 1);

    this.material = new MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexColors: false,
      side: DoubleSide,
    });
    this.configureMaterialForInstanceAlpha();

    this.renderRoot = new Mesh();
    this.renderRoot.name = `${this.name}-Particles`;
    this.add(this.renderRoot);

    this.instanceColorAttr = new InstancedBufferAttribute(
      new Float32Array(this.maxParticles * 3),
      3
    );
    this.instanceColorAttr.setUsage(DynamicDrawUsage);
    this.instanceAlphaAttr = new InstancedBufferAttribute(new Float32Array(this.maxParticles), 1);
    this.instanceAlphaAttr.setUsage(DynamicDrawUsage);

    this.initializeParticles();
    this.rebuildRenderer();

    if (this.simulationSpace === 'world') {
      this.renderRoot.matrixAutoUpdate = false;
    }

    if (this.trailEnabled) {
      this.allocateTrailBuffers();
      this.buildTrailMesh();
    }

    if (this.prewarm && this.playing) {
      this.prewarmSimulation();
    }
  }

  get texturePath(): string | null {
    return this.texture?.url ?? null;
  }

  set texturePath(value: string | null) {
    this.texture = coerceTextureResource(value);
  }

  setTextureResource(value: unknown): void {
    this.texture = coerceTextureResource(value);
  }

  setTexture(texture: Texture): void {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  clearTexture(): void {
    this.material.map = null;
    this.material.needsUpdate = true;
  }

  setMaxParticles(count: number): void {
    const next = Math.max(1, Math.floor(count));
    if (next === this.maxParticles) {
      return;
    }

    this.maxParticles = next;
    this.instanceColorAttr = new InstancedBufferAttribute(
      new Float32Array(this.maxParticles * 3),
      3
    );
    this.instanceColorAttr.setUsage(DynamicDrawUsage);
    this.instanceAlphaAttr = new InstancedBufferAttribute(new Float32Array(this.maxParticles), 1);
    this.instanceAlphaAttr.setUsage(DynamicDrawUsage);
    this.initializeParticles();
    this.rebuildRenderer();

    if (this.trailEnabled) {
      this.allocateTrailBuffers();
      this.buildTrailMesh();
    }
  }

  setParticleShape(shape: ParticleRenderShape): void {
    if (shape === this.particleShape) {
      return;
    }
    this.particleShape = shape;
    this.rebuildRenderer();
  }

  restart(): void {
    for (const particle of this.particles) {
      particle.active = false;
      particle.age = 0;
      particle.trailHead = 0;
      particle.trailLen = 0;
      particle.trailTimer = 0;
    }
    this.activeCount = 0;
    this.emissionAccumulator = 0;
    this.deathScratch.length = 0;
    if (this.instancedMesh) {
      this.instancedMesh.count = 0;
      this.instancedMesh.instanceMatrix.needsUpdate = true;
    }
    this.collapseAllTrails();
  }

  /**
   * Per-frame render sync: latches world-space compensation, updates billboard
   * matrices and rebuilds trail ribbons. Both editor and runtime hosts call this
   * once per rendered frame with the active camera's world orientation/position.
   */
  syncRenderState(cameraQuaternion: Quaternion, cameraPosition: Vector3): void {
    if (this.simulationSpace === 'world') {
      this.syncWorldCompensation();
    }
    this.applyBillboardInternal(cameraQuaternion);
    this.updateTrailGeometry(cameraPosition);
  }

  /**
   * @deprecated Use {@link syncRenderState}. Kept so existing user scripts that
   * only have a camera quaternion keep compiling; trails need a camera position.
   */
  applyBillboard(cameraQuaternion: Quaternion): void {
    this.syncRenderState(cameraQuaternion, ZERO_VECTOR);
  }

  private applyBillboardInternal(cameraQuaternion: Quaternion): void {
    if (!this.billboard || this.particleShape !== 'plane' || !this.instancedMesh) {
      return;
    }

    if (this.simulationSpace === 'world') {
      // renderRoot's effective world transform is identity, so the instanced
      // mesh needs the camera orientation directly (no node-inverse).
      this.tempQuatNode.copy(cameraQuaternion);
    } else {
      this.getWorldQuaternion(this.tempQuatWorld);
      this.tempQuatNode.copy(this.tempQuatWorld).invert().multiply(cameraQuaternion);
    }

    let renderIndex = 0;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      if (!particle.active) {
        continue;
      }

      this.tempQuat.copy(this.tempQuatNode);
      this.tempQuatRot.setFromAxisAngle(FORWARD, particle.rotation);
      this.tempQuat.multiply(this.tempQuatRot);

      this.tempScale.set(particle.size, particle.size, particle.size);
      this.tempMatrix.compose(particle.position, this.tempQuat, this.tempScale);
      this.instancedMesh.setMatrixAt(renderIndex, this.tempMatrix);
      renderIndex += 1;
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  override tick(dt: number): void {
    super.tick(dt);

    if ((!this.playing && !this.preview) || dt <= 0) {
      return;
    }

    // Latch world compensation before spawn so world-space spawn math uses a
    // fresh matrixWorld (also re-latched at render time in syncRenderState).
    if (this.simulationSpace === 'world') {
      this.syncWorldCompensation();
    }

    const clampedDt = Math.min(dt, 1 / 20);
    this.spawnParticles(clampedDt);
    this.updateParticles(clampedDt);
  }

  private initializeParticles(): void {
    this.particles = [];
    for (let i = 0; i < this.maxParticles; i += 1) {
      this.particles.push({
        active: false,
        age: 0,
        lifetime: this.lifetime,
        position: new Vector3(),
        velocity: new Vector3(),
        size: this.particleSize,
        rotation: 0,
        angularVelocity: 0,
        trailHead: 0,
        trailLen: 0,
        trailTimer: 0,
      });
    }
  }

  private prewarmSimulation(): void {
    const step = 1 / 60;
    const duration = Math.min(this.lifetime, 3);
    const steps = Math.floor(duration / step);
    this.isPrewarming = true;
    try {
      for (let i = 0; i < steps; i += 1) {
        this.spawnParticles(step);
        this.updateParticles(step);
      }
    } finally {
      this.isPrewarming = false;
    }
  }

  private spawnParticles(dt: number): void {
    if (!this.loop && this.activeCount >= this.maxParticles) {
      return;
    }

    this.emissionAccumulator += this.emissionRate * dt;
    let spawnCount = Math.floor(this.emissionAccumulator);
    if (spawnCount <= 0) {
      return;
    }
    this.emissionAccumulator -= spawnCount;

    for (let i = 0; i < this.particles.length && spawnCount > 0; i += 1) {
      const particle = this.particles[i];
      if (particle.active) {
        continue;
      }

      this.activateParticle(particle, i);
      spawnCount -= 1;
    }
  }

  private activateParticle(
    particle: ParticleState,
    pIdx = -1,
    originSimSpace?: Vector3,
    velocityBias?: Vector3
  ): void {
    particle.active = true;
    particle.age = 0;
    particle.lifetime = this.lifetime * MathUtils.lerp(0.85, 1.15, Math.random());
    particle.rotation = this.disableRotation ? 0 : Math.random() * Math.PI * 2;
    particle.angularVelocity = this.disableRotation ? 0 : MathUtils.lerp(-3, 3, Math.random());
    this.assignSpawnPosition(particle.position);

    this.tempDirection.set(
      MathUtils.randFloatSpread(2),
      Math.random() * 1.5,
      MathUtils.randFloatSpread(2)
    );
    if (this.tempDirection.lengthSq() < 1e-5) {
      this.tempDirection.copy(UP);
    }
    this.tempDirection.normalize();

    const speedJitter = MathUtils.randFloatSpread(this.speedSpread * 2);
    const speed = Math.max(0, this.speed + speedJitter);
    particle.velocity.copy(this.tempDirection.multiplyScalar(speed));

    if (originSimSpace) {
      // Sub-emitter burst: origin is already in this emitter's sim space; the
      // emitter-shape offset becomes an offset *around* the death point. Skip
      // the D1 node-matrixWorld spawn transform (origin is pre-converted).
      particle.position.add(originSimSpace);
    } else if (this.simulationSpace === 'world') {
      // D1: compose local spawn offset into world coordinates so already-spawned
      // particles stop following the emitter.
      particle.position.applyMatrix4(this.matrixWorld);
      particle.velocity.applyQuaternion(this.getWorldQuaternion(this.tempQuatWorld));
    }

    if (velocityBias) {
      particle.velocity.addScaledVector(velocityBias, 1);
    }

    const sizeScale = 1 - this.sizeRandomness + Math.random() * this.sizeRandomness;
    particle.size = Math.max(0.001, this.particleSize * sizeScale);

    particle.trailHead = 0;
    particle.trailLen = 0;
    particle.trailTimer = 0;
    if (this.trailEnabled && this.trailData && pIdx >= 0) {
      // Seed the ring head so the first rendered ribbon has a second point.
      this.writeTrailSample(pIdx, particle);
      particle.trailLen = 1;
    }
  }

  private assignSpawnPosition(target: Vector3): void {
    if (this.emitterShape === 'sphere') {
      this.tempDirection.set(
        MathUtils.randFloatSpread(2),
        MathUtils.randFloatSpread(2),
        MathUtils.randFloatSpread(2)
      );
      if (this.tempDirection.lengthSq() < 1e-5) {
        this.tempDirection.copy(UP);
      }
      this.tempDirection.normalize().multiplyScalar(Math.random() * this.emitterRadius);
      target.copy(this.tempDirection);
      return;
    }

    if (this.emitterShape === 'box') {
      target.set(
        MathUtils.randFloatSpread(this.emitterBoxSize.x),
        MathUtils.randFloatSpread(this.emitterBoxSize.y),
        MathUtils.randFloatSpread(this.emitterBoxSize.z)
      );
      return;
    }

    target.set(0, 0, 0);
  }

  private updateParticles(dt: number): void {
    if (!this.instancedMesh) {
      return;
    }

    this.startColorVec.set(this.startColor);
    this.endColorVec.set(this.endColor);

    let visibleCount = 0;

    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      if (!particle.active) {
        continue;
      }

      particle.age += dt;
      if (particle.age >= particle.lifetime) {
        particle.active = false;
        if (this.subEmitterId !== '') {
          this.recordDeath(particle);
        }
        continue;
      }

      this.tempVelocity.set(this.gravity.x, this.gravity.y, this.gravity.z).multiplyScalar(dt);
      particle.velocity.add(this.tempVelocity);
      particle.position.addScaledVector(particle.velocity, dt);
      particle.rotation += particle.angularVelocity * dt;

      if (this.trailEnabled && this.trailData) {
        this.advanceTrailSampling(i, particle, dt);
      }

      const life = MathUtils.clamp(particle.age / particle.lifetime, 0, 1);
      const alpha = MathUtils.lerp(this.startAlpha, this.endAlpha, life);
      this.tempColor.copy(this.startColorVec).lerp(this.endColorVec, life);

      this.tempQuat.identity();
      if (!this.billboard || this.particleShape !== 'plane') {
        this.tempQuat.setFromAxisAngle(FORWARD, particle.rotation);
      }

      this.tempScale.set(particle.size, particle.size, particle.size);
      this.tempMatrix.compose(particle.position, this.tempQuat, this.tempScale);
      this.instancedMesh.setMatrixAt(visibleCount, this.tempMatrix);
      this.instanceColorAttr.setXYZ(
        visibleCount,
        this.tempColor.r,
        this.tempColor.g,
        this.tempColor.b
      );
      this.instanceAlphaAttr.setX(visibleCount, alpha);
      visibleCount += 1;
    }

    this.activeCount = visibleCount;
    this.instancedMesh.count = visibleCount;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this.instanceColorAttr.needsUpdate = true;
    this.instanceAlphaAttr.needsUpdate = true;

    this.flushSubEmission();
  }

  private buildRenderGeometry(): PlaneGeometry | BoxGeometry | SphereGeometry {
    if (this.particleShape === 'cube') {
      return new BoxGeometry(1, 1, 1);
    }
    if (this.particleShape === 'sphere') {
      return new SphereGeometry(0.5, 8, 8);
    }
    return new PlaneGeometry(1, 1);
  }

  private rebuildRenderer(): void {
    if (this.instancedMesh) {
      this.renderRoot.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
    }

    const geometry = this.buildRenderGeometry();
    this.instancedMesh = new InstancedMesh(geometry, this.material, this.maxParticles);
    this.instancedMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.count = 0;
    this.instancedMesh.instanceColor = this.instanceColorAttr;
    this.instancedMesh.geometry.setAttribute('instanceAlpha', this.instanceAlphaAttr);
    this.renderRoot.add(this.instancedMesh);
  }

  private configureMaterialForInstanceAlpha(): void {
    this.material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <color_pars_vertex>',
          '#include <color_pars_vertex>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;'
        )
        .replace(
          '#include <color_vertex>',
          '#include <color_vertex>\nvInstanceAlpha = instanceAlpha;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_pars_fragment>',
          '#include <color_pars_fragment>\nvarying float vInstanceAlpha;'
        )
        .replace(
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceAlpha );'
        );
    };

    this.material.customProgramCacheKey = () => 'pix3-particles3d-instance-alpha-v1';
    this.material.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // World-space simulation (D1)
  // ---------------------------------------------------------------------------

  /**
   * Neutralize the emitter's ancestor transform so particle state stored in world
   * coordinates renders correctly: renderRoot.matrix = matrixWorld⁻¹ makes
   * renderRoot's effective world transform identity. No-op in local mode.
   */
  private syncWorldCompensation(): void {
    if (this.simulationSpace !== 'world') {
      return;
    }
    this.updateWorldMatrix(true, false);
    const det = this.matrixWorld.determinant();
    if (Math.abs(det) < 1e-8) {
      // Non-invertible (e.g. a zero scale in the chain): keep the last matrix.
      return;
    }
    this.tempMatInv.copy(this.matrixWorld).invert();
    this.renderRoot.matrix.copy(this.tempMatInv);
    this.renderRoot.matrixWorldNeedsUpdate = true;
  }

  setSimulationSpace(next: 'local' | 'world'): void {
    if (next === this.simulationSpace) {
      return;
    }
    this.simulationSpace = next;
    this.restart();
    if (next === 'world') {
      this.renderRoot.matrixAutoUpdate = false;
      this.syncWorldCompensation();
    } else {
      this.renderRoot.matrix.identity();
      this.renderRoot.matrixAutoUpdate = true;
      this.renderRoot.matrixWorldNeedsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-emitters (D3)
  // ---------------------------------------------------------------------------

  /** Record a dead particle's world-space position + velocity for deferred sub-emission. */
  private recordDeath(particle: ParticleState): void {
    this.tempDeathPos.copy(particle.position);
    this.tempDeathVel.copy(particle.velocity);
    if (this.simulationSpace === 'local') {
      this.tempDeathPos.applyMatrix4(this.matrixWorld);
      this.tempDeathVel.applyQuaternion(this.getWorldQuaternion(this.tempQuatWorld));
    }
    this.deathScratch.push(
      this.tempDeathPos.x,
      this.tempDeathPos.y,
      this.tempDeathPos.z,
      this.tempDeathVel.x,
      this.tempDeathVel.y,
      this.tempDeathVel.z
    );
  }

  /** Fire recorded deaths into the referenced sub-emitter, then clear the scratch. */
  private flushSubEmission(): void {
    if (this.deathScratch.length === 0) {
      return;
    }
    if (this.isPrewarming) {
      this.deathScratch.length = 0;
      return;
    }
    const sub = this.resolveSubEmitter();
    if (!sub) {
      this.deathScratch.length = 0;
      return;
    }
    const inherit = this.subEmitterInheritVelocity;
    for (let i = 0; i + 5 < this.deathScratch.length; i += 6) {
      this.tempDeathPos.set(
        this.deathScratch[i],
        this.deathScratch[i + 1],
        this.deathScratch[i + 2]
      );
      this.tempDeathVel
        .set(this.deathScratch[i + 3], this.deathScratch[i + 4], this.deathScratch[i + 5])
        .multiplyScalar(inherit);
      sub.emitBurstAt(this.tempDeathPos, this.subEmitterBurstCount, this.tempDeathVel);
    }
    this.deathScratch.length = 0;
  }

  /** Resolve (and cache) the referenced sub-emitter node by id. */
  private resolveSubEmitter(): Particles3D | null {
    const id = this.subEmitterId;
    if (!id) {
      this.subEmitterCache = null;
      this.subEmitterCacheId = '';
      return null;
    }
    if (this.subEmitterCache && this.subEmitterCacheId === id) {
      return this.subEmitterCache;
    }
    let found: NodeBase | null = null;
    if (this.scene) {
      found = this.scene.findNode(id);
    } else {
      let root: NodeBase = this;
      while (root.parentNode) {
        root = root.parentNode;
      }
      found = root.findNode(id);
    }
    this.subEmitterCache = found instanceof Particles3D ? found : null;
    this.subEmitterCacheId = id;
    return this.subEmitterCache;
  }

  /**
   * Spawn `count` particles around a world-space point. Safe to call from scripts
   * and safe to self-reference (deferred emission means no mid-loop mutation).
   */
  emitBurstAt(worldPosition: Vector3, count: number, inheritedWorldVelocity?: Vector3): void {
    const total = Math.max(0, Math.floor(count));
    if (total <= 0) {
      return;
    }
    const originSim = this.tempBurstPos.copy(worldPosition);
    let velSim: Vector3 | undefined;
    if (inheritedWorldVelocity) {
      velSim = this.tempBurstVel.copy(inheritedWorldVelocity);
    }
    if (this.simulationSpace === 'local') {
      this.updateWorldMatrix(true, false);
      this.tempMatInv.copy(this.matrixWorld).invert();
      originSim.applyMatrix4(this.tempMatInv);
      if (velSim) {
        velSim.applyQuaternion(this.getWorldQuaternion(this.tempQuatWorld).invert());
      }
    }

    let remaining = total;
    for (let i = 0; i < this.particles.length && remaining > 0; i += 1) {
      const particle = this.particles[i];
      if (particle.active) {
        continue;
      }
      this.activateParticle(particle, i, originSim, velSim);
      remaining -= 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Trails (D2)
  // ---------------------------------------------------------------------------

  setTrailEnabled(value: boolean): void {
    const next = Boolean(value);
    if (next === this.trailEnabled) {
      return;
    }
    this.trailEnabled = next;
    if (next) {
      this.allocateTrailBuffers();
      this.buildTrailMesh();
      this.resetTrailState();
    } else {
      this.disposeTrailMesh();
      this.trailData = null;
      this.trailPositions = null;
      this.trailColors = null;
      this.trailIndices = null;
    }
  }

  setTrailSegments(value: number): void {
    const next = MathUtils.clamp(Math.floor(value), MIN_TRAIL_SEGMENTS, MAX_TRAIL_SEGMENTS);
    if (next === this.trailSegments) {
      return;
    }
    this.trailSegments = next;
    if (this.trailEnabled) {
      this.allocateTrailBuffers();
      this.buildTrailMesh();
      this.resetTrailState();
    }
  }

  private resetTrailState(): void {
    for (const particle of this.particles) {
      particle.trailHead = 0;
      particle.trailLen = 0;
      particle.trailTimer = 0;
    }
  }

  private allocateTrailBuffers(): void {
    const segments = this.trailSegments;
    const n = this.maxParticles;
    this.trailData = new Float32Array(n * segments * 3);
    this.trailPositions = new Float32Array(n * segments * 2 * 3);
    this.trailColors = new Float32Array(n * segments * 2 * 4);

    const indices = new Uint32Array(n * (segments - 1) * 6);
    let ptr = 0;
    for (let p = 0; p < n; p += 1) {
      const base = p * segments * 2;
      for (let i = 0; i < segments - 1; i += 1) {
        const a0 = base + i * 2;
        const b0 = a0 + 1;
        const a1 = base + (i + 1) * 2;
        const b1 = a1 + 1;
        indices[ptr] = a0;
        indices[ptr + 1] = b0;
        indices[ptr + 2] = a1;
        indices[ptr + 3] = b0;
        indices[ptr + 4] = b1;
        indices[ptr + 5] = a1;
        ptr += 6;
      }
    }
    this.trailIndices = indices;
  }

  private buildTrailMesh(): void {
    this.disposeTrailMesh();
    if (!this.trailPositions || !this.trailColors || !this.trailIndices) {
      return;
    }

    const geometry = new BufferGeometry();
    const posAttr = new BufferAttribute(this.trailPositions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    const colAttr = new BufferAttribute(this.trailColors, 4);
    colAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('color', colAttr);
    geometry.setIndex(new BufferAttribute(this.trailIndices, 1));

    this.trailMaterial = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      vertexColors: true, // itemSize-4 color attribute → USE_COLOR_ALPHA (per-vertex alpha)
    });
    this.trailMesh = new Mesh(geometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.name = `${this.name}-Trails`;
    this.renderRoot.add(this.trailMesh);
  }

  private disposeTrailMesh(): void {
    if (this.trailMesh) {
      this.renderRoot.remove(this.trailMesh);
      this.trailMesh.geometry.dispose();
      this.trailMesh = null;
    }
    if (this.trailMaterial) {
      this.trailMaterial.dispose();
      this.trailMaterial = null;
    }
  }

  private writeTrailSample(pIdx: number, particle: ParticleState): void {
    if (!this.trailData) {
      return;
    }
    const off = (pIdx * this.trailSegments + particle.trailHead) * 3;
    this.trailData[off] = particle.position.x;
    this.trailData[off + 1] = particle.position.y;
    this.trailData[off + 2] = particle.position.z;
  }

  private advanceTrailSampling(pIdx: number, particle: ParticleState, dt: number): void {
    const segments = this.trailSegments;
    const interval = this.trailLifetime / (segments - 1);
    if (interval <= 0) {
      return;
    }
    particle.trailTimer += dt;
    let guard = segments; // never advance more than a full ring in one frame
    while (particle.trailTimer >= interval && guard > 0) {
      particle.trailTimer -= interval;
      particle.trailHead = (particle.trailHead + 1) % segments;
      this.writeTrailSample(pIdx, particle);
      particle.trailLen = Math.min(particle.trailLen + 1, segments);
      guard -= 1;
    }
  }

  /**
   * Read cross-section `i` of a particle's ribbon into `out`. i=0 is the live head
   * (current position); i in [1, trailLen] walk the ring buffer backwards.
   */
  private readTrailPoint(pIdx: number, particle: ParticleState, i: number, out: Vector3): void {
    if (i <= 0 || !this.trailData) {
      out.copy(particle.position);
      return;
    }
    const segments = this.trailSegments;
    const k = Math.min(i, particle.trailLen);
    const ringSlot = (((particle.trailHead - (k - 1)) % segments) + segments) % segments;
    const off = (pIdx * segments + ringSlot) * 3;
    out.set(this.trailData[off], this.trailData[off + 1], this.trailData[off + 2]);
  }

  private writeTrailVertex(
    vIndex: number,
    pos: Vector3,
    r: number,
    g: number,
    b: number,
    a: number
  ): void {
    const positions = this.trailPositions;
    const colors = this.trailColors;
    if (!positions || !colors) {
      return;
    }
    const pOff = vIndex * 3;
    positions[pOff] = pos.x;
    positions[pOff + 1] = pos.y;
    positions[pOff + 2] = pos.z;
    const cOff = vIndex * 4;
    colors[cOff] = r;
    colors[cOff + 1] = g;
    colors[cOff + 2] = b;
    colors[cOff + 3] = a;
  }

  /** Collapse every trail strip to a degenerate, invisible state. */
  private collapseAllTrails(): void {
    if (!this.trailMesh || !this.trailPositions || !this.trailColors) {
      return;
    }
    this.trailPositions.fill(0);
    this.trailColors.fill(0);
    const geometry = this.trailMesh.geometry;
    (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  /** Rebuild the trail ribbon geometry, camera-facing, in the current sim space. */
  private updateTrailGeometry(cameraPosition: Vector3): void {
    if (!this.trailEnabled || !this.trailMesh || !this.trailData) {
      return;
    }
    const segments = this.trailSegments;

    // Bring the camera position into this emitter's sim space (world mode:
    // renderRoot is identity, so sim space == world).
    this.tempCamSim.copy(cameraPosition);
    if (this.simulationSpace === 'local') {
      this.updateWorldMatrix(true, false);
      this.tempMatInv.copy(this.matrixWorld).invert();
      this.tempCamSim.applyMatrix4(this.tempMatInv);
    }

    this.startColorVec.set(this.startColor);
    this.endColorVec.set(this.endColor);
    const halfWidth = this.trailWidth / 2;

    for (let pIdx = 0; pIdx < this.particles.length; pIdx += 1) {
      const particle = this.particles[pIdx];
      const vBase = pIdx * segments * 2;

      if (!particle.active || particle.trailLen < 1) {
        for (let i = 0; i < segments; i += 1) {
          const vA = vBase + i * 2;
          this.writeTrailVertex(vA, ZERO_VECTOR, 0, 0, 0, 0);
          this.writeTrailVertex(vA + 1, ZERO_VECTOR, 0, 0, 0, 0);
        }
        continue;
      }

      const life = MathUtils.clamp(particle.age / particle.lifetime, 0, 1);
      const baseAlpha = MathUtils.lerp(this.startAlpha, this.endAlpha, life);
      this.tempColor.copy(this.startColorVec).lerp(this.endColorVec, life);
      const len = particle.trailLen;

      for (let i = 0; i < segments; i += 1) {
        const vA = vBase + i * 2;
        const vB = vA + 1;

        if (i > len) {
          this.writeTrailVertex(vA, particle.position, 0, 0, 0, 0);
          this.writeTrailVertex(vB, particle.position, 0, 0, 0, 0);
          continue;
        }

        this.readTrailPoint(pIdx, particle, i, this.tempTrailP);
        this.readTrailPoint(pIdx, particle, Math.max(i - 1, 0), this.tempTrailPrev);
        this.readTrailPoint(pIdx, particle, Math.min(i + 1, len), this.tempTrailNext);

        this.tempTrailDir.copy(this.tempTrailPrev).sub(this.tempTrailNext);
        if (this.tempTrailDir.lengthSq() < 1e-10) {
          this.tempTrailDir.copy(FORWARD);
        }
        this.tempTrailDir.normalize();

        this.tempTrailView.copy(this.tempCamSim).sub(this.tempTrailP);
        if (this.tempTrailView.lengthSq() < 1e-10) {
          this.tempTrailView.copy(FORWARD);
        }
        this.tempTrailView.normalize();

        this.tempTrailSide.copy(this.tempTrailDir).cross(this.tempTrailView);
        const t = i / (segments - 1);
        if (this.tempTrailSide.lengthSq() < 1e-12) {
          // Ribbon direction is parallel to the view: no meaningful width.
          this.writeTrailVertex(vA, this.tempTrailP, 0, 0, 0, 0);
          this.writeTrailVertex(vB, this.tempTrailP, 0, 0, 0, 0);
          continue;
        }
        this.tempTrailSide.normalize().multiplyScalar(halfWidth * (1 - t));

        const alpha = baseAlpha * (1 - this.trailFade * t);
        this.tempTrailPrev.copy(this.tempTrailP).add(this.tempTrailSide);
        this.writeTrailVertex(
          vA,
          this.tempTrailPrev,
          this.tempColor.r,
          this.tempColor.g,
          this.tempColor.b,
          alpha
        );
        this.tempTrailNext.copy(this.tempTrailP).sub(this.tempTrailSide);
        this.writeTrailVertex(
          vB,
          this.tempTrailNext,
          this.tempColor.r,
          this.tempColor.g,
          this.tempColor.b,
          alpha
        );
      }
    }

    const geometry = this.trailMesh.geometry;
    (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node3D.getPropertySchema();
    return {
      nodeType: 'Particles3D',
      extends: 'Node3D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'texture',
          type: 'object',
          ui: {
            label: 'Texture',
            group: 'Rendering',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (node: unknown) =>
            (node as Particles3D).texture ?? { type: 'texture', url: '' },
          setValue: (node: unknown, value: unknown) =>
            (node as Particles3D).setTextureResource(value),
        },
        {
          name: 'particleShape',
          type: 'enum',
          ui: { label: 'Particle Shape', group: 'Rendering', options: ['plane', 'sphere', 'cube'] },
          getValue: (node: unknown) => (node as Particles3D).particleShape,
          setValue: (node: unknown, value: unknown) => {
            const next = String(value) as ParticleRenderShape;
            if (next === 'plane' || next === 'sphere' || next === 'cube') {
              (node as Particles3D).setParticleShape(next);
            }
          },
        },
        {
          name: 'particleSize',
          type: 'number',
          ui: {
            label: 'Particle Size',
            group: 'Rendering',
            min: 0.01,
            max: 5,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).particleSize,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).particleSize = Math.max(0.01, Number(value));
          },
        },
        {
          name: 'sizeRandomness',
          type: 'number',
          ui: {
            label: 'Size Randomness',
            group: 'Rendering',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).sizeRandomness,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).sizeRandomness = MathUtils.clamp(Number(value), 0, 1);
          },
        },
        {
          name: 'startColor',
          type: 'color',
          ui: { label: 'Start Color', group: 'Rendering' },
          getValue: (node: unknown) => (node as Particles3D).startColor,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).startColor = String(value);
          },
        },
        {
          name: 'endColor',
          type: 'color',
          ui: { label: 'End Color', group: 'Rendering' },
          getValue: (node: unknown) => (node as Particles3D).endColor,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).endColor = String(value);
          },
        },
        {
          name: 'startAlpha',
          type: 'number',
          ui: {
            label: 'Start Alpha',
            group: 'Rendering',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).startAlpha,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).startAlpha = MathUtils.clamp(Number(value), 0, 1);
          },
        },
        {
          name: 'endAlpha',
          type: 'number',
          ui: {
            label: 'End Alpha',
            group: 'Rendering',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).endAlpha,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).endAlpha = MathUtils.clamp(Number(value), 0, 1);
          },
        },
        {
          name: 'billboard',
          type: 'boolean',
          ui: { label: 'Billboard', group: 'Rendering' },
          getValue: (node: unknown) => (node as Particles3D).billboard,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).billboard = Boolean(value);
          },
        },
        {
          name: 'emitterShape',
          type: 'enum',
          ui: { label: 'Emitter Shape', group: 'Emitter', options: ['point', 'sphere', 'box'] },
          getValue: (node: unknown) => (node as Particles3D).emitterShape,
          setValue: (node: unknown, value: unknown) => {
            const next = String(value) as ParticleEmitterShape;
            if (next === 'point' || next === 'sphere' || next === 'box') {
              (node as Particles3D).emitterShape = next;
            }
          },
        },
        {
          name: 'emitterRadius',
          type: 'number',
          ui: {
            label: 'Emitter Radius',
            group: 'Emitter',
            min: 0,
            max: 10,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).emitterRadius,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).emitterRadius = Math.max(0, Number(value));
          },
        },
        {
          name: 'emitterBoxSize',
          type: 'vector3',
          ui: { label: 'Emitter Box Size', group: 'Emitter', step: 0.01, precision: 2 },
          getValue: (node: unknown) => ({ ...(node as Particles3D).emitterBoxSize }),
          setValue: (node: unknown, value: unknown) => {
            const v = value as { x: number; y: number; z: number };
            (node as Particles3D).emitterBoxSize = {
              x: Math.max(0, Number(v.x)),
              y: Math.max(0, Number(v.y)),
              z: Math.max(0, Number(v.z)),
            };
          },
        },
        {
          name: 'emissionRate',
          type: 'number',
          ui: {
            label: 'Emission Rate',
            group: 'Emission',
            min: 0,
            max: 1000,
            step: 1,
            precision: 0,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).emissionRate,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).emissionRate = Math.max(0, Number(value));
          },
        },
        {
          name: 'maxParticles',
          type: 'number',
          ui: {
            label: 'Max Particles',
            group: 'Emission',
            min: 1,
            max: 10000,
            step: 1,
            precision: 0,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).maxParticles,
          setValue: (node: unknown, value: unknown) =>
            (node as Particles3D).setMaxParticles(Number(value)),
        },
        {
          name: 'lifetime',
          type: 'number',
          ui: {
            label: 'Lifetime',
            group: 'Emission',
            unit: 's',
            min: 0.01,
            max: 30,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).lifetime,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).lifetime = Math.max(0.01, Number(value));
          },
        },
        {
          name: 'speed',
          type: 'number',
          ui: {
            label: 'Speed',
            group: 'Emission',
            min: 0,
            max: 100,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).speed,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).speed = Math.max(0, Number(value));
          },
        },
        {
          name: 'speedSpread',
          type: 'number',
          ui: {
            label: 'Speed Spread',
            group: 'Emission',
            min: 0,
            max: 20,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).speedSpread,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).speedSpread = Math.max(0, Number(value));
          },
        },
        {
          name: 'gravity',
          type: 'vector3',
          ui: { label: 'Gravity', group: 'Emission', step: 0.01, precision: 2 },
          getValue: (node: unknown) => ({ ...(node as Particles3D).gravity }),
          setValue: (node: unknown, value: unknown) => {
            const v = value as { x: number; y: number; z: number };
            (node as Particles3D).gravity = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
          },
        },
        {
          name: 'disableRotation',
          type: 'boolean',
          ui: { label: 'Disable Rotation', group: 'Emission' },
          getValue: (node: unknown) => (node as Particles3D).disableRotation,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).disableRotation = Boolean(value);
          },
        },
        {
          name: 'playing',
          type: 'boolean',
          ui: { label: 'Playing', group: 'Runtime' },
          getValue: (node: unknown) => (node as Particles3D).playing,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).playing = Boolean(value);
          },
        },
        {
          name: 'loop',
          type: 'boolean',
          ui: { label: 'Loop', group: 'Runtime' },
          getValue: (node: unknown) => (node as Particles3D).loop,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).loop = Boolean(value);
          },
        },
        {
          name: 'prewarm',
          type: 'boolean',
          ui: { label: 'Prewarm', group: 'Runtime' },
          getValue: (node: unknown) => (node as Particles3D).prewarm,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).prewarm = Boolean(value);
          },
        },
        {
          name: 'preview',
          type: 'boolean',
          ui: { label: 'Preview', group: 'Runtime' },
          getValue: (node: unknown) => (node as Particles3D).preview,
          setValue: (node: unknown, value: unknown) => {
            const particles = node as Particles3D;
            const next = Boolean(value);
            if (particles.preview && !next) {
              particles.restart();
            }
            particles.preview = next;
          },
        },
        {
          name: 'simulationSpace',
          type: 'enum',
          ui: { label: 'Simulation Space', group: 'Runtime', options: ['local', 'world'] },
          getValue: (node: unknown) => (node as Particles3D).simulationSpace,
          setValue: (node: unknown, value: unknown) => {
            const next = String(value);
            if (next === 'local' || next === 'world') {
              (node as Particles3D).setSimulationSpace(next);
            }
          },
        },
        {
          name: 'trailEnabled',
          type: 'boolean',
          ui: {
            label: 'Enable Trails',
            group: 'Trails',
            description: 'Draw a camera-facing ribbon behind each particle. Best with Simulation Space = world.',
          },
          getValue: (node: unknown) => (node as Particles3D).trailEnabled,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).setTrailEnabled(Boolean(value));
          },
        },
        {
          name: 'trailLifetime',
          type: 'number',
          ui: {
            label: 'Trail Lifetime',
            group: 'Trails',
            unit: 's',
            min: 0.05,
            max: 5,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).trailLifetime,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).trailLifetime = Math.max(0.05, Number(value));
          },
        },
        {
          name: 'trailWidth',
          type: 'number',
          ui: {
            label: 'Trail Width',
            group: 'Trails',
            min: 0.001,
            max: 2,
            step: 0.001,
            precision: 3,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).trailWidth,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).trailWidth = MathUtils.clamp(Number(value), 0.001, 2);
          },
        },
        {
          name: 'trailSegments',
          type: 'number',
          ui: {
            label: 'Trail Segments',
            group: 'Trails',
            description: 'Ribbon resolution. Keep Max Particles moderate when trails are enabled.',
            min: 2,
            max: 64,
            step: 1,
            precision: 0,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).trailSegments,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).setTrailSegments(Number(value));
          },
        },
        {
          name: 'trailFade',
          type: 'number',
          ui: {
            label: 'Trail Fade',
            group: 'Trails',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).trailFade,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).trailFade = MathUtils.clamp(Number(value), 0, 1);
          },
        },
        {
          name: 'subEmitterId',
          type: 'node',
          ui: {
            label: 'Sub Emitter',
            group: 'Sub Emitter',
            description: 'Particles3D fired as a burst at each particle death (author it with Emission Rate = 0).',
            nodeTypes: ['Particles3D'],
          },
          getValue: (node: unknown) => (node as Particles3D).subEmitterId,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).subEmitterId = value == null ? '' : String(value);
          },
        },
        {
          name: 'subEmitterBurstCount',
          type: 'number',
          ui: {
            label: 'Burst Count',
            group: 'Sub Emitter',
            min: 0,
            max: 128,
            step: 1,
            precision: 0,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).subEmitterBurstCount,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).subEmitterBurstCount = MathUtils.clamp(
              Math.floor(Number(value)),
              0,
              128
            );
          },
        },
        {
          name: 'subEmitterInheritVelocity',
          type: 'number',
          ui: {
            label: 'Inherit Velocity',
            group: 'Sub Emitter',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
          },
          getValue: (node: unknown) => (node as Particles3D).subEmitterInheritVelocity,
          setValue: (node: unknown, value: unknown) => {
            (node as Particles3D).subEmitterInheritVelocity = MathUtils.clamp(Number(value), 0, 1);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Rendering: {
          label: 'Rendering',
          description: 'Particle rendering settings',
          expanded: true,
        },
        Emitter: {
          label: 'Emitter',
          description: 'Emitter shape and spawn volume',
          expanded: true,
        },
        Emission: { label: 'Emission', description: 'Emission rates and movement', expanded: true },
        Runtime: { label: 'Runtime', description: 'Simulation runtime controls', expanded: true },
        Trails: {
          label: 'Trails',
          description: 'Per-particle ribbon trails',
          expanded: false,
        },
        'Sub Emitter': {
          label: 'Sub Emitter',
          description: 'Burst another emitter on particle death',
          expanded: false,
        },
      },
    };
  }
}
