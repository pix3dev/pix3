import { Quaternion, Texture, Vector3 } from 'three';
import { type TextureResourceRef } from '../../core/TextureResource';
import type { PropertySchema } from '../../fw/property-schema';
import { Node3D, type Node3DProps } from '../Node3D';
export type ParticleEmitterShape = 'point' | 'sphere' | 'box';
export type ParticleRenderShape = 'plane' | 'sphere' | 'cube';
export interface Particles3DProps extends Omit<Node3DProps, 'type'> {
    texture?: TextureResourceRef | null;
    texturePath?: string | null;
    emitterShape?: ParticleEmitterShape;
    emitterRadius?: number;
    emitterBoxSize?: {
        x: number;
        y: number;
        z: number;
    };
    particleShape?: ParticleRenderShape;
    emissionRate?: number;
    maxParticles?: number;
    lifetime?: number;
    speed?: number;
    speedSpread?: number;
    gravity?: {
        x: number;
        y: number;
        z: number;
    };
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
export declare class Particles3D extends Node3D {
    texture: TextureResourceRef | null;
    emitterShape: ParticleEmitterShape;
    emitterRadius: number;
    emitterBoxSize: {
        x: number;
        y: number;
        z: number;
    };
    particleShape: ParticleRenderShape;
    emissionRate: number;
    maxParticles: number;
    lifetime: number;
    speed: number;
    speedSpread: number;
    gravity: {
        x: number;
        y: number;
        z: number;
    };
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
    private particles;
    private emissionAccumulator;
    private activeCount;
    private isPrewarming;
    private readonly renderRoot;
    private instancedMesh;
    private readonly material;
    private instanceColorAttr;
    private instanceAlphaAttr;
    private trailMesh;
    private trailMaterial;
    private trailData;
    private trailPositions;
    private trailColors;
    private trailIndices;
    private subEmitterCacheId;
    private subEmitterCache;
    private readonly deathScratch;
    private readonly startColorVec;
    private readonly endColorVec;
    private readonly tempColor;
    private readonly tempMatrix;
    private readonly tempMatInv;
    private readonly tempScale;
    private readonly tempQuat;
    private readonly tempQuatWorld;
    private readonly tempQuatNode;
    private readonly tempQuatRot;
    private readonly tempVelocity;
    private readonly tempDirection;
    private readonly tempDeathPos;
    private readonly tempDeathVel;
    private readonly tempBurstPos;
    private readonly tempBurstVel;
    private readonly tempCamSim;
    private readonly tempTrailP;
    private readonly tempTrailPrev;
    private readonly tempTrailNext;
    private readonly tempTrailDir;
    private readonly tempTrailView;
    private readonly tempTrailSide;
    constructor(props: Particles3DProps);
    get texturePath(): string | null;
    set texturePath(value: string | null);
    setTextureResource(value: unknown): void;
    setTexture(texture: Texture): void;
    clearTexture(): void;
    setMaxParticles(count: number): void;
    setParticleShape(shape: ParticleRenderShape): void;
    restart(): void;
    /**
     * Per-frame render sync: latches world-space compensation, updates billboard
     * matrices and rebuilds trail ribbons. Both editor and runtime hosts call this
     * once per rendered frame with the active camera's world orientation/position.
     */
    syncRenderState(cameraQuaternion: Quaternion, cameraPosition: Vector3): void;
    /**
     * @deprecated Use {@link syncRenderState}. Kept so existing user scripts that
     * only have a camera quaternion keep compiling; trails need a camera position.
     */
    applyBillboard(cameraQuaternion: Quaternion): void;
    private applyBillboardInternal;
    tick(dt: number): void;
    private initializeParticles;
    private prewarmSimulation;
    private spawnParticles;
    private activateParticle;
    private assignSpawnPosition;
    private updateParticles;
    private buildRenderGeometry;
    private rebuildRenderer;
    private configureMaterialForInstanceAlpha;
    /**
     * Neutralize the emitter's ancestor transform so particle state stored in world
     * coordinates renders correctly: renderRoot.matrix = matrixWorld⁻¹ makes
     * renderRoot's effective world transform identity. No-op in local mode.
     */
    private syncWorldCompensation;
    setSimulationSpace(next: 'local' | 'world'): void;
    /** Record a dead particle's world-space position + velocity for deferred sub-emission. */
    private recordDeath;
    /** Fire recorded deaths into the referenced sub-emitter, then clear the scratch. */
    private flushSubEmission;
    /** Resolve (and cache) the referenced sub-emitter node by id. */
    private resolveSubEmitter;
    /**
     * Spawn `count` particles around a world-space point. Safe to call from scripts
     * and safe to self-reference (deferred emission means no mid-loop mutation).
     */
    emitBurstAt(worldPosition: Vector3, count: number, inheritedWorldVelocity?: Vector3): void;
    setTrailEnabled(value: boolean): void;
    setTrailSegments(value: number): void;
    private resetTrailState;
    private allocateTrailBuffers;
    private buildTrailMesh;
    private disposeTrailMesh;
    private writeTrailSample;
    private advanceTrailSampling;
    /**
     * Read cross-section `i` of a particle's ribbon into `out`. i=0 is the live head
     * (current position); i in [1, trailLen] walk the ring buffer backwards.
     */
    private readTrailPoint;
    private writeTrailVertex;
    /** Collapse every trail strip to a degenerate, invisible state. */
    private collapseAllTrails;
    /** Rebuild the trail ribbon geometry, camera-facing, in the current sim space. */
    private updateTrailGeometry;
    static getPropertySchema(): PropertySchema;
}
