/**
 * Dev-only debugging bridge for AI agents (and humans) driving a *running*
 * editor through Chrome DevTools (e.g. the `chrome-devtools` MCP).
 *
 * It is NOT a feature of the editor and never ships to production: `main.ts`
 * only imports it behind `import.meta.env.DEV`, so the whole module (and its
 * imports) is dead-code-eliminated from the prod PWA bundle.
 *
 * The contract: an external tool calls `evaluate_script` against the live page
 * and pokes `window.__PIX3_DEBUG__`. Every method returns plain,
 * JSON-serialisable data — Three.js `Object3D`s and Valtio proxies are
 * circular and huge, so we hand back curated DTOs instead of live objects.
 *
 * Mutations go through the normal mutation gateway (`CommandDispatcher`), so
 * they stay consistent and land in undo/redo — never poke `appState` or nodes
 * directly from here.
 */
import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { resolveCommandDispatcher } from '@/services/CommandDispatcher';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import {
  SceneManager,
  NodeBase,
  getGameDebug,
  getRuntimeSceneRoot,
  getPhysicsDebugSource,
  isPhysicsDebugEnabled,
} from '@pix3/runtime';

// ---------------------------------------------------------------------------
// JSON-safe serialisation
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_KEYS = 60;
const MAX_ARRAY = 100;

/**
 * Depth-limited, cycle-safe serialiser. Drops functions/symbols, collapses
 * Vector/Euler-like objects to `{x,y,z[,w]}`, and truncates deep/large values
 * so a single `evaluate_script` round-trip stays small.
 */
