/**
 * BallBody — the ball's motion and collisions.
 *
 * The engine ships no rigidbody solver, and `core:Hitbox2D` is an axis-aligned
 * overlap test that ignores rotation — useless for a fast ball and impossible
 * for an angled paddle. So this component runs the swept solver in
 * `ball-collision.ts` and builds its colliders every frame from the LIVE WORLD
 * TRANSFORMS of ordinary marker nodes:
 *
 *   `wallsNode` / `paddlesNode` children → oriented boxes (4 segments each),
 *                                          so a rotated paddle or flipper works
 *   `bumpersNode` children              → circles
 *   `drainNode`                         → trigger box: entering it loses a ball
 *
 * Because the geometry is re-read each frame, rotating or moving a marker node
 * (from a script, an AnimationPlayer clip, or the inspector) just works.
 *
 * On contact it emits `ball-hit` (kind, nodeId, speed, x, y) on its own node,
 * and `ball-drained` when it is lost. TouchRules turns those into score/damage.
 * Never import rapier: it is a ~2 MB lazy wasm payload this does not need.
 */
import { NodeBase, Script, type PropertySchema } from '@pix3/runtime';

import {
  stepBall,
  type BallOptions,
  type BallState,
  type CircleCollider,
  type SegmentCollider,
} from './ball-collision';

/** Oriented box in world space: centre, unit axes, half extents. */
interface Obb {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  hw: number;
  hh: number;
}

/** Any 2D node that carries a size (ColorRect2D, Sprite2D, Group2D, …). */
interface Sized {
  width?: number;
  height?: number;
}

function readObb(node: NodeBase): Obb {
  node.updateWorldMatrix(true, false);
  const e = node.matrixWorld.elements;
  const scaleX = Math.hypot(e[0], e[1]) || 1;
  const scaleY = Math.hypot(e[4], e[5]) || 1;
  const sized = node as unknown as Sized;
  return {
    cx: e[12],
    cy: e[13],
    ux: e[0] / scaleX,
    uy: e[1] / scaleX,
    hw: ((Number(sized.width) || 0) / 2) * scaleX,
    hh: ((Number(sized.height) || 0) / 2) * scaleY,
  };
}

function obbSegments(obb: Obb, restitution: number, id: string, out: SegmentCollider[]): void {
  // Perpendicular of (ux, uy) is (-uy, ux) — the box's local Y axis in world space.
  const ax = obb.ux * obb.hw;
  const ay = obb.uy * obb.hw;
  const bx = -obb.uy * obb.hh;
  const by = obb.ux * obb.hh;
  const corners = [
    [obb.cx - ax - bx, obb.cy - ay - by],
    [obb.cx + ax - bx, obb.cy + ay - by],
    [obb.cx + ax + bx, obb.cy + ay + by],
    [obb.cx - ax + bx, obb.cy - ay + by],
  ];
  for (let i = 0; i < 4; i++) {
    const from = corners[i];
    const to = corners[(i + 1) % 4];
    out.push({ ax: from[0], ay: from[1], bx: to[0], by: to[1], restitution, id });
  }
}

function pointInObb(obb: Obb, x: number, y: number): boolean {
  const dx = x - obb.cx;
  const dy = y - obb.cy;
  const along = dx * obb.ux + dy * obb.uy;
  const across = dx * -obb.uy + dy * obb.ux;
  return Math.abs(along) <= obb.hw && Math.abs(across) <= obb.hh;
}

function childNodes(parent: NodeBase | null): NodeBase[] {
  if (!parent) {
    return [];
  }
  return parent.children.filter((child): child is NodeBase => child instanceof NodeBase);
}

