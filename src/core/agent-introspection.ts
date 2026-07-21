/**
 * Scene / runtime introspection used by both the in-editor AI agent (production) and the dev-only
 * debug bridge (`src/core/debug-bridge.ts`). It turns Three.js `Object3D` subclasses and Valtio
 * proxies — which are circular and huge — into curated, JSON-serialisable DTOs, and keeps a small
 * ring buffer of recent runtime errors.
 *
 * This module is production-safe: it pulls in only `@pix3/runtime` (the engine contract), no
 * dev-only dependencies, so the agent tool layer can depend on it without dragging the debug bridge
 * into the prod bundle. The debug bridge re-uses these exact functions so its `window.__PIX3_DEBUG__`
 * contract is unchanged.
 */
import { NodeBase } from '@pix3/runtime';

// ---------------------------------------------------------------------------
// JSON-safe serialisation
// ---------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_KEYS = 60;
const MAX_ARRAY = 100;

/**
 * Depth-limited, cycle-safe serialiser. Drops functions/symbols, collapses
 * Vector/Euler-like objects to `{x,y,z[,w]}`, and truncates deep/large values
 * so a single round-trip stays small.
 */
export function safeSerialize(value: unknown, depth = 2): Json {
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
    const vec: { [key: string]: Json } = {
      x: obj.x as number,
      y: obj.y as number,
      z: obj.z as number,
    };
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

export interface TransformDTO {
  position: Json;
  rotation: Json;
  scale: Json;
}

export interface ComponentDTO {
  index: number;
  className: string;
  scriptId: string | null;
  state: Json;
}

export interface NodeDTO {
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

export interface NodeSummary {
  nodeId: string;
  type: string;
  name: string;
}

export interface CapturedError {
  at: number;
  source: 'console.error' | 'window.onerror' | 'unhandledrejection';
  message: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Node → DTO
// ---------------------------------------------------------------------------

function transformOf(node: NodeBase): TransformDTO {
  return {
    position: { x: node.position.x, y: node.position.y, z: node.position.z },
    rotation: { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z },
    scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
  };
}

export function nodeToDTO(node: NodeBase, depth: number): NodeDTO {
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

export function componentToDTO(component: unknown, index: number): ComponentDTO {
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
// Live Three.js object tree (play-mode runtime instances)
// ---------------------------------------------------------------------------

/**
 * During play, games spawn raw Three.js objects (sprites, instanced meshes,
 * falling-cluster meshes) as children of authored nodes — they are NOT NodeBase
 * and so never appear in the authored graph. This walks the *actual* Object3D
 * tree so tooling can see the live render hierarchy.
 */
export interface Object3DLike {
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

export interface LiveObjectDTO {
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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function liveObjectToDTO(obj: Object3DLike, depth: number): LiveObjectDTO {
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

/** Flatten the live tree to a filtered list (for searching spawned objects). */
export function flattenLive(
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

// ---------------------------------------------------------------------------
// Error capture (ring buffer)
// ---------------------------------------------------------------------------

const MAX_ERRORS = 200;
const errorBuffer: CapturedError[] = [];
let errorCaptureInstalled = false;

function pushError(error: CapturedError): void {
  errorBuffer.push(error);
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
}

/**
 * Wrap `console.error` and listen for `error` / `unhandledrejection` so recent runtime failures land
 * in a ring buffer. Idempotent — safe to call from both the dev bridge and the prod agent tool
 * layer; only the first call installs the hooks.
 */
export function installErrorCapture(): void {
  if (errorCaptureInstalled || typeof window === 'undefined') return;
  errorCaptureInstalled = true;

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

/** Snapshot of the captured runtime errors (newest last). */
export function errors(): CapturedError[] {
  return [...errorBuffer];
}

/** Empty the error ring buffer. */
export function clearErrors(): void {
  errorBuffer.length = 0;
}
