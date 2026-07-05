import { parse } from 'yaml';
import { Euler, MathUtils, Vector2, Vector3 } from 'three';

import { NodeBase, type NodeBaseProps } from '../nodes/NodeBase';
import { Node3D } from '../nodes/Node3D';
import { MeshInstance } from '../nodes/3D/MeshInstance';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { TiledSprite2D } from '../nodes/2D/TiledSprite2D';
import type { TiledSpriteAxisStretch, TiledSpritePatchMode } from './tiled-sprite-geometry';
import { Group2D } from '../nodes/2D/Group2D';
import { DirectionalLightNode } from '../nodes/3D/DirectionalLightNode';
import { PointLightNode } from '../nodes/3D/PointLightNode';
import { SpotLightNode } from '../nodes/3D/SpotLightNode';
import { AmbientLightNode } from '../nodes/3D/AmbientLightNode';
import { HemisphereLightNode } from '../nodes/3D/HemisphereLightNode';
import { Sprite3D } from '../nodes/3D/Sprite3D';
import { AnimatedSprite3D } from '../nodes/3D/AnimatedSprite3D';
import { Particles3D } from '../nodes/3D/Particles3D';
import { Joystick2D } from '../nodes/2D/UI/Joystick2D';
import { Button2D, type Button2DSpriteState } from '../nodes/2D/UI/Button2D';
import { Slider2D } from '../nodes/2D/UI/Slider2D';
import { Bar2D } from '../nodes/2D/UI/Bar2D';
import { Checkbox2D } from '../nodes/2D/UI/Checkbox2D';
import { InventorySlot2D } from '../nodes/2D/UI/InventorySlot2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import { ScrollContainer2D } from '../nodes/2D/UI/ScrollContainer2D';
import { AudioPlayer } from '../nodes/AudioPlayer';
import type { SceneGraph } from './SceneManager';

import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { InstancedMesh3D } from '../nodes/3D/InstancedMesh3D';

import { Camera3D } from '../nodes/3D/Camera3D';

import { Node2D, type Node2DLayoutConfig } from '../nodes/Node2D';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { ScriptRegistry } from './ScriptRegistry';
import { coerceTextureResource, type TextureResourceRef } from './TextureResource';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import type { PropertyDefinition } from '../fw/property-schema';
import { getAnimationFrameTexturePath } from './AnimationResource';

const ZERO_VECTOR3 = new Vector3(0, 0, 0);
const UNIT_VECTOR3 = new Vector3(1, 1, 1);
const ZERO_VECTOR2 = new Vector2(0, 0);
const UNIT_VECTOR2 = new Vector2(1, 1);

export class SceneValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[]) {
    super(message);
    this.name = 'SceneValidationError';
    this.details = details;
  }
}

export interface ComponentDefinition {
  id?: string;
  type: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

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
  material?: { color?: string; roughness?: number; metalness?: number; type?: string };
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
  emitterBoxSize?: [number, number, number] | { x: number; y: number; z: number };
  particleShape?: 'plane' | 'sphere' | 'cube';
  emissionRate?: number;
  maxParticles?: number;
  lifetime?: number;
  speed?: number;
  speedSpread?: number;
  gravity?: [number, number, number] | { x: number; y: number; z: number };
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

interface PrefabMarkerMetadata {
  localId: string;
  effectiveLocalId: string;
  instanceRootId: string;
  sourcePath: string;
  basePropertiesByLocalId?: Record<string, Record<string, unknown>>;
}

export class SceneLoader {
  private readonly assetLoader: AssetLoader;
  private readonly scriptRegistry: ScriptRegistry;
  private readonly resourceManager: ResourceManager;

  constructor(
    assetLoader: AssetLoader,
    scriptRegistry: ScriptRegistry,
    resourceManager: ResourceManager
  ) {
    this.assetLoader = assetLoader;
    this.scriptRegistry = scriptRegistry;
    this.resourceManager = resourceManager;
  }

  async parseScene(sceneText: string, options: ParseSceneOptions = {}): Promise<SceneGraph> {
    let document: SceneDocument;

    console.debug('[SceneLoader.parseScene] Starting parse', {
      contentLength: sceneText.length,
      contentPreview: sceneText.substring(0, 100),
      filePath: options.filePath,
    });

    try {
      document = parse(sceneText) as SceneDocument;
    } catch (error) {
      throw new SceneValidationError(
        `Failed to parse scene YAML${options.filePath ? ` (${options.filePath})` : ''}.`,
        [(error as Error).message]
      );
    }

    // Handle null document (empty or invalid YAML)
    if (!document) {
      console.error('[SceneLoader.parseScene] YAML parser returned null', {
        contentLength: sceneText.length,
        contentPreview: sceneText.substring(0, 100),
        filePath: options.filePath,
      });
      throw new SceneValidationError(
        `Scene document is empty or invalid${options.filePath ? ` (${options.filePath})` : ''}.`,
        ['The YAML parser returned null or undefined']
      );
    }

    const nodeIndex = new Map<string, NodeBase>();
    const rootNodes: NodeBase[] = [];
    const instanceStack = [...(options.instanceStack ?? [])];

    for (const definition of document.root ?? []) {
      const rootNode = await this.instantiateNode(
        definition,
        null,
        nodeIndex,
        options.filePath ?? 'unknown',
        instanceStack
      );
      rootNodes.push(rootNode);
    }

    return {
      version: document.version,
      description: document.description,
      metadata: document.metadata ?? {},
      rootNodes,
      nodeMap: nodeIndex,
    };
  }