export class BallBody extends Script {
  private readonly state: BallState = { x: 0, y: 0, vx: 0, vy: 0 };
  private readonly segments: SegmentCollider[] = [];
  private readonly circles: CircleCollider[] = [];
  private readonly kinds = new Map<string, string>();
  private homeX = 0;
  private homeY = 0;
  private respawnIn = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      radius: 30,
      gravity: -2400,
      maxSpeed: 2600,
      minSpeed: 420,
      damping: 0.999,
      substeps: 4,
      launchSpeed: 1150,
      launchAngleDeg: 72,
      wallsNode: 'walls',
      paddlesNode: 'paddles',
      bumpersNode: 'bumpers',
      drainNode: 'drain',
      wallRestitution: 1,
      paddleRestitution: 1.05,
      bumperRestitution: 1.3,
      resetDelaySec: 0.7,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number, group: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group, min, max, step, slider: true },
      getValue: (s: unknown) => (s as BallBody).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as BallBody).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'Colliders' },
      getValue: (s: unknown) => (s as BallBody).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as BallBody).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'BallBody',
      properties: [
        num('radius', 'Radius', 2, 400, 1, 'Body'),
        num('gravity', 'Gravity (px/s²)', -12000, 12000, 50, 'Body'),
        num('maxSpeed', 'Max Speed', 100, 12000, 50, 'Body'),
        num('minSpeed', 'Min Speed', 0, 4000, 10, 'Body'),
        num('damping', 'Damping', 0.9, 1, 0.001, 'Body'),
        num('substeps', 'Substeps', 1, 16, 1, 'Body'),
        num('launchSpeed', 'Launch Speed', 0, 6000, 25, 'Launch'),
        num('launchAngleDeg', 'Launch Angle (°)', 5, 175, 1, 'Launch'),
        num('resetDelaySec', 'Reset Delay (s)', 0, 5, 0.1, 'Launch'),
        num('wallRestitution', 'Wall Bounce', 0, 2, 0.01, 'Bounce'),
        num('paddleRestitution', 'Paddle Bounce', 0, 2, 0.01, 'Bounce'),
        num('bumperRestitution', 'Bumper Bounce', 0, 3, 0.01, 'Bounce'),
        str('wallsNode', 'Walls Node'),
        str('paddlesNode', 'Paddles Node'),
        str('bumpersNode', 'Bumpers Node'),
        str('drainNode', 'Drain Node'),
      ],
      groups: {
        Body: { label: 'Body', expanded: true },
        Launch: { label: 'Launch', expanded: true },
        Bounce: { label: 'Bounce', expanded: true },
        Colliders: { label: 'Collider Sources', expanded: false },
      },
    };
  }

  onStart(): void {
    const node = this.node;
    if (!node) {
      return;
    }
    node.updateWorldMatrix(true, false);
    this.homeX = node.matrixWorld.elements[12];
    this.homeY = node.matrixWorld.elements[13];
    this.launch();
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || dt <= 0) {
      return;
    }
    if (this.respawnIn > 0) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) {
        this.launch();
      }
      return;
    }

    this.rebuildColliders();
    const options: BallOptions = {
      radius: Math.max(1, Number(this.config.radius) || 1),
      gravity: Number(this.config.gravity) || 0,
      maxSpeed: Number(this.config.maxSpeed) || 0,
      minSpeed: Number(this.config.minSpeed) || 0,
      damping: Number(this.config.damping) || 1,
      substeps: Number(this.config.substeps) || 1,
    };

    for (const hit of stepBall(this.state, options, this.segments, this.circles, dt)) {
      node.emit('ball-hit', this.kinds.get(hit.id) ?? 'wall', hit.id, hit.speed, hit.x, hit.y);
    }
    this.writeBackPosition();
    this.checkDrain();
  }

  /** Send the ball on its way (also used after a drain). Override the angle for a plunger. */
  launch(): void {
    const speed = Math.max(0, Number(this.config.launchSpeed) || 0);
    const angle = ((Number(this.config.launchAngleDeg) || 90) * Math.PI) / 180;
    const dir = Math.random() < 0.5 ? -1 : 1;
    this.state.x = this.homeX;
    this.state.y = this.homeY;
    this.state.vx = Math.cos(angle) * speed * dir;
    this.state.vy = Math.sin(angle) * speed;
    this.writeBackPosition();
    this.node?.emit('ball-launched');
  }

  private rebuildColliders(): void {
    this.segments.length = 0;
    this.circles.length = 0;
    this.kinds.clear();

    const wallBounce = Number(this.config.wallRestitution) || 1;
    for (const child of childNodes(this.findNode(String(this.config.wallsNode ?? '')))) {
      obbSegments(readObb(child), wallBounce, child.nodeId, this.segments);
      this.kinds.set(child.nodeId, 'wall');
    }

    const paddleBounce = Number(this.config.paddleRestitution) || 1;
    for (const child of childNodes(this.findNode(String(this.config.paddlesNode ?? '')))) {
      obbSegments(readObb(child), paddleBounce, child.nodeId, this.segments);
      this.kinds.set(child.nodeId, 'paddle');
    }

    const bumperBounce = Number(this.config.bumperRestitution) || 1;
    for (const child of childNodes(this.findNode(String(this.config.bumpersNode ?? '')))) {
      const obb = readObb(child);
      this.circles.push({ cx: obb.cx, cy: obb.cy, r: Math.max(1, obb.hw), restitution: bumperBounce, id: child.nodeId });
      this.kinds.set(child.nodeId, 'bumper');
    }
  }

  private checkDrain(): void {
    const drain = this.findNode(String(this.config.drainNode ?? ''));
    if (!drain) {
      return;
    }
    const obb = readObb(drain);
    const below = this.state.y < obb.cy - obb.hh;
    if (!below && !pointInObb(obb, this.state.x, this.state.y)) {
      return;
    }
    const node = this.node;
    node?.emit('ball-hit', 'drain', drain.nodeId, Math.hypot(this.state.vx, this.state.vy), this.state.x, this.state.y);
    node?.emit('ball-drained');
    this.state.vx = 0;
    this.state.vy = 0;
    this.respawnIn = Math.max(0.05, Number(this.config.resetDelaySec) || 0.05);
  }

  /** World simulation → the ball node's parent-local position. */
  private writeBackPosition(): void {
    const node = this.node;
    const parent = node?.parentNode ?? null;
    if (!node) {
      return;
    }
    if (!parent) {
      node.position.set(this.state.x, this.state.y, node.position.z);
      return;
    }
    parent.updateWorldMatrix(true, false);
    const e = parent.matrixWorld.elements;
    const dx = this.state.x - e[12];
    const dy = this.state.y - e[13];
    const det = e[0] * e[5] - e[1] * e[4];
    if (Math.abs(det) < 1e-8) {
      node.position.set(dx, dy, node.position.z);
      return;
    }
    node.position.set((e[5] * dx - e[4] * dy) / det, (e[0] * dy - e[1] * dx) / det, node.position.z);
  }
}
