import type { Object3D } from 'three';
import { NodeBase } from '../nodes/NodeBase';
import { describeUnknownNodeType, isKnownSceneNodeType } from './node-type-registry';

/**
 * "Will this scene actually show anything?" — computed from the scene graph, not from a picture.
 *
 * The failure this exists for: a 3D scene whose meshes use lit materials and whose lights are
 * missing (or were authored under a name the loader does not know, so they loaded inert) renders
 * pure black, and every cheap way of checking says it is fine. The editor viewport adds its own
 * fallback lights, so a screenshot looks correct; the console is empty, because nothing threw; the
 * node count is right, because the inert nodes are still there. An agent verifying its own work has
 * no signal at all until a human looks at the running game.
 *
 * So the check has to key on the thing that is actually wrong — lit geometry with nothing lighting
 * it — and be readable wherever the agent already looks (play-start, `game_observe`, `scene_tree`).
 *
 * Pure and editor-agnostic: it walks `Object3D`s and reads `node.type`, so it works on an editor
 * scene graph, a running graph, or a graph parsed in a test, and it pulls no node classes into the
 * bundle beyond `NodeBase` (which every bundle already has).
 */

export type RenderabilityIssueCode =
  | 'lit-material-no-light'
  | 'no-camera-3d'
  | 'inert-nodes'
  | 'pbr-on-mobile';

/**
 * `blocking` = the scene cannot draw what it contains. `advice` = it draws, but costs more than
 * the target platform wants to pay.
 *
 * The split exists so advice can be shown where someone is authoring and withheld from the
 * verification loop: a warning that appears in every single `game_observe` result is a warning
 * everyone learns to scroll past, which would cost the blocking ones their credibility too.
 */
export type RenderabilitySeverity = 'blocking' | 'advice';

export interface RenderabilityLintOptions {
  /** The project's render budget; `desktop` is the only value that buys PBR without comment. */
  readonly targetPlatform?: string;
}

export interface RenderabilityIssue {
  readonly code: RenderabilityIssueCode;
  readonly severity: RenderabilitySeverity;
  /** One sentence, naming the fix — this string is what reaches Logs and agent tool results. */
  readonly message: string;
  /** Node ids the issue is about (capped; `nodeCount` is the true total). */
  readonly nodeIds: readonly string[];
  readonly nodeCount: number;
}

/** In-memory `node.type` of the light nodes (un-suffixed — see `node-type-registry`). */
const LIGHT_NODE_TYPES: ReadonlySet<string> = new Set([
  'AmbientLight',
  'DirectionalLight',
  'HemisphereLight',
  'PointLight',
  'SpotLight',
]);

/**
 * 3D nodes that put geometry on screen. `Sprite3D`/`AnimatedSprite3D`/`Particles3D` are absent on
 * purpose: they are unlit (`MeshBasicMaterial`), so a scene made only of those is perfectly fine
 * without a light and must never be warned about.
 */
const LIT_CONTENT_NODE_TYPES: ReadonlySet<string> = new Set([
  'GeometryMesh',
  'MeshInstance',
  'InstancedMesh3D',
]);

/** Any 3D node that occupies the scene visually — used to decide whether a camera is required. */
const CONTENT_3D_NODE_TYPES: ReadonlySet<string> = new Set([
  ...LIT_CONTENT_NODE_TYPES,
  'Sprite3D',
  'AnimatedSprite3D',
  'Particles3D',
]);

const CAMERA_3D_NODE_TYPES: ReadonlySet<string> = new Set(['Camera3D', 'VirtualCamera3D']);

/** How many node ids an issue carries; the full count still travels in `nodeCount`. */
const MAX_REPORTED_NODES = 8;

/**
 * Walk a scene graph and report what would keep it from rendering.
 *
 * Visibility is respected — an invisible subtree cannot be the reason the screen is black, and a
 * light switched off by the author is not a light. Play-mode `startVisible` is deliberately *not*
 * consulted: the lint runs against whatever graph it is handed, so a caller checking a running
 * scene already sees the play-mode truth.
 */