  private async instantiateNode(
    definition: SceneNodeDefinition,
    parent: NodeBase | null,
    index: Map<string, NodeBase>,
    sceneIdentifier: string,
    instanceStack: string[]
  ): Promise<NodeBase> {
    if (definition.instance) {
      return await this.instantiateInstanceNode(
        definition,
        parent,
        index,
        sceneIdentifier,
        instanceStack
      );
    }

    if (index.has(definition.id)) {
      throw new SceneValidationError(`Duplicate node id "${definition.id}" detected.`, [
        sceneIdentifier,
      ]);
    }

    const node = await this.createNodeFromDefinition(definition);
    if (Array.isArray(definition.groups)) {
      for (const group of definition.groups) {
        if (typeof group === 'string' && group.trim().length > 0) {
          node.addToGroup(group);
        }
      }
    }
    index.set(node.nodeId, node);

    // Load components
    if (definition.components) {
      for (const componentDef of definition.components) {
        const componentId =
          componentDef.id || `${definition.id}-${componentDef.type}-${Date.now()}`;
        const component = this.scriptRegistry.createComponent(componentDef.type, componentId);

        if (component) {
          component.enabled = componentDef.enabled ?? true;

          const configData = componentDef.config ?? {};
          component.config = { ...configData };

          // Set config values using PropertySchema if available
          const schema = this.scriptRegistry.getComponentPropertySchema(componentDef.type);
          if (schema && configData) {
            for (const prop of schema.properties) {
              if (configData[prop.name] !== undefined) {
                prop.setValue(component, configData[prop.name]);
              }
            }
          }

          node.addComponent(component);
        } else {
          console.warn(
            `[SceneLoader] Failed to create component "${componentDef.type}" for node "${definition.id}"`
          );
        }
      }
    }

    if (parent) {
      parent.adoptChild(node);
    }

    const childDefinitions = definition.children ?? [];
    for (const childDef of childDefinitions) {
      await this.instantiateNode(childDef, node, index, sceneIdentifier, instanceStack);
    }

    return node;
  }

  private async instantiateInstanceNode(
    definition: SceneNodeDefinition,
    parent: NodeBase | null,
    index: Map<string, NodeBase>,
    sceneIdentifier: string,
    instanceStack: string[]
  ): Promise<NodeBase> {
    if (index.has(definition.id)) {
      throw new SceneValidationError(`Duplicate node id "${definition.id}" detected.`, [
        sceneIdentifier,
      ]);
    }

    const instancePath = definition.instance;
    if (!instancePath) {
      throw new SceneValidationError('Instance node is missing an instance path.', [
        sceneIdentifier,
      ]);
    }

    const normalizedInstancePath = this.normalizeInstancePath(instancePath);
    if (instanceStack.includes(normalizedInstancePath)) {
      const cycle = [...instanceStack, normalizedInstancePath].join(' -> ');
      throw new SceneValidationError(`Instance cycle detected for "${normalizedInstancePath}".`, [
        cycle,
      ]);
    }

    const nestedStack = [...instanceStack, normalizedInstancePath];
    const prefabText = await this.resourceManager.readText(normalizedInstancePath);
    const prefabGraph = await this.parseScene(prefabText, {
      filePath: normalizedInstancePath,
      instanceStack: nestedStack,
    });

    if (!prefabGraph.rootNodes.length) {
      throw new SceneValidationError(`Instance "${normalizedInstancePath}" has no root nodes.`, [
        sceneIdentifier,
      ]);
    }

    if (prefabGraph.rootNodes.length > 1) {
      throw new SceneValidationError(
        `Instance "${normalizedInstancePath}" must contain exactly one root node.`,
        [sceneIdentifier]
      );
    }

    const sourceRoot = prefabGraph.rootNodes[0];
    // Reserve every id already present in the destination parse index plus the
    // instance root id, so ids minted during this clone are unique against each
    // other AND against nodes already loaded in the scene (clones aren't written
    // to `index` until registerSubtree runs at the very end).
    const reservedIds = new Set<string>(index.keys());
    reservedIds.add(definition.id);
    const clonedRoot = await this.cloneNodeWithRuntimeIds(
      sourceRoot,
      definition.id,
      index,
      definition.id,
      normalizedInstancePath,
      this.normalizeLocalId(sourceRoot.nodeId),
      normalizedInstancePath,
      reservedIds
    );

    clonedRoot.name = definition.name ?? clonedRoot.name;
    this.addGroupsFromDefinition(clonedRoot, definition);
    this.mergeMetadata(clonedRoot, definition.metadata ?? {});
    this.remapNodeReferences(clonedRoot);
    this.snapshotPrefabBaseProperties(clonedRoot);
    this.applyLegacyInstanceRootProperties(clonedRoot, definition.properties ?? {});
    this.applyInstanceOverrides(clonedRoot, definition.overrides ?? null);

    if (parent) {
      parent.adoptChild(clonedRoot);
    }

    this.registerSubtree(index, clonedRoot, sceneIdentifier);
    return clonedRoot;
  }

  private normalizeInstancePath(path: string): string {
    return path.replace(/\\/g, '/').trim();
  }

  private normalizeLocalId(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  }

  private addGroupsFromDefinition(node: NodeBase, definition: SceneNodeDefinition): void {
    if (!Array.isArray(definition.groups)) {
      return;
    }

    for (const group of definition.groups) {
      if (typeof group === 'string' && group.trim().length > 0) {
        node.addToGroup(group);
      }
    }
  }

  private mergeMetadata(node: NodeBase, metadata: Record<string, unknown>): void {
    Object.assign(node.metadata, metadata);
  }

  private registerSubtree(
    index: Map<string, NodeBase>,
    root: NodeBase,
    sceneIdentifier: string
  ): void {
    const stack: NodeBase[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }

      if (index.has(node.nodeId)) {
        throw new SceneValidationError(`Duplicate node id "${node.nodeId}" detected.`, [
          sceneIdentifier,
        ]);
      }

      index.set(node.nodeId, node);
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
  }

  private async cloneNodeWithRuntimeIds(
    sourceNode: NodeBase,
    runtimeId: string,
    globalIndex: Map<string, NodeBase>,
    instanceRootId: string,
    sourcePath: string,
    effectiveLocalId: string,
    rootInstancePath: string | null,
    reservedIds: Set<string>
  ): Promise<NodeBase> {
    const sourceMarker = this.getPrefabMarker(sourceNode);
    const localId = this.normalizeLocalId(sourceMarker?.localId ?? sourceNode.nodeId);
    const sourcePathForNode = sourceMarker?.sourcePath ?? sourcePath;

    const definition: SceneNodeDefinition = {
      id: runtimeId,
      type: sourceNode.type,
      name: sourceNode.name,
      instancePath:
        runtimeId === instanceRootId
          ? (rootInstancePath ?? sourceNode.instancePath ?? undefined)
          : (sourceNode.instancePath ?? undefined),
      groups: Array.from(sourceNode.groups),
      properties: this.captureNodeComparableProperties(sourceNode),
      metadata: {
        ...sourceNode.metadata,
      },
      components: sourceNode.components.map(component => ({
        id: component.id,
        type: component.type,
        enabled: component.enabled,
        config: { ...(component.config ?? {}) },
      })),
    };

    const marker = this.createPrefabMarker({
      localId,
      effectiveLocalId,
      instanceRootId,
      sourcePath: sourcePathForNode,
    });
    const metadataWithMarker = definition.metadata ?? {};
    metadataWithMarker.__pix3Prefab = marker;
    definition.metadata = metadataWithMarker;

    const node = await this.createNodeFromDefinition(definition);
    this.populateNodeComponents(node, definition.components ?? []);

    for (const child of sourceNode.children) {
      if (!(child instanceof NodeBase)) {
        continue;
      }

      const childRuntimeId = this.generateUniqueRuntimeNodeId(
        this.normalizeLocalId(child.nodeId),
        globalIndex,
        reservedIds
      );
      const childSourceMarker = this.getPrefabMarker(child);
      const childLocalId = this.normalizeLocalId(childSourceMarker?.localId ?? child.nodeId);
      const childEffectiveLocalId = `${effectiveLocalId}/${childLocalId}`;
      const clonedChild = await this.cloneNodeWithRuntimeIds(
        child,
        childRuntimeId,
        globalIndex,
        instanceRootId,
        sourcePathForNode,
        childEffectiveLocalId,
        null,
        reservedIds
      );
      node.adoptChild(clonedChild);
    }

    return node;
  }

