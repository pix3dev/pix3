import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { CompoundBalloon } from './CompoundBalloon';
import { EnemyBalloon } from './EnemyBalloon';
import { GroundVehicle } from './GroundVehicle';
import { BRIDGE, MISSIONS, UNITS, type MissionEntry, type UnitDef } from './SdBalance';
import { V15_SURVIVAL } from './SdV15';

/** Joe's alarm cry — the original plays it on every ground-unit spawn. */
const GROUND_ALARM_SOUND = 'res://src/assets/audio/other/warning_scream.mp3';

// ── Unit prefab registry ─────────────────────────────────────────────────────
// Every unit FAMILY is an authored prefab (visual composition baked per the
// decompiled com.enemy.*.init(); reviewable on the dev unit-gallery scene).
// The spawner only applies per-id STATS from SdBalance on top.
const PREFABS = 'res://src/assets/prefabs';
const AIR_FAMILY: ReadonlyArray<[from: number, to: number, file: string]> = [
  [1, 1, 'lucky'],
  [2, 2, 'lucky2'],
  [3, 3, 'slevin'],
  [4, 4, 'slevin-fire'],
  [5, 8, 'avalon1'],
  [9, 12, 'avalon2'],
  [13, 16, 'lavalon1'],
  [17, 20, 'lavalon2'],
  [21, 25, 'nz'],
  [26, 29, 'suc'],
  [30, 30, 'fatty'],
  [31, 31, 'fish'],
  [32, 32, 'splash'],
  [34, 34, 'nut'],
];
const GROUND_FAMILY = [
  'atabus', 'attaban', 'baka', 'baron', 'bb', 'bus', 'dream',
  'dreamer', 'fatima', 'medic', 'rracer', 'garbag', 'siege', 'warchild',
] as const; // ids 49..62 in order

/** id (1-62) → prefab path, or null for ids without a prefab yet (npc/boss). */
function unitPrefabPath(id: number): string | null {
  if (id === 33) return `${PREFABS}/transporter-enemy.pix3scene`;
  if (id >= 35 && id <= 42) return `${PREFABS}/unik.pix3scene`;
  if (id >= 43 && id <= 48) return `${PREFABS}/urik.pix3scene`;
  if (id >= 49 && id <= 62) return `${PREFABS}/units/${GROUND_FAMILY[id - 49]}.pix3scene`;
  const air = AIR_FAMILY.find(([from, to]) => id >= from && id <= to);
  return air ? `${PREFABS}/units/${air[2]}.pix3scene` : null;
}

/** Original 640×480 top-left y → stage-local center-origin Y-up. */
const toStageY = (origY: number): number => 240 - origY;
/** Original attack x (640-wide) → stage-local; clamped clear of the crash line. */
const toStopX = (a: number): number => (a > 0 ? Math.max(a - 320, -170) : 0);
/** Spawn x just past the right edge of the original playfield. */
const SPAWN_X = 470;

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
    // Warm the texture cache for every unit body so first spawns don't pop in.
    // (Prefab rig art — baskets, guns, gondolas — loads with each prefab.)
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      const paths = new Set<string>();
      for (const unit of Object.values(UNITS)) {
        if (unit.sprite) paths.add(unit.sprite);
      }
      for (const path of paths) {
        void loader
          .loadTexture(path)
          .catch(() => console.warn(`[WaveSpawner] missing sprite ${path}`));
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
    this.despawnAll();
  }

  /**
   * Remove every live enemy without advancing the wave — used by the survival
   * retry (a destroyed castle costs a life and replays the wave from scratch).
   * The wave is re-armed by the next `startSurvivalWave` → `beginRun`.
   */
  despawnAll(): void {
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
    const prefab = unitPrefabPath(entry.id);
    if (!prefab) {
      console.warn(`[WaveSpawner] no prefab for unit ${entry.id} (${unit.name})`);
      this.aliveCount = Math.max(0, this.aliveCount - 1);
      return;
    }
    void scene
      .instantiate(prefab, { parent: String(this.config.enemiesNode) })
      .then(node => {
        if (unit.ground) {
          node.position.set(SPAWN_X, BRIDGE.truckY, 0);
          this.applyGroundStats(node, entry, unit);
          // The ground-assault alarm (original FN_addMob: warning_scream +
          // Joe's scream animation for every unit rolling onto the bridge).
          scene.audio.play(GROUND_ALARM_SOUND, { bus: 'sfx' });
        } else {
          node.position.set(SPAWN_X, toStageY(entry.y), 0);
          if (unit.compound) {
            this.applyCompoundStats(node, entry, unit);
          } else {
            this.applyAirStats(node, entry, unit);
          }
        }
      })
      .catch(err => {
        this.aliveCount = Math.max(0, this.aliveCount - 1);
        console.warn('[WaveSpawner] spawn failed', err);
      });
  }

  // The unit's VISUAL composition is baked into its family prefab (authored
  // per the decompiled init() — review on the dev unit-gallery scene). The
  // spawner only pushes per-id numbers from the v15 data on top.

  /** Per-id stats for air units (survival overrides the transporter fodder). */
  private applyAirStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is EnemyBalloon => c instanceof EnemyBalloon);
    if (!logic) return;
    const survival = this.survivalStats;
    logic.config.hp = survival && entry.id === 33 ? survival.hp : unit.hp;
    logic.config.speed = survival && entry.id === 33 ? survival.speed : unit.speed;
    logic.config.score = survival && entry.id === 33 ? survival.score : unit.score;
    logic.config.castleDamage = unit.castleDamage;
    logic.config.stopX = toStopX(entry.a);
    logic.config.attackDamage = unit.attackDamage ?? 0;
    logic.config.attackPeriod = unit.attackPeriod ?? 4;
  }

  /** Per-id stats for compound units (unik/urik prefabs). */
  private applyCompoundStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is CompoundBalloon => c instanceof CompoundBalloon);
    if (!logic) return;
    logic.config.bodyHp = unit.hp;
    logic.config.speed = unit.speed;
    logic.config.score = unit.score;
    logic.config.stopX = toStopX(entry.a);
  }

  /** Per-id stats for ground vehicles. */
  private applyGroundStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is GroundVehicle => c instanceof GroundVehicle);
    if (!logic) return;
    logic.config.hp = unit.hp;
    logic.config.speed = unit.speed;
    logic.config.score = unit.score;
    logic.config.stopX = toStopX(entry.a);
    logic.config.attackDamage = unit.attackDamage ?? 0;
    logic.config.attackPeriod = unit.attackPeriod ?? 5;
  }
}
