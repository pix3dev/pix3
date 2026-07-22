import { Vector3 } from 'three';
import { componentToDTO, type Json } from '@/core/agent-introspection';

/**
 * Records what a live node *actually did* over a window — not just its endpoints.
 *
 * The endpoint-diff model (`game_input`'s before/after) is blind to the whole
 * class of non-transform gameplay: a spawner/pool container never moves, and
 * transient children (a cannonball that spawns, flies, and is destroyed inside
 * the window) leave both endpoints identical. This recorder samples four
 * orthogonal channels across the window and keeps peaks/cumulative counts, so
 * "the shooting works" is provable even when the watched node's own transform
 * is frozen at (0,0,0):
 *
 *  - self motion   — peak world displacement of the node itself
 *  - structure     — child add/remove (exact via three's childadded/childremoved
 *                    events; poll-diff fallback when the node has no event API)
 *  - child liveness— visible-child count peak + peak displacement of any child
 *                    (object pools recycle by toggling `visible`, never removal)
 *  - state         — scalar component fields that changed (ammo/score/health)
 *
 * Decoupled from the runtime by design: it takes a resolver + a structural node
 * view, so it unit-tests against plain fakes and never imports SceneRunner.
 */

/** Default poll cadence while watching a running game. */
const WATCH_POLL_MS = 100;
const MAX_WATCH_NODES = 8;
const MAX_TRACKED_CHILDREN = 32;
const MAX_LOG_ENTRIES = 10;
const MAX_STATE_CHANGES = 10;
/** World distance a node/child must travel to count as motion (matches GameInputService). */
const MOVE_EPS = 0.5;

export interface WatchLogEntry {
  /** ms since the watch window started. */
  at: number;
  kind: 'spawn' | 'despawn' | 'show' | 'hide' | 'state';
  note: string;
}

/** What a watched node did over the window (see {@link NodeWatchRecorder}). */
export interface NodeActivity {
  /** Direct children added during the window (cumulative — counts ones later removed). */
  spawned: number;
  /** Direct children removed during the window. */
  removed: number;
  /** Highest direct-child count seen during the window. */
  childCountPeak: number;
  /** Highest count of *visible* direct children — the object-pool signal. */
  visibleChildPeak: number;
  /** Peak world displacement of the node itself (catches out-and-back motion). */
  maxDistanceFromStart: number;
  /** Peak world displacement of any tracked direct child (projectiles fly; the pool doesn't). */
  maxChildDistance: number;
  /** Scalar component fields that changed over the window: 'GunController.mag' -> [3, 0]. */
  stateChanges?: Record<string, [Json, Json]>;
  /** Sparse changelog, entries only on a change (capped). */
  log?: WatchLogEntry[];
  /** True when ANY channel registered activity — the per-node headline. */
  active: boolean;
}

/** Minimal structural view of a live child the recorder reads. `NodeBase`/`Object3D` satisfy it. */
export interface WatchChildLike {
  uuid?: string;
  nodeId?: string;
  visible?: boolean;
  getWorldPosition(target: Vector3): { x: number; y: number; z: number };
}