function safeSerialize(value: unknown, depth = 2): Json {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return value as Json;
  if (t === 'bigint') return Number(value as bigint);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return null;

  if (Array.isArray(value)) {
    if (depth <= 0) return `[Array(${value.length})]`;
    return value.slice(0, MAX_ARRAY).map(item => safeSerialize(item, depth - 1));
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  // Collapse only *pure* vectors (Vector3/Euler/Quaternion-like): an object
  // whose only keys are x/y/z[/w]. A richer DTO that merely happens to carry
  // x/y/z fields must NOT be flattened, or its other fields are silently lost.
  const isPureVector =
    keys.length <= 4 &&
    typeof obj.x === 'number' &&
    typeof obj.y === 'number' &&
    typeof obj.z === 'number' &&
    keys.every(k => k === 'x' || k === 'y' || k === 'z' || k === 'w');
  if (isPureVector) {
    const vec: { [key: string]: Json } = { x: obj.x as number, y: obj.y as number, z: obj.z as number };
    if (typeof obj.w === 'number') vec.w = obj.w;
    return vec;
  }

  if (depth <= 0) return '[Object]';
  const out: { [key: string]: Json } = {};
  let count = 0;
  for (const key of keys) {
    if (key.startsWith('_')) continue;
    if (count >= MAX_KEYS) {
      out['…'] = `(+${Object.keys(obj).length - count} more keys)`;
      break;
    }
    count += 1;
    out[key] = safeSerialize(obj[key], depth - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

interface TransformDTO {
  position: Json;
  rotation: Json;
  scale: Json;
}

interface ComponentDTO {
  index: number;
  className: string;
  scriptId: string | null;
  state: Json;
}

interface NodeDTO {
  nodeId: string;
  type: string;
  name: string;
  visible: boolean;
  transform: TransformDTO;
  groups: string[];
  componentCount: number;
  properties: Json;
  /** Present when children were expanded (tree view within maxDepth). */
  children?: NodeDTO[];
  /** Present when children exist but were not expanded (depth limit hit). */
  childCount?: number;
  /** Present only on single-node inspection (`node(id)`). */
  components?: ComponentDTO[];
}

interface NodeSummary {
  nodeId: string;
  type: string;
  name: string;
}

interface CapturedError {
  at: number;
  source: 'console.error' | 'window.onerror' | 'unhandledrejection';
  message: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Service access helpers
// ---------------------------------------------------------------------------

type Ctor<T = unknown> = new (...args: never[]) => T;

function service<T>(ctor: Ctor<T>): T {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
}

function activeGraph() {
  return service<SceneManager>(SceneManager).getActiveSceneGraph();
}

/**
 * The topmost live Object3D ancestor of the scene (the THREE.Scene root). Climb
 * from a NodeBase root so objects added straight to the scene root (e.g. game
 * droppable sprites) are reachable, not just the authored NodeBase tree.
 */
function liveSceneRoot(): Object3DLike | null {
  // During play the game runs on an isolated CLONE in SceneRunner's own scene —
  // spawned objects (droppables, falling clusters) live there, NOT in the
  // authored graph. Prefer the live runtime root when a scene is running.
  const runtimeRoot = getRuntimeSceneRoot() as Object3DLike | null;
  if (runtimeRoot) return runtimeRoot;

  // Fallback (edit mode / no runtime): climb from the authored NodeBase graph.
  const graph = activeGraph();
  if (!graph) return null;
  type Linked = Object3DLike & { parent?: Linked | null };
  const first = graph.rootNodes[0] as unknown as Linked | undefined;
  if (!first) return null;
  let node: Linked = first;
  let guard = 0;
  while (node.parent && guard++ < 64) {
    node = node.parent;
  }
  return node;
}

function transformOf(node: NodeBase): TransformDTO {
  return {
    position: { x: node.position.x, y: node.position.y, z: node.position.z },
    rotation: { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z },
    scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
  };
}

function nodeToDTO(node: NodeBase, depth: number): NodeDTO {
  const childNodes = node.children.filter((c): c is NodeBase => c instanceof NodeBase);
  const dto: NodeDTO = {
    nodeId: node.nodeId,
    type: node.type,
    name: node.name,
    visible: node.visible,
    transform: transformOf(node),
    groups: [...node.groups],
    componentCount: node.components.length,
    properties: safeSerialize(node.properties, 2),
  };
  if (childNodes.length === 0) return dto;
  if (depth > 0) {
    dto.children = childNodes.map(child => nodeToDTO(child, depth - 1));
  } else {
    dto.childCount = childNodes.length;
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Live Three.js object tree (play-mode runtime instances)
// ---------------------------------------------------------------------------

/**
 * During play, games spawn raw Three.js objects (sprites, instanced meshes,
 * falling-cluster meshes) as children of authored nodes — they are NOT NodeBase
 * and so never appear in `scene()`. This walks the *actual* Object3D tree so
 * tooling/the Runtime panel can see the live render hierarchy.
 */
interface Object3DLike {
  name?: string;
  type?: string;
  uuid?: string;
  visible?: boolean;
  renderOrder?: number;
  position?: { x: number; y: number; z: number };
  matrixWorld?: { elements: number[] };
  children?: unknown[];
  userData?: Record<string, unknown>;
  count?: number;
  isInstancedMesh?: boolean;
}

interface LiveObjectDTO {
  threeType: string;
  name: string;
  uuid: string | null;
  visible: boolean;
  renderOrder: number;
  /** World-space position read from matrixWorld (updated every play frame). */
  worldPos: { x: number; y: number; z: number } | null;
  isNodeBase: boolean;
  nodeId: string | null;
  /** Instance count for InstancedMesh (else null). */
  instances: number | null;
  flags: { droppable?: boolean; gizmo?: boolean; overlay2D?: boolean };
  childCount: number;
  children?: LiveObjectDTO[];
}

function liveObjectToDTO(obj: Object3DLike, depth: number): LiveObjectDTO {
  const ctorName = (obj as { constructor?: { name?: string } }).constructor?.name;
  const m = obj.matrixWorld?.elements;
  const worldPos =
    m && m.length >= 15
      ? { x: round3(m[12]), y: round3(m[13]), z: round3(m[14]) }
      : obj.position
        ? { x: round3(obj.position.x), y: round3(obj.position.y), z: round3(obj.position.z) }
        : null;
  const ud = obj.userData ?? {};
  const rawChildren = Array.isArray(obj.children) ? (obj.children as Object3DLike[]) : [];
  const isNode = obj instanceof NodeBase;

  const dto: LiveObjectDTO = {
    threeType: obj.type || ctorName || 'Object3D',
    name: obj.name || '',
    uuid: obj.uuid ?? null,
    visible: obj.visible !== false,
    renderOrder: obj.renderOrder ?? 0,
    worldPos,
    isNodeBase: isNode,
    nodeId: isNode ? (obj as unknown as NodeBase).nodeId : null,
    instances: obj.isInstancedMesh ? (obj.count ?? null) : null,
    flags: {
      droppable: 'droppableItemRef' in ud || undefined,
      gizmo: ud.isGizmo === true || undefined,
      overlay2D: ud.overlay2D === true || undefined,
    },
    childCount: rawChildren.length,
  };

  if (rawChildren.length > 0 && depth > 0) {
    dto.children = rawChildren.slice(0, MAX_ARRAY).map(child => liveObjectToDTO(child, depth - 1));
  }
  return dto;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Flatten the live tree to a filtered list (for searching spawned objects). */
function flattenLive(
  obj: Object3DLike,
  predicate: (dto: LiveObjectDTO, raw: Object3DLike) => boolean,
  out: LiveObjectDTO[],
  budget: { n: number }
): void {
  if (budget.n <= 0) return;
  const dto = liveObjectToDTO(obj, 0);
  if (predicate(dto, obj)) {
    out.push(dto);
    budget.n -= 1;
  }
  const children = Array.isArray(obj.children) ? (obj.children as Object3DLike[]) : [];
  for (const child of children) flattenLive(child, predicate, out, budget);
}

function componentToDTO(component: unknown, index: number): ComponentDTO {
  const rec = component as Record<string, unknown>;
  const ctor = (component as { constructor?: { name?: string } }).constructor;
  const scriptId =
    (typeof rec.scriptId === 'string' && rec.scriptId) ||
    (typeof rec.typeId === 'string' && rec.typeId) ||
    (typeof rec.id === 'string' && rec.id) ||
    null;

  // Serialise only the component's own data fields (skip framework refs).
  const skip = new Set(['node', 'input', 'scene', 'constructor']);
  const state: { [key: string]: Json } = {};
  for (const key of Object.keys(rec)) {
    if (key.startsWith('_') || skip.has(key)) continue;
    state[key] = safeSerialize(rec[key], 1);
  }

  return {
    index,
    className: ctor?.name ?? 'Unknown',
    scriptId,
    state,
  };
}

// ---------------------------------------------------------------------------
// Error capture (ring buffer)
// ---------------------------------------------------------------------------

const MAX_ERRORS = 200;
const errorBuffer: CapturedError[] = [];

function pushError(error: CapturedError): void {
  errorBuffer.push(error);
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
}

function installErrorCapture(): void {
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    pushError({
      at: Date.now(),
      source: 'console.error',
      message: args
        .map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
        .join(' '),
      stack: args.find((a): a is Error => a instanceof Error)?.stack,
    });
    originalConsoleError(...args);
  };

  window.addEventListener('error', event => {
    pushError({
      at: Date.now(),
      source: 'window.onerror',
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    pushError({
      at: Date.now(),
      source: 'unhandledrejection',
      message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// The bridge API
// ---------------------------------------------------------------------------

export interface Pix3DebugBridge {
  readonly version: number;
  /** Quick description of the available API (handy for an agent to read first). */
  help(): Record<string, string>;

  // --- read ---
  /** Active scene as a DTO tree, expanded up to `maxDepth` levels. */
  scene(maxDepth?: number): (NodeDTO & { sceneVersion: string }) | null;
  /** Full detail of one node (transform, properties, components). */
  node(nodeId: string): NodeDTO | null;
  /** Case-insensitive search across node name + type. */
  find(text: string): NodeSummary[];
  /** Current selection (node IDs only — resolve detail with `node(id)`). */
  selection(): { nodeIds: string[]; primaryNodeId: string | null; hoveredNodeId: string | null };

  /**
   * Live Three.js object tree under the scene roots — the *actual* render
   * hierarchy during play, including raw sprites/meshes/instanced-meshes that
   * games spawn outside the NodeBase graph (which `scene()` cannot see).
   */
  liveScene(maxDepth?: number): { roots: LiveObjectDTO[] } | null;
  /**
   * Search the live object tree by name/type substring, or the token
   * `'droppable'` to list every object tagged with a `droppableItemRef`.
   */
  liveFind(query: string, limit?: number): LiveObjectDTO[];

  /**
   * Summary of the live physics-debug source (collider wireframe geometry the
   * running game exposes). Counts only — the raw Float32Array buffers stay live
   * for per-frame rendering and are not serialised here. Null if no source.
   */
  physicsDebug(): {
    available: boolean;
    /** Whether the collider wireframe overlay is currently toggled on. */
    enabled: boolean;
    bodies: number | null;
    vertexCount: number;
    segments: number;
  } | null;

  // --- play mode (through commands → keeps appState.ui in sync + undoable) ---
  readonly play: {
    status(): { isPlaying: boolean; playModeStatus: string };
    start(): Promise<boolean>;
    stop(): Promise<boolean>;
    restart(): Promise<boolean>;
  };

  // --- mutate (through the gateway) ---
  /** Edit a node property via UpdateObjectPropertyCommand (lands in undo). */
  setProperty(args: { nodeId: string; propertyPath: string; value: unknown }): Promise<boolean>;
  /** Run any registered command by id (e.g. 'history.undo'). */
  command(commandId: string): Promise<boolean>;

  // --- components / errors ---
  components(nodeId: string): ComponentDTO[];
  errors(): CapturedError[];
  clearErrors(): void;

  // --- game-specific surface (present only if the running game registered one) ---
  readonly game: {
    /** True if the running game registered a GameDebugProvider. */
    available(): boolean;
    /** Provider metadata, or null if no game registered. */
    info(): {
      name: string;
      version: number | null;
      has: { snapshot: boolean; inspect: boolean; action: boolean };
    } | null;
    /** Game's high-level overview, or null. */
    snapshot(): Json | null;
    /** Run a named game query, e.g. inspect('droppables'). Null if unsupported. */
    inspect(query: string, args?: unknown): Json | null;
    /** Run a named game action, e.g. action('wakeAll'). Null if unsupported. */
    action(name: string, args?: unknown): Json | null;
  };
}

function createBridge(): Pix3DebugBridge {
  return {
    version: 1,

    help() {
      return {
        'scene(maxDepth=3)': 'Active scene as a DTO tree.',
        'node(id)': 'One node in full detail (transform, properties, components).',
        'find(text)': 'Search nodes by name/type substring.',
        'selection()': 'Selected node IDs.',
        'liveScene(maxDepth=4)': 'Live Three.js object tree (play-mode runtime instances, incl. raw sprites/meshes).',
        'liveFind(query,limit=50)': "Search live objects by name/type, or 'droppable' for tagged items.",
        'physicsDebug()': 'Summary of collider wireframe buffers exposed by the running game (counts only).',
        'play.status() / play.start() / play.stop() / play.restart()': 'Play-mode control.',
        'setProperty({nodeId,propertyPath,value})': 'Edit a property (undoable).',
        'command(id)': "Run a command by id, e.g. 'history.undo'.",
        'components(id)': 'Script components attached to a node.',
        'errors() / clearErrors()': 'Captured console/runtime errors (ring buffer).',
        'game.available() / game.info()': 'Whether the running game exposed a debug provider.',
        'game.snapshot() / game.inspect(q) / game.action(n)':
          'Game-specific debug surface (per-game).',
      };
    },

    scene(maxDepth = 3) {
      const graph = activeGraph();
      if (!graph) return null;
      const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
      // Wrap roots under a synthetic node so the return is a single tree.
      const tree: NodeDTO = {
        nodeId: '<scene-root>',
        type: 'SceneRoot',
        name: graph.description ?? 'Scene',
        visible: true,
        transform: { position: null, rotation: null, scale: null },
        groups: [],
        componentCount: 0,
        properties: null,
        children: roots.map(root => nodeToDTO(root, maxDepth - 1)),
      };
      return { ...tree, sceneVersion: graph.version };
    },

    node(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return null;
      const dto = nodeToDTO(node, 0);
      dto.components = node.components.map((c, i) => componentToDTO(c, i));
      return dto;
    },

    find(text) {
      const graph = activeGraph();
      if (!graph) return [];
      const needle = text.toLowerCase();
      const matches: NodeSummary[] = [];
      for (const node of graph.nodeMap.values()) {
        if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
          matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
        }
      }
      return matches;
    },

    selection() {
      return {
        nodeIds: [...appState.selection.nodeIds],
        primaryNodeId: appState.selection.primaryNodeId,
        hoveredNodeId: appState.selection.hoveredNodeId,
      };
    },

    liveScene(maxDepth = 4) {
      const root = liveSceneRoot();
      if (!root) return null;
      return { roots: [liveObjectToDTO(root, maxDepth)] };
    },

    liveFind(query, limit = 50) {
      const root = liveSceneRoot();
      if (!root) return [];
      const needle = query.toLowerCase();
      const wantDroppable = needle === 'droppable' || needle === 'droppables';
      const out: LiveObjectDTO[] = [];
      const budget = { n: limit };
      const predicate = (dto: LiveObjectDTO, raw: Object3DLike): boolean => {
        if (wantDroppable) {
          return !!(raw.userData && 'droppableItemRef' in raw.userData);
        }
        return dto.threeType.toLowerCase().includes(needle) || dto.name.toLowerCase().includes(needle);
      };
      flattenLive(root, predicate, out, budget);
      return out;
    },

    physicsDebug() {
      const source = getPhysicsDebugSource();
      if (!source) return null;
      const buffers = source() as
        | { vertices?: ArrayLike<number>; bodies?: number }
        | null;
      const vertexCount = buffers?.vertices?.length ?? 0;
      return {
        available: !!buffers,
        enabled: isPhysicsDebugEnabled(),
        bodies: typeof buffers?.bodies === 'number' ? buffers.bodies : null,
        vertexCount,
        // 3 floats per point, 2 points per line segment.
        segments: Math.floor(vertexCount / 6),
      };
    },

    play: {
      status() {
        return {
          isPlaying: appState.ui.isPlaying,
          playModeStatus: appState.ui.playModeStatus,
        };
      },
      start() {
        return resolveCommandDispatcher().executeById('game.start');
      },
      stop() {
        return resolveCommandDispatcher().executeById('game.stop');
      },
      restart() {
        return resolveCommandDispatcher().executeById('game.restart');
      },
    },

    setProperty({ nodeId, propertyPath, value }) {
      return resolveCommandDispatcher().execute(
        new UpdateObjectPropertyCommand({ nodeId, propertyPath, value })
      );
    },

    command(commandId) {
      return resolveCommandDispatcher().executeById(commandId);
    },

    components(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return [];
      return node.components.map((c, i) => componentToDTO(c, i));
    },

    errors() {
      return [...errorBuffer];
    },

    clearErrors() {
      errorBuffer.length = 0;
    },

    game: {
      available() {
        return getGameDebug() !== null;
      },
      info() {
        const provider = getGameDebug();
        if (!provider) return null;
        return {
          name: provider.name,
          version: provider.version ?? null,
          has: {
            snapshot: !!provider.snapshot,
            inspect: !!provider.inspect,
            action: !!provider.action,
          },
        };
      },
      snapshot() {
        const provider = getGameDebug();
        return provider?.snapshot ? safeSerialize(provider.snapshot(), 5) : null;
      },
      inspect(query, args) {
        const provider = getGameDebug();
        return provider?.inspect ? safeSerialize(provider.inspect(query, args), 5) : null;
      },
      action(name, args) {
        const provider = getGameDebug();
        return provider?.action ? safeSerialize(provider.action(name, args), 3) : null;
      },
    },
  };
}

interface WindowWithDebug extends Window {
  __PIX3_DEBUG__?: Pix3DebugBridge;
}

/** Install the bridge on `window.__PIX3_DEBUG__`. Idempotent. */
export function installDebugBridge(): void {
  const target = window as unknown as WindowWithDebug;
  if (target.__PIX3_DEBUG__) return;
  installErrorCapture();
  target.__PIX3_DEBUG__ = createBridge();
  console.info('[Pix3] Debug bridge ready: window.__PIX3_DEBUG__.help()');
}
