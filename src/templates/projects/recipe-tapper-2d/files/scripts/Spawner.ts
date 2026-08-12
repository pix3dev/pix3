/**
 * Spawner — drops prefab instances into the field on a timer.
 *
 * One spawner = one kind of thing. Put a second Spawner on a second node for a
 * second kind (the recipe ships `spawner-targets` + `spawner-hazards`).
 *
 * It owns the whole life of what it spawns: pick a random point in the spawn
 * rect (optionally grid-snapped), instantiate the prefab under `parentNode`,
 * drift it every frame, and `queueFree` it when its lifetime runs out or it
 * leaves `despawnRadius`. What a spawned thing DOES on contact is not its
 * business — that is `TouchRules` reading the prefab's `core:Hitbox2D` group.
 */
import { Script, type NodeBase, type PropertySchema } from '@pix3/runtime';

interface SpawnedEntry {
  node: NodeBase;
  ttl: number;
}

/** World point → the coordinate space of `node` (2×2 inverse of its world basis). */
function worldToLocal2D(node: NodeBase, wx: number, wy: number): { x: number; y: number } {
  node.updateWorldMatrix(true, false);
  const e = node.matrixWorld.elements;
  const dx = wx - e[12];
  const dy = wy - e[13];
  const det = e[0] * e[5] - e[1] * e[4];
  if (Math.abs(det) < 1e-8) {
    return { x: dx, y: dy };
  }
  return { x: (e[5] * dx - e[4] * dy) / det, y: (e[0] * dy - e[1] * dx) / det };
}

/** Local point in `node`'s space → 2D world. */
function localToWorld2D(node: NodeBase, lx: number, ly: number): { x: number; y: number } {
  node.updateWorldMatrix(true, false);
  const e = node.matrixWorld.elements;
  return { x: e[0] * lx + e[4] * ly + e[12], y: e[1] * lx + e[5] * ly + e[13] };
}