/** Minimal structural view of a watched node. `NodeBase` (a three `Object3D`) satisfies it. */
export interface WatchNodeLike {
  nodeId?: string;
  visible?: boolean;
  children: readonly WatchChildLike[];
  components?: readonly unknown[];
  getWorldPosition(target: Vector3): { x: number; y: number; z: number };
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

/** Resolves a watch query (node name or id) to a live node, or null if absent. */
export type WatchResolver = (query: string) => WatchNodeLike | null;

type Vec3 = { x: number; y: number; z: number };

interface Tracked {
  query: string;
  node: WatchNodeLike;
  startPos: Vec3;
  startChildCount: number;
  startVisibleChildCount: number;
  childCountPeak: number;
  visibleChildPeak: number;
  maxDistanceFromStart: number;
  maxChildDistance: number;
  spawned: number;
  removed: number;
  lastVisibleCount: number;
  /** child key -> first-seen world position, for displacement tracking. */
  childStart: Map<string, Vec3>;
  /** current child keys, for the poll-diff spawn/despawn fallback. */
  lastKeys: Set<string>;
  /** true when the node exposes addEventListener → exact spawn/despawn via three events. */
  hasEvents: boolean;
  startState: Map<string, Json>;
  log: WatchLogEntry[];
  onAdded?: (event: unknown) => void;
  onRemoved?: (event: unknown) => void;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const copyVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const sameJson = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
const childKey = (child: WatchChildLike, index: number): string =>
  child.uuid ?? child.nodeId ?? `#${index}`;
const childName = (child: WatchChildLike | undefined): string =>
  child?.nodeId ? ` (${child.nodeId})` : '';
const isVisible = (child: WatchChildLike): boolean => child.visible !== false;
const countVisible = (children: readonly WatchChildLike[]): number =>
  children.reduce((n, c) => n + (isVisible(c) ? 1 : 0), 0);

/** Flatten a node's component scalar fields to `ClassName.field -> value` for diffing. */
function flattenState(node: WatchNodeLike): Map<string, Json> {
  const out = new Map<string, Json>();
  const components = node.components ?? [];
  components.forEach((component, index) => {
    const dto = componentToDTO(component, index);
    const state = dto.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    for (const [key, value] of Object.entries(state)) {
      if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'string'
      ) {
        out.set(`${dto.className}.${key}`, value);
      }
    }
  });
  return out;
}

export class NodeWatchRecorder {
  private readonly tracked: Tracked[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  /** Number of queries dropped because more than {@link MAX_WATCH_NODES} were requested. */
  readonly droppedWatchCount: number;

  constructor(
    resolve: WatchResolver,
    queries: readonly string[],
    private readonly intervalMs: number = WATCH_POLL_MS
  ) {
    const capped = queries.slice(0, MAX_WATCH_NODES);
    this.droppedWatchCount = Math.max(0, queries.length - capped.length);
    const scratch = new Vector3();
    for (const query of capped) {
      const node = resolve(query);
      if (node) this.track(query, node, scratch);
    }
  }

  /** True when at least one query resolved to a live node. */
  get isWatching(): boolean {
    return this.tracked.length > 0;
  }

  /** Begin capture: attach lifecycle listeners, take the baseline sample, start polling. */
  start(): void {
    if (!this.isWatching) return;
    this.startedAt = Date.now();
    for (const t of this.tracked) this.attach(t);
    this.sample();
    this.intervalHandle = setInterval(() => this.sample(), this.intervalMs);
  }

  /** End capture: take a final sample, detach listeners, return per-query activity. */
  stop(): Map<string, NodeActivity> {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.sample();
    for (const t of this.tracked) this.detach(t);
    const out = new Map<string, NodeActivity>();
    for (const t of this.tracked) out.set(t.query, this.finish(t));
    return out;
  }

  private track(query: string, node: WatchNodeLike, scratch: Vector3): void {
    const startPos = copyVec(node.getWorldPosition(scratch));
    const children = node.children ?? [];
    const visible = countVisible(children);
    const t: Tracked = {
      query,
      node,
      startPos,
      startChildCount: children.length,
      startVisibleChildCount: visible,
      childCountPeak: children.length,
      visibleChildPeak: visible,
      maxDistanceFromStart: 0,
      maxChildDistance: 0,
      spawned: 0,
      removed: 0,
      lastVisibleCount: visible,
      childStart: new Map(),
      lastKeys: new Set(children.map((c, i) => childKey(c, i))),
      hasEvents: typeof node.addEventListener === 'function',
      startState: flattenState(node),
      log: [],
    };
    for (let i = 0; i < children.length && i < MAX_TRACKED_CHILDREN; i++) {
      const key = childKey(children[i], i);
      if (!t.childStart.has(key))
        t.childStart.set(key, copyVec(children[i].getWorldPosition(scratch)));
    }
    this.tracked.push(t);
  }

  private attach(t: Tracked): void {
    if (!t.hasEvents || !t.node.addEventListener) return;
    const scratch = new Vector3();
    t.onAdded = (event: unknown) => {
      t.spawned += 1;
      const child = (event as { child?: WatchChildLike }).child;
      this.pushLog(t, 'spawn', `child added${childName(child)}`);
      if (child) {
        const key = childKey(child, t.childStart.size);
        if (!t.childStart.has(key)) t.childStart.set(key, copyVec(child.getWorldPosition(scratch)));
      }
    };
    t.onRemoved = (event: unknown) => {
      t.removed += 1;
      const child = (event as { child?: WatchChildLike }).child;
      this.pushLog(t, 'despawn', `child removed${childName(child)}`);
    };
    t.node.addEventListener('childadded', t.onAdded);
    t.node.addEventListener('childremoved', t.onRemoved);
  }

  private detach(t: Tracked): void {
    if (!t.node.removeEventListener) return;
    if (t.onAdded) t.node.removeEventListener('childadded', t.onAdded);
    if (t.onRemoved) t.node.removeEventListener('childremoved', t.onRemoved);
  }

  private sample(): void {
    const scratch = new Vector3();
    for (const t of this.tracked) {
      const children = t.node.children ?? [];

      const pos = t.node.getWorldPosition(scratch);
      t.maxDistanceFromStart = Math.max(t.maxDistanceFromStart, dist(pos, t.startPos));

      t.childCountPeak = Math.max(t.childCountPeak, children.length);
      const visible = countVisible(children);
      t.visibleChildPeak = Math.max(t.visibleChildPeak, visible);
      if (visible > t.lastVisibleCount) {
        this.pushLog(
          t,
          'show',
          `+${visible - t.lastVisibleCount} visible children (${visible} now)`
        );
      } else if (visible < t.lastVisibleCount) {
        this.pushLog(
          t,
          'hide',
          `-${t.lastVisibleCount - visible} visible children (${visible} now)`
        );
      }
      t.lastVisibleCount = visible;

      for (let i = 0; i < children.length && i < MAX_TRACKED_CHILDREN; i++) {
        const key = childKey(children[i], i);
        const cp = children[i].getWorldPosition(scratch);
        const start = t.childStart.get(key);
        if (!start) t.childStart.set(key, copyVec(cp));
        else t.maxChildDistance = Math.max(t.maxChildDistance, dist(cp, start));
      }

      // Poll-diff spawn/despawn only when the node has no event API (else events are exact).
      if (!t.hasEvents) {
        const keys = new Set(children.map((c, i) => childKey(c, i)));
        for (const key of keys) {
          if (!t.lastKeys.has(key)) {
            t.spawned += 1;
            this.pushLog(t, 'spawn', 'child added');
          }
        }
        for (const key of t.lastKeys) {
          if (!keys.has(key)) {
            t.removed += 1;
            this.pushLog(t, 'despawn', 'child removed');
          }
        }
        t.lastKeys = keys;
      }
    }
  }

  private pushLog(t: Tracked, kind: WatchLogEntry['kind'], note: string): void {
    if (t.log.length >= MAX_LOG_ENTRIES) return;
    t.log.push({ at: Math.max(0, Date.now() - this.startedAt), kind, note });
  }

  private finish(t: Tracked): NodeActivity {
    const endState = flattenState(t.node);
    const stateChanges: Record<string, [Json, Json]> = {};
    let stateCount = 0;
    for (const key of new Set([...t.startState.keys(), ...endState.keys()])) {
      if (stateCount >= MAX_STATE_CHANGES) break;
      const before = t.startState.has(key) ? (t.startState.get(key) as Json) : null;
      const after = endState.has(key) ? (endState.get(key) as Json) : null;
      if (!sameJson(before, after)) {
        stateChanges[key] = [before, after];
        stateCount += 1;
      }
    }
    const hasState = stateCount > 0;
    const active =
      t.spawned > 0 ||
      t.removed > 0 ||
      t.childCountPeak > t.startChildCount ||
      t.visibleChildPeak > t.startVisibleChildCount ||
      t.maxDistanceFromStart > MOVE_EPS ||
      t.maxChildDistance > MOVE_EPS ||
      hasState;
    const activity: NodeActivity = {
      spawned: t.spawned,
      removed: t.removed,
      childCountPeak: t.childCountPeak,
      visibleChildPeak: t.visibleChildPeak,
      maxDistanceFromStart: round3(t.maxDistanceFromStart),
      maxChildDistance: round3(t.maxChildDistance),
      active,
    };
    if (hasState) activity.stateChanges = stateChanges;
    if (t.log.length) activity.log = t.log;
    return activity;
  }
}
