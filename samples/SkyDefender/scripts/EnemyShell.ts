import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { AdditiveBlending } from 'three';
import type { Mesh, MeshBasicMaterial } from 'three';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const IMPACT_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';

/**
 * EnemyShell — the original `Ball`/`Ball1` cannon round fired by parked
 * gunships and ground cannon (see EnemyBalloon.fireGun / GroundVehicle.fireCannon).
 * Three flight profiles, selected via config:
 * - `mode:'straight'` + `gravity:0` — the heavy/direct cannon (flies flat);
 * - `mode:'straight'` + upward `vy` + negative `gravity` — the light LOBBED
 *   cannon (arc), so the ball rises then falls toward the castle;
 * - `mode:'torpedo'` — free-falls for `torpedoIgniteSec`, then the engine
 *   ignites: it levels out and flies straight left at full `vx`, trailing a
 *   glow (`trailTexture`) and wearing the torpedo body (`bodyTexture`).
 * On reaching the castle column (`impactX`) it deals its `damage` to the castle
 * (via `castle-damaged` on `game-root`), shakes the camera, spawns a small
 * explosion (no shockwave shove — it's near the wall, not among the fleet) and
 * frees itself. Purely a projectile under `effects`; it carries no hitbox and
 * cannot be shot down.
 */
export class EnemyShell extends Script {
  private done = false;
  private life = 0;
  /** Torpedo-only vertical velocity during the free-fall glide. */
  private torpedoVy = 0;
  private ignited = false;
  private trail: Sprite2D | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      vx: -300,
      vy: 0,
      // Vertical acceleration (px/s²); 0 = flat, negative = lobbed arc / torpedo fall.
      gravity: 0,
      damage: 0,
      // Stage-local x of the castle column; the shell pops on reaching it.
      impactX: -190,
      shake: 4,
      // 'straight' (direct / arc) or 'torpedo' (free-fall → ignite → fly straight).
      mode: 'straight',
      // Torpedo: seconds of free-fall before the engine ignites.
      torpedoIgniteSec: 0.4,
      // Torpedo dressing (set by the launcher; falls back to the prefab Ball).
      bodyTexture: '',
      trailTexture: '',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Shell' },
      getValue: (c: unknown) => (c as EnemyShell).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as EnemyShell).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'EnemyShell',
      properties: [
        num('vx', 'Vx (px/s)'),
        num('vy', 'Vy (px/s)'),
        num('gravity', 'Gravity (px/s²)'),
        num('damage', 'Castle Damage'),
        num('torpedoIgniteSec', 'Torpedo Ignite (s)'),
        {
          name: 'mode',
          type: 'string' as const,
          ui: { label: 'Mode (straight|torpedo)', group: 'Shell' },
          getValue: (c: unknown) => (c as EnemyShell).config.mode,
          setValue: (c: unknown, v: unknown) => {
            (c as EnemyShell).config.mode = String(v);
          },
        },
      ],
      groups: { Shell: { label: 'Enemy Shell', expanded: true } },
    };
  }

  onStart(): void {
    if (String(this.config.mode) === 'torpedo') {
      this.torpedoVy = Number(this.config.vy) || 0;
      this.setupTorpedoVisuals();
    }
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.done) return;
    this.life += dt;

    if (String(this.config.mode) === 'torpedo') {
      this.updateTorpedo(node, dt);
    } else {
      // Straight (direct) or arc (lobbed): integrate gravity into vy each frame.
      const vy = Number(this.config.vy) + Number(this.config.gravity) * dt;
      this.config.vy = vy;
      node.position.x += Number(this.config.vx) * dt;
      node.position.y += vy * dt;
      node.rotation.z += 3 * dt;
    }

    if (node.position.x <= Number(this.config.impactX)) {
      this.impact();
    } else if (node.position.x < -430 || this.life > 6) {
      // Overshot / stray — vanish quietly.
      this.done = true;
      node.queueFree();
    }
  }

  /** Torpedo (weapon class 2): free-fall, then ignite and run straight. */
  private updateTorpedo(node: NodeBase, dt: number): void {
    const ignite = Math.max(0, Number(this.config.torpedoIgniteSec));
    const fullVx = Number(this.config.vx);
    if (this.life < ignite) {
      // Engine off: gravity pulls it down, only a slow forward drift.
      this.torpedoVy += Number(this.config.gravity) * dt;
      node.position.x += fullVx * 0.3 * dt;
      node.position.y += this.torpedoVy * dt;
    } else {
      this.ignited = true;
      // Engine on: level out and fly straight left at full speed.
      node.position.x += fullVx * dt;
    }
    // Exhaust trail: faint while gliding, bright and pulsing once ignited.
    if (this.trail) {
      this.trail.opacity = this.ignited ? 0.8 + Math.sin(this.life * 30) * 0.2 : 0.15;
    }
  }

  /** Swap in the torpedo body + attach a trailing glow (robust: skips if missing). */
  private setupTorpedoVisuals(): void {
    const node = this.node;
    const loader = this.scene?.getAssetLoader();
    if (!node || !loader) return;

    const bodyPath = String(this.config.bodyTexture ?? '');
    const sprite = node instanceof Sprite2D ? node : null;
    if (bodyPath && sprite) {
      void loader
        .loadTexture(bodyPath)
        .then(tex => {
          sprite.setTexture(tex);
          // Body texture (torpedo.png 72×12) drives its own size.
          sprite.resetToOriginalSize();
        })
        .catch(() => console.warn(`[EnemyShell] missing torpedo body ${bodyPath}`));
    }

    const trailPath = String(this.config.trailTexture ?? '');
    if (trailPath) {
      void loader
        .loadTexture(trailPath)
        .then(tex => {
          const trail = new Sprite2D({
            id: `${node.id ?? 'shell'}-trail`,
            name: 'Torpedo Trail',
            width: 20,
            height: 12,
          });
          trail.setTexture(tex);
          // Sit at the tail (+x) so it streams behind the leftward torpedo.
          trail.position.set(30, 0, 0);
          trail.opacity = 0;
          trail.traverse(obj => {
            const mesh = obj as Mesh;
            if (mesh.isMesh) (mesh.material as MeshBasicMaterial).blending = AdditiveBlending;
          });
          node.add(trail);
          this.trail = trail;
        })
        .catch(() => console.warn(`[EnemyShell] missing torpedo trail ${trailPath}`));
    }
  }

  private impact(): void {
    const node = this.node;
    if (!node || this.done) return;
    this.done = true;
    const damage = Number(this.config.damage) || 0;
    if (damage > 0) {
      this.findNode('game-root')?.emit('castle-damaged', damage);
      this.scene?.juice.shake('camera2d', {
        amplitude: Number(this.config.shake) || 4,
        duration: 0.15,
      });
    }
    this.scene?.audio.play(IMPACT_SOUND, { bus: 'sfx', pitchVariation: 0.15 });
    const x = node.position.x;
    const y = node.position.y;
    void this.scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
        fx.scale.set(0.45, 0.45, 1);
        // No shockwave shove for a shell hit (would shove the whole fleet).
        const efx = fx.components.find(
          c => (c as { type?: string }).type === 'user:ExplosionEffect'
        ) as { config?: Record<string, unknown> } | undefined;
        if (efx?.config) efx.config.waveEnabled = false;
      })
      .catch(() => undefined);
    node.queueFree();
  }
}
