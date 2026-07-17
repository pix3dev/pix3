import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { Vector3 } from 'three';
import { session } from './SdSession';

const CANNONBALL_PREFAB = 'res://src/assets/prefabs/cannonball.pix3scene';
const SFX_SELECT = 'res://src/assets/audio/gui/ingame/ing_select_weapon.mp3';
const SFX_DRY = 'res://src/assets/audio/guns/main/out_of_ammo.mp3';

/**
 * One player weapon (GDD §4.2). Damage / magazine / reserve come straight from
 * the original conf.xml (`<DMG>` / `<AMMO>`); feel numbers (speed/gravity/rates)
 * are the remaster's stage-local tuning on the same arc ballistics.
 */
export interface WeaponDef {
  key: 'gun' | 'shotgun' | 'minigun' | 'rifle';
  displayName: string;
  damage: number;
  magSize: number;
  /** Total shots beyond the loaded magazine; -1 = infinite (Gun until the M4 shop sells refills). */
  reserve: number;
  reloadSec: number;
  cooldownSec: number;
  /** Fires continuously while the pointer is held (Minigun). */
  auto: boolean;
  /** Projectiles per shot (Shotgun fan). */
  pellets: number;
  spreadDeg: number;
  muzzleSpeed: number;
  gravity: number;
  ballRadius: number;
  ballScale: number;
  /** Rifle: instant ray along the aim line instead of a projectile. */
  hitscan: boolean;
  sound: string;
  /** Scene node id of this weapon's barrel sprite on the carriage. */
  barrelNode: string;
  /** Muzzle distance from the pivot along the barrel (stage px). */
  muzzle: number;
  /** Muzzle-flash texture (each weapon ships its own fx sprite). */
  flashTexture: string;
}

const WEAPONS: WeaponDef[] = [
  {
    key: 'gun', displayName: 'GUN',
    damage: 50, magSize: 100, reserve: 200, reloadSec: 0.9, cooldownSec: 0.35,
    auto: true, pellets: 1, spreadDeg: 0,
    muzzleSpeed: 700, gravity: 640, ballRadius: 6, ballScale: 1, hitscan: false,
    sound: 'res://src/assets/audio/guns/main/main_tg.mp3',
    barrelNode: 'barrel-gun', muzzle: 34,
    flashTexture: 'res://src/assets/textures/maingun/gun/fx.png',
  },
  {
    key: 'shotgun', displayName: 'SHOTGUN',
    damage: 25, magSize: 5, reserve: 14, reloadSec: 1.3, cooldownSec: 0.55,
    auto: false, pellets: 6, spreadDeg: 22,
    muzzleSpeed: 640, gravity: 760, ballRadius: 4, ballScale: 0.65, hitscan: false,
    sound: 'res://src/assets/audio/guns/main/main_shotgun.mp3',
    barrelNode: 'barrel-shotgun', muzzle: 18,
    flashTexture: 'res://src/assets/textures/maingun/shotgun/fx.png',
  },
  {
    key: 'minigun', displayName: 'MINIGUN',
    damage: 50, magSize: 100, reserve: 100, reloadSec: 1.8, cooldownSec: 0.1,
    auto: true, pellets: 1, spreadDeg: 3,
    muzzleSpeed: 760, gravity: 560, ballRadius: 4, ballScale: 0.7, hitscan: false,
    sound: 'res://src/assets/audio/guns/main/main_minigun.mp3',
    barrelNode: 'barrel-minigun', muzzle: 20,
    flashTexture: 'res://src/assets/textures/maingun/minigun/fx/fire1.png',
  },
  {
    key: 'rifle', displayName: 'RIFLE',
    damage: 100, magSize: 4, reserve: 50, reloadSec: 2.2, cooldownSec: 0.7,
    auto: false, pellets: 1, spreadDeg: 0,
    muzzleSpeed: 0, gravity: 0, ballRadius: 0, ballScale: 1, hitscan: true,
    sound: 'res://src/assets/audio/guns/main/main_rifle.mp3',
    barrelNode: 'barrel-rifle', muzzle: 38,
    flashTexture: 'res://src/assets/textures/maingun/rifle/fx.png',
  },
];

