import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];
const DEATH_SOUND = 'res://src/assets/audio/explosions/explosion.mp3';
const CRASH_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';
const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';

/**
 * EnemyBalloon — a typical aerostat (GDD "S" class). Flies right→left with a
 * light bob, takes `damaged(amount)` hits from the player's gun (via
 * `scene.collision2d`), dies into a spawned explosion prefab, and reaching the
 * castle deals it damage. Reports to the GameFlow through signals on the
 * `game-root` node: `unit-killed(score)` / `castle-damaged(amount)` /
 * `enemy-gone` (any despawn — kill or crash — for wave accounting).
 */
export class EnemyBalloon extends Script {
  private hp = 0;
  private dead = false;
  private bobTime = 0;
  private baseY: number | null = null;
  private shoveVx = 0;
  private shoveVy = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hp: 100,
      speed: 55,
      score: 8,
      // Fraction of the castle HP bar one breakthrough costs (M2 scale: 0..1).
      castleDamage: 0.08,
      // Stage-local x where this unit stops and holds position (0 = fly to the castle).
      stopX: 0,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Enemy', step },
      getValue: (c: unknown) => (c as EnemyBalloon).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as EnemyBalloon).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'EnemyBalloon',
      properties: [
        num('hp', 'HP'),
        num('speed', 'Speed (px/s)'),
        num('score', 'Score'),
        num('castleDamage', 'Castle Damage (0..1)', 0.01),
        num('stopX', 'Stop X (0 = none)'),
      ],
      groups: { Enemy: { label: 'Enemy Balloon', expanded: true } },
    };
  }

  onStart(): void {
    this.hp = Number(this.config.hp);
    this.node?.connect('damaged', this, (amount: unknown) => {
      this.onDamaged(Number(amount) || 0);
    });
    // Shockwave shove (see ExplosionEffect): a decaying impulse; getting
    // shoved into the castle triggers the regular breakthrough detonation.
    this.node?.connect('shoved', this, (vx: unknown, vy: unknown) => {
      this.shoveVx += Number(vx) || 0;
      this.shoveVy += Number(vy) || 0;
    });
  }

  onUpdate(dt: number): void {
    if (!this.node || this.dead) return;

    if (this.baseY === null) {
      this.baseY = this.node.position.y;
    }

    // Shockwave impulse (decays quickly).
    if (this.shoveVx !== 0 || this.shoveVy !== 0) {
      this.node.position.x += this.shoveVx * dt;
      this.baseY += this.shoveVy * dt;
      const damp = Math.max(0, 1 - 3 * dt);
      this.shoveVx *= damp;
      this.shoveVy *= damp;
      if (Math.abs(this.shoveVx) < 2 && Math.abs(this.shoveVy) < 2) {
        this.shoveVx = 0;
        this.shoveVy = 0;
      }
    }

    // Drift left + a light bob so the balloon feels buoyant.
    this.bobTime += dt;
    const stopX = Number(this.config.stopX);
    const holding = stopX !== 0 && this.node.position.x <= stopX;
    if (!holding) {
      this.node.position.x -= Number(this.config.speed) * dt;
    }
    this.node.position.y = this.baseY + Math.sin(this.bobTime * 1.7) * 4;

    // Breakthrough: reached the castle column.
    if (this.node.position.x <= -180) {
      this.crashIntoCastle();
    }
  }

  private onDamaged(amount: number): void {
    if (this.dead || !this.node) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.die(true);
      return;
    }
    const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
    this.scene?.juice.punchScale(this.node, { amount: 0.22, duration: 0.16 });
  }

  private crashIntoCastle(): void {
    if (this.dead) return;
    this.scene?.audio.play(CRASH_SOUND, { bus: 'sfx', volumeVariation: 0.1 });
    this.scene?.juice.shake('camera2d', { amplitude: 10, duration: 0.3 });
    this.emitToGameRoot('castle-damaged', Number(this.config.castleDamage));
    this.die(false);
  }

  private die(scored: boolean): void {
    if (this.dead || !this.node) return;
    this.dead = true;

    if (scored) {
      this.scene?.audio.play(DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
      this.emitToGameRoot('unit-killed', Number(this.config.score));
    }
    this.emitToGameRoot('enemy-gone');
    this.spawnExplosion();
    this.node.queueFree();
  }

  private spawnExplosion(): void {
    const scene = this.scene;
    const node = this.node;
    if (!scene || !node) return;
    const x = node.position.x;
    const y = node.position.y;
    void scene
      .instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
      })
      .catch(err => console.warn('[EnemyBalloon] explosion spawn failed', err));
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }
}