  private createPrefabMarker(input: {
    localId: string;
    effectiveLocalId: string;
    instanceRootId: string;
    sourcePath: string;
  }): PrefabMarkerMetadata {
    return {
      localId: this.normalizeLocalId(input.localId),
      effectiveLocalId: this.normalizeLocalId(input.effectiveLocalId),
      instanceRootId: input.instanceRootId,
      sourcePath: input.sourcePath,
    };
  }

  private populateNodeComponents(
    node: NodeBase,
    componentDefinitions: ComponentDefinition[]
  ): void {
    for (const componentDef of componentDefinitions) {
      const componentId = componentDef.id || `${node.nodeId}-${componentDef.type}-${Date.now()}`;
      const component = this.scriptRegistry.createComponent(componentDef.type, componentId);
      if (!component) {
        continue;
      }

      component.enabled = componentDef.enabled ?? true;
      const configData = componentDef.config ?? {};
      component.config = { ...configData };

      const schema = this.scriptRegistry.getComponentPropertySchema(componentDef.type);
      if (schema && configData) {
        for (const prop of schema.properties) {
          if (configData[prop.name] !== undefined) {
            prop.setValue(component, configData[prop.name]);
          }
        }
      }

      node.addComponent(component);
    }
  }

  private generateUniqueRuntimeNodeId(
    seed: string,
    globalIndex: Map<string, NodeBase>,
    reserved: Set<string>
  ): string {
    const base = seed.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'node';
    let nextId = base;
    let counter = 1;

    while (globalIndex.has(nextId) || reserved.has(nextId)) {
      nextId = `${base}-${counter}`;
      counter += 1;
    }

    reserved.add(nextId);
    return nextId;
  }

  private remapNodeReferences(root: NodeBase): void {
    const remapBySourcePath = new Map<string, Map<string, string>>();
    const remapByEffective = new Map<string, string>();

    this.walkSubtree(root, node => {
      const marker = this.getPrefabMarker(node);
      if (!marker) {
        return;
      }

      if (!remapBySourcePath.has(marker.sourcePath)) {
        remapBySourcePath.set(marker.sourcePath, new Map<string, string>());
      }
      remapBySourcePath.get(marker.sourcePath)?.set(marker.localId, node.nodeId);
      remapByEffective.set(marker.effectiveLocalId, node.nodeId);
    });

    this.walkSubtree(root, node => {
      const marker = this.getPrefabMarker(node);
      const sourceMap = marker ? (remapBySourcePath.get(marker.sourcePath) ?? null) : null;

      const schema = getNodePropertySchema(node);
      this.remapPropertiesBySchema(node, schema.properties, sourceMap, remapByEffective);

      for (const component of node.components) {
        const componentSchema = this.scriptRegistry.getComponentPropertySchema(component.type);
        if (!componentSchema) {
          continue;
        }
        this.remapPropertiesBySchema(
          component,
          componentSchema.properties,
          sourceMap,
          remapByEffective
        );
      }
    });
  }

  private remapPropertiesBySchema(
    target: unknown,
    properties: PropertyDefinition[],
    sourceMap: Map<string, string> | null,
    effectiveMap: Map<string, string>
  ): void {
    for (const prop of properties) {
      if (prop.type !== 'node') {
        continue;
      }

      const currentValue = prop.getValue(target);
      if (typeof currentValue !== 'string' || !currentValue.trim()) {
        continue;
      }

      const mappedValue =
        (sourceMap ? sourceMap.get(this.normalizeLocalId(currentValue)) : undefined) ??
        effectiveMap.get(this.normalizeLocalId(currentValue));

      if (mappedValue && mappedValue !== currentValue) {
        prop.setValue(target, mappedValue);
      }
    }
  }

  private snapshotPrefabBaseProperties(root: NodeBase): void {
    const basePropertiesByLocalId: Record<string, Record<string, unknown>> = {};
    this.walkSubtree(root, node => {
      const marker = this.getPrefabMarker(node);
      if (!marker) {
        return;
      }
      basePropertiesByLocalId[marker.effectiveLocalId] = this.captureNodeComparableProperties(node);
    });

    const rootMarker = this.getPrefabMarker(root);
    if (!rootMarker) {
      return;
    }

    const nextMarker: PrefabMarkerMetadata = {
      ...rootMarker,
      basePropertiesByLocalId,
    };
    (root.metadata as Record<string, unknown>).__pix3Prefab = nextMarker;
  }

  private captureNodeComparableProperties(node: NodeBase): Record<string, unknown> {
    const schema = getNodePropertySchema(node);
    const result: Record<string, unknown> = {};
    for (const prop of schema.properties) {
      // Skip only STATICALLY read-only props (identity/derived). A function
      // `readOnly` marks a conditionally-editable real value (e.g. 2D anchor
      // align gated on layoutEnabled) and must be captured for the prefab base
      // snapshot so instance override diffs stay correct. See SceneSaver.
      if (prop.ui?.hidden || prop.ui?.readOnly === true) {
        continue;
      }
      result[prop.name] = this.cloneValue(prop.getValue(node));
    }
    return result;
  }