/** Minigun spin frames, cycled while firing. */
const MINIGUN_FRAMES = Array.from(
  { length: 6 },
  (_, i) => `res://src/assets/textures/maingun/minigun/frames/mg000${i + 1}.png`
);

/** Local length of the rifle laser/beam rects as authored in the scene. */
const BEAM_RECT_LENGTH = 1000;

interface Cannonball {
  node: NodeBase;
  active: boolean;
  vx: number;
  vy: number;
  age: number;
  damage: number;
  radius: number;
}

interface AmmoState {
  mag: number;
  reserve: number;
}

/**
 * GunController — the player's Main Gun with all four weapons (M3):
 * 1 Gun (single arc shot), 2 Shotgun (pellet fan), 3 Minigun (auto while the
 * pointer is held), 4 Rifle (laser sight + hitscan via `scene.collision2d.raycast`).
 *
 * Input parity: aiming tracks `scene.getPointer2DWorldPosition()` (mouse and
 * touch are unified by InputService); weapons switch with keys 1-4 AND the HUD
 * touch buttons (WeaponHUD calls `selectWeapon`). Pointer-downs over the HUD
 * weapon bar (`uiGuardNode`) or hovered UI never fire the gun.
 */
export class GunController extends Script {
  private pivot: NodeBase | null = null;
  private flashUnder: NodeBase | null = null;
  private flashOver: NodeBase | null = null;
  private laser: NodeBase | null = null;
  private beam: NodeBase | null = null;
  private uiGuards: NodeBase[] = [];
  private barrels: (NodeBase | null)[] = [];
  private deadGun: NodeBase | null = null;
  private flashTextures: (import('three').Texture | null)[] = [];
  private minigunFrames: import('three').Texture[] = [];
  private minigunSpin = 0;
  private gameOver = false;
  private balls: Cannonball[] = [];
  private ammo: AmmoState[] = [];
  private weaponIndex = 0;
  private reloadLeft = 0;
  private cooldownLeft = 0;
  private flashLeft = 0;
  private beamLeft = 0;
  private recoilLeft = 0;
  private dryLeft = 0;
  private autoHeld = false;
  private poolGrown = false;
  private poolDelay = 0;
  private pivotBaseX = 0;
  private currentAngle = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      pivotNode: 'barrel-pivot',
      ballsGroup: 'cannonballs',
      targetGroup: 'enemy',
      uiGuardNode: 'weapon-bar',
      minAngleDeg: -65,
      maxAngleDeg: 65,
      muzzleDistance: 52,
      poolSize: 36,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Gun', step },
      getValue: (c: unknown) => (c as GunController).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as GunController).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'GunController',
      properties: [
        num('minAngleDeg', 'Min Angle (deg)'),
        num('maxAngleDeg', 'Max Angle (deg)'),
        num('muzzleDistance', 'Muzzle Distance (px)'),
        num('poolSize', 'Projectile Pool Size'),
      ],
      groups: { Gun: { label: 'Main Gun', expanded: true } },
    };
  }

  // ── public state for the HUD ────────────────────────────────────────────────

  get weapons(): readonly WeaponDef[] {
    return WEAPONS;
  }

  get currentIndex(): number {
    return this.weaponIndex;
  }

  get currentWeapon(): WeaponDef {
    return WEAPONS[this.weaponIndex];
  }

  get isReloading(): boolean {
    return this.reloadLeft > 0;
  }

  get reloadProgress(): number {
    const total = this.effectiveReload(this.currentWeapon);
    return total > 0 ? 1 - this.reloadLeft / total : 1;
  }

  getAmmo(index: number): AmmoState {
    return this.ammo[index] ?? { mag: 0, reserve: 0 };
  }

  /** M4 shop: only purchased weapons can be selected (the Gun is free). */
  isUnlocked(index: number): boolean {
    const def = WEAPONS[index];
    return !!def && session.weaponUnlocked(def.key);
  }

  /** Per-hit damage with the shop's power/special upgrades applied. */
  private effectiveDamage(def: WeaponDef): number {
    return session.weaponDamage(def.key) || def.damage;
  }

  /** Reload time with the shop's Reload Speed upgrades applied. */
  private effectiveReload(def: WeaponDef): number {
    return def.reloadSec * session.weaponReloadFactor(def.key);
  }

  selectWeapon(index: number): void {
    const next = Math.min(WEAPONS.length - 1, Math.max(0, Math.floor(index)));
    if (next === this.weaponIndex || this.gameOver) return;
    if (!this.isUnlocked(next)) {
      this.scene?.audio.play(SFX_DRY, { bus: 'sfx' });
      return;
    }
    this.weaponIndex = next;
    this.reloadLeft = 0;
    this.cooldownLeft = Math.max(this.cooldownLeft, 0.12);
    this.autoHeld = false;
    this.applyBarrelVisibility();
    this.applyFlashTexture();
    this.scene?.audio.play(SFX_SELECT, { bus: 'sfx' });
    this.node?.emit('weapon-changed', next);
    // Selecting an empty weapon starts its reload right away.
    this.maybeAutoReload();
  }

  /** Show only the current weapon's barrel; move the flashes to its muzzle. */
  private applyBarrelVisibility(): void {
    this.barrels.forEach((barrel, i) => {
      if (barrel) barrel.visible = i === this.weaponIndex;
    });
    const muzzle = this.currentWeapon.muzzle;
    if (this.flashUnder) this.flashUnder.position.x = muzzle;
    if (this.flashOver) this.flashOver.position.x = muzzle;
  }

  private applyFlashTexture(): void {
    const tex = this.flashTextures[this.weaponIndex];
    if (!tex) return;
    for (const flash of [this.flashUnder, this.flashOver]) {
      const sprite = flash as { setTexture?: (t: import('three').Texture) => void } | null;
      sprite?.setTexture?.(tex);
    }
  }

  private onGameOver(): void {
    this.gameOver = true;
    this.autoHeld = false;
    if (this.pivot) this.pivot.visible = false;
    if (this.deadGun) this.deadGun.visible = true;
    if (this.laser) this.laser.visible = false;
    if (this.beam) this.beam.visible = false;
    this.setFlashVisible(false);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  onStart(): void {
    this.pivot = this.findNode(String(this.config.pivotNode));
    this.flashUnder = this.findNode('muzzle-flash-under');
    this.flashOver = this.findNode('muzzle-flash-over');
    this.laser = this.findNode('rifle-laser');
    this.beam = this.findNode('rifle-beam');
    this.deadGun = this.findNode('gun-dead');
    this.uiGuards = String(this.config.uiGuardNode)
      .split(',')
      .map(id => this.findNode(id.trim()))
      .filter((n): n is NodeBase => !!n);
    if (this.pivot) {
      this.pivotBaseX = this.pivot.position.x;
    }

    // Per-weapon barrel sprites on the carriage + per-weapon muzzle flashes.
    this.barrels = WEAPONS.map(w => this.findNode(w.barrelNode));
    this.applyBarrelVisibility();
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      this.flashTextures = WEAPONS.map(() => null);
      WEAPONS.forEach((w, i) => {
        void loader.loadTexture(w.flashTexture)
          .then(tex => { this.flashTextures[i] = tex; })
          .catch(() => undefined);
      });
      void Promise.all(MINIGUN_FRAMES.map(p => loader.loadTexture(p)))
        .then(frames => { this.minigunFrames = frames; })
        .catch(() => undefined);
    }

    // The gun dies with the castle: swap to the wreck and stop responding.
    this.findNode('game-root')?.connect('game-over', this, (victory: unknown) => {
      if (!victory) this.onGameOver();
    });

    this.ammo = WEAPONS.map(w => ({ mag: w.magSize, reserve: w.reserve }));

    // Projectile pool: adopt the authored seed balls. The pool grows from the
    // prefab on the first update — `scene.instantiate` needs the runner to be
    // fully running, which is not yet the case during onStart.
    this.balls = [];
    const pool = this.findNode(String(this.config.ballsGroup));
    if (pool) {
      for (const child of pool.children) {
        this.addBall(child as NodeBase);
      }
    }

    this.setFlashVisible(false);
    if (this.laser) this.laser.visible = false;
    if (this.beam) this.beam.visible = false;
  }

  private addBall(node: NodeBase): void {
    node.visible = false;
    this.balls.push({ node, active: false, vx: 0, vy: 0, age: 0, damage: 0, radius: 4 });
  }

  private growPool(dt: number): void {
    if (this.poolGrown) return;
    // The runner reports "not running" during the very first ticks — give the
    // scene a moment before instantiating (see the WaveSpawner which spawns
    // its first enemy at t=1 and never hits this).
    this.poolDelay += dt;
    if (this.poolDelay < 0.5) return;
    this.poolGrown = true;
    const want = Math.max(0, Number(this.config.poolSize) - this.balls.length);
    for (let i = 0; i < want; i++) {
      void this.scene
        ?.instantiate(CANNONBALL_PREFAB, { parent: String(this.config.ballsGroup) })
        .then(node => this.addBall(node))
        .catch(err => console.warn('[GunController] pool spawn failed', err));
    }
  }

  onUpdate(dt: number): void {
    this.growPool(dt);
    this.updateBalls(dt);
    if (this.gameOver) return;
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    this.dryLeft = Math.max(0, this.dryLeft - dt);
    this.updateReload(dt);
    this.aim();
    this.handleWeaponKeys();
    this.handleFireInput();
    this.updateRecoilAndFlash(dt);
    this.updateMinigunSpin(dt);
    this.updateLaser(dt);
  }

  /** Cycle the minigun's barrel frames for a short burst after each shot. */
  private updateMinigunSpin(dt: number): void {
    if (this.minigunSpin <= 0 || this.minigunFrames.length === 0) return;
    this.minigunSpin -= dt;
    const barrel = this.barrels[2] as { setTexture?: (t: import('three').Texture) => void } | null;
    const frame = Math.floor(performance.now() / 40) % this.minigunFrames.length;
    barrel?.setTexture?.(this.minigunFrames[frame]);
  }

  // ── aiming ────────────────────────────────────────────────────────────────

  private aim(): void {
    if (!this.pivot || !this.scene) return;
    const pointer = this.scene.getPointer2DWorldPosition();
    if (!pointer) return;

    const world = this.pivot.getWorldPosition(GunController.scratch);
    const angle = Math.atan2(pointer.y - world.y, pointer.x - world.x);
    const min = (Number(this.config.minAngleDeg) * Math.PI) / 180;
    const max = (Number(this.config.maxAngleDeg) * Math.PI) / 180;
    this.currentAngle = Math.min(max, Math.max(min, angle));
    this.pivot.rotation.z = this.currentAngle;
  }

  // ── input ─────────────────────────────────────────────────────────────────

  private handleWeaponKeys(): void {
    if (!this.input) return;
    for (const event of this.input.keyEvents) {
      if (event.type !== 'down' || event.repeat) continue;
      const match = /^(?:Digit|Numpad)([1-4])$/.exec(event.code);
      if (match) {
        this.selectWeapon(Number(match[1]) - 1);
      }
    }
  }

  private handleFireInput(): void {
    if (!this.input) return;

    for (const event of this.input.pointerEvents) {
      if (event.type === 'down') {
        if (this.isPointerOverUI()) {
          this.autoHeld = false;
          continue;
        }
        // Aim once more so a touch tap (down with no prior move) shoots at the tap point.
        this.aim();
        this.autoHeld = true;
        // Semi-auto weapons fire once on pointer-down; auto weapons rely on the
        // held-repeat block below so they never double-fire on the same frame.
        if (!this.currentWeapon.auto) {
          this.tryFire();
        }
      } else if (event.type === 'up') {
        this.autoHeld = false;
      }
    }

    // Auto-fire: keep firing while the pointer stays held (mouse button or touch).
    if (this.currentWeapon.auto && this.autoHeld && this.input.isPointerDown) {
      this.tryFire();
    }
  }

  /** True when the pointer is over any HUD guard zone or hovered UI control. */
  private isPointerOverUI(): boolean {
    if (this.input?.isHoveringUI) return true;
    if (this.uiGuards.length === 0 || !this.scene) return false;
    const pointer = this.scene.getPointer2DWorldPosition();
    if (!pointer) return false;
    for (const guardNode of this.uiGuards) {
      const center = guardNode.getWorldPosition(GunController.scratch);
      const scale = guardNode.getWorldScale(GunController.scratch2);
      const guard = guardNode as NodeBase & { width?: number; height?: number };
      const hw = ((guard.width ?? 0) / 2) * Math.abs(scale.x);
      const hh = ((guard.height ?? 0) / 2) * Math.abs(scale.y);
      if (Math.abs(pointer.x - center.x) <= hw && Math.abs(pointer.y - center.y) <= hh) {
        return true;
      }
    }
    return false;
  }

  // ── ammo / reload ─────────────────────────────────────────────────────────

  private updateReload(dt: number): void {
    if (this.reloadLeft <= 0) return;
    this.reloadLeft -= dt;
    if (this.reloadLeft > 0) return;
    this.reloadLeft = 0;
    const state = this.ammo[this.weaponIndex];
    const def = this.currentWeapon;
    if (state.reserve < 0) {
      state.mag = def.magSize;
    } else {
      const take = Math.min(def.magSize - state.mag, state.reserve);
      state.mag += take;
      state.reserve -= take;
    }
  }

  private maybeAutoReload(): void {
    const state = this.ammo[this.weaponIndex];
    if (state.mag <= 0 && state.reserve !== 0 && this.reloadLeft <= 0) {
      this.reloadLeft = this.effectiveReload(this.currentWeapon);
    }
  }

  // ── firing ────────────────────────────────────────────────────────────────

  private tryFire(): void {
    if (this.cooldownLeft > 0 || this.reloadLeft > 0 || !this.pivot) return;
    const def = this.currentWeapon;
    const state = this.ammo[this.weaponIndex];

    if (state.mag <= 0) {
      if (state.reserve !== 0) {
        this.reloadLeft = this.effectiveReload(def);
      } else if (this.dryLeft <= 0) {
        this.dryLeft = 0.6;
        this.scene?.audio.play(SFX_DRY, { bus: 'sfx' });
      }
      return;
    }

    state.mag -= 1;
    this.cooldownLeft = def.cooldownSec;
    if (def.key === 'minigun') {
      this.minigunSpin = 0.25;
    }

    if (def.hitscan) {
      this.fireHitscan(def);
    } else {
      this.fireProjectiles(def);
    }

    this.flashLeft = 0.07;
    this.recoilLeft = 0.09;
    this.setFlashVisible(true);
    this.scene?.audio.play(def.sound, { bus: 'sfx', pitchVariation: 0.08, volumeVariation: 0.1 });
    this.node?.emit('fired');
    this.maybeAutoReload();
  }

  private fireProjectiles(def: WeaponDef): void {
    if (!this.pivot) return;
    const pool = this.balls[0]?.node.parentNode ?? this.findNode(String(this.config.ballsGroup));
    if (!pool) return;

    const muzzleDistance = def.muzzle;
    const pivotWorld = this.pivot.getWorldPosition(GunController.scratch);
    const poolWorld = pool.getWorldPosition(GunController.scratch2);
    const poolScale = pool.getWorldScale(GunController.scratch3);
    const sx = Math.abs(poolScale.x) || 1;
    const sy = Math.abs(poolScale.y) || 1;

    const spread = (def.spreadDeg * Math.PI) / 180;
    for (let i = 0; i < def.pellets; i++) {
      const ball = this.balls.find(b => !b.active);
      if (!ball) return;

      const t = def.pellets > 1 ? i / (def.pellets - 1) - 0.5 : 0;
      const jitter = def.auto ? (Math.random() - 0.5) * spread : t * spread;
      const angle = this.currentAngle + jitter;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const localX = (pivotWorld.x - poolWorld.x) / sx + cos * muzzleDistance;
      const localY = (pivotWorld.y - poolWorld.y) / sy + sin * muzzleDistance;

      ball.node.position.set(localX, localY, 0);
      ball.node.scale.set(def.ballScale, def.ballScale, 1);
      ball.node.visible = true;
      ball.active = true;
      ball.age = 0;
      ball.damage = this.effectiveDamage(def);
      ball.radius = def.ballRadius;
      ball.vx = cos * def.muzzleSpeed;
      ball.vy = sin * def.muzzleSpeed;
    }
  }

  private fireHitscan(def: WeaponDef): void {
    if (!this.pivot || !this.scene) return;
    const muzzleDistance = def.muzzle;
    const pivotWorld = this.pivot.getWorldPosition(GunController.scratch);
    const pivotScale = this.pivot.getWorldScale(GunController.scratch2);
    const worldScale = Math.abs(pivotScale.x) || 1;
    const cos = Math.cos(this.currentAngle);
    const sin = Math.sin(this.currentAngle);

    const x1 = pivotWorld.x + cos * muzzleDistance * worldScale;
    const y1 = pivotWorld.y + sin * muzzleDistance * worldScale;
    const rayLength = BEAM_RECT_LENGTH * worldScale;
    const x2 = x1 + cos * rayLength;
    const y2 = y1 + sin * rayLength;

    const hit = this.scene.collision2d.raycast(x1, y1, x2, y2, String(this.config.targetGroup));
    let beamLocalLength = BEAM_RECT_LENGTH;
    if (hit) {
      hit.node.emit('damaged', this.effectiveDamage(def));
      beamLocalLength = (hit.distance ?? rayLength) / worldScale;
    }

    if (this.beam) {
      this.beam.visible = true;
      this.beam.scale.x = Math.max(0.02, beamLocalLength / BEAM_RECT_LENGTH);
      this.beam.position.x = muzzleDistance + beamLocalLength / 2;
      this.beamLeft = 0.09;
    }
  }

  // ── visuals ───────────────────────────────────────────────────────────────

  private updateRecoilAndFlash(dt: number): void {
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) this.setFlashVisible(false);
    }
    if (this.beamLeft > 0) {
      this.beamLeft -= dt;
      if (this.beamLeft <= 0 && this.beam) this.beam.visible = false;
    }
    if (this.pivot) {
      if (this.recoilLeft > 0) {
        this.recoilLeft -= dt;
        this.pivot.position.x = this.pivotBaseX - 3;
      } else {
        this.pivot.position.x = this.pivotBaseX;
      }
    }
  }

  private updateLaser(_dt: number): void {
    if (!this.laser) return;
    const showLaser = this.currentWeapon.hitscan && this.reloadLeft <= 0;
    if (this.laser.visible !== showLaser) {
      this.laser.visible = showLaser;
    }
  }

  private setFlashVisible(visible: boolean): void {
    if (this.flashUnder) this.flashUnder.visible = visible;
    if (this.flashOver) this.flashOver.visible = visible;
  }

  // ── projectiles ───────────────────────────────────────────────────────────

  private updateBalls(dt: number): void {
    const def = this.currentWeapon;
    const targetGroup = String(this.config.targetGroup);

    for (const ball of this.balls) {
      if (!ball.active) continue;

      // Gravity is a property of the weapon that fired the ball; close enough
      // to per-ball since switching mid-flight is rare and the arc families are
      // similar. Damage/radius ARE stored per ball.
      ball.vy -= (def.hitscan ? 640 : def.gravity) * dt;
      ball.node.position.x += ball.vx * dt;
      ball.node.position.y += ball.vy * dt;
      ball.age += dt;

      const p = ball.node.position;
      if (ball.age > 5 || p.x > 480 || p.x < -480 || p.y < -300 || p.y > 400) {
        this.recycle(ball);
        continue;
      }

      if (!this.scene) continue;
      const world = ball.node.getWorldPosition(GunController.scratch);
      const worldScale = ball.node.getWorldScale(GunController.scratch2);
      const worldRadius = ball.radius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y));
      const hits = this.scene.collision2d.overlapCircle(world.x, world.y, worldRadius, targetGroup);
      if (hits.length > 0) {
        hits[0].node.emit('damaged', ball.damage);
        this.recycle(ball);
      }
    }
  }

  private recycle(ball: Cannonball): void {
    ball.active = false;
    ball.node.visible = false;
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
  private static readonly scratch3 = new Vector3();
}
