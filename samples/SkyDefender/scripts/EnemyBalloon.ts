import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { BurningWreck } from './BurningWreck';

const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];
const DEATH_SOUND = 'res://src/assets/audio/explosions/explosion.mp3';
const MINE_BOOM_SOUND = 'res://src/assets/audio/explosions/big_explosion.mp3';
const LINK_SNAP_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';
const CRASH_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';
const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const WRECK_PREFAB = 'res://src/assets/prefabs/burning-wreck.pix3scene';
const DROP_SOUNDS = [
  'res://src/assets/audio/guns/enemy/edrop1.mp3',
  'res://src/assets/audio/guns/enemy/edrop2.mp3',
  'res://src/assets/audio/guns/enemy/edrop3.mp3',
];
const FALLING_MINE_PREFAB = 'res://src/assets/prefabs/falling-mine.pix3scene';
const DEFAULT_SPRITE = 'res://src/assets/textures/enemy/air/typical_bloon/SU_typical.png';

/**
 * EnemyBalloon — a typical aerostat (GDD "S" class) with the original
 * three-part destruction scenario (шар / перемычка / бомба):
 * - hit the BALLOON body → it catches fire and falls as a burning wreck
 *   (detonating on impact), the carried mine detaches into free fall;
 * - hit the LINK (weapon mount) → the rig snaps: the mine drops as a bomb
 *   while the freed balloon sails up into the sky and escapes;
 * - hit the MINE → it detonates instantly and takes the balloon with it.
 * Flies right→left with a light bob, takes `damaged(amount)` hits (via
 * `scene.collision2d`), and reaching the castle deals it damage. Reports to
 * the GameFlow through signals on the `game-root` node: `unit-killed(score)`
 * / `castle-damaged(amount)` / `enemy-gone` (any despawn — kill, escape or
 * crash — for wave accounting).
 */
