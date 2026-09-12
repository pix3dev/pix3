import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { BossEnemy } from './BossEnemy';
import { CompoundBalloon } from './CompoundBalloon';
import { EnemyBalloon } from './EnemyBalloon';
import { GroundVehicle } from './GroundVehicle';
import { QuestNpc } from './QuestNpc';
import { UnitHealthBar } from './UnitHealthBar';
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
/** `GRracer` — the one truck `FN_addMob` gives `tip 13` (rams the gate). */
const GROUND_RAMMER_ID = 61;

// ── Unit prefab registry ─────────────────────────────────────────────────────
// Every unit CLASS is an authored prefab (visual composition baked per the
// decompiled com.enemy.*.init(); reviewable on the dev air-gallery and
// unit-gallery scenes). The spawner only applies per-id STATS from SdBalance.
const PREFABS = 'res://src/assets/prefabs';
/**
 * Air band, id → prefab file. ONE PREFAB PER CLASS, not per family: the
 * original has 48 distinct rigs and a family's `_1` variant is not
 * representative of the rest of it (`.plans/enemy-fidelity-audit.md` §3). The
 * `_1`-shaped names (`avalon1`, `nz`, `suc`, …) are the pre-existing files that
 * already carried that class's rig; everything else is a per-class file.
 * Ids 5-24, 26-29 and 35-48 are GENERATED from the rig table in
 * `scripts/gen-levels.mjs` — review them on `scenes/dev/air-gallery.pix3scene`.
 */
const AIR_CLASS: Readonly<Record<number, string>> = {
  1: 'lucky', // Lucky_1     body + Mine
  2: 'lucky2', // Lucky_2     body + Stoneb
  3: 'slevin', // Slevin_1    body + Mine
  4: 'slevin-fire', // Slevin_2  body + Stoneb + Burn1 + Littlebg
  5: 'avalon1', // Avalon1_1  nose BigGun
  6: 'avalon1-2', // Avalon1_2  heavy B_Torpedo
  7: 'avalon1-3', // Avalon1_3  3x Mine
  8: 'avalon1-4', // Avalon1_4  3x fire bomb
  9: 'avalon2', // Avalon2_1  2x gun-basket
  10: 'avalon2-2', // Avalon2_2  4x Stoneb
  11: 'avalon2-3', // Avalon2_3  2x B_LTorpedo
  12: 'avalon2-4', // Avalon2_4  5x Mine
  13: 'lavalon1', // Lavalon1_1 gun-basket
  14: 'lavalon1-2', // Lavalon1_2 B_LTorpedo
  15: 'lavalon1-3', // Lavalon1_3 2x Mine
  16: 'lavalon1-4', // Lavalon1_4 fire bomb
  17: 'lavalon2', // Lavalon2_1 gun-basket
  18: 'lavalon2-2', // Lavalon2_2 2x Stoneb — the level-1 "Bomber"
  19: 'lavalon2-3', // Lavalon2_3 burning hull, no weapon
  20: 'lavalon2-4', // Lavalon2_4 2x Mine
  21: 'nz', // NZ_1        gun-basket
  22: 'nz-2', // NZ_2        basket + 55x10 sniper
  23: 'nz-3', // NZ_3        3x Mine
  24: 'nz-4', // NZ_4        3x Burn2 (burning)
  // NZ_5 is the ONE variant of the family that carries no basket and no gun:
  // `E/NZ_5.init()` hangs `Stoneb` + `Burn1` + `Littlebg` off a `d1` sprite.
  25: 'nz-fire',
  26: 'suc', // SUC_1       gun-basket
  27: 'suc-2', // SUC_2       basket + 2x sniper
  28: 'suc-3', // SUC_3       2x Mine
  29: 'suc-4', // SUC_4       2x Stoneb
  30: 'fatty',
  31: 'fish',
  32: 'splash',
  34: 'nut',
  35: 'unik-1', // Unik_1   compound + B_TypSnp
  36: 'unik-2', // Unik_2   compound + B_LTorpedo
  37: 'unik-3', // Unik_3   compound + Stoneb
  38: 'unik-4', // Unik_4   compound + fire bomb
  39: 'unik-5', // Unik_5   PLANE + B_TypSnp
  40: 'unik-6', // Unik_6   PLANE + B_TypGun — the level-1 "ATS"
  41: 'unik-7', // Unik_7   PLANE + B_LTorpedo
  42: 'unik-8', // Unik_8   PLANE, burning
  43: 'urik-1', // Urik_1   compound + heavy B_Torpedo
  44: 'urik-2', // Urik_2   compound + 3x Mine
  45: 'urik-3', // Urik_3   compound + BigGun
  46: 'urik-4', // Urik_4   PLANE + B_TypGun
  47: 'urik-5', // Urik_5   PLANE + B_Mine
  48: 'urik-6', // Urik_6   PLANE, burning + motion blur
};
/**
 * Ground band, id → truck prefab. EXPLICIT, not an offset into an ordered list:
 * `FN_addMob`'s stage-1 switch has no `case 49` and maps every id from 50 up to
 * `id - 2`, so the band is 50-63 with three HOLES (58/59/62 reach a
 * constructor-less case; SdV15 marks them `cat: 'cut'`). The `fatima`/`garbag`/
 * `siege` prefabs stay on disk but are deliberately out of this registry — those
 * liveries only ever existed as `CorsetCar` wreck bitmaps.
 */
