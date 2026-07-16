import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';

const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];
const DEATH_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';
const SHOT_SOUNDS = [
  'res://src/assets/audio/guns/enemy/eshot1.mp3',
  'res://src/assets/audio/guns/enemy/eshot2.mp3',
  'res://src/assets/audio/guns/enemy/eshot3.mp3',
];
const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';

/**
 * GroundVehicle — a ground unit that drives the assembled bridge toward the
 * castle (right→left along the deck), parks at the gate and rams it every
 * `attackPeriod` seconds until killed. Spawned by WaveSpawner once the bridge
 * reports ready; shares the balloon signal contract (`damaged` in,
 * `unit-killed` / `castle-damaged` / `enemy-gone` out on `game-root`).
 */
export class GroundVehicle extends Script {
  private hp = 0;
  private dead = false;
  private time = 0;
  private baseY: number | null = null;
  private attackTimer = 0;
  private lunge = 0;
  /** Deck cannon (prefab child); recoils on each shot at the gate. */
  private gun: NodeBase | null = null;
  private gunBaseX = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hp: 300,
      speed: 35,
      score: 25,
      // Stage-local x where the vehicle parks (the castle gate).
      stopX: -70,
      attackDamage: 25,
      attackPeriod: 5,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Vehicle', step },
      getValue: (c: unknown) => (c as GroundVehicle).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as GroundVehicle).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'GroundVehicle',
      properties: [
        num('hp', 'HP'),
        num('speed', 'Speed (px/s)'),
        num('score', 'Score'),
        num('stopX', 'Stop X'),
        num('attackDamage', 'Ram Damage (HP)'),
        num('attackPeriod', 'Ram Period (s)', 0.1),
      ],
      groups: { Vehicle: { label: 'Ground Vehicle', expanded: true } },
    };
  }

  onStart(): void {
    this.hp = Number(this.config.hp);
    this.node?.connect('damaged', this, (amount: unknown) => {
      this.onDamaged(Number(amount) || 0);
    });
    this.gun = (this.node?.getChildByName('Truck Gun') as NodeBase | undefined) ?? null;
    this.gunBaseX = this.gun?.position.x ?? 0;
  }

  onUpdate(dt: number): void {
    if (!this.node || this.dead) return;
    this.time += dt;
    if (this.baseY === null) {
      this.baseY = this.node.position.y;
    }

    const stopX = Number(this.config.stopX);
    const holding = this.node.position.x <= stopX;
    if (!holding) {
      this.node.position.x -= Number(this.config.speed) * dt;
      // Suspension rattle while rolling over the trusses.
      this.node.position.y = this.baseY + Math.abs(Math.sin(this.time * 9)) * 1.3;
    } else {
      this.node.position.y = this.baseY;
      this.updateRam(dt);
    }

    // Firing animation: the deck cannon kicks back; without a gun the hull
    // lunges at the gate the old way.
    if (this.lunge > 0) {
      this.lunge = Math.max(0, this.lunge - dt * 3);
      const kick = Math.sin(this.lunge * Math.PI);
      if (this.gun) {
        this.gun.position.x = this.gunBaseX + kick * 5;
      } else {
        this.node.position.x = stopX - kick * 7;
      }
    }
  }

  /** Parked at the gate: batter the castle on a timer. */
  private updateRam(dt: number): void {
    const damage = Number(this.config.attackDamage);
    if (damage <= 0) return;
    this.attackTimer += dt;
    const period = Math.max(0.5, Number(this.config.attackPeriod));
    if (this.attackTimer < period) return;
    this.attackTimer = 0;
    this.lunge = 1;
    const sound = SHOT_SOUNDS[Math.floor(Math.random() * SHOT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.1 });
    this.scene?.juice.shake('camera2d', { amplitude: 5, duration: 0.2 });
    this.emitToGameRoot('castle-damaged', damage);
  }

  private onDamaged(amount: number): void {
    if (this.dead || !this.node) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.die();
      return;
    }
    const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
    this.scene?.juice.punchScale(this.node, { amount: 0.15, duration: 0.14 });
  }

  private die(): void {
    if (this.dead || !this.node) return;
    this.dead = true;
    this.scene?.audio.play(DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.emitToGameRoot('unit-killed', Number(this.config.score));
    this.emitToGameRoot('enemy-gone');

    const scene = this.scene;
    const x = this.node.position.x;
    const y = this.node.position.y;
    void scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y + 8, 0);
        fx.scale.set(0.85, 0.85, 1);
      })
      .catch(() => undefined);
    this.node.queueFree();
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }
}
