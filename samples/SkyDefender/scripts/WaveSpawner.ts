import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';
import { EnemyBalloon } from './EnemyBalloon';
import { GroundVehicle } from './GroundVehicle';
import { BRIDGE, MISSIONS, UNITS, type MissionEntry, type UnitDef } from './SdBalance';
import { V15_SURVIVAL } from './SdV15';

const BALLOON_PREFAB = 'res://src/assets/prefabs/balloon.pix3scene';
const UNIK_PREFAB = 'res://src/assets/prefabs/unik.pix3scene';
const TRUCK_PREFAB = 'res://src/assets/prefabs/ground-truck.pix3scene';
/** Joe's alarm cry — the original plays it on every ground-unit spawn. */
const GROUND_ALARM_SOUND = 'res://src/assets/audio/other/warning_scream.mp3';

/** Original 640×480 top-left y → stage-local center-origin Y-up. */
const toStageY = (origY: number): number => 240 - origY;
/** Original attack x (640-wide) → stage-local; clamped clear of the crash line. */
const toStopX = (a: number): number => (a > 0 ? Math.max(a - 320, -170) : 0);
/** Spawn x just past the right edge of the original playfield. */
const SPAWN_X = 470;

/** Structural view of the runtime Sprite2D bits we poke (setTexture is public). */
type SpriteNode = NodeBase & {
  setTexture?: (tex: Texture) => void;
  updateSize?: (w: number, h: number) => void;
};

/**
 * WaveSpawner — drives one wave at a time. Campaign waves are the original
 * missions converted verbatim from design/original-data/mobs.xml (`<Lvl>`
 * tables: exact spawn seconds, heights, unit ids per units.txt and hold
 * positions). Survival builds endless procedural waves from the same unit
 * roster. GameFlow starts waves with `startWave(n)` / `startSurvivalWave(n)`
 * and polls `isWaveClear()` (all spawned AND all gone — enemies report
 * despawn via `enemy-gone` on `game-root`).
 */