export class Spawner extends Script {
  private alive: SpawnedEntry[] = [];
  private cooldown = 0;
  private pending = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Prefab (.pix3scene with exactly one root node) to instantiate.
      prefab: 'res://scenes/prefabs/target.pix3scene',
      // Node id/name the instances are parented to. Empty = this spawner node.
      parentNode: '',
      // Seconds between spawns, plus a random 0..jitter extra.
      intervalSec: 1.1,
      intervalJitter: 0.35,
      // Hard cap on simultaneously alive instances from THIS spawner.
      maxAlive: 10,
      // Spawn rect (centred on this node), in logical pixels.
      spawnWidth: 860,
      spawnHeight: 60,
      // Snap spawn coordinates to a grid of this size (0 = free placement).
      gridSnap: 0,
      // Constant per-second drift applied to every live instance.
      driftX: 0,
      driftY: -300,
      // Seconds an instance lives (0 = until it leaves despawnRadius).
      lifetimeSec: 7,
      // Distance from this node beyond which an instance is freed.
      despawnRadius: 1800,
      // Delay before the first spawn.
      startDelaySec: 0.4,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number, group: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group, min, max, step, slider: true },
      getValue: (s: unknown) => (s as Spawner).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as Spawner).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'Source' },
      getValue: (s: unknown) => (s as Spawner).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as Spawner).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'Spawner',
      properties: [
        str('prefab', 'Prefab'),
        str('parentNode', 'Parent Node'),
        num('intervalSec', 'Interval (s)', 0.05, 20, 0.05, 'Rate'),
        num('intervalJitter', 'Interval Jitter (s)', 0, 10, 0.05, 'Rate'),
        num('maxAlive', 'Max Alive', 1, 200, 1, 'Rate'),
        num('startDelaySec', 'Start Delay (s)', 0, 20, 0.1, 'Rate'),
        num('spawnWidth', 'Spawn Width', 0, 4000, 10, 'Placement'),
        num('spawnHeight', 'Spawn Height', 0, 4000, 10, 'Placement'),
        num('gridSnap', 'Grid Snap', 0, 500, 1, 'Placement'),
        num('driftX', 'Drift X (px/s)', -3000, 3000, 10, 'Motion'),
        num('driftY', 'Drift Y (px/s)', -3000, 3000, 10, 'Motion'),
        num('lifetimeSec', 'Lifetime (s)', 0, 120, 0.5, 'Motion'),
        num('despawnRadius', 'Despawn Radius', 100, 8000, 50, 'Motion'),
      ],
      groups: {
        Source: { label: 'Source', expanded: true },
        Rate: { label: 'Rate', expanded: true },
        Placement: { label: 'Placement', expanded: true },
        Motion: { label: 'Motion', expanded: true },
      },
    };
  }

  onStart(): void {
    this.cooldown = Math.max(0, Number(this.config.startDelaySec) || 0);
  }

  onUpdate(dt: number): void {
    this.driftAndExpire(dt);

    this.cooldown -= dt;
    if (this.cooldown > 0) {
      return;
    }
    const interval = Math.max(0.05, Number(this.config.intervalSec) || 0.05);
    const jitter = Math.max(0, Number(this.config.intervalJitter) || 0);
    this.cooldown = interval + Math.random() * jitter;

    const maxAlive = Math.max(1, Number(this.config.maxAlive) || 1);
    if (this.alive.length + this.pending < maxAlive) {
      void this.spawnOne();
    }
  }

  /** Free everything this spawner currently owns (e.g. on a restart). */
  clear(): void {
    for (const entry of this.alive) {
      entry.node.queueFree();
    }
    this.alive = [];
  }

  private driftAndExpire(dt: number): void {
    const dx = (Number(this.config.driftX) || 0) * dt;
    const dy = (Number(this.config.driftY) || 0) * dt;
    const lifetime = Math.max(0, Number(this.config.lifetimeSec) || 0);
    const despawn = Math.max(1, Number(this.config.despawnRadius) || 1);
    const survivors: SpawnedEntry[] = [];

    for (const entry of this.alive) {
      if (!entry.node.parent) {
        continue; // already freed elsewhere (TouchRules consumed it)
      }
      entry.node.position.x += dx;
      entry.node.position.y += dy;
      entry.ttl -= dt;

      const world = localToWorld2D(entry.node, 0, 0);
      const here = worldToLocal2D(this.node ?? entry.node, world.x, world.y);
      const outOfRange = Math.abs(here.x) > despawn || Math.abs(here.y) > despawn;
      if (outOfRange || (lifetime > 0 && entry.ttl <= 0)) {
        entry.node.queueFree();
        continue;
      }
      survivors.push(entry);
    }
    this.alive = survivors;
  }

  private async spawnOne(): Promise<void> {
    const scene = this.scene;
    const owner = this.node;
    const prefab = String(this.config.prefab ?? '');
    if (!scene || !owner || !prefab) {
      return;
    }
    const parentQuery = String(this.config.parentNode ?? '');
    const parent = parentQuery ? this.findNode(parentQuery) : owner;
    if (!parent) {
      console.warn(`[Spawner] Parent "${parentQuery}" not found.`);
      return;
    }

    const snap = Math.max(0, Number(this.config.gridSnap) || 0);
    const halfW = Math.max(0, Number(this.config.spawnWidth) || 0) / 2;
    const halfH = Math.max(0, Number(this.config.spawnHeight) || 0) / 2;
    let localX = (Math.random() * 2 - 1) * halfW;
    let localY = (Math.random() * 2 - 1) * halfH;
    if (snap > 0) {
      localX = Math.round(localX / snap) * snap;
      localY = Math.round(localY / snap) * snap;
    }
    const world = localToWorld2D(owner, localX, localY);

    this.pending += 1;
    try {
      const node = await scene.instantiate(prefab, { parent });
      const local = worldToLocal2D(parent, world.x, world.y);
      node.position.set(local.x, local.y, node.position.z);
      this.alive.push({ node, ttl: Math.max(0, Number(this.config.lifetimeSec) || 0) });
    } catch (error) {
      console.warn(`[Spawner] Failed to spawn "${prefab}":`, error);
    } finally {
      this.pending -= 1;
    }
  }
}