export const collectRenderabilityIssues = (
  rootNodes: readonly NodeBase[],
  options: RenderabilityLintOptions = {}
): RenderabilityIssue[] => {
  const litContent: NodeBase[] = [];
  const content3D: NodeBase[] = [];
  const inert: NodeBase[] = [];
  let lightCount = 0;
  let cameraCount = 0;
  let litMaterialSeen = false;
  let pbrMaterialCount = 0;

  const visit = (object: Object3D): void => {
    if (object.visible === false) {
      return;
    }
    const node = asNode(object);
    if (node) {
      if (LIGHT_NODE_TYPES.has(node.type)) {
        lightCount++;
      }
      if (CAMERA_3D_NODE_TYPES.has(node.type)) {
        cameraCount++;
      }
      if (CONTENT_3D_NODE_TYPES.has(node.type)) {
        content3D.push(node);
      }
      if (LIT_CONTENT_NODE_TYPES.has(node.type)) {
        litContent.push(node);
      }
      if (isInertNode(node)) {
        inert.push(node);
      }
    } else if (hasLitMaterial(object)) {
      // Read the material rather than trusting the node type: it is what makes a
      // `material.type: 'basic'` mesh, or an unlit glTF, stop triggering the light warning.
      litMaterialSeen = true;
      if (hasPbrMaterial(object)) {
        pbrMaterialCount++;
      }
    }
    for (const child of object.children) {
      visit(child);
    }
  };

  for (const root of rootNodes) {
    visit(root);
  }

  const issues: RenderabilityIssue[] = [];

  // A mesh whose asset has not finished loading carries no material yet, so the material read
  // cannot speak for it — assume lit (glTF materials are PBR by definition). A loaded-and-unlit
  // mesh still gets the benefit of the doubt, which is what keeps an all-basic scene quiet.
  const needsLight = litMaterialSeen || litContent.some(node => !hasAnyMaterial(node));
  if (needsLight && litContent.length > 0 && lightCount === 0) {
    issues.push({
      code: 'lit-material-no-light',
      severity: 'blocking',
      message: `${litContent.length} 3D mesh node(s) use lit materials but the scene has no enabled light — they will render black. Add a HemisphereLightNode (plus a DirectionalLightNode for shading), or give the meshes an unlit material.`,
      nodeIds: litContent.slice(0, MAX_REPORTED_NODES).map(node => node.nodeId),
      nodeCount: litContent.length,
    });
  }

  if (content3D.length > 0 && cameraCount === 0) {
    issues.push({
      code: 'no-camera-3d',
      severity: 'blocking',
      message: `The scene has ${content3D.length} 3D node(s) but no enabled Camera3D — nothing 3D will be drawn. Add a Camera3D and position it to look at the content.`,
      nodeIds: content3D.slice(0, MAX_REPORTED_NODES).map(node => node.nodeId),
      nodeCount: content3D.length,
    });
  }

  // Advice, deliberately last: a scene that renders correctly but expensively.
  if (pbrMaterialCount > 0 && options.targetPlatform && options.targetPlatform !== 'desktop') {
    issues.push({
      code: 'pbr-on-mobile',
      severity: 'advice',
      message: `${pbrMaterialCount} material(s) use PBR (standard/physical) in a ${options.targetPlatform} project. PBR shading is a desktop-class per-pixel cost; set the meshes' materialType to 'lambert' (or 'basic' for unlit) unless the user asked for a high-end look.`,
      nodeIds: litContent.slice(0, MAX_REPORTED_NODES).map(node => node.nodeId),
      nodeCount: pbrMaterialCount,
    });
  }

  if (inert.length > 0) {
    const detail = inert
      .slice(0, MAX_REPORTED_NODES)
      .map(node => describeUnknownNodeType(node.name, node.type))
      .join(' ');
    issues.push({
      code: 'inert-nodes',
      severity: 'blocking',
      message: `${inert.length} node(s) have an unrecognised type and do nothing. ${detail}`,
      nodeIds: inert.slice(0, MAX_REPORTED_NODES).map(node => node.nodeId),
      nodeCount: inert.length,
    });
  }

  return issues;
};

/** One-line summary for a log line or a verdict prefix; empty string when the scene is fine. */
export const summarizeRenderabilityIssues = (issues: readonly RenderabilityIssue[]): string =>
  issues.length === 0 ? '' : issues.map(issue => issue.message).join(' ');

const asNode = (object: Object3D): NodeBase | null => (object instanceof NodeBase ? object : null);

/**
 * A node the loader could not build: it fell through to the permissive `NodeBase` fallback *and*
 * its type is not one the vocabulary knows. Both halves are needed — `Group` is a legitimate bare
 * `NodeBase`, and a known type on a real subclass is obviously fine.
 *
 * Exported because the lint is not the only surface that owes the user this fact: an inert node is
 * indistinguishable from a working one in the Scene Tree, which is the first place anybody looks
 * when a node "is there but does nothing".
 */
export const isInertNode = (node: NodeBase): boolean =>
  Object.getPrototypeOf(node) === NodeBase.prototype && !isKnownSceneNodeType(node.type);

/** Three sets an `isMesh*Material` flag on every material instance; no class imports needed. */
const PBR_MATERIAL_FLAGS = ['isMeshStandardMaterial', 'isMeshPhysicalMaterial'] as const;

const LIT_MATERIAL_FLAGS = [
  'isMeshStandardMaterial',
  'isMeshPhysicalMaterial',
  'isMeshLambertMaterial',
  'isMeshPhongMaterial',
  'isMeshToonMaterial',
] as const;

const materialsOf = (object: Object3D): unknown[] => {
  const material = (object as { material?: unknown }).material;
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
};

const hasPbrMaterial = (object: Object3D): boolean =>
  materialsOf(object).some(material =>
    PBR_MATERIAL_FLAGS.some(flag => (material as Record<string, unknown>)[flag] === true)
  );

const hasLitMaterial = (object: Object3D): boolean =>
  materialsOf(object).some(material =>
    LIT_MATERIAL_FLAGS.some(flag => (material as Record<string, unknown>)[flag] === true)
  );

/** Whether a node's own subtree carries any material at all (a not-yet-loaded mesh carries none). */
const hasAnyMaterial = (node: NodeBase): boolean => {
  let found = false;
  node.traverse(object => {
    if (!found && materialsOf(object).length > 0) {
      found = true;
    }
  });
  return found;
};
