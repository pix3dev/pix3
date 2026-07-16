import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';
import { EnemyBalloon } from './EnemyBalloon';
import { MISSIONS, UNITS, type MissionEntry, type UnitDef } from './SdBalance';

const BALLOON_PREFAB = 'res://src/assets/prefabs/balloon.pix3scene';
const UNIK_PREFAB = 'res://src/assets/prefabs/unik.pix3scene';

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
  /** Per-unit sprite cache, preloaded in onStart to avoid texture pop-in. */
  private unitTextures = new Map<number, Texture>();
  /** Survival-only stat overrides for the typical balloon. */
  private survivalStats: { hp: number; speed: number; score: number } | null = null;

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
      survival: this.survivalStats,
    };
  }

  onStart(): void {
    // Track despawns for the clear check (enemies emit on game-root).
    this.findNode('game-root')?.connect('enemy-gone', this, () => {
      this.aliveCount = Math.max(0, this.aliveCount - 1);
    });
    // Warm the sprite cache for every unit in the roster.
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      for (const [id, unit] of Object.entries(UNITS)) {
        if (!unit.sprite) continue;
        void loader
          .loadTexture(unit.sprite)
          .then(tex => this.unitTextures.set(Number(id), tex))
          .catch(() => console.warn(`[WaveSpawner] missing sprite for unit ${id}`));
      }
    }
  }

  /** Campaign: the original mobs.xml level table, verbatim. */
  startWave(waveNumber: number): void {
    const index = Math.min(Math.max(1, waveNumber), MISSIONS.length) - 1;
    const mission = MISSIONS[index];
    this.entries = mission.entries;
    this.missionName = mission.name;
    this.survivalStats = null;
    this.beginRun();
  }

  /**
   * Survival: endless procedurally-escalating waves built from the original
   * formation heights (presets.txt wedges/crosses). Density, speed, HP and
   * compound-unit count all grow with the wave number.
   */
  startSurvivalWave(waveNumber: number): void {
    const n = Math.max(1, waveNumber);
    const heights = [210, 170, 250, 130, 290, 100, 320, 70, 350, 220, 180];
    const count = Math.min(26, 6 + n * 2);
    const gap = Math.max(0.9, 2.4 - n * 0.12);
    const entries: MissionEntry[] = [];
    for (let i = 0; i < count; i++) {
      // Wedge pairs: every third unit flies with a ±30 wingman.
      const y = heights[i % heights.length] + (i % 3 === 0 ? 0 : i % 3 === 1 ? -30 : 30);
      entries.push({ t: 1 + i * gap, id: 33, y: Math.min(400, Math.max(50, y)), a: 0 });
    }
    const uniks = Math.min(5, Math.floor(n / 2));
    for (let i = 0; i < uniks; i++) {
      entries.push({ t: 4 + i * 7, id: 39, y: 140 + (i % 3) * 70, a: 0 });
    }

    // Escalating overrides for the typical balloons of this wave.
    this.survivalStats = {
      hp: 90 + n * 12,
      speed: Math.min(115, 48 + n * 4),
      score: 4 + n,
    };
    this.entries = entries;
    this.missionName = `Survival ${n}`;
    this.beginRun();
  }

  private beginRun(): void {
    this.spawnedFlags = this.entries.map(() => false);
    this.elapsed = 0;
    this.aliveCount = 0;
    this.running = true;
  }

  stopWave(): void {
    this.running = false;
  }

  /** Dev-only: mark the current wave finished so GameFlow advances (debug action). */
  forceClear(): void {
    this.spawnedFlags = this.spawnedFlags.map(() => true);
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
    return this.running && this.spawnedFlags.every(Boolean) && this.aliveCount === 0;
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
  }

  private spawn(entry: MissionEntry): void {
    const scene = this.scene;
    const unit = UNITS[entry.id];
    if (!scene || !unit) {
      if (!unit) console.warn(`[WaveSpawner] unknown unit id ${entry.id}`);
      this.aliveCount = Math.max(0, this.aliveCount - 1);
      return;
    }
    const prefab = unit.compound ? UNIK_PREFAB : BALLOON_PREFAB;
    void scene
      .instantiate(prefab, { parent: String(this.config.enemiesNode) })
      .then(node => {
        node.position.set(SPAWN_X, toStageY(entry.y), 0);
        if (!unit.compound) {
          this.applyUnit(node, entry, unit);
        }
      })
      .catch(err => {
        this.aliveCount = Math.max(0, this.aliveCount - 1);
        console.warn('[WaveSpawner] spawn failed', err);
      });
  }

  /** Dress a typical-balloon prefab up as the mission's actual unit. */
  private applyUnit(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    // Sprite: the prefab root IS the Sprite2D.
    const sprite = node as SpriteNode;
    const texture = this.unitTextures.get(entry.id);
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
    }
  }
}