const GROUND_FAMILY: Readonly<Record<number, string>> = {
  50: 'atabus',
  51: 'attaban',
  52: 'baka',
  53: 'baron',
  54: 'bb',
  55: 'bus',
  56: 'dream',
  57: 'dreamer',
  60: 'medic',
  61: 'rracer',
  63: 'warchild',
};

/** id (1-84) → prefab path, or null for ids without a prefab yet (quest npc). */
function unitPrefabPath(id: number): string | null {
  if (id === 33) return `${PREFABS}/transporter-enemy.pix3scene`;
  const truck = GROUND_FAMILY[id];
  if (truck) return `${PREFABS}/units/${truck}.pix3scene`;
  if (id >= 64 && id <= 75) return `${PREFABS}/quest-npc.pix3scene`;
  if (id >= 76 && id <= 84) return `${PREFABS}/boss.pix3scene`;
  const air = AIR_CLASS[id];
  return air ? `${PREFABS}/units/${air}.pix3scene` : null;
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
      ground: this.entries.filter(e => UNITS[e.id]?.ground).length,
      survival: this.survivalStats,
      questLevel: this.questLevel,
    };
  }

  onStart(): void {
    // Track despawns for the clear check (enemies emit on game-root).
    this.findNode('game-root')?.connect('enemy-gone', this, () => {
      this.aliveCount = Math.max(0, this.aliveCount - 1);
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
    this.missionName = mission.name;
    this.survivalStats = null;
    this.questLevel = index + 1;
    this.beginRun();
  }

  /**
   * Survival: the original PREDEFINED 40-wave set (release build set2), verbatim.
   * Waves play in order with a lives counter; beyond wave 40 the last wave
   * repeats. Ground units in a wave route onto the bridge deck like campaign —
   * on the same single clock (the 40-level set in fact uses no id >= 49).
   */
  startSurvivalWave(waveNumber: number): void {
    const n = Math.max(1, waveNumber);
    const level = V15_SURVIVAL[Math.min(n, V15_SURVIVAL.length) - 1] ?? [];
    this.survivalStats = null;
    this.entries = level.map(
      ([t, id, y, a, tip, dop]): MissionEntry => ({ t, id, y, a, tip, dop })
    );
    this.missionName = `Survival ${n}`;
    // Survival has no campaign quest levels; quest NPCs (if any appear) fall back
    // to a per-unit questId with no container.
    this.questLevel = 0;
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
    return this.running && this.spawnedFlags.every(Boolean) && this.aliveCount === 0;
  }

  /**
   * ONE clock for the whole table, ground included — the original's
   * `MT.gameCode` is a single `++this.g_time` compared against every
   * `arMobs[i][0]` with no ground branch. The bridge carriers run concurrently
   * on `t_enTP` and gate nothing: on level 1 the last one docks at ~7 s just as
   * the `GBaron` (t=7) rolls on, which is the coincidence the old `bridge-ready`
   * gate mistook for a dependency.
   */
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
    this.attachHealthBar(node, unit);
  }

  /** Per-id stats for the rope-hung compounds (Unik_1-4 / Urik_1-3). */
  private applyCompoundStats(node: NodeBase, entry: MissionEntry, unit: UnitDef): void {
    const logic = node.components.find((c): c is CompoundBalloon => c instanceof CompoundBalloon);
    if (!logic) return;
    logic.config.bodyHp = unit.hp;
    logic.config.speed = unit.speed;
    logic.config.score = unit.score;
    logic.config.stopX = toStopX(entry.a);
    // Air units never ram (see CompoundBalloon): they park-and-shoot from `a`
    // or drift through.
    logic.config.castleDamage = 0;
    logic.config.attackDamage = unit.attackDamage ?? 0;
    logic.config.attackPeriod = unit.attackPeriod ?? 2;
    // Per CLASS, not per family: only Unik_2 (36) and Urik_1 (43) mount a
    // torpedo launcher — the rest of the compounds fire the lobbed arc shell.
    logic.config.weaponClass = unit.weaponClass ?? 'arc';
    this.attachHealthBar(node, unit);
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
    // It comes from the CLASS, not the XML: `FN_addMob` emits `pushbyte 12;
    // setproperty tip` for every `G*` and `pushbyte 13` for `GRracer` (id 61),
    // while the XML `<tip>` lands in `tpp` and is `0` for every campaign ground
    // spawn — so feeding `entry.tip` here meant the racers never rammed.
    logic.config.tip = entry.id === GROUND_RAMMER_ID ? 13 : 12;
    this.attachHealthBar(node, unit);
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
    this.attachHealthBar(node, unit);
  }

  /**
   * Attach a floating HP bar to a freshly-spawned combat unit. Runtime-only
   * (never authored/serialised), so it's constructed directly and attached with
   * `addComponent`, which fires its `onStart` immediately (scene already running)
   * to build the `Bar2D` child. Bosses are intentionally excluded — they own the
   * dedicated HUD boss bar. Size/offset come from the unit's body when known so
   * the bar sits just above each livery.
   */
  private attachHealthBar(node: NodeBase, unit?: UnitDef): void {
    const bar = new UnitHealthBar(`${node.nodeId}:hpbar`, 'user:UnitHealthBar');
    if (unit?.width) bar.config.width = Math.max(24, Math.min(64, unit.width));
    if (unit?.height) bar.config.offsetY = unit.height / 2 + 12;
    node.addComponent(bar);
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
