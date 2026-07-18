import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const IMPACT_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';

/**
 * EnemyShell — the original `Ball`/`Ball1` cannon round fired by parked
 * gunships (see EnemyBalloon.fireGun). It flies straight toward the castle
 * with a lazy spin; on reaching the castle column (`impactX`) it deals its
 * `damage` to the castle (via `castle-damaged` on `game-root`), shakes the
 * camera, spawns a small explosion (no shockwave shove — it's near the wall,
 * not among the fleet) and frees itself. Purely a projectile under `effects`;
 * it carries no hitbox and cannot be shot down.
 */
export class EnemyShell extends Script {
  private done = false;
  private life = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      vx: -300,
      vy: 0,
      damage: 0,
      // Stage-local x of the castle column; the shell pops on reaching it.
      impactX: -190,
      shake: 4,
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
      properties: [num('vx', 'Vx (px/s)'), num('vy', 'Vy (px/s)'), num('damage', 'Castle Damage')],
      groups: { Shell: { label: 'Enemy Shell', expanded: true } },
    };
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.done) return;
    node.position.x += Number(this.config.vx) * dt;
    node.position.y += Number(this.config.vy) * dt;
    node.rotation.z += 3 * dt;
    this.life += dt;

    if (node.position.x <= Number(this.config.impactX)) {
      this.impact();
    } else if (node.position.x < -430 || this.life > 6) {
      // Overshot / stray — vanish quietly.
      this.done = true;
      node.queueFree();
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