export class WaveSpawner extends Script {
  private entries: MissionEntry[] = [];
  private spawnedFlags: boolean[] = [];
  private elapsed = 0;
  private running = false;
  private aliveCount = 0;
  private missionName = '';
  /** Sprite cache keyed by texture path, preloaded in onStart to avoid pop-in. */
  private unitTextures = new Map<string, Texture>();
  /** Survival-only stat overrides for the typical balloon. */
  private survivalStats: { hp: number; speed: number; score: number } | null = null;
  /** Ground assault: waits for the bridge, then runs its own clock. */
  private groundEntries: MissionEntry[] = [];
  private groundFlags: boolean[] = [];
  private groundElapsed = 0;
  private bridgeReady = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      enemiesNode: 'enemies',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'WaveSpawner',
      properties: [
        {
          name: 'enemiesNode',
          type: 'string',
          ui: { label: 'Enemies Group', group: 'Spawner' },
          getValue: (c: unknown) => (c as WaveSpawner).config.enemiesNode,
          setValue: (c: unknown, v: unknown) => {
            (c as WaveSpawner).config.enemiesNode = String(v);
          },
        },
      ],
      groups: { Spawner: { label: 'Wave Spawner', expanded: true } },
    };
  }

  /** Total number of authored campaign missions. */
  get waveCount(): number {
    return MISSIONS.length;
  }

  /** JSON-serialisable spawn state for the game-debug provider (see GameFlow). */
  get debugState(): Record<string, unknown> {
    return {
      running: this.running,
      mission: this.missionName,
      alive: this.aliveCount,
      entries: this.entries.length,
      spawned: this.spawnedFlags.filter(Boolean).length,
      ground: this.groundEntries.length,
      groundSpawned: this.groundFlags.filter(Boolean).length,
      bridgeReady: this.bridgeReady,
      survival: this.survivalStats,
    };
  }

  onStart(): void {
    // Track despawns for the clear check (enemies emit on game-root).
    this.findNode('game-root')?.connect('enemy-gone', this, () => {
      this.aliveCount = Math.max(0, this.aliveCount - 1);
    });
    // Ground waves hold until the transporters finish the bridge (mission 1);
    // once built it stays up for the rest of the run.
    this.findNode('game-root')?.connect('bridge-ready', this, () => {
      this.bridgeReady = true;
    });
    // Warm the sprite cache for every unit in the roster.
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      for (const [id, unit] of Object.entries(UNITS)) {
        const paths = [unit.sprite, ...(unit.spriteVariants ?? [])].filter(Boolean);
        for (const path of paths) {
          void loader
            .loadTexture(path)
            .then(tex => this.unitTextures.set(path, tex))
            .catch(() => console.warn(`[WaveSpawner] missing sprite ${path} (unit ${id})`));
        }
      }
    }
  }

  /** Campaign: the original mobs.xml level table, verbatim. */
  startWave(waveNumber: number): void {
    const index = Math.min(Math.max(1, waveNumber), MISSIONS.length) - 1;
    const mission = MISSIONS[index];
    this.entries = mission.entries;
    this.groundEntries = mission.ground ?? [];
    this.missionName = mission.name;
    this.survivalStats = null;
    this.beginRun();
  }

  /**
   * Survival: the original PREDEFINED 40-wave set (release build set2), verbatim.
   * Waves play in order with a lives counter; beyond wave 40 the last wave
   * repeats. Ground units in a wave route onto the bridge deck like campaign.
   */
  startSurvivalWave(waveNumber: number): void {
    const n = Math.max(1, waveNumber);
    const level = V15_SURVIVAL[Math.min(n, V15_SURVIVAL.length) - 1] ?? [];
    const entries: MissionEntry[] = [];
    const ground: MissionEntry[] = [];
    for (const [t, id, y, a] of level) {
      const e: MissionEntry = { t, id, y, a };
      if (UNITS[id]?.ground) ground.push(e);
      else entries.push(e);
    }
    this.survivalStats = null;
    this.entries = entries;
    this.groundEntries = ground;
    this.missionName = `Survival ${n}`;
    this.beginRun();
  }

  private beginRun(): void {
    this.spawnedFlags = this.entries.map(() => false);
    this.groundFlags = this.groundEntries.map(() => false);
    this.elapsed = 0;
    this.groundElapsed = 0;
    this.aliveCount = 0;
    this.running = true;
  }

  stopWave(): void {
    this.running = false;
  }

  /** Dev-only: mark the current wave finished so GameFlow advances (debug action). */
  forceClear(): void {
    this.spawnedFlags = this.spawnedFlags.map(() => true);
    this.groundFlags = this.groundFlags.map(() => true);
    // Despawn the survivors too — otherwise they keep flying and shell the
    // castle while the debug-driven shop is open.
    const enemies = this.findNode(String(this.config.enemiesNode));
    if (enemies) {
      for (const child of [...enemies.children]) {
        (child as NodeBase & { queueFree?: () => void }).queueFree?.();
      }
    }
    this.aliveCount = 0;
  }

  /** True when every entry has spawned and every spawned enemy is gone. */
  isWaveClear(): boolean {
    return (
      this.running &&
      this.spawnedFlags.every(Boolean) &&
      this.groundFlags.every(Boolean) &&
      this.aliveCount === 0
    );
  }

  onUpdate(dt: number): void {
    if (!this.running || !this.scene) return;
    this.elapsed += dt;

    for (let i = 0; i < this.entries.length; i++) {
      if (this.spawnedFlags[i] || this.entries[i].t > this.elapsed) continue;
      this.spawnedFlags[i] = true;
      this.aliveCount += 1;
      this.spawn(this.entries[i]);
    }

    // Ground assault clock only ticks once the bridge is standing.
    if (this.bridgeReady && this.groundEntries.length > 0) {
      this.groundElapsed += dt;
      for (let i = 0; i < this.groundEntries.length; i++) {
        if (this.groundFlags[i] || this.groundEntries[i].t > this.groundElapsed) continue;
        this.groundFlags[i] = true;
        this.aliveCount += 1;
        this.spawn(this.groundEntries[i]);
      }
    }
  }

  private spawn(entry: MissionEntry): void {
    const scene = this.scene;
    const unit = UNITS[entry.id];
    if (!scene || !unit || unit.unsupported) {
      if (!unit) console.warn(`[WaveSpawner] unknown unit id ${entry.id}`);
      else if (unit.unsupported)
        // npc/boss ids have no prefab wired yet (bosses + quest NPCs are a
        // later increment) — skip so the wave still clears.
        console.warn(`[WaveSpawner] skipping unsupported unit ${entry.id} (${unit.name})`);
      this.aliveCount = Math.max(0, this.aliveCount - 1);
      return;
    }
    const prefab = unit.compound ? UNIK_PREFAB : unit.ground ? TRUCK_PREFAB : BALLOON_PREFAB;
    void scene
      .instantiate(prefab, { parent: String(this.config.enemiesNode) })
      .then(node => {
        if (unit.ground) {
          node.position.set(SPAWN_X, BRIDGE.truckY, 0);
          this.applyGroundUnit(node, entry, unit);
          // The ground-assault alarm (original FN_addMob: warning_scream +
          // Joe's scream animation for every unit rolling onto the bridge).
          scene.audio.play(GROUND_ALARM_SOUND, { bus: 'sfx' });
        } else {
          node.position.set(SPAWN_X, toStageY(entry.y), 0);
          if (!unit.compound) {
            this.applyUnit(node, entry, unit);
          }
        }
      })
      .catch(err => {
        this.aliveCount = Math.max(0, this.aliveCount - 1);
        console.warn('[WaveSpawner] spawn failed', err);
      });
  }

  /** Dress a typical-balloon prefab up as the mission's actual unit. */
  private applyUnit(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    // Sprite: the prefab root IS the Sprite2D. Typical balloons come in
    // several liveries (spriteVariants) so a wave doesn't look uniform.
    const sprite = node as SpriteNode;
    const variants = unit.spriteVariants;
    const spritePath =
      variants && variants.length > 0
        ? variants[Math.floor(Math.random() * variants.length)]
        : unit.sprite;
    const texture = this.unitTextures.get(spritePath);
    if (texture && sprite.setTexture) {
      sprite.setTexture(texture);
      sprite.updateSize?.(unit.width, unit.height);
    }

    // Hitbox follows the display size (the collision service reads config live).
    const hitbox = node.components.find(
      c => (c as { type?: string }).type === 'core:Hitbox2D'
    ) as { config?: Record<string, unknown> } | undefined;
    if (hitbox?.config) {
      hitbox.config.width = Math.max(10, unit.width - 6);
      hitbox.config.height = Math.max(8, unit.height - 4);
    }

    // Hanging rig: the typical "S" carries a naval mine, bombers carry their
    // bomb on the same mount (both shootable). Units without the rig also
    // lose its hitboxes (link + mine are targets too).
    const carries = unit.carriesMine === true || unit.bomber === true;
    const mount = node.getChildByName('Weapon Mount');
    const mine = node.getChildByName('Carried Mine');
    if (mount) mount.visible = carries;
    if (mine) mine.visible = carries;
    for (const part of [mount, mine]) {
      if (!part) continue;
      for (const comp of part.components) {
        if ((comp as { type?: string }).type === 'core:Hitbox2D') {
          (comp as { config: Record<string, unknown> }).config.group = carries
            ? 'enemy'
            : 'disabled';
        }
      }
    }

    // Behavior stats (survival waves override the typical balloon's numbers).
    const logic = node.components.find((c): c is EnemyBalloon => c instanceof EnemyBalloon);
    if (logic) {
      const survival = this.survivalStats;
      logic.config.hp = survival && entry.id === 33 ? survival.hp : unit.hp;
      logic.config.speed = survival && entry.id === 33 ? survival.speed : unit.speed;
      logic.config.score = survival && entry.id === 33 ? survival.score : unit.score;
      logic.config.castleDamage = unit.castleDamage;
      logic.config.stopX = toStopX(entry.a);
      logic.config.attackDamage = unit.attackDamage ?? 0;
      logic.config.attackPeriod = unit.attackPeriod ?? 4;
      logic.config.bomber = unit.bomber === true;
      // The burning wreck reuses the livery this balloon was dressed with.
      logic.config.spritePath = spritePath;
    }
  }

  /** Dress the truck prefab up as the mission's ground unit. */
  private applyGroundUnit(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const sprite = node as SpriteNode;
    const texture = this.unitTextures.get(unit.sprite);
    if (texture && sprite.setTexture) {
      sprite.setTexture(texture);
      sprite.updateSize?.(unit.width, unit.height);
    }

    const hitbox = node.components.find(
      c => (c as { type?: string }).type === 'core:Hitbox2D'
    ) as { config?: Record<string, unknown> } | undefined;
    if (hitbox?.config) {
      hitbox.config.width = Math.max(10, unit.width - 6);
      hitbox.config.height = Math.max(8, unit.height - 4);
    }

    const logic = node.components.find((c): c is GroundVehicle => c instanceof GroundVehicle);
    if (logic) {
      logic.config.hp = unit.hp;
      logic.config.speed = unit.speed;
      logic.config.score = unit.score;
      logic.config.stopX = toStopX(entry.a);
      logic.config.attackDamage = unit.attackDamage ?? 0;
      logic.config.attackPeriod = unit.attackPeriod ?? 5;
    }
  }
}
