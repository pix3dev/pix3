import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { insertNodeAtIndex, removeNodeFromSceneGraph } from '@/features/scene/node-placement';
import { isPrefabNode } from '@/features/scene/prefab-utils';
import { ResourceManager } from '@/services/ResourceManager';
import {
  AssetLoader,
  NodeBase,
  SceneLoader,
  SceneManager,
  ScriptRegistry,
  getNodePropertySchema,
  type SceneGraph,
} from '@pix3/runtime';

export interface ConvertNodeTypeOperationParams {
  /** Id of the node to replace. */
  nodeId: string;
  /** Target node type name (e.g. "Sprite2D"). */
  toType: string;
  /** Extra property overrides merged onto the migrated properties (e.g. { texturePath }). */
  properties?: Record<string, unknown>;
}

type SceneNode = SceneGraph['rootNodes'][0];

/**
 * Replace a node with a new node of a different type IN PLACE, preserving the node's id, name,
 * transform, size and other shared properties, its attached script components, and its children.
 * This is the "skin a placeholder" operation — e.g. turn a scaffolding `ColorRect2D` into a
 * `Sprite2D` that shows a generated texture without losing the CarController on it or its child
 * nodes. Editor-side only: the new node is built through the runtime's node factory
 * (`SceneLoader.createNodeFromDefinition`), components and children are moved across as live
 * instances (no lifecycle churn), and the whole swap is a single undoable step.
 */
export class ConvertNodeTypeOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.convert-node-type',
    title: 'Convert Node Type',
    description: 'Replace a node with a new node of a different type, keeping its content',
    tags: ['scene', 'node', 'convert'],
    affectsNodeStructure: true,
  };

  constructor(private readonly params: ConvertNodeTypeOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const sceneId = state.scenes.activeSceneId;
    if (!sceneId) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager?.getSceneGraph(sceneId);
    if (!sceneManager || !sceneGraph) {
      return { didMutate: false };
    }

    const source = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!(source instanceof NodeBase)) {
      return { didMutate: false };
    }
    // Prefab instances own their structure (edits are stored as overrides, not a type swap).
    if (isPrefabNode(source)) {
      return { didMutate: false };
    }

    // Capture placement so we can restore it exactly on undo.
    const parentNode = (source.parentNode as SceneNode | null) ?? null;
    const siblings = parentNode ? parentNode.children : sceneGraph.rootNodes;
    const index = siblings.indexOf(source);

    // The new node is built ONLY from the caller's overrides (e.g. { texturePath }); shared
    // properties are copied afterwards through the target's own schema. Carrying the source's full
    // property bag would pollute the target with foreign keys (a Sprite2D's texture ending up on a
    // ColorRect2D, etc.) that then re-serialize into the scene file.
    const overrides = this.params.properties ?? {};

    const loader = new SceneLoader(
      container.getService<AssetLoader>(container.getOrCreateToken(AssetLoader)),
      container.getService<ScriptRegistry>(container.getOrCreateToken(ScriptRegistry)),
      container.getService<ResourceManager>(container.getOrCreateToken(ResourceManager))
    );

    const newNode = (await loader.createNodeFromDefinition({
      id: source.nodeId, // reuse the id so name/id-based references keep resolving
      name: source.name,
      type: this.params.toType,
      properties: { ...overrides },
      metadata: source.metadata,
    })) as SceneNode;

    // Guard against an unknown target type: the factory falls back to a plain node whose type
    // won't match what was asked for. Don't destroy the source in that case.
    if (!(newNode instanceof NodeBase) || newNode.type !== this.params.toType) {
      return { didMutate: false };
    }

    // Copy the properties the two types SHARE (width/height/opacity/visibility/layout/…), skipping
    // any the caller explicitly overrode, using the target's setters so only real fields are set.
    this.copySharedProperties(source, newNode, new Set(Object.keys(overrides)));

    // Preserve the exact transform even if a schema round-trip lost precision.
    newNode.position.copy(source.position);
    newNode.rotation.copy(source.rotation);
    newNode.scale.copy(source.scale);

    // Move script components across as live instances (no onDetach/onAttach churn — state is kept).
    const movedComponents = source.components.splice(0, source.components.length);
    for (const component of movedComponents) {
      component.node = newNode;
      newNode.components.push(component);
    }

    // Move children across (Object3D.add reparents; iterate a copy since the array mutates).
    const movedChildren = [...source.children] as SceneNode[];
    for (const child of movedChildren) {
      newNode.add(child);
    }

    // Carry group membership.
    const groups = [...source.groups];

    const swapIn = () => {
      for (const group of source.groups) {
        sceneManager.removeNodeFromGroup(source, group, sceneId);
      }
      removeNodeFromSceneGraph(sceneGraph, source);
      sceneGraph.nodeMap.delete(source.nodeId);

      insertNodeAtIndex(sceneGraph, newNode, parentNode, index);
      sceneGraph.nodeMap.set(newNode.nodeId, newNode);
      for (const group of groups) {
        newNode.groups.add(group);
        sceneManager.addNodeToGroup(newNode, group, sceneId);
      }
      SceneStateUpdater.updateHierarchyState(state, sceneId, sceneGraph);
      SceneStateUpdater.markSceneDirty(state, sceneId);
      SceneStateUpdater.selectNode(state, newNode.nodeId);
    };

    const swapOut = () => {
      for (const group of newNode.groups) {
        sceneManager.removeNodeFromGroup(newNode, group, sceneId);
      }
      // Return components to the source.
      const returning = newNode.components.splice(0, newNode.components.length);
      for (const component of returning) {
        component.node = source;
        source.components.push(component);
      }
      // Return children to the source.
      for (const child of [...newNode.children] as SceneNode[]) {
        source.add(child);
      }
      removeNodeFromSceneGraph(sceneGraph, newNode);
      sceneGraph.nodeMap.delete(newNode.nodeId);

      insertNodeAtIndex(sceneGraph, source, parentNode, index);
      sceneGraph.nodeMap.set(source.nodeId, source);
      for (const group of groups) {
        source.groups.add(group);
        sceneManager.addNodeToGroup(source, group, sceneId);
      }
      SceneStateUpdater.updateHierarchyState(state, sceneId, sceneGraph);
      SceneStateUpdater.markSceneDirty(state, sceneId);
      SceneStateUpdater.selectNode(state, source.nodeId);
    };

    swapIn();

    return {
      didMutate: true,
      commit: {
        label: `Convert to ${this.params.toType}`,
        undo: swapOut,
        redo: swapIn,
      },
    };
  }

  /**
   * Copy the properties the source and target types have in COMMON (matched by schema name), using
   * the target's `setValue` so only real fields are written — never the raw property bag. Names in
   * `skip` (the caller's explicit overrides) and any getter/setter that throws are left alone. This
   * migrates size/opacity/visibility/layout/transform across a type change without dragging over
   * type-specific keys.
   */
  private copySharedProperties(source: NodeBase, target: NodeBase, skip: Set<string>): void {
    let sourceProps, targetProps;
    try {
      sourceProps = getNodePropertySchema(source).properties;
      targetProps = getNodePropertySchema(target).properties;
    } catch {
      return;
    }
    const sourceByName = new Map(sourceProps.map(p => [p.name, p]));
    for (const targetProp of targetProps) {
      if (skip.has(targetProp.name)) {
        continue;
      }
      const sourceProp = sourceByName.get(targetProp.name);
      if (!sourceProp) {
        continue;
      }
      try {
        targetProp.setValue(target, sourceProp.getValue(source));
      } catch {
        // A prop whose getter/setter rejects the other type's value — skip it, keep the default.
      }
    }
  }
}
