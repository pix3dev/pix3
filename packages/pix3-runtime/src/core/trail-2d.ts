import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Uint16BufferAttribute,
  Vector3,
} from 'three';

import { Node2D, type Node2DProps } from '../nodes/Node2D';
import { NodeBase } from '../nodes/NodeBase';
import { OVERLAY_2D_FLAG } from './render-order-2d';

/**
 * The motion ribbon behind `scene.juice.trail()`.
 *
 * Same species as `ParticleBurst2D` / `FloatText2D` (see `./juice-transients`): a
 * runtime-only 2D node with no YAML serialization, no editor proxy and no
 * inspector schema. It is spawned into the running 2D tree, animates through
 * `node.tick` (so a hitstop freezes it), and frees itself once it has faded.
 *
 * It differs from the other two in that it FOLLOWS something: every tick it
 * samples the target's world position into a short history and rebuilds a
 * triangle strip through those points, tapering the width and the alpha towards
 * the tail. Points are stored in this node's own local space, so a moving host
 * does not drag the ribbon along with it.
 *
 * 2D pass rules it obeys (CLAUDE.md "2D overlay rendering"): `depthTest: false`
 * with paint order from the DFS `renderOrder` walk, `OVERLAY_2D_FLAG` so it floats
 * above the host's own children, and `frustumCulled = false` because the baked
 * vertex positions leave the bounding sphere stale every frame.
 */

/** Tuning for {@link Trail2D} — every field has a working default. */
export interface TrailOptions {
  /** How long a sampled point survives, in seconds (default 0.35). */
  lifeSec?: number;
  /** Ribbon width at the head, in px; it tapers to 0 at the tail (default 14). */
  widthPx?: number;
  /** Ribbon colour (CSS string), or a palette lerped head→tail. Default `#ffffff`. */
  color?: string | readonly string[];
  /** Palette head→tail. Takes precedence over {@link color} (same shape as `BurstOptions`). */
  colors?: readonly string[];
  /** Additive blending — the neon/glow look (default true). False = normal alpha blend. */
  additive?: boolean;
  /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
  zIndex?: number;
  /** Maximum sampled points; the history is also bounded by {@link lifeSec} (default 48). */
  maxPoints?: number;
}

const TRAIL_DEFAULTS = {
  lifeSec: 0.35,
  widthPx: 14,
  maxPoints: 48,
} as const;

/** Hard ceiling on sampled points — a runaway `maxPoints` must not stall a frame. */
export const TRAIL_MAX_POINTS = 256;

/** Below this the tangent is unusable, so the previous normal is reused. */
const MIN_SEGMENT_LENGTH = 1e-4;

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** Head→tail colour ramp. One entry means a flat colour. */
function resolveTrailPalette(options: TrailOptions): Color[] {
  const raw: readonly string[] = Array.isArray(options.colors)
    ? options.colors
    : Array.isArray(options.color)
      ? (options.color as readonly string[])
      : typeof options.color === 'string'
        ? [options.color]
        : [];
  const entries = raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
  if (entries.length === 0) {
    entries.push('#ffffff');
  }
  return entries.map(entry => {
    try {
      return new Color(entry);
    } catch {
      return new Color('#ffffff');
    }
  });
}

/**
 * A fading ribbon that follows a node. Created by `scene.juice.trail()`; call
 * {@link stop} to let it fade out and free itself.
 */
export class Trail2D extends Node2D {
  private readonly points: TrailPoint[] = [];
  private readonly geometry: BufferGeometry;
  private readonly positionAttribute: Float32BufferAttribute;
  private readonly colorAttribute: Float32BufferAttribute;
  private readonly palette: Color[];
  private readonly lifeSec: number;
  private readonly halfWidth: number;
  private readonly maxPoints: number;
  private readonly scratchWorld = new Vector3();
  private readonly scratchColor = new Color();
  private target: NodeBase | null;
  private following = true;
  private freed = false;

