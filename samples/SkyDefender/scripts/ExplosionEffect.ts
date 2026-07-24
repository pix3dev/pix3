import { Node2D, Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { AdditiveBlending, Vector3 } from 'three';
import type { Mesh, MeshBasicMaterial } from 'three';

/**
 * engine-check: no built-in covers this because it is the gameplay shockwave
 * ("Взрывная волна" — an area impulse via collision2d.overlapCircle → emit
 * 'shoved') plus a procedural halo/wave whose scale+opacity are coupled to the
 * explosion timeline. The flipbook part (boom1 sequence) is NOT here anymore:
 * the three Boom AnimatedSprite2D children self-play the one-shot `burst` clip.
 *
 * ExplosionEffect — the GDD "typical explosion": three boom sprites at random
 * angles/sizes (now AnimatedSprite2D), a BlowGlow halo that expands and fades,
 * PLUS the shockwave (GDD "Взрывная волна" — the player's hidden weapon): the
 * explosion_wave mask grows ×2 while fading (additive blend), and every `enemy`
 * hitbox inside the wave radius gets a `shoved(vx, vy)` impulse away from the
 * epicenter — a unit shoved into the castle detonates there. The prefab
 * self-destroys via `queueFree()` when everything is done. `fps` matches the
 * boom1.pix3anim clip so the halo/wave/free stay in sync with the frames.
 */
export class ExplosionEffect extends Script {
  /** Frame count of the boom1 `burst` clip — drives glow/wave/free timing. */
  private static readonly BOOM_FRAME_COUNT = 22;

  private glow: Node2D | null = null;
  private wave: Node2D | null = null;
  private time = 0;
  private glowBaseScale = 1;
  private pushed = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      fps: 26,
      glowMaxScale: 2.4,
      // Shockwave: gameplay radius in stage px (scaled by the node's scale) and
      // the impulse at the epicenter (falls off linearly to the rim).
      waveRadius: 85,
      wavePush: 170,
      waveEnabled: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Explosion', step },
      getValue: (c: unknown) => (c as ExplosionEffect).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as ExplosionEffect).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'ExplosionEffect',
      properties: [
        num('fps', 'Sequence FPS'),
        num('glowMaxScale', 'Glow Max Scale', 0.1),
        num('waveRadius', 'Wave Radius (px)'),
        num('wavePush', 'Wave Push (px/s)'),
      ],
      groups: { Explosion: { label: 'Explosion', expanded: true } },
    };
  }

  onStart(): void {
    // Random per-instance orientation so no two explosions look alike (GDD).
    // The three Boom AnimatedSprite2D children keep their authored relative
    // angles; spinning the whole group varies the composite each spawn.
    if (this.node) {
      this.node.rotation.z = Math.random() * Math.PI * 2;
    }

    const glowNode = this.node?.getChildByName('Blow Glow') ?? null;
    this.glow = glowNode instanceof Node2D ? glowNode : null;
    if (this.glow) {
      this.glowBaseScale = this.glow.scale.x || 1;
    }

    // Shockwave sprite: additive blending sells the "flash of pressure"
    // (the GDD asks for Overlay with a normal-blend fallback; additive is the
    // closest three.js equivalent that needs no custom blend function).
    const waveNode = this.node?.getChildByName('Shock Wave') ?? null;
    this.wave = waveNode instanceof Node2D ? waveNode : null;
    this.wave?.traverse(obj => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) {
        (mesh.material as MeshBasicMaterial).blending = AdditiveBlending;
      }
    });
  }

  onUpdate(dt: number): void {
    if (!this.node) return;
    this.time += dt;

    const fps = Math.max(1, Number(this.config.fps));
    const duration = ExplosionEffect.BOOM_FRAME_COUNT / fps;

    if (!this.pushed) {
      this.pushed = true;
      this.pushNeighbors();
    }

    // Glow: expand and fade over the whole duration.
    if (this.glow) {
      const t = Math.min(1, this.time / duration);
      const maxScale = Number(this.config.glowMaxScale);
      const s = this.glowBaseScale * (1 + (maxScale - 1) * t);
      this.glow.scale.set(s, s, 1);
      this.glow.opacity = 0.9 * (1 - t);
    }

    // Shockwave: grows to 2× the gameplay radius over the front half of the
    // effect, fading out (GDD: mask grows ×2 with decay). Config keys may be
    // absent when the scene YAML predates them — treat missing as enabled.
    if (this.wave && this.config.waveEnabled !== false) {
      const waveT = Math.min(1, this.time / (duration * 0.55));
      const targetDiameter = (Number(this.config.waveRadius) || 85) * 2;
      const s = (targetDiameter / 60) * (0.35 + 1.65 * waveT);
      this.wave.scale.set(s, s, 1);
      this.wave.opacity = 0.55 * (1 - waveT);
    }

    if (this.time >= duration + 0.1) {
      this.node.queueFree();
    }
  }

  /** One-shot gameplay push: shove every enemy hitbox inside the wave radius. */
  private pushNeighbors(): void {
    const node = this.node;
    const scene = this.scene;
    if (!node || !scene || this.config.waveEnabled === false) return;

    const epicenter = node.getWorldPosition(ExplosionEffect.scratch);
    const worldScale = node.getWorldScale(ExplosionEffect.scratch2);
    const scale = Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y)) || 1;
    const radiusWorld = (Number(this.config.waveRadius) || 85) * scale;
    const push = Number(this.config.wavePush) || 170;

    const hits = scene.collision2d.overlapCircle(epicenter.x, epicenter.y, radiusWorld, 'enemy');
    const shovedNodes = new Set<unknown>();
    for (const hit of hits) {
      if (shovedNodes.has(hit.node)) continue;
      shovedNodes.add(hit.node);
      const target = hit.node.getWorldPosition(ExplosionEffect.scratch3);
      const dx = target.x - epicenter.x;
      const dy = target.y - epicenter.y;
      const dist = Math.hypot(dx, dy);
      const falloff = Math.max(0.25, 1 - dist / radiusWorld);
      const nx = dist > 1e-3 ? dx / dist : 1;
      const ny = dist > 1e-3 ? dy / dist : 0;
      // Impulse is in stage-local px/s (enemies integrate their own position).
      hit.node.emit('shoved', nx * push * falloff, ny * push * falloff);
    }
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
  private static readonly scratch3 = new Vector3();
}