  private applyInstanceOverrides(root: NodeBase, overrides: InstanceOverrides | null): void {
    if (!overrides || !overrides.byLocalId) {
      return;
    }

    const map = new Map<string, NodeBase>();
    this.walkSubtree(root, node => {
      const marker = this.getPrefabMarker(node);
      if (marker) {
        map.set(marker.effectiveLocalId, node);
      }
    });

    const rootMarker = this.getPrefabMarker(root);
    const rootPrefix = rootMarker?.effectiveLocalId ?? '';

    for (const [effectiveLocalId, entry] of Object.entries(overrides.byLocalId)) {
      const normalizedKey = this.normalizeLocalId(effectiveLocalId);
      // Overrides are serialized root-relative (SceneSaver strips the root
      // prefix), so re-add it FIRST. Trying the prefixed key before the raw key
      // avoids the nested-prefab ambiguity where a stripped key like
      // "root/child" could either be a root-relative path or a full path — the
      // prefixed form ("<rootPrefix>/root/child") is the correct target, and the
      // raw key remains as a fallback for legacy unstripped/full keys.
      const prefixedKey =
        rootPrefix && normalizedKey !== rootPrefix
          ? `${rootPrefix}/${normalizedKey}`
          : normalizedKey;
      const target = map.get(prefixedKey) ?? map.get(normalizedKey);
      if (!target) {
        console.warn(`[SceneLoader] Override target "${effectiveLocalId}" not found in instance.`);
        continue;
      }
      this.applyLegacyInstanceRootProperties(target, entry.properties ?? {});
    }
  }

  private applyLegacyInstanceRootProperties(
    node: NodeBase,
    properties: Record<string, unknown>
  ): void {
    if (!properties || Object.keys(properties).length === 0) {
      return;
    }

    const schema = getNodePropertySchema(node);
    const byName = new Map(schema.properties.map(prop => [prop.name, prop] as const));

    for (const [key, rawValue] of Object.entries(properties)) {
      if (key === 'transform') {
        this.applyTransformOverride(node, byName, rawValue);
        continue;
      }

      const prop = byName.get(key);
      if (!prop) {
        node.properties[key] = this.cloneValue(rawValue);
        continue;
      }

      prop.setValue(node, this.normalizePropertyValue(rawValue, prop));
    }
  }

  private applyTransformOverride(
    node: NodeBase,
    byName: Map<string, PropertyDefinition>,
    transformValue: unknown
  ): void {
    const transform = this.asRecord(transformValue);
    if (!transform) {
      return;
    }

    const position = transform.position ?? transform.translate;
    const rotation = transform.rotationEuler ?? transform.rotation ?? transform.euler;
    const scale = transform.scale;

    const positionProp = byName.get('position');
    if (positionProp && position !== undefined) {
      positionProp.setValue(node, this.normalizePropertyValue(position, positionProp));
    }

    const rotationProp = byName.get('rotation');
    if (rotationProp && rotation !== undefined) {
      rotationProp.setValue(node, this.normalizePropertyValue(rotation, rotationProp));
    }

    const scaleProp = byName.get('scale');
    if (scaleProp && scale !== undefined) {
      scaleProp.setValue(node, this.normalizePropertyValue(scale, scaleProp));
    }
  }

  private normalizePropertyValue(value: unknown, prop: PropertyDefinition): unknown {
    if (prop.type === 'vector2') {
      const vector = this.readVector2(value, ZERO_VECTOR2);
      return { x: vector.x, y: vector.y };
    }

    if (prop.type === 'vector3' || prop.type === 'euler') {
      const vector = this.readVector3(value, ZERO_VECTOR3);
      return { x: vector.x, y: vector.y, z: vector.z };
    }

    return value;
  }

  private walkSubtree(root: NodeBase, visitor: (node: NodeBase) => void): void {
    const stack: NodeBase[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      visitor(node);
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
  }

  private getPrefabMarker(node: NodeBase): PrefabMarkerMetadata | null {
    const metadata = node.metadata as Record<string, unknown>;
    const markerCandidate = metadata.__pix3Prefab;
    if (!markerCandidate || typeof markerCandidate !== 'object') {
      return null;
    }
    const marker = markerCandidate as Partial<PrefabMarkerMetadata>;
    if (
      typeof marker.localId !== 'string' ||
      typeof marker.effectiveLocalId !== 'string' ||
      typeof marker.instanceRootId !== 'string' ||
      typeof marker.sourcePath !== 'string'
    ) {
      return null;
    }
    return marker as PrefabMarkerMetadata;
  }

  private cloneValue<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    return JSON.parse(JSON.stringify(value)) as T;
  }

  async createNodeFromDefinition(definition: SceneNodeDefinition): Promise<NodeBase> {
    const baseProps: NodeBaseProps = {
      id: definition.id,
      name: definition.name,
      instancePath: definition.instancePath ?? null,
      properties: { ...(definition.properties ?? {}) },
      metadata: definition.metadata ?? {},
    };

    switch (definition.type) {
      case 'ColorRect2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new ColorRect2D({
          ...baseProps,
          properties: props,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          color: typeof props.color === 'string' ? props.color : undefined,
          opacity: typeof props.opacity === 'number' ? props.opacity : undefined,
        });
      }
      case 'AnimatedSprite2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        const animationResourcePath =
          typeof props.animationResourcePath === 'string' &&
          props.animationResourcePath.trim().length > 0
            ? props.animationResourcePath.trim()
            : null;

        const sprite = new AnimatedSprite2D({
          ...baseProps,
          properties: props,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          animationResourcePath,
          currentClip: typeof props.currentClip === 'string' ? props.currentClip : undefined,
          isPlaying: typeof props.isPlaying === 'boolean' ? props.isPlaying : undefined,
          currentFrame: typeof props.currentFrame === 'number' ? props.currentFrame : undefined,
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          color: typeof props.color === 'string' ? props.color : undefined,
        });

        if (animationResourcePath) {
          void this.loadAnimatedSprite2DAsset(sprite, animationResourcePath);
        }