  constructor(props: Node2DProps, target: NodeBase, options: TrailOptions = {}) {
    super(props, 'Trail2D');

    // A transient effect is never a drop target and has no children to hit-test.
    this.isContainer = false;
    this.target = target;

    this.lifeSec = clampNumber(options.lifeSec, TRAIL_DEFAULTS.lifeSec, 0.02, 10);
    this.halfWidth = clampNumber(options.widthPx, TRAIL_DEFAULTS.widthPx, 0.1, 4096) / 2;
    this.maxPoints = Math.round(
      clampNumber(options.maxPoints, TRAIL_DEFAULTS.maxPoints, 2, TRAIL_MAX_POINTS)
    );
    this.palette = resolveTrailPalette(options);
    if (options.zIndex !== undefined) {
      this.zIndex = clampNumber(options.zIndex, 0, -4096, 4096);
    }

    this.geometry = new BufferGeometry();
    this.positionAttribute = new Float32BufferAttribute(
      new Float32Array(this.maxPoints * 2 * 3),
      3
    );
    this.colorAttribute = new Float32BufferAttribute(new Float32Array(this.maxPoints * 2 * 4), 4);
    const indices = new Uint16Array((this.maxPoints - 1) * 6);
    for (let segment = 0; segment < this.maxPoints - 1; segment++) {
      const base = segment * 2;
      const offset = segment * 6;
      indices[offset] = base;
      indices[offset + 1] = base + 1;
      indices[offset + 2] = base + 2;
      indices[offset + 3] = base + 2;
      indices[offset + 4] = base + 1;
      indices[offset + 5] = base + 3;
    }
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setIndex(new Uint16BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexColors: true,
      // The ribbon's winding flips whenever the target turns, so a single-sided
      // material would drop half the strip.
      side: DoubleSide,
      blending: options.additive === false ? NormalBlending : AdditiveBlending,
    });
    this.registerOpacityMaterial(material, 1);

    const mesh = new Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.userData[OVERLAY_2D_FLAG] = true;
    this.add(mesh);
  }

  /** Points currently in the ribbon; 0 after it has fully faded. */
  get pointCount(): number {
    return this.points.length;
  }

  /** False once {@link stop} was called (or the target went away). */
  get isFollowing(): boolean {
    return this.following;
  }

  /**
   * Stop sampling. The ribbon keeps fading for `lifeSec` and then frees itself —
   * a trail on a ball that just despawned should not vanish mid-air.
   */
  stop(): void {
    this.following = false;
    this.target = null;
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (this.freed) {
      return;
    }
    const step = Math.max(0, dt);

    for (const point of this.points) {
      point.age += step;
    }
    while (this.points.length > 0 && this.points[this.points.length - 1].age >= this.lifeSec) {
      this.points.pop();
    }

    const target = this.target;
    if (target && target.isDisposed) {
      // Freeing the target frees the trail (after the ribbon has faded out).
      this.stop();
    } else if (target && this.following) {
      this.sample(target);
    }

    this.rebuild();

    if (!this.following && this.points.length === 0) {
      this.freed = true;
      this.queueFree();
    }
  }

  /** Append the target's current position, in this node's local space, as the new head. */
  private sample(target: NodeBase): void {
    target.updateWorldMatrix(true, false);
    target.getWorldPosition(this.scratchWorld);
    // `worldToLocal` reads matrixWorld, which is a frame behind whenever this node's
    // host moved this tick — refresh it so the ribbon never lags the host.
    this.updateWorldMatrix(true, false);
    const local = this.worldToLocal(this.scratchWorld);
    this.points.unshift({ x: local.x, y: local.y, age: 0 });
    while (this.points.length > this.maxPoints) {
      this.points.pop();
    }
  }

  /** Rewrite the strip: two vertices per point, width and alpha tapering to the tail. */
  private rebuild(): void {
    const count = this.points.length;
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    let normalX = 0;
    let normalY = 1;
    for (let i = 0; i < count; i++) {
      const point = this.points[i];
      const previous = this.points[i - 1] ?? point;
      const next = this.points[i + 1] ?? point;
      const tangentX = previous.x - next.x;
      const tangentY = previous.y - next.y;
      const length = Math.hypot(tangentX, tangentY);
      if (length > MIN_SEGMENT_LENGTH) {
        normalX = -tangentY / length;
        normalY = tangentX / length;
      }

      const ramp = count > 1 ? i / (count - 1) : 0;
      const taper = 1 - ramp;
      const half = this.halfWidth * taper;
      const alpha = Math.max(0, 1 - point.age / this.lifeSec) * taper;
      this.sampleRamp(ramp);

      const head = i * 2;
      this.positionAttribute.setXYZ(head, point.x + normalX * half, point.y + normalY * half, 0);
      this.positionAttribute.setXYZ(
        head + 1,
        point.x - normalX * half,
        point.y - normalY * half,
        0
      );
      this.colorAttribute.setXYZW(
        head,
        this.scratchColor.r,
        this.scratchColor.g,
        this.scratchColor.b,
        alpha
      );
      this.colorAttribute.setXYZW(
        head + 1,
        this.scratchColor.r,
        this.scratchColor.g,
        this.scratchColor.b,
        alpha
      );
    }

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, (count - 1) * 6);
  }

  /** Palette lookup at `ramp` (0 = head, 1 = tail), written into {@link scratchColor}. */
  private sampleRamp(ramp: number): void {
    const palette = this.palette;
    if (palette.length === 1) {
      this.scratchColor.copy(palette[0]);
      return;
    }
    const scaled = ramp * (palette.length - 1);
    const index = Math.min(palette.length - 2, Math.floor(scaled));
    this.scratchColor.copy(palette[index]).lerp(palette[index + 1], scaled - index);
  }
}
