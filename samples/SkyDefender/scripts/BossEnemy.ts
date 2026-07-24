import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { AdditiveBlending } from 'three';
import type { Mesh, MeshBasicMaterial } from 'three';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const ENEMY_SHELL_PREFAB = 'res://src/assets/prefabs/enemy-shell.pix3scene';
const DEATH_SOUND = 'res://src/assets/audio/explosions/big_explosion.mp3';
const CHAIN_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';
// No dedicated "armor clang" clip survives in the archive — the softest hit
// stinger at reduced volume reads as a shot glancing off the shielded hull.
const SHIELD_CLANG = 'res://src/assets/audio/hits/enemy_hit1.mp3';
const SHOT_SOUNDS = [
  'res://src/assets/audio/guns/enemy/eshot1.mp3',
  'res://src/assets/audio/guns/enemy/eshot2.mp3',
  'res://src/assets/audio/guns/enemy/eshot3.mp3',
];
const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];

// ── timing (original runs on a 30 fps `rld` tick counter) ──────────────────
const TICKS_PER_SEC = 30;
/** Fly-in speed (modest, majestic approach). */
const FLY_SPEED = 40;
const SHELL_SPEED = 300;
const RECOIL_DUR = 0.18;
const FLASH_DUR = 0.12;
/** White-flash decay on a damaging hit. */
const WHITE_FLASH_DUR = 0.15;
/** Final boss (id 84): the King finale fires below this HP. */
const FINALE_HP_THRESHOLD = 400;

// ── FN_addBumbumZep death (chained nose→tail detonation) ───────────────────
/** Number of staggered explosions walked across the body. */
const CHAIN_COUNT = 7;
/** Time the chain takes to sweep nose→tail. */
const CHAIN_SPAN = 0.8;
/** How long the majestic fall+fade runs before the hull despawns. */
const DEATH_DURATION = 1.4;
/** Majestic descent speed while dying. */
const DEATH_FALL_SPEED = 30;

interface BossGun {
  mount: NodeBase;
  flash: (NodeBase & { opacity?: number }) | null;
  baseX: number;
  recoilT: number;
  flashT: number;
}

/**
 * BossEnemy — one generic behaviour for every Sky Defender boss (v15 ids
 * 75-84), faithful to com.enemy.Boss* (README §Boss behavior):
 * - fly-in from the right edge to `stopX`, then hold and bob on a slow sine
 *   (`x = stopX - sin(t)*4`) — bosses never ram the castle;
 * - up to three emplacement guns fire in a ROUND-ROBIN during the open window
 *   (a visible direct EnemyShell each, with recoil + muzzle flash);
 * - the VULNERABILITY WINDOW (`uyaz`): the boss is only damageable while the
 *   barrage is open. An `rld` tick counter loops 0..cycleTicks; `uyaz=true` for
 *   rld ∈ [uyazOpenTick, cycleTicks) (guns fire), `uyaz=false` in the short
 *   reload window at the cycle start (incoming damage is ABSORBED — a soft clang
 *   + tiny shake teaches the player it's shielded);
 * - a damaging hit flashes the white overlay and subtracts hp;
 * - death = FN_addBumbumZep: a nose→tail chain of explosions + one big
 *   BlowGlow-scale blast while the hull descends and fades, then despawns.
 * Drives the HUD boss bar via `boss-spawned`/`boss-hp`/`boss-dead` on
 * `game-root` (escorts stay off the bar). Standard game-root signal contract:
 * `damaged` in; `unit-killed`/`enemy-gone` out.
 */
export class BossEnemy extends Script {
  private hp = 0;
  private maxHp = 0;
  private state: 'flyin' | 'hold' | 'dying' | 'gone' = 'flyin';
  private bobTime = 0;
  private baseY: number | null = null;

  // vulnerability / barrage cycle
  private rld = 0;
  private fireAcc = 0;
  private uyaz = false;

  // guns (round-robin)
  private guns: BossGun[] = [];
  private nextGun = 0;

  // hit feedback
  private white: (NodeBase & { opacity?: number }) | null = null;
  private whiteT = 0;
  private body: Sprite2D | null = null;

  // finale (id 84)
  private finaleFired = false;

