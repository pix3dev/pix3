import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Uint16BufferAttribute,
  type Texture,
} from 'three';

import { Node2D, type Node2DProps } from '../nodes/Node2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import { configure2DTexture } from './configure-2d-texture';
import { OVERLAY_2D_FLAG } from './render-order-2d';

/**
 * Transient play-mode visuals behind `scene.juice.burst()` / `scene.juice.floatText()`.
 *
 * These are deliberately NOT authorable node types: no YAML serialization, no
 * editor proxy, no inspector schema. They are spawned into the running 2D tree,
 * live for a fraction of a second, and `queueFree()` themselves — the same
 * lifecycle a one-shot VFX prefab would have, minus the authoring cost.
 *
 * 2D pass rules they must obey (see CLAUDE.md "2D overlay rendering"):
 * - they are `Node2D`s, so `Node2D.add` stamps `LAYER_2D` on their meshes and the
 *   per-frame `assign2DLayers` keeps them in whichever band their host lives in;
 * - materials are `depthTest: false` — paint order comes from the DFS
 *   `renderOrder` walk, so being the LAST child of the host is what puts them on
 *   top (plus `zIndex` when a caller needs more);
 * - canvas textures go through `configure2DTexture` (mipmaps off).
 */

/** A point in 2D world/design space (origin at the design-resolution centre, Y up). */
export interface JuicePoint2D {
  x: number;
  y: number;
}

/** Tuning for {@link ParticleBurst2D} — every field has a "already juicy" default. */
export interface BurstOptions {
  /** Number of particles (1..512, default 14). */
  count?: number;
  /** Initial speed in px/s; each particle gets 55–100% of it (default 260). */
  speed?: number;
  /** Cone width in RADIANS around {@link direction} (default `Math.PI * 2` = all around). */
  spread?: number;
  /** Cone centre in RADIANS (default `Math.PI / 2` = up). Irrelevant at full spread. */
  direction?: number;
  /** Particle lifetime in seconds; each gets 70–130% of it (default 0.5). */
  lifeSec?: number;
  /** Single particle colour (CSS string). Ignored when {@link colors} is set. */
  color?: string;
  /** Palette — each particle picks one at random. */
  colors?: string[];
  /** Particle size in px; each gets 70–130% of it (default 10). */
  sizePx?: number;
  /** Vertical acceleration in px/s² (default -600, i.e. falling sparks; 0 = weightless). */
  gravityY?: number;
  /** Fade particles out over their life (default true). */
  fadeOut?: boolean;
  /** Additive blending — the neon/glow look (default true). False = normal alpha blend. */
  additive?: boolean;
  /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
  zIndex?: number;
}

/** Style/motion tuning for {@link FloatText2D} (the `at` target lives on `JuiceApi`). */
export interface FloatTextStyleOptions {
  /** Text colour (CSS string, default `#ffffff`). */
  color?: string;
  /** Font size in px (default 28). */
  fontSizePx?: number;
  /** Font family (default `Arial`). */
  fontFamily?: string;
  /** Vertical travel in px over the popup's life; negative drifts down (default 60). */
  driftPx?: number;
  /** Total life in seconds (default 0.8). */
  durationSec?: number;
  /** `true` glows in the text colour, a CSS string glows in that colour (default off). */
  glow?: boolean | string;
  /** Glow strength 0..4 when {@link glow} is on (default 1.5). */
  glowStrength?: number;
  /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
  zIndex?: number;
}

const BURST_DEFAULTS = {
  count: 14,
  speed: 260,
  spread: Math.PI * 2,
  direction: Math.PI / 2,
  lifeSec: 0.5,
  sizePx: 10,
  gravityY: -600,
} as const;

/** Hard ceiling on particles per burst — a runaway `count` must not stall a frame. */
export const BURST_MAX_PARTICLES = 512;

const FLOAT_TEXT_DEFAULTS = {
  fontSizePx: 28,
  driftPx: 60,
  durationSec: 0.8,
  glowStrength: 1.5,
} as const;

/** Portion of the popup's life spent on the scale pop-in. */
const FLOAT_TEXT_POP_PORTION = 0.22;
/** Portion of the popup's life shown at full opacity before the fade starts. */
const FLOAT_TEXT_FADE_START = 0.45;

// Unit-quad corners / UVs, matching SHARED_UNIT_QUAD_GEOMETRY's winding (see batch-2d).
const QUAD_CORNERS: readonly (readonly [number, number])[] = [
  [-0.5, 0.5],
  [0.5, 0.5],
  [-0.5, -0.5],
  [0.5, -0.5],
];
const QUAD_UVS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [0, 0],
  [1, 0],
];
const QUAD_INDEX: readonly number[] = [0, 1, 2, 2, 1, 3];

/** `undefined` = not built yet, `null` = this environment has no 2D canvas (headless). */
let sharedParticleTexture: Texture | null | undefined;

/**
 * Soft round particle sprite, built once and shared by every burst (so it must
 * never be disposed by a node teardown — `Material.dispose()` does not touch
 * textures, which is why the default `disposeResources()` is safe here).
 */
