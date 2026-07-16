import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { EnemyBalloon } from './EnemyBalloon';

const BALLOON_PREFAB = 'res://src/assets/prefabs/balloon.pix3scene';
const UNIK_PREFAB = 'res://src/assets/prefabs/unik.pix3scene';

/** One spawn entry: original mobs.xml semantics (t seconds, y in 640×480 coords). */
interface WaveEntry {
  /** Spawn time in seconds from wave start (original `<t>`). */
  t: number;
  /** Original screen y (top-left origin, 0..480) — converted to stage-local. */
  y: number;
  /** Optional stage-local x where the unit stops to hold position (original `<a>`). */
  stopX?: number;
  /** Unit prefab: default typical balloon; 'unik' = compound aerostat (id 39). */
  kind?: 'unik';
}

/**
 * Wave 1 of the original game, converted verbatim from
 * design/original-data/mobs.xml `<Lvl n="1">` (all entries are unit id 33 —
 * the typical "S" balloon; wing formations marked by `<com>` in presets.txt).
 */
const LEVEL_1_WAVES: WaveEntry[][] = [
  // Wave 1 — the original Lvl 1 spawn table.
  [
    { t: 1, y: 120 }, { t: 1, y: 300 }, { t: 4, y: 210 },
    { t: 7, y: 120 }, { t: 7, y: 300 }, { t: 10, y: 210 },
    { t: 13, y: 210 }, { t: 14, y: 180 }, { t: 14, y: 240 },
    { t: 15, y: 150 }, { t: 15, y: 270 }, { t: 16, y: 120 }, { t: 16, y: 300 },
    { t: 17, y: 90 }, { t: 17, y: 330 }, { t: 18, y: 60 }, { t: 18, y: 360 },
    // A first taste of the compound units at the tail of the wave.
    { t: 21, y: 200, kind: 'unik' },
  ],
  // Wave 2 — "galka + cross" support patterns (denser, from Lvl 1 tail) + Uniks.
  [
    { t: 1, y: 210 }, { t: 2, y: 210 }, { t: 3, y: 210 },
    { t: 2, y: 180 }, { t: 2, y: 240 },
    { t: 4, y: 140, kind: 'unik' },
    { t: 6, y: 210 }, { t: 5, y: 180 }, { t: 7, y: 180 },
    { t: 5, y: 240 }, { t: 7, y: 240 },
    { t: 8, y: 280, kind: 'unik' },
    { t: 10, y: 120 }, { t: 10, y: 300 }, { t: 12, y: 60 }, { t: 12, y: 360 },
    { t: 13, y: 200, kind: 'unik' },
  ],
];

/** Original 640×480 top-left y → stage-local center-origin Y-up. */
const toStageY = (origY: number): number => 240 - origY;
/** Spawn x just past the right edge of the original playfield. */
const SPAWN_X = 470;

/**
 * WaveSpawner — drives one wave at a time from the converted original spawn
 * tables: instantiates the balloon prefab (`scene.instantiate`) into the
 * `enemies` group at the authored time/height. GameFlow starts waves with
 * `startWave(n)` and polls `isWaveClear()` (all spawned AND all gone —
 * enemies report despawn via `enemy-gone` on `game-root`).
 */
export class WaveSpawner extends Script {
  private entries: WaveEntry[] = [];
  private spawnedFlags: boolean[] = [];
  private elapsed = 0;
  private running = false;
  private aliveCount = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      enemiesNode: 'enemies',
      hp: 100,
      speed: 55,
      score: 8,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Spawner', step: 1 },
      getValue: (c: unknown) => (c as WaveSpawner).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as WaveSpawner).config[name] = Number(v);
      },
    });
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
        num('hp', 'Enemy HP'),
        num('speed', 'Enemy Speed'),
        num('score', 'Enemy Score'),
      ],
      groups: { Spawner: { label: 'Wave Spawner', expanded: true } },
    };
  }

  /** Total number of authored waves. */
  get waveCount(): number {
    return LEVEL_1_WAVES.length;
  }

  /** JSON-serialisable spawn state for the game-debug provider (see GameFlow). */
  get debugState(): Record<string, unknown> {
    return {
      running: this.running,
      alive: this.aliveCount,
      entries: this.entries.length,
      spawned: this.spawnedFlags.filter(Boolean).length,
      cfgHp: Number(this.config.hp),
      cfgSpeed: Number(this.config.speed),
      cfgScore: Number(this.config.score),
    };
  }

  onStart(): void {
    // Track despawns for the clear check (enemies emit on game-root).
    this.findNode('game-root')?.connect('enemy-gone', this, () => {
      this.aliveCount = Math.max(0, this.aliveCount - 1);
    });
  }

  startWave(waveNumber: number): void {
    const index = Math.min(Math.max(1, waveNumber), LEVEL_1_WAVES.length) - 1;
    this.entries = LEVEL_1_WAVES[index];
    this.spawnedFlags = this.entries.map(() => false);
    this.elapsed = 0;
    this.aliveCount = 0;
    this.running = true;
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
    const entries: WaveEntry[] = [];
    for (let i = 0; i < count; i++) {
      // Wedge pairs: every third unit flies with a ±30 wingman.
      const y = heights[i % heights.length] + (i % 3 === 0 ? 0 : i % 3 === 1 ? -30 : 30);
      entries.push({ t: 1 + i * gap, y: Math.min(400, Math.max(50, y)) });
    }
    const uniks = Math.min(5, Math.floor(n / 2));
    for (let i = 0; i < uniks; i++) {
      entries.push({ t: 4 + i * 7, y: 140 + (i % 3) * 70, kind: 'unik' });
    }

    // Escalate the per-wave overrides the spawner hands to typical balloons.
    this.config.hp = 90 + n * 12;
    this.config.speed = Math.min(115, 48 + n * 4);
    this.config.score = 4 + n;

    this.entries = entries;
    this.spawnedFlags = entries.map(() => false);
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

  private spawn(entry: WaveEntry): void {
    const scene = this.scene;
    if (!scene) return;
    const prefab = entry.kind === 'unik' ? UNIK_PREFAB : BALLOON_PREFAB;
    void scene
      .instantiate(prefab, { parent: String(this.config.enemiesNode) })
      .then(node => {
        node.position.set(SPAWN_X, toStageY(entry.y), 0);
        // Uniks keep their prefab-authored balance; typical balloons take the
        // spawner's per-wave overrides.
        const logic = node.components.find(
          (c): c is EnemyBalloon => c instanceof EnemyBalloon
        );
        if (logic) {
          logic.config.hp = Number(this.config.hp);
          logic.config.speed = Number(this.config.speed);
          logic.config.score = Number(this.config.score);
          if (entry.stopX !== undefined) {
            logic.config.stopX = entry.stopX;
          }
        }
      })
      .catch(err => {
        this.aliveCount = Math.max(0, this.aliveCount - 1);
        console.warn('[WaveSpawner] spawn failed', err);
      });
  }
}
