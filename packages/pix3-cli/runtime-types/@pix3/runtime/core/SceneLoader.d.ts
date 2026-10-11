import { Vector2 } from 'three';
import { NodeBase } from '../nodes/NodeBase';
import { SpineSkeleton2D } from '../nodes/2D/SpineSkeleton2D';
import type { SceneGraph } from './SceneManager';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { ScriptRegistry } from './ScriptRegistry';
import { type ComponentDefinition } from './component-hydration';
import { type TextureResourceRef } from './TextureResource';
export declare class SceneValidationError extends Error {
    readonly details: string[];
    constructor(message: string, details: string[]);
}
export type { ComponentDefinition };
export interface SceneNodeDefinition {
    id: string;
    type?: string;
    name?: string;
    instance?: string;
    instancePath?: string;
    groups?: string[];
    properties?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    children?: SceneNodeDefinition[];
    components?: ComponentDefinition[];
    overrides?: InstanceOverrides;
}
export interface InstanceOverrideEntry {
    properties?: Record<string, unknown>;
}
export interface InstanceOverrides {
    byLocalId: Record<string, InstanceOverrideEntry>;
}
export interface SceneDocument {
    version: string;
    description?: string;
    metadata?: Record<string, unknown>;
    root: SceneNodeDefinition[];
}
export interface GeometryMeshProperties {
    geometry?: string;
    size?: [number, number, number];
    castShadow?: boolean;
    receiveShadow?: boolean;
    material?: {
        color?: string;
        roughness?: number;
        metalness?: number;
        type?: string;
        aoMap?: string;
        aoMapIntensity?: number;
        map?: string;
        effects?: unknown[];
    };
}
export interface Camera3DProperties {
    projection?: 'perspective' | 'orthographic';
    fov?: number;
    near?: number;
    far?: number;
    orthographicSize?: number;
}
export interface InstancedMesh3DProperties {
    maxInstances?: number;
    castShadow?: boolean;
    receiveShadow?: boolean;
    enablePerInstanceColor?: boolean;
    frustumCulled?: boolean;
    /** Same vocabulary as `GeometryMesh`'s, minus the maps — see `InstancedMaterialConfig`. */
    material?: {
        type?: string;
        color?: string;
        roughness?: number;
        metalness?: number;
    };
}
export interface DirectionalLightNodeProperties {
    color?: string;
    intensity?: number;
    castShadow?: boolean;
    shadowCameraSize?: number;
    shadowMapSize?: number;
}
export interface PointLightNodeProperties {
    color?: string;
    intensity?: number;
    distance?: number;
    decay?: number;
    castShadow?: boolean;
}
export interface SpotLightNodeProperties {
    color?: string;
    intensity?: number;
    distance?: number;
    angle?: number;
    penumbra?: number;
    decay?: number;
    castShadow?: boolean;
}
export interface AmbientLightNodeProperties {
    color?: string;
    intensity?: number;
}
export interface HemisphereLightNodeProperties {
    skyColor?: string;
    groundColor?: string;
    intensity?: number;
}
export interface Sprite3DProperties {
    texture?: TextureResourceRef | null;
    texturePath?: string | null;
    width?: number;
    height?: number;
    color?: string;
    billboard?: boolean;
    billboardRoll?: number;
    opacity?: number;
}
export interface Particles3DProperties {
    texture?: TextureResourceRef | null;
    texturePath?: string | null;
    emitterShape?: 'point' | 'sphere' | 'box';
    emitterRadius?: number;
    emitterBoxSize?: [number, number, number] | {
        x: number;
        y: number;
        z: number;
    };
    particleShape?: 'plane' | 'sphere' | 'cube';
    emissionRate?: number;
    maxParticles?: number;
    lifetime?: number;
    speed?: number;
    speedSpread?: number;
    gravity?: [number, number, number] | {
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
    disableRotation?: boolean;
    playing?: boolean;
    loop?: boolean;
    prewarm?: boolean;
    preview?: boolean;
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
export interface Node2DProperties {
    position?: Vector2 | [number, number];
    scale?: Vector2 | [number, number];
    rotation?: number;
    opacity?: number;
}
export interface Group2DProperties extends Node2DProperties {
    width?: number;
    height?: number;
}
export interface ScrollContainer2DProperties extends Group2DProperties {
    scrollY?: number;
    dragScrollEnabled?: boolean;
    wheelScrollEnabled?: boolean;
    inertiaEnabled?: boolean;
    showScrollbar?: boolean;
    wheelSensitivity?: number;
    dragThreshold?: number;
    inertiaDamping?: number;
    scrollbarWidth?: number;
    scrollbarMinHeight?: number;
    scrollbarInset?: number;
    scrollbarColor?: string;
    scrollbarTrackColor?: string;
    scrollbarThumbTexture?: TextureResourceRef | string | null;
    scrollbarTrackTexture?: TextureResourceRef | string | null;
}
export interface ParseSceneOptions {
    filePath?: string;
    instanceStack?: string[];
}
export declare class SceneLoader {
    private readonly assetLoader;
    private readonly scriptRegistry;
    private readonly resourceManager;
    constructor(assetLoader: AssetLoader, scriptRegistry: ScriptRegistry, resourceManager: ResourceManager);
    parseScene(sceneText: string, options?: ParseSceneOptions): Promise<SceneGraph>;
    private instantiateNode;
    /**
     * Instantiate a prefab scene (`.pix3scene` with exactly one root node) as a
     * fresh subtree with unique runtime ids derived from `instanceId`. This is
     * the runtime-spawn entry point (Godot `PackedScene.instantiate()`); the
     * caller owns attaching the returned root to a live parent.
     */
    instantiatePrefab(instancePath: string, instanceId: string): Promise<NodeBase>;
    private instantiateInstanceNode;
    private normalizeInstancePath;
    private normalizeLocalId;
    private addGroupsFromDefinition;
    private mergeMetadata;
    private registerSubtree;
    private cloneNodeWithRuntimeIds;
    private createPrefabMarker;
    private populateNodeComponents;
    /**
     * Attach parked components whose script type has since been registered — see
     * {@link resolvePendingComponents}.
     */
    resolvePendingComponents(roots: Iterable<NodeBase>): number;
    private generateUniqueRuntimeNodeId;
    private remapNodeReferences;
    private remapPropertiesBySchema;
    private snapshotPrefabBaseProperties;
    private captureNodeComparableProperties;
    private applyInstanceOverrides;
    private applyLegacyInstanceRootProperties;
    private applyTransformOverride;
    private normalizePropertyValue;
    private walkSubtree;
    private getPrefabMarker;
    private cloneValue;
    createNodeFromDefinition(definition: SceneNodeDefinition): Promise<NodeBase>;
    /**
     * Resolves a SpineSkeleton2D's skeleton + atlas and installs it on the node.
     * A missing/broken asset only warns — the node stays in the scene with its
     * authored paths so the inspector can fix them.
     */
    loadSpineSkeleton2DAsset(skeleton: SpineSkeleton2D): Promise<void>;
    private loadAnimatedSprite2DAsset;
    private parseNode3DTransforms;
    private readVector3;
    /**
     * The four `sliceBorder*` scalars a skinned 2D control writes, read back as one
     * border. Same YAML spelling `TiledSprite2D` uses, so a skin authored once can be
     * pasted between a panel and a button.
     */
    /**
     * The caption style every `UIControl2D` shares: family, size, colour, weight and the sticker
     * decoration (outline + drop shadow + tracking) the UI kit's captions are drawn with. One
     * reader, because six node types load the same block and a seventh will too.
     */
    private readLabelStyle;
    private readSliceBorder;
    private readVector2;
    /**
     * Coerce a serialized `material.effects` array into a typed config. Each entry
     * needs a `type` (registry id); `enabled` defaults to true; `params` are passed
     * through as a record and coerced per param-type by the node on attach. Unknown
     * types are dropped by the node with a warning. Non-array input → no effects.
     */
    private parseGeometryMeshEffects;
    private readRotationOrder;
    private asNumber;
    private asPositiveInteger;
    private asRecord;
    private asString;
    /**
     * Container flow (`Node2DFlowConfig`): a stacked column/row, as opposed to `layout`, which
     * anchors ONE node to its parent's edges. Absent or `enabled: false` ⇒ children keep the
     * positions they were authored at.
     */
    private parseNode2DFlow;
    private parseNode2DLayout;
}