export class EnemyBalloon extends Script {
  private hp = 0;
  private linkHp = 0;
  private mineHp = 0;
  private state: 'intact' | 'flyaway' | 'climb' | 'gone' = 'intact';
  private flyawaySpeed = 0;
  private bobTime = 0;
  private baseY: number | null = null;
  private shoveVx = 0;
  private shoveVy = 0;
  private attackTimer = 0;
  /** Bombing-run acceleration on top of config speed (original +0.05 px/f²). */
  private speedBoost = 0;
  private linkNode: NodeBase | null = null;
  private mineNode: NodeBase | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hp: 100,
      speed: 55,
      score: 8,
      // Absolute castle HP one breakthrough costs (M4 scale: floors are 700..1600).
      castleDamage: 60,
      // Stage-local x where this unit stops and holds position (0 = fly to the castle).
      stopX: 0,
      // Gun platforms: while holding at stopX, shell the castle every attackPeriod s.
      attackDamage: 0,
      attackPeriod: 4,
      // Bombers (original class_108): carry ONE bomb, release it at stopX and
      // climb away; attackDamage is the bomb's castle hit on landing.
      bomber: false,
      // Weapon rig parts (only active on units that carry the mine).
      linkHp: 25,
      mineHp: 25,
      // Texture the burning wreck reuses (set by WaveSpawner per livery).
      spritePath: '',
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
        num('castleDamage', 'Castle Damage (HP)'),
        num('stopX', 'Stop X (0 = none)'),
        num('attackDamage', 'Attack Damage (HP)'),
        num('attackPeriod', 'Attack Period (s)', 0.1),
        {
          name: 'bomber',
          type: 'boolean',
          ui: { label: 'Bomber (single drop)', group: 'Enemy' },
          getValue: (c: unknown) => (c as EnemyBalloon).config.bomber,
          setValue: (c: unknown, v: unknown) => {
            (c as EnemyBalloon).config.bomber = Boolean(v);
          },
        },
        num('linkHp', 'Link HP'),
        num('mineHp', 'Mine HP'),
      ],
      groups: { Enemy: { label: 'Enemy Balloon', expanded: true } },
    };
  }

  onStart(): void {
    this.hp = Number(this.config.hp);
    this.linkHp = Number(this.config.linkHp);
    this.mineHp = Number(this.config.mineHp);
    this.node?.connect('damaged', this, (amount: unknown) => {
      this.onBodyDamaged(Number(amount) || 0);
    });
    // Shockwave shove (see ExplosionEffect): a decaying impulse; getting
    // shoved into the castle triggers the regular breakthrough detonation.
    this.node?.connect('shoved', this, (vx: unknown, vy: unknown) => {
      this.shoveVx += Number(vx) || 0;
      this.shoveVy += Number(vy) || 0;
    });

    // Weapon rig parts with their own hitboxes (WaveSpawner disables both on
    // units that fly without the mine).
    this.linkNode = (this.node?.getChildByName('Weapon Mount') as NodeBase | undefined) ?? null;
    this.mineNode = (this.node?.getChildByName('Carried Mine') as NodeBase | undefined) ?? null;
    this.linkNode?.connect('damaged', this, (amount: unknown) => {
      this.onLinkDamaged(Number(amount) || 0);
    });
    this.mineNode?.connect('damaged', this, (amount: unknown) => {
      this.onMineDamaged(Number(amount) || 0);
    });
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;

    if (this.baseY === null) {
      this.baseY = node.position.y;
    }

    if (this.state === 'flyaway') {
      // The freed balloon sails up and slightly onward until off-screen.
      this.flyawaySpeed = Math.min(110, this.flyawaySpeed + 80 * dt);
      node.position.y += this.flyawaySpeed * dt;
      node.position.x -= Number(this.config.speed) * 0.25 * dt;
      if (node.position.y > 330) {
        this.despawn();
      }
      return;
    }

    // Shockwave impulse (decays quickly).
    if (this.shoveVx !== 0 || this.shoveVy !== 0) {
      node.position.x += this.shoveVx * dt;
      this.baseY += this.shoveVy * dt;
      const damp = Math.max(0, 1 - 3 * dt);
      this.shoveVx *= damp;
      this.shoveVy *= damp;
      if (Math.abs(this.shoveVx) < 2 && Math.abs(this.shoveVy) < 2) {
        this.shoveVx = 0;
        this.shoveVy = 0;
      }
    }

    this.bobTime += dt;
    const stopX = Number(this.config.stopX);
    const speed = Number(this.config.speed) + this.speedBoost;

    if (this.state === 'climb') {
      // Bomb away: the lightened ship climbs out over the castle (original
      // class_108: y -0.5/frame) and leaves the field.
      node.position.x -= speed * dt;
      this.baseY += 15 * dt;
      node.position.y = this.baseY + Math.sin(this.bobTime * 1.7) * 4;
      if (node.position.x < -520 || node.position.y > 330) {
        this.despawn();
      }
      return;
    }

    // Drift left + a light bob so the balloon feels buoyant.
    if (this.isBomber()) {
      // Bombing run: speed up on final approach (original: +0.05 px/frame²
      // once past x 340 ≈ stage 20), release at the `a` mark, then climb.
      if (node.position.x < 20) {
        this.speedBoost = Math.min(80, this.speedBoost + 45 * dt);
      }
      node.position.x -= speed * dt;
      if (stopX !== 0 && node.position.x <= stopX) {
        this.releaseBomb();
      }
    } else {
      const holding = stopX !== 0 && node.position.x <= stopX;
      if (!holding) {
        node.position.x -= speed * dt;
      } else {
        this.updateAttack(dt);
      }
    }
    node.position.y = this.baseY + Math.sin(this.bobTime * 1.7) * 4;

    // Breakthrough: reached the castle column.
    if (node.position.x <= -180) {
      this.crashIntoCastle();
    }
  }

  private isBomber(): boolean {
    return this.config.bomber === true && Number(this.config.attackDamage) > 0;
  }

  /** Bomber at the release mark: one bomb toward the castle, then climb away. */
  private releaseBomb(): void {
    if (this.state !== 'intact' || !this.node) return;
    this.dropCarriedMine(
      Number(this.config.attackDamage),
      -(Number(this.config.speed) + this.speedBoost)
    );
    // The empty rig is no longer worth shooting.
    if (this.linkNode) {
      this.linkNode.visible = false;
      this.disableHitboxes(this.linkNode);
    }
    if (this.mineNode) {
      this.mineNode.visible = false;
      this.disableHitboxes(this.mineNode);
    }
    this.state = 'climb';
  }

  /** Gun platforms (original `a` position): shell the castle from their perch. */
  private updateAttack(dt: number): void {
    const damage = Number(this.config.attackDamage);
    if (damage <= 0) return;
    this.attackTimer += dt;
    const period = Math.max(0.5, Number(this.config.attackPeriod));
    if (this.attackTimer < period) return;
    this.attackTimer = 0;
    const sound = DROP_SOUNDS[Math.floor(Math.random() * DROP_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.1 });
    this.scene?.juice.shake('camera2d', { amplitude: 4, duration: 0.15 });
    this.emitToGameRoot('castle-damaged', damage);
  }

  // ── destruction scenarios ─────────────────────────────────────────────────

  private onBodyDamaged(amount: number): void {
    // Bombers stay legitimate targets while climbing out after the drop.
    if ((this.state !== 'intact' && this.state !== 'climb') || !this.node) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.shotDown();
      return;
    }
    this.hitFeedback();
  }

  private onLinkDamaged(amount: number): void {
    if (this.state !== 'intact' || !this.linkNode?.visible) return;
    this.linkHp -= amount;
    if (this.linkHp <= 0) {
      this.snapLink();
      return;
    }
    this.hitFeedback();
  }

  private onMineDamaged(amount: number): void {
    if (this.state !== 'intact' || !this.mineNode?.visible) return;
    this.mineHp -= amount;
    if (this.mineHp <= 0) {
      this.detonateWithMine();
      return;
    }
    this.hitFeedback();
  }

  private hitFeedback(): void {
    const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
    if (this.node) {
      this.scene?.juice.punchScale(this.node, { amount: 0.22, duration: 0.16 });
    }
  }

  /** Body shot → the hull catches fire and falls; the mine detaches and falls. */
  private shotDown(): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;
    this.scene?.audio.play(DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.emitToGameRoot('unit-killed', Number(this.config.score));
    // A downed bomber loses its bomb mid-air (original kill(): half momentum).
    this.dropCarriedMine(
      this.isBomber() ? Number(this.config.attackDamage) : 0,
      this.isBomber() ? -(Number(this.config.speed) + this.speedBoost) * 0.5 : 0
    );
    this.spawnExplosion(node.position.x, node.position.y, 0.7);
    this.spawnWreck(node.position.x, node.position.y, -Number(this.config.speed) * 0.5, 10, 1);
    this.despawn();
  }

  /** Mine hit → it detonates on the spot and takes the balloon with it. */
  private detonateWithMine(): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;
    const mx = node.position.x + (this.mineNode?.position.x ?? 0);
    const my = node.position.y + (this.mineNode?.position.y ?? 0);
    this.scene?.audio.play(MINE_BOOM_SOUND, { bus: 'sfx', volumeVariation: 0.1 });
    this.spawnExplosion(mx, my, 1.0);
    this.spawnExplosion(node.position.x, node.position.y, 1.25);
    this.spawnWreck(node.position.x, node.position.y, -Number(this.config.speed) * 0.4, -20, 0.9);
    this.emitToGameRoot('unit-killed', Number(this.config.score));
    this.despawn();
  }

  /** Link shot → the rig snaps: the bomb falls, the freed balloon escapes up. */
  private snapLink(): void {
    const node = this.node;
    if (!node || this.state !== 'intact') return;
    this.scene?.audio.play(LINK_SNAP_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.dropCarriedMine(
      this.isBomber() ? Number(this.config.attackDamage) : 0,
      this.isBomber() ? -(Number(this.config.speed) + this.speedBoost) * 0.5 : 0
    );
    if (this.linkNode) {
      this.linkNode.visible = false;
      this.disableHitboxes(this.linkNode);
    }
    if (this.mineNode) {
      this.mineNode.visible = false;
      this.disableHitboxes(this.mineNode);
    }
    // The escaping balloon is no longer a target.
    this.disableHitboxes(node);
    this.emitToGameRoot('unit-killed', Math.max(1, Math.round(Number(this.config.score) / 2)));
    this.state = 'flyaway';
    this.flyawaySpeed = 30;
  }

  private crashIntoCastle(): void {
    if (this.state !== 'intact' || !this.node) return;
    this.scene?.audio.play(CRASH_SOUND, { bus: 'sfx', volumeVariation: 0.1 });
    this.scene?.juice.shake('camera2d', { amplitude: 10, duration: 0.3 });
    this.emitToGameRoot('castle-damaged', Number(this.config.castleDamage));
    this.spawnExplosion(this.node.position.x, this.node.position.y, 1);
    this.despawn();
  }

  private despawn(): void {
    if (this.state === 'gone' || !this.node) return;
    this.state = 'gone';
    this.emitToGameRoot('enemy-gone');
    this.node.queueFree();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Release the hanging mine/bomb (visible only on units dressed with one).
   * Bombers pass their bomb's castle damage and momentum (`vx`); the plain
   * S-mine falls straight down and only threatens the bridge.
   */
  private dropCarriedMine(castleDamage = 0, vx = 0): void {
    const scene = this.scene;
    const node = this.node;
    const carried = this.mineNode;
    if (!scene || !node || !carried?.visible) return;
    const x = node.position.x + carried.position.x;
    const y = node.position.y + carried.position.y;
    const sound = DROP_SOUNDS[Math.floor(Math.random() * DROP_SOUNDS.length)];
    scene.audio.play(sound, { bus: 'sfx', pitchVariation: 0.1 });
    void scene
      .instantiate(FALLING_MINE_PREFAB, { parent: 'effects' })
      .then(mine => {
        mine.position.set(x, y, 0);
        const logic = mine.components.find(
          c => (c as { type?: string }).type === 'user:FallingMine'
        ) as { config?: Record<string, unknown> } | undefined;
        if (logic?.config) {
          if (castleDamage > 0) logic.config.castleDamage = castleDamage;
          if (vx !== 0) logic.config.vx = vx;
        }
      })
      .catch(err => console.warn('[EnemyBalloon] mine drop failed', err));
  }

  private disableHitboxes(node: NodeBase): void {
    for (const comp of node.components) {
      if (comp.type === 'core:Hitbox2D') {
        comp.config.group = 'disabled';
      }
    }
  }

  private spawnExplosion(x: number, y: number, scale: number): void {
    void this.scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
        fx.scale.set(scale, scale, 1);
      })
      .catch(err => console.warn('[EnemyBalloon] explosion spawn failed', err));
  }

  private spawnWreck(x: number, y: number, vx: number, vy: number, explosionScale: number): void {
    const texturePath = String(this.config.spritePath ?? '') || DEFAULT_SPRITE;
    void this.scene
      ?.instantiate(WRECK_PREFAB, { parent: 'effects' })
      .then(wreck => {
        wreck.position.set(x, y, 0);
        BurningWreck.configure(wreck, texturePath, vx, vy, explosionScale);
      })
      .catch(err => console.warn('[EnemyBalloon] wreck failed', err));
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }
}
