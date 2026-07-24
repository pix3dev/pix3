import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { BossEnemy } from './BossEnemy';
import { CompoundBalloon } from './CompoundBalloon';
import { EnemyBalloon } from './EnemyBalloon';
import { GroundVehicle } from './GroundVehicle';
import { QuestNpc } from './QuestNpc';
import {
  BRIDGE,
  containerRectFromNode,
  MISSIONS,
  QUEST_LEVELS,
  UNITS,
  type MissionEntry,
  type UnitDef,
} from './SdBalance';
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

/** id (1-84) → prefab path, or null for ids without a prefab yet (quest npc). */
function unitPrefabPath(id: number): string | null {
  if (id === 33) return `${PREFABS}/transporter-enemy.pix3scene`;
  if (id >= 35 && id <= 42) return `${PREFABS}/unik.pix3scene`;
  if (id >= 43 && id <= 48) return `${PREFABS}/urik.pix3scene`;
  if (id >= 49 && id <= 62) return `${PREFABS}/units/${GROUND_FAMILY[id - 49]}.pix3scene`;
  if (id >= 63 && id <= 74) return `${PREFABS}/quest-npc.pix3scene`;
  if (id >= 75 && id <= 84) return `${PREFABS}/boss.pix3scene`;
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
  /** 1-based campaign level of the current wave (0 = survival/none) — drives the
   *  per-level quest identity + container rect for quest NPCs. */
  private questLevel = 0;

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
      questLevel: this.questLevel,
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
        // Boss white-flash overlays load lazily on spawn — warm them too.
        if (unit.whiteTex) paths.add(unit.whiteTex);
        // Quest NPC body + cargo liveries are re-textured on spawn — warm them.
        if (unit.npcTex) paths.add(unit.npcTex);
        if (unit.payloadTex) paths.add(unit.payloadTex);
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
    this.questLevel = index + 1;
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
    for (const [t, id, y, a, tip, dop] of level) {
      const e: MissionEntry = { t, id, y, a, tip, dop };
      if (UNITS[id]?.ground) ground.push(e);
      else entries.push(e);
    }
    this.survivalStats = null;
    this.entries = entries;
    this.groundEntries = ground;
    this.missionName = `Survival ${n}`;
    // Survival has no campaign quest levels; quest NPCs (if any appear) fall back
    // to a per-unit questId with no container.
    this.questLevel = 0;
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
          if (unit.boss) {
            this.applyBossStats(node, entry, unit);
          } else if (unit.npc) {
            this.applyNpcStats(node, entry, unit);
          } else if (unit.compound) {
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
    // Air units never ram (see CompoundBalloon): they park-and-shoot from `a`
    // or drift through. Unik (35-42) = arc cannon, Urik (43-48) = torpedo.
    logic.config.castleDamage = 0;
    logic.config.attackDamage = unit.attackDamage ?? 0;
    logic.config.attackPeriod = unit.attackPeriod ?? 2;
    logic.config.weaponClass = entry.id >= 43 && entry.id <= 48 ? 'torpedo' : 'arc';
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
    // Behaviour variant: tip 13 = ram-and-self-destruct; else park-and-shoot.
    logic.config.tip = entry.tip;
  }

  /**
   * Per-id stats for bosses (ids 75-84, generic boss.pix3scene). Bosses always
   * HOLD (never ram): they hold at `a` if given, else at a safe default on the
   * right so they don't fly off the field. Re-textures the Boss Body + Boss
   * White sprites to the per-id livery from the BOSS table (via the AssetLoader,
   * resized to the texture's native size).
   */
  private applyBossStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is BossEnemy => c instanceof BossEnemy);
    if (!logic) return;
    logic.config.hp = unit.hp;
    logic.config.score = unit.score;
    // Bosses always hold: use the `a` mark, else a default hold on the right.
    logic.config.stopX = entry.a > 0 ? toStopX(entry.a) : 120;
    logic.config.attackDamage = unit.attackDamage ?? 0;
    logic.config.bodyTex = unit.sprite;
    logic.config.whiteTex = unit.whiteTex ?? unit.sprite;
    logic.config.bodyWidth = unit.width;
    logic.config.bodyHeight = unit.height;
    logic.config.gunCount = unit.gunCount ?? 2;
    logic.config.escort = unit.escort === true;
    logic.config.finale = unit.finale === true;
    logic.config.bossName = unit.name;

    // Re-texture the body + white overlay to this boss's livery.
    this.setBossTexture(node, 'Boss Body', unit.sprite);
    this.setBossTexture(node, 'Boss White', unit.whiteTex ?? unit.sprite);

    // Fit the `enemy` hitbox (on the Boss Body) to this boss's body size — the
    // prefab default only covers the placeholder livery.
    const body = node.getChildByName('Boss Body') as NodeBase | undefined;
    const hitbox = body?.components.find(c => c.type === 'core:Hitbox2D');
    if (hitbox) {
      hitbox.config.width = Math.max(8, unit.width - 8);
      hitbox.config.height = Math.max(8, unit.height - 8);
    }
  }

  /** Swap a boss child sprite's texture and resize it to the texture's native size. */
  private setBossTexture(node: NodeBase, childName: string, path: string): void {
    this.setChildTexture(node, childName, path);
  }

  /**
   * Per-id stats for quest NPCs (ids 63-74, generic quest-npc.pix3scene). Mirrors
   * applyBossStats: pushes hp/speed/score + the role/payload/questId, re-textures
   * the NPC Body (+ Cargo for carriers) and fits the body hitbox. The per-LEVEL
   * questId + container rect (the boat/cup/truck) come from QUEST_LEVELS keyed by
   * the current campaign level; survival (questLevel 0) falls back to a per-unit
   * id with no container. Near-zero original speeds (MGold/MLuckyGold) are floored
   * so the NPC still traverses the field (QuestNpc never parks — see its docstring).
   */
  private applyNpcStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is QuestNpc => c instanceof QuestNpc);
    if (!logic) return;
    const level = QUEST_LEVELS[this.questLevel];

    logic.config.hp = unit.hp;
    logic.config.speed = Math.max(40, unit.speed);
    logic.config.score = unit.score;
    logic.config.stopX = toStopX(entry.a);
    logic.config.role = unit.role ?? 'combat';
    logic.config.payloadType = unit.payloadType ?? 0;
    logic.config.payloadTex = unit.payloadTex ?? '';
    logic.config.npcName = unit.name;
    logic.config.questId = level?.questId ?? `unit-${entry.id}`;
    // Container rect: an authored `quest-container` node in the level scene wins
    // (scene-per-level author placed the boat/cup/truck visually); otherwise the
    // QUEST_LEVELS rect. This is the same source the visual + QuestCargo use.
    const c = containerRectFromNode(this.findNode('quest-container')) ?? level?.container;
    logic.config.containerX = c?.x ?? 0;
    logic.config.containerY = c?.y ?? -170;
    logic.config.containerW = c?.w ?? 360;
    logic.config.containerH = c?.h ?? 90;

    // Re-texture the body to this NPC's livery + fit the `enemy` hitbox.
    this.setChildTexture(node, 'NPC Body', unit.npcTex ?? unit.sprite);
    const body = node.getChildByName('NPC Body') as NodeBase | undefined;
    const bodyHit = body?.components.find(c2 => c2.type === 'core:Hitbox2D');
    if (bodyHit) {
      bodyHit.config.width = Math.max(8, unit.width - 4);
      bodyHit.config.height = Math.max(8, unit.height - 4);
    }
    // Carriers show + re-texture the Cargo child; QuestNpc.onStart handles the
    // visibility/hitbox for non-carriers.
    if (unit.role === 'carrier' && unit.payloadTex) {
      this.setChildTexture(node, 'Cargo', unit.payloadTex);
    }
  }

  /** Swap a child sprite's texture and resize it to the texture's native size. */
  private setChildTexture(node: NodeBase, childName: string, path: string): void {
    if (!path) return;
    const child = node.getChildByName(childName);
    const sprite = child instanceof Sprite2D ? child : null;
    const loader = this.scene?.getAssetLoader();
    if (!sprite || !loader) return;
    void loader
      .loadTexture(path)
      .then(tex => {
        sprite.setTexture(tex);
        sprite.resetToOriginalSize();
      })
      .catch(() => console.warn(`[WaveSpawner] missing texture ${path}`));
  }
}