  // death sequence
  private deathT = 0;
  private chainFired = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hp: 8000,
      score: 1000,
      // Stage-local x where the boss stops and holds (positive = far right).
      stopX: 120,
      // Castle damage per shell.
      attackDamage: 7,
      // Body/white livery + display size (set per-id by WaveSpawner).
      bodyTex: '',
      whiteTex: '',
      bodyWidth: 214,
      bodyHeight: 81,
      // 1..3 emplacement guns shown (rest hidden).
      gunCount: 2,
      // Fire cadence (ticks) inside the open window.
      fireIntervalTicks: 5,
      // Full barrage/reload cycle length (ticks; 30 = 1 s).
      cycleTicks: 80,
      // rld at which the window opens (guns fire + boss becomes damageable).
      uyazOpenTick: 5,
      // Final boss: fire the King finale below FINALE_HP_THRESHOLD.
      finale: false,
      // Escort/mini-boss: same behaviour, but stays OFF the HUD boss bar.
      escort: false,
      // Display name for the boss bar (V15 class, set by WaveSpawner).
      bossName: 'BOSS',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Boss', step },
      getValue: (c: unknown) => (c as BossEnemy).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as BossEnemy).config[name] = Number(v);
      },
    });
    const bool = (name: string, label: string) => ({
      name,
      type: 'boolean' as const,
      ui: { label, group: 'Boss' },
      getValue: (c: unknown) => (c as BossEnemy).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as BossEnemy).config[name] = Boolean(v);
      },
    });
    return {
      nodeType: 'BossEnemy',
      properties: [
        num('hp', 'HP'),
        num('score', 'Score'),
        num('stopX', 'Stop X'),
        num('attackDamage', 'Attack Damage (HP)'),
        num('bodyWidth', 'Body Width'),
        num('bodyHeight', 'Body Height'),
        num('gunCount', 'Gun Count (1-3)'),
        num('fireIntervalTicks', 'Fire Interval (ticks)'),
        num('cycleTicks', 'Cycle (ticks)'),
        num('uyazOpenTick', 'Window Open (tick)'),
        bool('finale', 'Final Boss (King finale)'),
        bool('escort', 'Escort (no HUD bar)'),
      ],
      groups: { Boss: { label: 'Boss', expanded: true } },
    };
  }

  onStart(): void {
    this.hp = Number(this.config.hp);
    this.maxHp = this.hp;

    // Body + white-flash overlay. The `enemy` hitbox lives on the Boss Body, so
    // the `damaged` signal fires there (not on the root) — connect it there too.
    const bodyNode = this.node?.getChildByName('Boss Body') ?? null;
    this.body = bodyNode instanceof Sprite2D ? bodyNode : null;
    (bodyNode ?? this.node)?.connect('damaged', this, (amount: unknown) => {
      this.onDamaged(Number(amount) || 0);
    });
    this.white =
      (this.node?.getChildByName('Boss White') as (NodeBase & { opacity?: number }) | undefined) ??
      null;
    if (this.white) {
      this.white.opacity = 0;
      this.white.visible = true;
    }

    // Emplacement guns: keep `gunCount` visible, hide + silence the rest.
    const count = Math.max(1, Math.min(3, Number(this.config.gunCount)));
    for (let i = 1; i <= 3; i++) {
      const mount = (this.node?.getChildByName(`Boss Gun ${i}`) as NodeBase | undefined) ?? null;
      if (!mount) continue;
      if (i > count) {
        mount.visible = false;
        continue;
      }
      const flash =
        (mount.getChildByName('Muzzle Flash') as (NodeBase & { opacity?: number }) | undefined) ??
        null;
      // Additive blend sells the flash (same trick as the explosion shockwave).
      flash?.traverse(obj => {
        const mesh = obj as Mesh;
        if (mesh.isMesh) (mesh.material as MeshBasicMaterial).blending = AdditiveBlending;
      });
      if (flash) flash.opacity = 0;
      this.guns.push({ mount, flash, baseX: mount.position.x, recoilT: 0, flashT: 0 });
    }

    // Announce to the HUD boss bar (escorts/mini-bosses stay off it).
    if (!this.isEscort()) {
      this.emitToGameRoot('boss-spawned', { name: String(this.config.bossName), maxHp: this.maxHp });
      this.emitToGameRoot('boss-hp', 1);
    }
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;

    if (this.baseY === null) this.baseY = node.position.y;

    // White-flash decay + gun recoil/flash decay (both run in every state).
    this.updateWhiteFlash(dt);
    this.updateGunRig(dt);

    if (this.state === 'dying') {
      this.updateDeath(dt);
      return;
    }

    this.bobTime += dt;
    const stopX = Number(this.config.stopX);

    if (this.state === 'flyin') {
      // Majestic advance to the hold point, then settle into the bob.
      node.position.x -= FLY_SPEED * dt;
      if (node.position.x <= stopX) {
        node.position.x = stopX;
        this.state = 'hold';
      }
      node.position.y = this.baseY;
    } else {
      // Holding: bob horizontally on a slow sine.
      node.position.x = stopX - Math.sin(this.bobTime) * 4;
      node.position.y = this.baseY;
    }

    // Barrage/vulnerability cycle runs while flying in AND holding, so the boss
    // fires (and is damageable in the open window) throughout the engagement.
    this.updateBarrage(dt);
  }

  // ── barrage + vulnerability window (uyaz) ──────────────────────────────────

  private updateBarrage(dt: number): void {
    const cycle = Math.max(1, Number(this.config.cycleTicks));
    const openTick = Math.max(0, Number(this.config.uyazOpenTick));
    const interval = Math.max(1, Number(this.config.fireIntervalTicks));

    this.rld += TICKS_PER_SEC * dt;
    if (this.rld >= cycle) this.rld -= cycle;
    this.uyaz = this.rld >= openTick;

    if (this.uyaz) {
      // Fire the next gun round-robin every `interval` ticks.
      this.fireAcc += TICKS_PER_SEC * dt;
      if (this.fireAcc >= interval) {
        this.fireAcc -= interval;
        this.fireNextGun();
      }
    } else {
      // Prime a shot for the instant the window reopens.
      this.fireAcc = interval;
    }
  }

  /** Fire the next visible gun (round-robin): recoil + flash + a direct shell. */
  private fireNextGun(): void {
    const node = this.node;
    if (!node || this.guns.length === 0) return;
    const gun = this.guns[this.nextGun % this.guns.length];
    this.nextGun = (this.nextGun + 1) % this.guns.length;

    gun.recoilT = RECOIL_DUR;
    gun.flashT = FLASH_DUR;
    const sound = SHOT_SOUNDS[Math.floor(Math.random() * SHOT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.1 });

    // Muzzle in stage-local coords (enemies + effects share the stage transform):
    // boss position + gun-mount local + flash local. Guns are direct children.
    const mx = node.position.x + gun.baseX + (gun.flash?.position.x ?? 0);
    const my = node.position.y + gun.mount.position.y + (gun.flash?.position.y ?? 0);
    const damage = Number(this.config.attackDamage);
    void this.scene
      ?.instantiate(ENEMY_SHELL_PREFAB, { parent: 'effects' })
      .then(shell => {
        shell.position.set(mx, my, 0);
        const logic = shell.components.find(
          c => (c as { type?: string }).type === 'user:EnemyShell'
        ) as { config?: Record<string, unknown> } | undefined;
        if (logic?.config) {
          logic.config.vx = -SHELL_SPEED;
          logic.config.vy = 0;
          logic.config.gravity = 0;
          logic.config.damage = damage;
        }
      })
      // If the shell can't spawn, don't lose the hit.
      .catch(() => this.emitToGameRoot('castle-damaged', damage));
  }

  /** Per-frame recoil/flash decay for every visible gun. */
  private updateGunRig(dt: number): void {
    for (const gun of this.guns) {
      if (gun.recoilT > 0) {
        gun.recoilT = Math.max(0, gun.recoilT - dt);
        const k = gun.recoilT / RECOIL_DUR; // 1 → 0
        gun.mount.position.x = gun.baseX + 8 * k * k; // kicks back (+x), eases home
      }
      if (gun.flashT > 0 && gun.flash) {
        gun.flashT = Math.max(0, gun.flashT - dt);
        const t = gun.flashT / FLASH_DUR; // 1 → 0
        gun.flash.opacity = 0.9 * t;
        const s = 0.6 + 0.9 * t;
        gun.flash.scale.set(s, s, 1);
      }
    }
  }

  // ── damage / vulnerability ─────────────────────────────────────────────────

  private onDamaged(amount: number): void {
    if (this.state === 'gone' || this.state === 'dying' || !this.node) return;

    // Closed window (reload): the hull is shielded — absorb the hit and teach
    // the player with a soft clang + a tiny shake, no hp loss.
    if (!this.uyaz) {
      this.scene?.audio.play(SHIELD_CLANG, { bus: 'sfx', volume: 0.45, pitchVariation: 0.1 });
      this.scene?.juice.punchScale(this.node, { amount: 0.05, duration: 0.12 });
      return;
    }

    // Open window: real damage + the white-flash + a hit stinger.
    this.hp -= amount;
    this.flashWhite();
    const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
    this.scene?.juice.punchScale(this.node, { amount: 0.1, duration: 0.14 });

    if (!this.isEscort()) {
      this.emitToGameRoot('boss-hp', Math.max(0, this.hp / this.maxHp));
    }

    // Final boss: the King finale fires (once) below the threshold, then the
    // signature zep death plays out (King cutscene is a later increment).
    if (this.config.finale === true && this.hp < FINALE_HP_THRESHOLD && !this.finaleFired) {
      this.finaleFired = true;
      this.emitToGameRoot('boss-finale');
      // TODO king_strike cutscene — scripted King finale (FN_final).
      console.info('[BossEnemy] boss-finale — king_strike cutscene pending');
      this.startDeath();
      return;
    }

    if (this.hp <= 0) this.startDeath();
  }

  private flashWhite(): void {
    if (this.white) this.white.opacity = 0.7;
    this.whiteT = WHITE_FLASH_DUR;
  }

  private updateWhiteFlash(dt: number): void {
    if (this.whiteT <= 0 || !this.white) return;
    this.whiteT = Math.max(0, this.whiteT - dt);
    this.white.opacity = 0.7 * (this.whiteT / WHITE_FLASH_DUR);
  }

  // ── death: FN_addBumbumZep signature detonation ────────────────────────────

  private startDeath(): void {
    const node = this.node;
    if (!node || this.state === 'dying' || this.state === 'gone') return;
    this.state = 'dying';
    this.deathT = 0;
    this.chainFired = 0;

    // Credit the kill + notify the HUD immediately (the fall is just spectacle).
    this.scene?.audio.play(DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.emitToGameRoot('unit-killed', Number(this.config.score));
    if (!this.isEscort()) {
      this.emitToGameRoot('boss-hp', 0);
      this.emitToGameRoot('boss-dead');
    }

    // One big BlowGlow-scale blast over the hull centre.
    this.spawnExplosion(node.position.x, node.position.y, 2.4);

    // The guns are done — hide them (their flashes stop with the state change).
    for (const gun of this.guns) gun.mount.visible = false;
  }

  private updateDeath(dt: number): void {
    const node = this.node;
    if (!node) return;
    this.deathT += dt;

    // Majestic descent + fade (GDD pillar #1: bosses fall slowly).
    node.position.y -= DEATH_FALL_SPEED * dt;
    node.rotation.z += 0.15 * dt;
    const fade = Math.max(0, 1 - this.deathT / DEATH_DURATION);
    if (this.body) this.body.opacity = fade;
    if (this.white) this.white.opacity = Math.min(this.white.opacity ?? 0, fade);

    // Chain of explosions swept nose→tail across the body width over CHAIN_SPAN.
    const due = Math.min(CHAIN_COUNT, Math.floor((this.deathT / CHAIN_SPAN) * CHAIN_COUNT) + 1);
    const halfW = Number(this.config.bodyWidth) / 2;
    while (this.chainFired < due) {
      const frac = CHAIN_COUNT > 1 ? this.chainFired / (CHAIN_COUNT - 1) : 0.5;
      // Nose (left, -x) → tail (right, +x).
      const ox = -halfW + frac * (halfW * 2);
      const oy = (Math.random() - 0.5) * Number(this.config.bodyHeight) * 0.5;
      this.spawnExplosion(node.position.x + ox, node.position.y + oy, 0.9);
      this.scene?.audio.play(CHAIN_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
      this.chainFired += 1;
    }

    if (this.deathT >= DEATH_DURATION) this.despawn();
  }

  private despawn(): void {
    if (this.state === 'gone' || !this.node) return;
    this.state = 'gone';
    this.emitToGameRoot('enemy-gone');
    this.node.queueFree();
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private isEscort(): boolean {
    return this.config.escort === true;
  }

  /** Live state for the debug bridge (see GameFlow.inspect('boss')). */
  get debugState(): Record<string, unknown> {
    return {
      name: String(this.config.bossName),
      hp: Math.round(this.hp),
      maxHp: this.maxHp,
      hpFraction: this.maxHp > 0 ? Math.round((this.hp / this.maxHp) * 1000) / 1000 : 0,
      uyaz: this.uyaz,
      state: this.state,
      escort: this.isEscort(),
      guns: this.guns.length,
      x: this.node ? Math.round(this.node.position.x) : null,
    };
  }

  private spawnExplosion(x: number, y: number, scale: number): void {
    void this.scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
        fx.scale.set(scale, scale, 1);
      })
      .catch(err => console.warn('[BossEnemy] explosion spawn failed', err));
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }
}