        return sprite;
      }
      case 'Sprite2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        const texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
        const texturePath = texture?.url ?? null;

        const sprite = new Sprite2D({
          ...baseProps,
          properties: props,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          texture,
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          aspectRatioLocked:
            typeof props.aspectRatioLocked === 'boolean' ? props.aspectRatioLocked : undefined,
          anchor: this.readVector2(props.anchor, new Vector2(0.5, 0.5)),
          color: typeof props.color === 'string' ? props.color : undefined,
        });

        if (texturePath) {
          try {
            const texture = await this.assetLoader.loadTexture(texturePath);
            sprite.setTexture(texture);
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading texture for Sprite2D "${sprite.nodeId}":`,
              error
            );
          }
        }

        return sprite;
      }
      case 'TiledSprite2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        const texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
        const texturePath = texture?.url ?? null;

        const node = new TiledSprite2D({
          ...baseProps,
          properties: props,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          texture,
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          patchMode:
            typeof props.patchMode === 'string'
              ? (props.patchMode as TiledSpritePatchMode)
              : undefined,
          sliceBorder: {
            left: this.asNumber(props.sliceBorderLeft, 0),
            right: this.asNumber(props.sliceBorderRight, 0),
            top: this.asNumber(props.sliceBorderTop, 0),
            bottom: this.asNumber(props.sliceBorderBottom, 0),
          },
          drawCenter: typeof props.drawCenter === 'boolean' ? props.drawCenter : undefined,
          axisStretchHorizontal:
            typeof props.axisStretchHorizontal === 'string'
              ? (props.axisStretchHorizontal as TiledSpriteAxisStretch)
              : undefined,
          axisStretchVertical:
            typeof props.axisStretchVertical === 'string'
              ? (props.axisStretchVertical as TiledSpriteAxisStretch)
              : undefined,
          tileScale: this.readVector2(props.tileScale, new Vector2(1, 1)),
          tileOffset: this.readVector2(props.tileOffset, ZERO_VECTOR2),
          anchor: this.readVector2(props.anchor, new Vector2(0.5, 0.5)),
          color: typeof props.color === 'string' ? props.color : undefined,
        });

        if (texturePath) {
          try {
            const loadedTexture = await this.assetLoader.loadTexture(texturePath);
            node.setTexture(loadedTexture);
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading texture for TiledSprite2D "${node.nodeId}":`,
              error
            );
          }
        }

        return node;
      }
      case 'AudioPlayer': {
        const props = baseProps.properties as Record<string, unknown>;
        return new AudioPlayer({
          ...baseProps,
          audioTrack: this.asString(props.audioTrack),
          autoplay: typeof props.autoplay === 'boolean' ? props.autoplay : undefined,
          loop: typeof props.loop === 'boolean' ? props.loop : undefined,
          volume: this.asNumber(props.volume, undefined),
        });
      }
      case 'Group':
        return new NodeBase({ ...baseProps, type: 'Group' });
      case 'Node3D':
      case undefined: {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        return new Node3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
        });
      }
      case 'Node2D': {
        const props = baseProps.properties as Node2DProperties;
        return new Node2D({
          ...baseProps,
          position: this.readVector2(props.position, ZERO_VECTOR2),
          scale: this.readVector2(props.scale, UNIT_VECTOR2),
          rotation: props.rotation ?? 0,
          layout: this.parseNode2DLayout(baseProps.properties as Record<string, unknown>),
          opacity: this.asNumber(props.opacity, undefined),
        });
      }
      case 'Layout2D': {
        throw new SceneValidationError('Layout2D nodes are no longer supported.', [
          `Node ${definition.id} still uses legacy type Layout2D. Replace it with root Node2D/Group2D anchors and project viewport settings.`,
        ]);
      }
      case 'Group2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);

        return new Group2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, 100),
          height: this.asNumber(props.height, 100),
        });
      }
      case 'ScrollContainer2D': {
        const props = baseProps.properties as ScrollContainer2DProperties & Record<string, unknown>;
        const transform = this.asRecord(props.transform);

        const thumbTexture = coerceTextureResource(props.scrollbarThumbTexture ?? null);
        const trackTexture = coerceTextureResource(props.scrollbarTrackTexture ?? null);

        const container = new ScrollContainer2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, 100),
          height: this.asNumber(props.height, 100),
          scrollY: this.asNumber(props.scrollY, 0),
          dragScrollEnabled:
            typeof props.dragScrollEnabled === 'boolean' ? props.dragScrollEnabled : undefined,
          wheelScrollEnabled:
            typeof props.wheelScrollEnabled === 'boolean' ? props.wheelScrollEnabled : undefined,
          inertiaEnabled:
            typeof props.inertiaEnabled === 'boolean' ? props.inertiaEnabled : undefined,
          showScrollbar: typeof props.showScrollbar === 'boolean' ? props.showScrollbar : undefined,
          wheelSensitivity: this.asNumber(props.wheelSensitivity, undefined),
          dragThreshold: this.asNumber(props.dragThreshold, undefined),
          inertiaDamping: this.asNumber(props.inertiaDamping, undefined),
          scrollbarWidth: this.asNumber(props.scrollbarWidth, undefined),
          scrollbarMinHeight: this.asNumber(props.scrollbarMinHeight, undefined),
          scrollbarInset: this.asNumber(props.scrollbarInset, undefined),
          scrollbarColor: this.asString(props.scrollbarColor),
          scrollbarTrackColor: this.asString(props.scrollbarTrackColor),
          scrollbarThumbTexture: thumbTexture,
          scrollbarTrackTexture: trackTexture,
        });

        if (thumbTexture) {
          try {
            container.setScrollbarThumbTexture(await this.assetLoader.loadTexture(thumbTexture.url));
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading scrollbar thumb texture for ScrollContainer2D "${container.nodeId}":`,
              error
            );
          }
        }
        if (trackTexture) {
          try {
            container.setScrollbarTrackTexture(await this.assetLoader.loadTexture(trackTexture.url));
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading scrollbar track texture for ScrollContainer2D "${container.nodeId}":`,
              error
            );
          }
        }

        return container;
      }
      case 'Joystick2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new Joystick2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          radius: this.asNumber(props.radius, undefined),
          handleRadius: this.asNumber(props.handleRadius, undefined),
          axisHorizontal: this.asString(props.axisHorizontal),
          axisVertical: this.asString(props.axisVertical),
          baseColor: this.asString(props.baseColor),
          handleColor: this.asString(props.handleColor),
          floating: typeof props.floating === 'boolean' ? props.floating : undefined,
        });
      }
      case 'Button2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);

        const stateRefs: Array<[Button2DSpriteState, TextureResourceRef | null]> = [
          ['normal', coerceTextureResource(props.textureNormal ?? null)],
          ['hover', coerceTextureResource(props.textureHover ?? null)],
          ['pressed', coerceTextureResource(props.texturePressed ?? null)],
          ['disabled', coerceTextureResource(props.textureDisabled ?? null)],
        ];

        const button = new Button2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          backgroundColor: this.asString(props.backgroundColor),
          hoverColor: this.asString(props.hoverColor),
          pressedColor: this.asString(props.pressedColor),
          buttonAction: this.asString(props.buttonAction),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          texturePath: this.asString(props.texturePath),
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
          textureNormal: stateRefs[0][1],
          textureHover: stateRefs[1][1],
          texturePressed: stateRefs[2][1],
          textureDisabled: stateRefs[3][1],
        });

        for (const [state, ref] of stateRefs) {
          if (!ref) {
            continue;
          }
          try {
            button.setStateTexture(state, await this.assetLoader.loadTexture(ref.url));
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading ${state} texture for Button2D "${button.nodeId}":`,
              error
            );
          }
        }

        return button;
      }
      case 'Label2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new Label2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
        });
      }
      case 'Slider2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new Slider2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          handleSize: this.asNumber(props.handleSize, undefined),
          trackBackgroundColor: this.asString(props.trackBackgroundColor),
          trackFilledColor: this.asString(props.trackFilledColor),
          handleColor: this.asString(props.handleColor),
          minValue: this.asNumber(props.minValue, undefined),
          maxValue: this.asNumber(props.maxValue, undefined),
          value: this.asNumber(props.value, undefined),
          axisName: this.asString(props.axisName),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          texturePath: this.asString(props.texturePath),
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
        });
      }
      case 'Bar2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new Bar2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          backBackgroundColor: this.asString(props.backBackgroundColor),
          barColor: this.asString(props.barColor),
          minValue: this.asNumber(props.minValue, undefined),
          maxValue: this.asNumber(props.maxValue, undefined),
          value: this.asNumber(props.value, undefined),
          showBorder: typeof props.showBorder === 'boolean' ? props.showBorder : undefined,
          borderColor: this.asString(props.borderColor),
          borderWidth: this.asNumber(props.borderWidth, undefined),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          texturePath: this.asString(props.texturePath),
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
        });
      }
      case 'Checkbox2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new Checkbox2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          size: this.asNumber(props.size, undefined),
          checked: typeof props.checked === 'boolean' ? props.checked : undefined,
          uncheckedColor: this.asString(props.uncheckedColor),
          checkedColor: this.asString(props.checkedColor),
          checkmarkColor: this.asString(props.checkmarkColor),
          checkmarkAction: this.asString(props.checkmarkAction),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          texturePath: this.asString(props.texturePath),
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
        });
      }
      case 'InventorySlot2D': {
        const props = baseProps.properties as Record<string, unknown>;
        const transform = this.asRecord(props.transform);
        return new InventorySlot2D({
          ...baseProps,
          position: this.readVector2(transform?.position ?? props.position, ZERO_VECTOR2),
          scale: this.readVector2(transform?.scale ?? props.scale, UNIT_VECTOR2),
          rotation:
            typeof (transform?.rotation ?? props.rotation) === 'number'
              ? ((transform?.rotation ?? props.rotation) as number)
              : 0,
          layout: this.parseNode2DLayout(props),
          opacity: this.asNumber(props.opacity, undefined),
          width: this.asNumber(props.width, undefined),
          height: this.asNumber(props.height, undefined),
          backdropColor: this.asString(props.backdropColor),
          borderColor: this.asString(props.borderColor),
          borderWidth: this.asNumber(props.borderWidth, undefined),
          quantity: this.asNumber(props.quantity, undefined),
          showQuantity: typeof props.showQuantity === 'boolean' ? props.showQuantity : undefined,
          quantityFontSize: this.asNumber(props.quantityFontSize, undefined),
          selectionColor: this.asString(props.selectionColor),
          selectedAction: this.asString(props.selectedAction),
          label: this.asString(props.label),
          labelFontFamily: this.asString(props.labelFontFamily),
          labelFontSize: this.asNumber(props.labelFontSize, undefined),
          labelColor: this.asString(props.labelColor),
          labelAlign: this.asString(props.labelAlign) as 'left' | 'center' | 'right' | undefined,
          texturePath: this.asString(props.texturePath),
          enabled: typeof props.enabled === 'boolean' ? props.enabled : undefined,
        });
      }
      case 'GeometryMesh': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const propsRec = baseProps.properties as Record<string, unknown>;
        const geometry = this.asString(propsRec.geometry) ?? 'box';
        const size = this.readVector3(propsRec.size, UNIT_VECTOR3);
        const material = this.asRecord(propsRec.material);
        const materialColor = this.asString(material?.color) ?? '#4e8df5';
        return new GeometryMesh({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          geometry,
          size: [size.x, size.y, size.z],
          material: { color: materialColor },
        });
      }
      case 'InstancedMesh3D': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as InstancedMesh3DProperties;
        const maxInstances = this.asPositiveInteger(props.maxInstances);

        if (maxInstances === null) {
          throw new SceneValidationError(
            `Node "${definition.id}" has invalid InstancedMesh3D.maxInstances value.`,
            ['maxInstances must be a positive integer.']
          );
        }

        return new InstancedMesh3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          maxInstances,
          castShadow: typeof props.castShadow === 'boolean' ? props.castShadow : false,
          receiveShadow: typeof props.receiveShadow === 'boolean' ? props.receiveShadow : false,
          enablePerInstanceColor:
            typeof props.enablePerInstanceColor === 'boolean'
              ? props.enablePerInstanceColor
              : false,
          frustumCulled: typeof props.frustumCulled === 'boolean' ? props.frustumCulled : undefined,
        });
      }
      case 'DirectionalLightNode': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as DirectionalLightNodeProperties;
        return new DirectionalLightNode({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          color: props.color ?? '#ffffff',
          intensity: props.intensity ?? 1,
          castShadow: typeof props.castShadow === 'boolean' ? props.castShadow : true,
          shadowCameraSize:
            typeof props.shadowCameraSize === 'number' ? props.shadowCameraSize : 20,
          shadowMapSize: typeof props.shadowMapSize === 'number' ? props.shadowMapSize : 2048,
        });
      }
      case 'PointLightNode': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as PointLightNodeProperties;
        return new PointLightNode({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          color: props.color ?? '#ffffff',
          intensity: props.intensity ?? 1,
          distance: props.distance ?? 0,
          decay: props.decay ?? 2,
          castShadow: typeof props.castShadow === 'boolean' ? props.castShadow : true,
        });
      }
      case 'SpotLightNode': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as SpotLightNodeProperties;
        return new SpotLightNode({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          color: props.color ?? '#ffffff',
          intensity: props.intensity ?? 1,
          distance: props.distance ?? 0,
          angle: typeof props.angle === 'number' ? (props.angle * Math.PI) / 180 : Math.PI / 3,
          penumbra: props.penumbra ?? 0,
          decay: props.decay ?? 2,
          castShadow: typeof props.castShadow === 'boolean' ? props.castShadow : true,
        });
      }
      case 'AmbientLightNode': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as AmbientLightNodeProperties;
        return new AmbientLightNode({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          color: props.color ?? '#ffffff',
          intensity: props.intensity ?? 0.5,
        });
      }
      case 'HemisphereLightNode': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as HemisphereLightNodeProperties;
        return new HemisphereLightNode({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          skyColor: props.skyColor ?? '#ffffff',
          groundColor: props.groundColor ?? '#444444',
          intensity: props.intensity ?? 0.5,
        });
      }
      case 'Camera3D': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as Camera3DProperties;
        return new Camera3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          projection: props.projection ?? 'perspective',
          fov: props.fov ?? 60,
          near: props.near ?? 0.1,
          far: props.far ?? 1000,
          orthographicSize: props.orthographicSize ?? 5,
        });
      }
      case 'MeshInstance': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as Record<string, unknown>;
        let src = this.asString(props['src']) ?? null;
        const castShadow = typeof props['castShadow'] === 'boolean' ? props['castShadow'] : true;
        const receiveShadow =
          typeof props['receiveShadow'] === 'boolean' ? props['receiveShadow'] : true;
        const initialAnimation = this.asString(props['initialAnimation']) ?? null;
        const isPlaying = typeof props['isPlaying'] === 'boolean' ? props['isPlaying'] : true;
        const isLoop = typeof props['isLoop'] === 'boolean' ? props['isLoop'] : true;

        const meshInstance = new MeshInstance({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          src,
          castShadow,
          receiveShadow,
          initialAnimation,
          isPlaying,
          isLoop,
        });

        // Load GLB/GLTF mesh and animations from resource manager
        if (src) {
          try {
            const assetLoaderResult = await this.assetLoader.loadAsset(src);
            const loadedNode = assetLoaderResult.node;

            // Add the loaded geometry to the mesh instance
            if (loadedNode.children && loadedNode.children.length > 0) {
              // Transfer children from loaded node to mesh instance
              for (const child of loadedNode.children) {
                meshInstance.add(child);
              }
            }

            // Transfer animations if available
            if ('animations' in loadedNode && Array.isArray(loadedNode.animations)) {
              meshInstance.animations = loadedNode.animations;
            }

            // Apply shadow properties to loaded children
            meshInstance.applyLoadedShadowProperties();

            // Show default animation at t=0 for editor and initial scene display
            meshInstance.showDefaultPose();
          } catch (error) {
            console.warn(`[SceneLoader] Error loading GLB model from "${src}":`, error);
          }
        }

        return meshInstance;
      }
      case 'AnimatedSprite3D': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as Record<string, unknown>;
        const frames = Array.isArray(props.frames) ? props.frames.map(coerceTextureResource) : [];

        const sprite = new AnimatedSprite3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          frames,
          width: this.asNumber(props.width, 1),
          height: this.asNumber(props.height, 1),
          color: this.asString(props.color) ?? '#ffffff',
          fps: typeof props.fps === 'number' ? props.fps : undefined,
          playing: typeof props.playing === 'boolean' ? props.playing : undefined,
          loop: typeof props.loop === 'boolean' ? props.loop : undefined,
          billboard: typeof props.billboard === 'boolean' ? props.billboard : false,
          opacity: this.asNumber(props.opacity, undefined),
        });

        // Load textures
        frames.forEach(async (frame, index) => {
          if (frame?.url) {
            try {
              const texture = await this.assetLoader.loadTexture(frame.url);
              sprite.setTextureForFrame(index, texture);
            } catch (error) {
              console.warn(
                `[SceneLoader] Error loading texture for AnimatedSprite3D "${sprite.nodeId}":`,
                error
              );
            }
          }
        });

        return sprite;
      }
      case 'Sprite3D': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as Sprite3DProperties;
        const texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
        const sprite = new Sprite3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          texture,
          width: this.asNumber(props.width, 1),
          height: this.asNumber(props.height, 1),
          color: this.asString(props.color) ?? '#ffffff',
          billboard: typeof props.billboard === 'boolean' ? props.billboard : false,
          billboardRoll: this.asNumber(props.billboardRoll, 0),
          opacity: this.asNumber(props.opacity, undefined),
        });

        if (sprite.texturePath) {
          try {
            const texture = await this.assetLoader.loadTexture(sprite.texturePath);
            sprite.setTexture(texture);
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading texture for Sprite3D "${sprite.nodeId}":`,
              error
            );
          }
        }

        return sprite;
      }
      case 'Particles3D': {
        const parsed = this.parseNode3DTransforms(baseProps.properties as Record<string, unknown>);
        const props = baseProps.properties as Particles3DProperties;
        const texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
        const emitterBoxSize = this.readVector3(props.emitterBoxSize, new Vector3(1, 1, 1));
        const gravity = this.readVector3(props.gravity, new Vector3(0, 0, 0));

        const particles = new Particles3D({
          ...baseProps,
          properties: parsed.restProps,
          position: parsed.position,
          rotation: parsed.rotation,
          rotationOrder: parsed.rotationOrder,
          scale: parsed.scale,
          texture,
          emitterShape: props.emitterShape,
          emitterRadius: this.asNumber(props.emitterRadius, 0.5),
          emitterBoxSize: {
            x: emitterBoxSize.x,
            y: emitterBoxSize.y,
            z: emitterBoxSize.z,
          },
          particleShape: props.particleShape,
          emissionRate: this.asNumber(props.emissionRate, 24),
          maxParticles: this.asNumber(props.maxParticles, 512),
          lifetime: this.asNumber(props.lifetime, 2),
          speed: this.asNumber(props.speed, 2),
          speedSpread: this.asNumber(props.speedSpread, 0.5),
          gravity: {
            x: gravity.x,
            y: gravity.y,
            z: gravity.z,
          },
          particleSize: this.asNumber(props.particleSize, 0.2),
          sizeRandomness: this.asNumber(props.sizeRandomness, 0.2),
          startColor: this.asString(props.startColor) ?? '#ffffff',
          endColor: this.asString(props.endColor) ?? '#ffd24d',
          startAlpha: this.asNumber(props.startAlpha, 1),
          endAlpha: this.asNumber(props.endAlpha, 0),
          billboard: typeof props.billboard === 'boolean' ? props.billboard : true,
          disableRotation:
            typeof props.disableRotation === 'boolean' ? props.disableRotation : false,
          playing: typeof props.playing === 'boolean' ? props.playing : true,
          loop: typeof props.loop === 'boolean' ? props.loop : true,
          prewarm: typeof props.prewarm === 'boolean' ? props.prewarm : false,
          preview: typeof props.preview === 'boolean' ? props.preview : false,
          simulationSpace: props.simulationSpace === 'world' ? 'world' : 'local',
        });

        if (particles.texturePath) {
          try {
            const textureAsset = await this.assetLoader.loadTexture(particles.texturePath);
            particles.setTexture(textureAsset);
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading texture for Particles3D "${particles.nodeId}":`,
              error
            );
          }
        }

        return particles;
      }
      default:
        return new NodeBase({ ...baseProps, type: definition.type });
    }
  }

  private async loadAnimatedSprite2DAsset(
    sprite: AnimatedSprite2D,
    animationResourcePath: string
  ): Promise<void> {
    try {
      const resource = await this.assetLoader.loadAnimationResource(animationResourcePath);
      sprite.setAnimationResource(resource);

      const frameTexturePaths = new Map<number, string>();
      for (const clip of resource.clips) {
        clip.frames.forEach((frame, frameIndex) => {
          const texturePath = getAnimationFrameTexturePath(resource, frame);
          if (texturePath) {
            frameTexturePaths.set(frameIndex, texturePath);
          }
        });
      }

      await Promise.all(
        Array.from(frameTexturePaths.entries()).map(async ([frameIndex, texturePath]) => {
          try {
            const texture = await this.assetLoader.loadTexture(texturePath);
            sprite.setFrameTexture(frameIndex, texture);
          } catch (error) {
            console.warn(
              `[SceneLoader] Error loading frame texture for AnimatedSprite2D "${sprite.nodeId}":`,
              error
            );
          }
        })
      );

      if (!resource.texturePath) {
        return;
      }

      try {
        const texture = await this.assetLoader.loadTexture(resource.texturePath);
        sprite.setSpritesheetTexture(texture);
      } catch (error) {
        console.warn(
          `[SceneLoader] Error loading spritesheet for AnimatedSprite2D "${sprite.nodeId}":`,
          error
        );
      }
    } catch (error) {
      console.warn(
        `[SceneLoader] Error loading animation resource for AnimatedSprite2D "${sprite.nodeId}":`,
        error
      );
    }
  }

  private parseNode3DTransforms(properties: Record<string, unknown>): {
    position: Vector3;
    rotation: Euler;
    rotationOrder: Euler['order'];
    scale: Vector3;
    restProps: Record<string, unknown>;
  } {
    const { position, rotation, scale, transform, ...rest } = properties;

    const fallbackPosition = this.readVector3(position, ZERO_VECTOR3);
    const fallbackRotation = this.readVector3(rotation, ZERO_VECTOR3);
    const fallbackScale = this.readVector3(scale, UNIT_VECTOR3);

    const transformRecord = this.asRecord(transform);

    let resolvedPosition = fallbackPosition;
    let resolvedRotation = fallbackRotation;
    let resolvedScale = fallbackScale;
    let rotationOrder: Euler['order'] = 'XYZ';

    if (transformRecord) {
      rotationOrder = this.readRotationOrder(transformRecord.rotationOrder) ?? rotationOrder;
      resolvedPosition = this.readVector3(
        transformRecord.position ?? transformRecord.translate,
        fallbackPosition
      );
      resolvedRotation = this.readVector3(
        transformRecord.rotationEuler ?? transformRecord.rotation ?? transformRecord.euler,
        fallbackRotation
      );
      resolvedScale = this.readVector3(transformRecord.scale, fallbackScale);

      const remainingTransformEntries = Object.entries(transformRecord).filter(
        ([key]) =>
          ![
            'position',
            'translate',
            'rotation',
            'rotationEuler',
            'euler',
            'scale',
            'rotationOrder',
          ].includes(key)
      );

      if (remainingTransformEntries.length > 0) {
        rest.transform = Object.fromEntries(remainingTransformEntries);
      }
    }

    const rotationEuler = new Euler(
      MathUtils.degToRad(resolvedRotation.x),
      MathUtils.degToRad(resolvedRotation.y),
      MathUtils.degToRad(resolvedRotation.z),
      rotationOrder
    );

    return {
      position: resolvedPosition,
      rotation: rotationEuler,
      rotationOrder,
      scale: resolvedScale,
      restProps: rest,
    };
  }

  private readVector3(value: unknown, fallback: Vector3): Vector3 {
    if (!value) {
      return fallback.clone();
    }

    if (value instanceof Vector3) {
      return value.clone();
    }

    if (Array.isArray(value)) {
      return new Vector3(
        this.asNumber(value[0], fallback.x),
        this.asNumber(value[1], fallback.y),
        this.asNumber(value[2], fallback.z)
      );
    }

    if (typeof value === 'object') {
      const vector = value as Record<string, unknown>;
      return new Vector3(
        this.asNumber(vector.x, fallback.x),
        this.asNumber(vector.y, fallback.y),
        this.asNumber(vector.z, fallback.z)
      );
    }

    return fallback.clone();
  }

  private readVector2(value: unknown, fallback: Vector2): Vector2 {
    if (!value) {
      return fallback.clone();
    }

    if (value instanceof Vector2) {
      return value.clone();
    }

    if (Array.isArray(value)) {
      return new Vector2(this.asNumber(value[0], fallback.x), this.asNumber(value[1], fallback.y));
    }

    if (typeof value === 'object') {
      const vector = value as Record<string, unknown>;
      return new Vector2(this.asNumber(vector.x, fallback.x), this.asNumber(vector.y, fallback.y));
    }

    return fallback.clone();
  }

  private readRotationOrder(value: unknown): Euler['order'] | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toUpperCase();
    const validOrders: Euler['order'][] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
    return validOrders.includes(normalized as Euler['order'])
      ? (normalized as Euler['order'])
      : undefined;
  }

  private asNumber<T>(value: unknown, fallback: T): number | T {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private asPositiveInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private parseNode2DLayout(props: Record<string, unknown>): Node2DLayoutConfig | undefined {
    const layout = this.asRecord(props.layout);
    if (!layout) {
      return undefined;
    }

    const horizontalAlignValues = ['left', 'center', 'right', 'stretch'] as const;
    const verticalAlignValues = ['top', 'center', 'bottom', 'stretch'] as const;

    const horizontalAlign = horizontalAlignValues.find(v => v === layout.horizontalAlign);
    const verticalAlign = verticalAlignValues.find(v => v === layout.verticalAlign);

    return {
      enabled: typeof layout.enabled === 'boolean' ? layout.enabled : undefined,
      horizontalAlign,
      verticalAlign,
    };
  }
}