function getParticleTexture(): Texture | null {
  if (sharedParticleTexture !== undefined) {
    return sharedParticleTexture;
  }
  sharedParticleTexture = createParticleTexture();
  return sharedParticleTexture;
}

function createParticleTexture(): Texture | null {
  if (typeof document === 'undefined') {
    return null;
  }
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.createRadialGradient !== 'function') {
      return null;
    }
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new CanvasTexture(canvas);
    configure2DTexture(texture);
    return texture;
  } catch {
    // No usable canvas (happy-dom / stubbed context) — square particles are fine.
    return null;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function resolvePalette(options: BurstOptions): Color[] {
  const raw = Array.isArray(options.colors) ? options.colors : [];
  const entries = raw.filter(
    (entry): entry is string => typeof entry === 'string' && !!entry.trim()
  );
  if (entries.length === 0 && typeof options.color === 'string' && options.color.trim()) {
    entries.push(options.color);
  }
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

interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
}

/**
 * One-shot 2D particle burst: a single quad-batch mesh whose vertices are moved
 * on the CPU each tick (a handful of particles for a fraction of a second, so the
 * per-frame cost is noise), auto-freeing once the last particle dies.
 *
 * Ticked through `node.tick`, so it respects the global `Time.scale` exactly like
 * the other juice effects — a hitstop freezes the sparks mid-air.
 */
export class ParticleBurst2D extends Node2D {
  private readonly particles: BurstParticle[] = [];
  private readonly geometry: BufferGeometry;
  private readonly positionAttribute: Float32BufferAttribute;
  private readonly colorAttribute: Float32BufferAttribute;
  private readonly gravityY: number;
  private readonly fadeOut: boolean;
  private aliveParticles: number;

  constructor(props: Node2DProps, options: BurstOptions = {}) {
    super(props, 'ParticleBurst2D');

    // A transient effect is never a drop target and has no children to hit-test.
    this.isContainer = false;

    const count = Math.round(
      clampNumber(options.count, BURST_DEFAULTS.count, 1, BURST_MAX_PARTICLES)
    );
    const speed = clampNumber(options.speed, BURST_DEFAULTS.speed, 0, 20000);
    const spread = clampNumber(options.spread, BURST_DEFAULTS.spread, 0, Math.PI * 2);
    const direction = clampNumber(options.direction, BURST_DEFAULTS.direction, -1e6, 1e6);
    const life = clampNumber(options.lifeSec, BURST_DEFAULTS.lifeSec, 0.05, 10);
    const size = clampNumber(options.sizePx, BURST_DEFAULTS.sizePx, 0.5, 1024);
    this.gravityY = clampNumber(options.gravityY, BURST_DEFAULTS.gravityY, -100000, 100000);
    this.fadeOut = options.fadeOut !== false;
    if (options.zIndex !== undefined) {
      this.zIndex = clampNumber(options.zIndex, 0, -4096, 4096);
    }

    const palette = resolvePalette(options);
    this.geometry = new BufferGeometry();
    this.positionAttribute = new Float32BufferAttribute(new Float32Array(count * 4 * 3), 3);
    this.colorAttribute = new Float32BufferAttribute(new Float32Array(count * 4 * 4), 4);
    const uvAttribute = new Float32BufferAttribute(new Float32Array(count * 4 * 2), 2);
    const indices = new Uint16Array(count * 6);

    for (let i = 0; i < count; i++) {
      const angle = direction + (Math.random() - 0.5) * spread;
      const particleSpeed = speed * (0.55 + Math.random() * 0.45);
      const particle: BurstParticle = {
        x: 0,
        y: 0,
        vx: Math.cos(angle) * particleSpeed,
        vy: Math.sin(angle) * particleSpeed,
        age: 0,
        life: life * (0.7 + Math.random() * 0.6),
        size: size * (0.7 + Math.random() * 0.6),
      };
      this.particles.push(particle);

      const tint = palette[Math.floor(Math.random() * palette.length)] ?? palette[0];
      for (let corner = 0; corner < 4; corner++) {
        const vertex = i * 4 + corner;
        uvAttribute.setXY(vertex, QUAD_UVS[corner][0], QUAD_UVS[corner][1]);
        this.colorAttribute.setXYZW(vertex, tint.r, tint.g, tint.b, 1);
      }
      for (let k = 0; k < QUAD_INDEX.length; k++) {
        indices[i * 6 + k] = i * 4 + QUAD_INDEX[k];
      }
      // Paint frame zero at full size — the burst is visible before its first tick.
      this.writeQuad(i, particle.x, particle.y, particle.size);
    }

    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('uv', uvAttribute);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setIndex(new Uint16BufferAttribute(indices, 1));
    this.aliveParticles = count;

    const material = new MeshBasicMaterial({
      map: getParticleTexture(),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexColors: true,
      blending: options.additive === false ? NormalBlending : AdditiveBlending,
    });
    this.registerOpacityMaterial(material, 1);

    const mesh = new Mesh(this.geometry, material);
    // Particle positions are baked into the buffer, so the geometry's bounding
    // sphere is stale every frame — culling it would pop the burst in and out.
    mesh.frustumCulled = false;
    // Float above anything the host draws under this node (see render-order-2d).
    mesh.userData[OVERLAY_2D_FLAG] = true;
    this.add(mesh);
  }

  /** Particles actually allocated (after the {@link BurstOptions.count} clamp). */
  get particleCount(): number {
    return this.particles.length;
  }

  /** Particles still moving; 0 means this node has queued itself for freeing. */
  get aliveCount(): number {
    return this.aliveParticles;
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (this.aliveParticles === 0) {
      return;
    }

    const step = Math.max(0, dt);
    let alive = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      if (particle.age >= particle.life) {
        continue;
      }
      particle.age += step;
      const progress = particle.age / particle.life;
      if (progress >= 1) {
        this.writeQuad(i, particle.x, particle.y, 0);
        this.writeAlpha(i, 0);
        continue;
      }
      particle.vy += this.gravityY * step;
      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      this.writeQuad(i, particle.x, particle.y, particle.size * (1 - 0.6 * progress));
      this.writeAlpha(i, this.fadeOut ? 1 - progress * progress : 1);
      alive++;
    }

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.aliveParticles = alive;
    if (alive === 0) {
      this.queueFree();
    }
  }

  private writeQuad(index: number, x: number, y: number, size: number): void {
    for (let corner = 0; corner < 4; corner++) {
      const [cornerX, cornerY] = QUAD_CORNERS[corner];
      this.positionAttribute.setXYZ(index * 4 + corner, x + cornerX * size, y + cornerY * size, 0);
    }
  }

  private writeAlpha(index: number, alpha: number): void {
    const array = this.colorAttribute.array as Float32Array;
    for (let corner = 0; corner < 4; corner++) {
      array[(index * 4 + corner) * 4 + 3] = alpha;
    }
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Floating score/text popup: a transient {@link Label2D} that pops in, rises and
 * fades, then frees itself. Never participates in picking (its hit test is
 * always false), so a popup drifting over a button can't eat the tap.
 */
export class FloatText2D extends Label2D {
  private readonly totalDuration: number;
  private readonly driftPx: number;
  private elapsed = 0;
  private captured = false;
  private baseY = 0;
  private baseScaleX = 1;
  private baseScaleY = 1;
  private finished = false;

  constructor(props: Node2DProps, text: string, options: FloatTextStyleOptions = {}) {
    const color =
      typeof options.color === 'string' && options.color.trim() ? options.color : '#ffffff';
    const glowColor =
      options.glow === true
        ? color
        : typeof options.glow === 'string' && options.glow.trim()
          ? options.glow
          : '';
    super({
      ...props,
      label: text,
      labelColor: color,
      labelFontFamily:
        typeof options.fontFamily === 'string' && options.fontFamily.trim()
          ? options.fontFamily
          : 'Arial',
      labelFontSize: clampNumber(options.fontSizePx, FLOAT_TEXT_DEFAULTS.fontSizePx, 1, 512),
      glowColor: glowColor || undefined,
      glowStrength: glowColor
        ? clampNumber(options.glowStrength, FLOAT_TEXT_DEFAULTS.glowStrength, 0, 4)
        : 0,
      zIndex: options.zIndex,
    });

    this.isContainer = false;
    this.totalDuration = clampNumber(
      options.durationSec,
      FLOAT_TEXT_DEFAULTS.durationSec,
      0.05,
      30
    );
    this.driftPx = clampNumber(options.driftPx, FLOAT_TEXT_DEFAULTS.driftPx, -10000, 10000);
  }

  /** Transient popups are never pickable — see the class doc. */
  override isPointInBounds(): boolean {
    return false;
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (this.finished) {
      return;
    }
    if (!this.captured) {
      // The spawner positions/scales the popup after construction, so the
      // animation base is captured on the first tick (as PunchScale does).
      this.baseY = this.position.y;
      this.baseScaleX = this.scale.x;
      this.baseScaleY = this.scale.y;
      this.captured = true;
    }

    this.elapsed += Math.max(0, dt);
    const progress = Math.min(1, this.elapsed / this.totalDuration);

    this.position.y = this.baseY + this.driftPx * easeOutCubic(progress);
    const pop =
      progress < FLOAT_TEXT_POP_PORTION ? easeOutBack(progress / FLOAT_TEXT_POP_PORTION) : 1;
    this.scale.set(this.baseScaleX * pop, this.baseScaleY * pop, 1);
    this.opacity =
      progress < FLOAT_TEXT_FADE_START
        ? 1
        : Math.max(0, 1 - (progress - FLOAT_TEXT_FADE_START) / (1 - FLOAT_TEXT_FADE_START));

    if (progress >= 1) {
      this.finished = true;
      this.queueFree();
    }
  }
}
