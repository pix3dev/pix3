import { registerGameDebug, Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema, TrParams } from '@pix3/runtime';
import { Vector3 } from 'three';
import { WaveSpawner } from './WaveSpawner';
import {
  AIR_SUPPORT_DAMAGE,
  AIR_SUPPORT_PERIOD,
  AIR_SUPPORT_TARGETS,
  missionNameKey,
  QUEST_LEVELS,
  REPAIR_AMOUNT,
  SHOP_ITEMS,
  UMBRELLA_FACTOR,
  type QuestLevelDef,
} from './SdBalance';
import { session } from './SdSession';

const QUEST_CONTAINER_PREFAB = 'res://src/assets/prefabs/quest-container.pix3scene';
/** How long the objective banner shows on the center label at wave start. */
const QUEST_BANNER_SECONDS = 5;
/** Repair pacing (L19): a turret is repaired every this many seconds the
 *  engineer stays alive on the field; two are enough to succeed. */
const REPAIR_SECONDS = 5;
const REPAIR_MAX_TURRETS = 3;
const REWARD_SOUND = 'res://src/assets/audio/other/money.mp3';

/** Live quest tracker for a campaign quest level (see GameFlow.initQuest). */
interface QuestTracker {
  def: QuestLevelDef;
  level: number;
  /** Cargo that landed in the boat/cup/truck (sheep saved / cones collected). */
  cargoSaved: number;
  /** Cargo that fell wide or was carried away (gold taken / sheep lost). */
  cargoLost: number;
  npcSpawned: number;
  npcSafe: number;
  npcLost: number;
  /** Cargo detached and still falling (holds wave-clear until it lands). */
  airborne: number;
  turretsRepaired: number;
  repairTimer: number;
  /** null until evaluated at wave-clear. */
  succeeded: boolean | null;
}

/** Minimal structural view of the gun for the debug snapshot (no hard import). */
interface GunView {
  currentIndex: number;
  currentWeapon: { key: string };
  getAmmo(index: number): { mag: number; reserve: number };
}

/** UIControl2D hides its canvas-text refresh behind a protected method. */
type RuntimeLabel2D = Label2D & { updateLabel(): void };

type FlowState = 'countdown' | 'wave' | 'intermission' | 'wave-failed' | 'shop' | 'result';

type GameMode = 'campaign' | 'survival';

/** Survival lives (`surv_zh` in the original): the castle can fall this many
 *  times — each fall replays the wave — before it is Game Over. */
const SURVIVAL_LIVES = 5;
/** How long the "WAVE FAILED" banner lingers before the wave replays. */
const WAVE_FAILED_SECONDS = 2.5;

/** Menu/map → battle hand-off (SdSession owns the run; this picks mode + mission). */
declare global {
  // eslint-disable-next-line no-var
  var __SD_MODE: GameMode | undefined;
  // eslint-disable-next-line no-var
  var __SD_MISSION: number | undefined;
}

const SFX = {
  click: 'res://src/assets/audio/gui/unibat/unibat_press.mp3',
  panel: 'res://src/assets/audio/gui/ingame/ing_panel_move.mp3',
  warning: 'res://src/assets/audio/other/warning_scream.mp3',
  strike: 'res://src/assets/audio/explosions/big_explosion.mp3',
};

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';

/**
 * GameFlow — the battle round driver.
 * Campaign: countdown → wave (mission) → shop → wave … → result.
 * Survival (original mode): endless escalating waves with a short intermission
 * between them, score ×2, defeat ends the run.
 *
 * Economy and castle state flow in through signals on this node (`game-root`):
 * `unit-killed(score)` adds gold/score/kills, `castle-damaged(amount)` deals
 * absolute HP damage (max HP comes from the shop's floors/flag via SdSession),
 * `purchase(itemId)` applies repair/floor effects immediately.
 */
export class GameFlow extends Script {
  private state: FlowState = 'countdown';
  private mode: GameMode = 'campaign';
  private stateTime = 0;
  private wave = 1;
  private score = 0;
  private kills = 0;
  private battleTime = 0;
  private castleHp = 700;
  private victory = true;
  private airSupportTimer = 0;

  // ── survival lives (surv_zh) + per-wave checkpoint ──
  private lives = 0;
  private checkpointHp = 0;
  private checkpointScore = 0;
  private checkpointKills = 0;
  private checkpointGold = 0;

  // ── read-only state for the HUD ──
  get scoreValue(): number {
    return this.score;
  }
  get killsValue(): number {
    return this.kills;
  }
  get battleTimeValue(): number {
    return this.battleTime;
  }
  get castleMaxHp(): number {
    return session.maxCastleHp();
  }
  get castleHpValue(): number {
    return this.castleHp;
  }
  get castleHpFraction(): number {
    const max = this.castleMaxHp;
    return max > 0 ? Math.max(0, this.castleHp / max) : 0;
  }
  /** Survival: lives left (heart counter). Campaign returns 0 (no lives). */
  get livesValue(): number {
    return this.lives;
  }
  get isSurvival(): boolean {
    return this.mode === 'survival';
  }

  private centerLabel: RuntimeLabel2D | null = null;
  private waveLabel: RuntimeLabel2D | null = null;
  private goldLabel: RuntimeLabel2D | null = null;
  private resultTitle: RuntimeLabel2D | null = null;
  private resultStats: RuntimeLabel2D | null = null;
  private hpBar: Bar2D | null = null;
  private shopOverlay: NodeBase | null = null;
  private resultOverlay: NodeBase | null = null;
  private spawner: WaveSpawner | null = null;
  private disposeDebug: (() => void) | null = null;

  // ── quest tracking (campaign quest levels: L3/6/7/8/9/11/14/17/19/21/22/23) ──
  private quest: QuestTracker | null = null;
  private questContainer: NodeBase | null = null;
  private questBannerTime = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      countdownSeconds: 3,
      // Scene-per-level: the level scene declares which campaign mission it runs
      // (0 = fall back to the map/session mission, as main.pix3scene does).
      startMission: 0,
      menuScene: 'res://src/assets/scenes/menu.pix3scene',
      mapScene: 'res://src/assets/scenes/map.pix3scene',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'GameFlow',
      properties: [
        {
          name: 'countdownSeconds',
          type: 'number',
          ui: { label: 'Countdown (s)', group: 'Flow', min: 0, step: 1 },
          getValue: (c: unknown) => (c as GameFlow).config.countdownSeconds,
          setValue: (c: unknown, v: unknown) => {
            (c as GameFlow).config.countdownSeconds = Number(v);
          },
        },
        {
          name: 'startMission',
          type: 'number',
          ui: { label: 'Start Mission (0=auto)', group: 'Flow', min: 0, step: 1 },
          getValue: (c: unknown) => (c as GameFlow).config.startMission,
          setValue: (c: unknown, v: unknown) => {
            (c as GameFlow).config.startMission = Number(v);
          },
        },
        {
          name: 'menuScene',
          type: 'string',
          ui: { label: 'Menu Scene', group: 'Flow' },
          getValue: (c: unknown) => (c as GameFlow).config.menuScene,
          setValue: (c: unknown, v: unknown) => {
            (c as GameFlow).config.menuScene = String(v);
          },
        },
        {
          name: 'mapScene',
          type: 'string',
          ui: { label: 'Map Scene', group: 'Flow' },
          getValue: (c: unknown) => (c as GameFlow).config.mapScene,
          setValue: (c: unknown, v: unknown) => {
            (c as GameFlow).config.mapScene = String(v);
          },
        },
      ],
      groups: { Flow: { label: 'Game Flow', expanded: true } },
    };
  }

  onStart(): void {
    this.mode = globalThis.__SD_MODE === 'survival' ? 'survival' : 'campaign';
    // Survival grants a fixed pool of lives (surv_zh); campaign has none.
    this.lives = this.mode === 'survival' ? SURVIVAL_LIVES : 0;
    // Direct editor play (no menu hand-off): every run starts a fresh wallet.
    if (!globalThis.__SD_MODE) {
      session.resetRun(this.mode);
    }
    this.centerLabel = this.findNode('center-label') as RuntimeLabel2D | null;
    this.waveLabel = this.findNode('wave-label') as RuntimeLabel2D | null;
    this.goldLabel = this.findNode('gold-label') as RuntimeLabel2D | null;
    this.resultTitle = this.findNode('result-title') as RuntimeLabel2D | null;
    this.resultStats = this.findNode('result-stats') as RuntimeLabel2D | null;
    this.hpBar = this.findNode('hp-bar') as Bar2D | null;
    this.shopOverlay = this.findNode('shop-overlay');
    this.resultOverlay = this.findNode('result-overlay');
    this.spawner =
      this.node?.components.find((c): c is WaveSpawner => c instanceof WaveSpawner) ?? null;

    // Economy + castle damage arrive as signals from enemies (see EnemyBalloon).
    this.node?.connect('unit-killed', this, (score: unknown) => {
      const value = Number(score) || 0;
      session.addGold(value);
      // Survival doubles the score (original rule).
      this.score += value * (this.mode === 'survival' ? 2 : 1);
      this.kills += 1;
      this.updateGoldLabel();
    });
    this.node?.connect('castle-damaged', this, (amount: unknown) => {
      this.onCastleDamaged(Number(amount) || 0);
    });
    // Shop purchases that touch the battle state (see ShopController).
    this.node?.connect('purchase', this, (itemId: unknown) => {
      this.onPurchase(String(itemId));
    });

    // Quest signals (QuestNpc / QuestCargo emit on game-root). The handlers only
    // mutate the tracker while a quest level is active (this.quest set).
    this.node?.connect('quest-cargo-dropped', this, () => {
      if (this.quest) this.quest.airborne += 1;
    });
    this.node?.connect('quest-cargo-saved', this, () => {
      if (this.quest) {
        this.quest.cargoSaved += 1;
        this.quest.airborne = Math.max(0, this.quest.airborne - 1);
      }
    });
    this.node?.connect('quest-cargo-lost', this, () => {
      if (this.quest) {
        this.quest.cargoLost += 1;
        this.quest.airborne = Math.max(0, this.quest.airborne - 1);
      }
    });
    this.node?.connect('quest-npc-spawned', this, () => {
      if (this.quest) this.quest.npcSpawned += 1;
    });
    this.node?.connect('quest-npc-safe', this, () => {
      if (this.quest) this.quest.npcSafe += 1;
    });
    this.node?.connect('quest-npc-lost', this, () => {
      if (this.quest) this.quest.npcLost += 1;
    });

    const fight = this.findNode('shop-fight-button');
    fight?.connect('click', this, () => this.onFightPressed());
    const toMenu = this.findNode('result-menu-button');
    toMenu?.connect('click', this, () => {
      void this.onMenuPressed();
    });

    // Campaign starts at the mission picked on the map (`__SD_MISSION`), else the
    // level scene's own `startMission` (scene-per-level), else the run frontier.
    if (this.mode === 'campaign') {
      const target = Math.floor(
        Number(globalThis.__SD_MISSION) || Number(this.config.startMission) || session.mission
      );
      this.wave = Math.min(Math.max(1, target), this.spawner?.waveCount ?? 1);
    }

    this.castleHp = this.castleMaxHp;
    this.hpBar?.setValue(1);
    if (this.shopOverlay) this.shopOverlay.visible = false;
    if (this.resultOverlay) this.resultOverlay.visible = false;
    this.updateGoldLabel();

    // Scene-per-level campaign: one mission per scene. Each mission OPENS with the
    // shop (spend the gold + keep the upgrades carried over in `session`), then
    // FIGHT starts this mission's battle. Survival has no start-of-mission shop —
    // it runs endless waves straight from the countdown.
    this.enterState(this.mode === 'campaign' ? 'shop' : 'countdown');

    // Expose the round to the engine debug bridge (`__PIX3_DEBUG__.game`) so the
    // agent harness can verify flow/economy from state instead of screenshots.
    this.disposeDebug = registerGameDebug({
      name: 'skydefender',
      version: 2,
      snapshot: () => this.debugSnapshot(),
      inspect: (query, args) => this.debugInspect(query, args),
      action: (name, args) => this.debugAction(name, args),
    });
  }

  /** Dev-only reproduction hooks for the debug bridge / agent harness. */
  private debugAction(name: string, args?: unknown): unknown {
    switch (name) {
      case 'clearWave':
        // Force the active wave to finish so the flow advances (survival:
        // intermission → next wave; campaign: shop or result).
        this.spawner?.forceClear();
        return { ok: true, state: this.state };
      case 'damageCastle': {
        // Back-compat: fractional args (≤1) scale against max HP.
        const raw = Number(args) || 0.25;
        this.onCastleDamaged(raw <= 1 ? raw * this.castleMaxHp : raw);
        return { ok: true, castleHp: this.castleHp };
      }
      case 'fight':
        // Leave the shop for the next mission (same as the FIGHT button).
        this.onFightPressed();
        return { ok: this.state === 'countdown', state: this.state, wave: this.wave };
      case 'grantGold': {
        const amount = Number(args) || 1000;
        session.addGold(amount);
        this.updateGoldLabel();
        return { ok: true, gold: session.gold };
      }
      case 'buy': {
        // Emulates a shop click, honoring prerequisites and price.
        const item = SHOP_ITEMS.find(i => i.id === String(args));
        if (!item) return { ok: false, error: `unknown item: ${String(args)}` };
        if (session.isOwned(item.id) && !item.repeatable) {
          return { ok: false, error: 'already owned' };
        }
        if (item.requires && !session.isOwned(item.requires)) {
          return { ok: false, error: `requires ${item.requires}` };
        }
        if (!session.spendGold(item.price)) return { ok: false, error: 'not enough gold' };
        if (!item.repeatable) session.own(item.id);
        this.node?.emit('purchase', item.id);
        return { ok: true, gold: session.gold, owned: session.debugState().owned };
      }
      case 'damageBoss': {
        // Dev: apply damage to the live boss via its real `damaged` path (so the
        // uyaz window still gates it) — used to drive the death/victory sequence.
        const amount = Number(args) || 1000;
        const enemies = this.findNode('enemies') as NodeBase | null;
        let hit = 0;
        for (const child of enemies?.children ?? []) {
          const isBoss = (child as NodeBase).components.some(
            c => (c as { type?: string }).type === 'user:BossEnemy'
          );
          if (!isBoss) continue;
          const body = ((child as NodeBase).getChildByName('Boss Body') as NodeBase | undefined) ?? (child as NodeBase);
          body.emit('damaged', amount);
          hit += 1;
        }
        return { ok: hit > 0, bossesHit: hit, amount };
      }
      default:
        return { ok: false, error: `unknown action: ${name}` };
    }
  }

  /**
   * Dev-only live read queries for the debug bridge (`__PIX3_DEBUG__.game.inspect`).
   * `entities` walks the `enemies` + `effects` containers and reports each live
   * node's REAL world position (getWorldPosition — unlike the editor `liveScene`
   * snapshot, which reports 0,0 in play) plus the config of its behaviour/shell
   * component and its child node names. This is how the harness verifies unit
   * behaviour (arc vs torpedo shells, park-and-shoot firing, compound no-ram)
   * from state instead of guessing off screenshots.
   */
  private debugInspect(query: string, args?: unknown): unknown {
    switch (query) {
      case 'entities': {
        const which = String((args as { group?: string } | undefined)?.group ?? 'all');
        const out: Record<string, unknown> = {};
        if (which === 'all' || which === 'enemies') out.enemies = this.inspectContainer('enemies');
        if (which === 'all' || which === 'effects') out.effects = this.inspectContainer('effects');
        return out;
      }
      case 'boss': {
        // Live boss readout (hp/uyaz/state) — BossEnemy exposes `debugState`.
        const enemies = this.findNode('enemies') as NodeBase | null;
        const bosses: unknown[] = [];
        for (const child of enemies?.children ?? []) {
          const comp = (child as NodeBase).components.find(
            c => (c as { type?: string }).type === 'user:BossEnemy'
          ) as { debugState?: Record<string, unknown> } | undefined;
          if (comp?.debugState) bosses.push(comp.debugState);
        }
        return { bosses };
      }
      case 'quest':
        return this.questDebug();
      default:
        return { ok: false, error: `unknown query: ${query}` };
    }
  }

  /** JSON-safe live view of the quest tracker for the debug bridge. */
  private questDebug(): Record<string, unknown> {
    const q = this.quest;
    if (!q) return { active: false };
    return {
      active: true,
      level: q.level,
      questId: q.def.questId,
      objective: q.def.objective,
      successRule: q.def.successRule,
      threshold: this.questThreshold(q.def.successRule),
      reward: q.def.reward,
      succeeded: q.succeeded,
      container: q.def.container ?? null,
      counters: {
        cargoSaved: q.cargoSaved,
        cargoLost: q.cargoLost,
        // Level-specific aliases so the harness reads the numbers the objective names.
        sheepSaved: q.def.successRule === 'sheep' ? q.cargoSaved : undefined,
        conesCollected: q.def.successRule === 'cones' ? q.cargoSaved : undefined,
        goldTaken: q.def.successRule === 'gold' ? q.cargoLost : undefined,
        turretsRepaired: q.turretsRepaired,
        npcSpawned: q.npcSpawned,
        npcSafe: q.npcSafe,
        npcLost: q.npcLost,
        npcAlive: Math.max(0, q.npcSpawned - q.npcSafe - q.npcLost),
      },
    };
  }

  /** Config fields worth reporting per behaviour/projectile component type. */
  private static readonly INSPECT_FIELDS: Record<string, string[]> = {
    'user:EnemyShell': ['mode', 'vx', 'vy', 'gravity', 'damage'],
    'user:EnemyBalloon': ['stopX', 'attackDamage', 'attackPeriod', 'gunType', 'castleDamage', 'bomber'],
    'user:CompoundBalloon': ['stopX', 'attackDamage', 'weaponClass', 'castleDamage'],
    'user:GroundVehicle': ['tip', 'stopX', 'attackDamage'],
    'user:QuestNpc': ['role', 'payloadType', 'questId', 'npcName', 'stopX'],
    'user:QuestCargo': ['payloadType', 'questId', 'containerX', 'containerY'],
  };

  private inspectContainer(name: string): Array<Record<string, unknown>> {
    const container = this.findNode(name) as NodeBase | null;
    if (!container) return [];
    return container.children.map(child => this.describeEntity(child as NodeBase));
  }

  private describeEntity(node: NodeBase): Record<string, unknown> {
    const wp = node.getWorldPosition(GameFlow.inspectScratch);
    const comps: Record<string, Record<string, unknown>> = {};
    for (const c of node.components) {
      const type = (c as { type?: string }).type ?? '';
      const fields = GameFlow.INSPECT_FIELDS[type];
      if (!fields) continue;
      const cfg = (c as { config?: Record<string, unknown> }).config ?? {};
      const picked: Record<string, unknown> = {};
      for (const f of fields) picked[f] = cfg[f];
      comps[type] = picked;
    }
    return {
      name: node.name,
      visible: node.visible,
      pos: [Math.round(wp.x), Math.round(wp.y)],
      comps,
      kids: node.children.map(k => (k as NodeBase).name),
    };
  }

  private static readonly inspectScratch = new Vector3();

  onDetach(): void {
    this.disposeDebug?.();
    this.disposeDebug = null;
    this.clearQuestContainer();
  }

  /** JSON-serialisable overview of the current round for dev tooling. */
  private debugSnapshot(): Record<string, unknown> {
    const comps = this.findNode('maingun')?.components ?? [];
    const gun = comps.find(
      c => (c as { type?: string }).type === 'user:GunController'
    ) as unknown as GunView | undefined;
    return {
      mode: this.mode,
      state: this.state,
      wave: this.wave,
      lives: this.lives,
      gold: Math.floor(session.gold),
      session: session.debugState(),
      score: this.score,
      kills: this.kills,
      battleTime: Math.round(this.battleTime * 10) / 10,
      castleHp: Math.round(this.castleHp),
      castleMaxHp: this.castleMaxHp,
      spawner: this.spawner?.debugState ?? null,
      quest: this.quest
        ? { questId: this.quest.def.questId, rule: this.quest.def.successRule, succeeded: this.quest.succeeded }
        : null,
      gun: gun
        ? { weapon: gun.currentWeapon.key, index: gun.currentIndex, ammo: gun.getAmmo(gun.currentIndex) }
        : null,
    };
  }

  onUpdate(dt: number): void {
    this.stateTime += dt;
    if (this.state === 'wave') {
      this.battleTime += dt;
      this.updateAirSupport(dt);
      this.updateQuest(dt);
    }

    switch (this.state) {
      case 'countdown': {
        const total = Number(this.config.countdownSeconds);
        const remaining = Math.ceil(total - this.stateTime);
        if (remaining > 0) {
          this.setLabel(this.centerLabel, String(remaining));
        } else {
          this.setLabelKey(this.centerLabel, 'game.fight');
        }
        if (this.stateTime >= total + 0.7) {
          this.enterState('wave');
        }
        break;
      }
      case 'wave': {
        // Hold wave-clear until any in-flight cargo has landed, so the quest is
        // evaluated on the final counts (not while a bar/sheep is still falling).
        if (this.spawner?.isWaveClear() && (this.quest?.airborne ?? 0) <= 0) {
          this.spawner.stopWave();
          this.evaluateQuest();
          if (this.mode === 'survival') {
            this.enterState('intermission');
          } else {
            // Scene-per-level: a cleared wave ENDS the mission → mission result →
            // back to the map (which shows the next mission's briefing). Unlock the
            // next mission so the map opens it; upgrades persist via `session`.
            this.victory = true;
            session.unlockMission(this.wave + 1);
            this.enterState('result');
          }
        }
        break;
      }
      case 'intermission': {
        // Short breather between survival waves; fade the banner out.
        if (this.stateTime >= 4) {
          this.wave += 1;
          this.enterState('countdown');
        }
        break;
      }
      case 'wave-failed': {
        // Lost a life: after the banner, replay the SAME wave (no wave++).
        if (this.stateTime >= WAVE_FAILED_SECONDS) {
          this.enterState('countdown');
        }
        break;
      }
      case 'shop':
      case 'result':
        break;
    }
  }

  // ── shop effects ────────────────────────────────────────────────────────────

  private onPurchase(itemId: string): void {
    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) return;
    switch (item.effect) {
      case 'repair':
        this.castleHp = Math.min(this.castleMaxHp, this.castleHp + REPAIR_AMOUNT);
        break;
      case 'floor':
      case 'flag':
        // A new floor (or the flag) raises max HP; the fresh masonry arrives whole.
        this.castleHp = Math.min(this.castleMaxHp, this.castleHp + this.addedHpFor(item.id));
        break;
      default:
        break;
    }
    this.hpBar?.setValue(this.castleHpFraction);
    this.updateGoldLabel();
  }

  /** HP the just-bought floor/flag added (session already owns the item). */
  private addedHpFor(_itemId: string): number {
    // Recompute delta against the roster without this purchase is fiddly;
    // in practice floors add 300 and the flag adds 100 (see CASTLE_FLOOR_HP).
    return _itemId === 'flag' ? 100 : 300;
  }

  /**
   * Air Support (shop device): while the castle is below half HP, the Royal
   * Air Cavalry strikes the closest attackers every 30 seconds.
   */
  private updateAirSupport(dt: number): void {
    if (!session.isOwned('air-support') || this.castleHp >= this.castleMaxHp * 0.5) return;
    this.airSupportTimer += dt;
    if (this.airSupportTimer < AIR_SUPPORT_PERIOD) return;
    this.airSupportTimer = 0;

    const scene = this.scene;
    const stage = this.findNode('stage');
    if (!scene || !stage) return;
    const stagePos = stage.getWorldPosition(GameFlow.scratch);
    const stageScale = stage.getWorldScale(GameFlow.scratch2);
    const sx = Math.abs(stageScale.x) || 1;
    // Sweep the whole playfield (stage-local x −330..480, y −250..250).
    const hits = scene.collision2d.overlapRect(
      stagePos.x + 75 * sx,
      stagePos.y,
      810 * sx,
      500 * sx,
      'enemy'
    );
    if (hits.length === 0) return;

    scene.audio.play(SFX.strike, { bus: 'sfx' });
    // Closest to the castle (leftmost) get hit first.
    const targets = hits
      .slice()
      .sort((h1, h2) => h1.node.getWorldPosition(GameFlow.scratch).x - h2.node.getWorldPosition(GameFlow.scratch2).x)
      .slice(0, AIR_SUPPORT_TARGETS);
    for (const hit of targets) {
      const pos = hit.node.position;
      void scene
        .instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
        .then(fx => fx.position.set(pos.x, pos.y + 20, 0))
        .catch(() => undefined);
      hit.node.emit('damaged', AIR_SUPPORT_DAMAGE);
    }
  }

  // ── quest levels ──────────────────────────────────────────────────────────

  /**
   * Arm the quest tracker for a campaign level (no-op / clears it otherwise).
   * Shows the verbatim objective on the center banner and spawns the placeholder
   * container (boat/cup/truck) for cargo levels. Called at wave start.
   */
  private initQuest(level: number): void {
    this.clearQuestContainer();
    const def = this.mode === 'campaign' ? QUEST_LEVELS[level] : undefined;
    if (!def) {
      this.quest = null;
      return;
    }
    this.quest = {
      def,
      level,
      cargoSaved: 0,
      cargoLost: 0,
      npcSpawned: 0,
      npcSafe: 0,
      npcLost: 0,
      airborne: 0,
      turretsRepaired: 0,
      repairTimer: 0,
      succeeded: null,
    };
    // Surface the objective (reuses the center label; cleared after the banner).
    this.setLabel(this.centerLabel, def.objective);
    this.questBannerTime = QUEST_BANNER_SECONDS;
    // Cargo levels: if the level scene AUTHORED a `quest-container` node (scene-
    // per-level places the boat/cup/truck visually), it IS the container — leave
    // it be. Only spawn the placeholder when no authored node exists and the
    // level defines a rect (back-compat with main.pix3scene).
    if (def.container && !this.findNode('quest-container')) this.spawnQuestContainer(def);
    this.node?.emit('quest-started', { questId: def.questId, objective: def.objective });
  }

  private spawnQuestContainer(def: QuestLevelDef): void {
    const rect = def.container;
    if (!rect) return;
    void this.scene
      ?.instantiate(QUEST_CONTAINER_PREFAB, { parent: 'effects' })
      .then(node => {
        this.questContainer = node;
        node.position.set(rect.x, rect.y, 0);
        // The prefab marker is 100×100; scale it to the level's landing rect.
        node.scale.set(rect.w / 100, rect.h / 100, 1);
      })
      .catch(err => console.warn('[GameFlow] quest container spawn failed', err));
  }

  private clearQuestContainer(): void {
    this.questContainer?.queueFree();
    this.questContainer = null;
  }

  /** Per-frame quest upkeep during a wave: banner timeout + the L19 repair tick. */
  private updateQuest(dt: number): void {
    const q = this.quest;
    if (!q) return;

    if (this.questBannerTime > 0) {
      this.questBannerTime -= dt;
      if (this.questBannerTime <= 0) this.setLabel(this.centerLabel, '');
    }

    // Repair (L19): while at least one engineer is alive on the field, a turret
    // is repaired every REPAIR_SECONDS (simplified — see the spec; the worker's
    // rz.png repair animation is a follow-up). Stops if every engineer is killed.
    if (q.def.successRule === 'repair' && q.turretsRepaired < REPAIR_MAX_TURRETS) {
      const engineerAlive = q.npcSpawned > 0 && q.npcLost < q.npcSpawned;
      if (engineerAlive) {
        q.repairTimer += dt;
        if (q.repairTimer >= REPAIR_SECONDS) {
          q.repairTimer -= REPAIR_SECONDS;
          q.turretsRepaired += 1;
          this.scene?.audio.play(SFX.panel, { bus: 'sfx', pitchVariation: 0.15 });
        }
      }
    }
  }

  /** Evaluate the quest at wave-clear: set succeeded, grant reward, surface it. */
  private evaluateQuest(): void {
    const q = this.quest;
    if (!q || q.succeeded !== null) return;
    let ok = false;
    switch (q.def.successRule) {
      case 'protect':
        ok = q.npcSpawned > 0 && q.npcLost === 0;
        break;
      case 'sheep':
        ok = q.cargoSaved >= 5;
        break;
      case 'gold':
        ok = q.cargoLost <= 3;
        break;
      case 'cones':
        ok = q.cargoSaved >= 10;
        break;
      case 'repair':
        ok = q.turretsRepaired >= 2;
        break;
      case 'combat':
        ok = true;
        break;
    }
    q.succeeded = ok;

    if (ok && q.def.reward > 0) {
      session.addGold(q.def.reward);
      this.updateGoldLabel();
    }
    this.scene?.audio.play(ok ? REWARD_SOUND : SFX.warning, { bus: 'sfx' });
    this.setLabel(this.centerLabel, ok ? 'QUEST COMPLETE' : 'QUEST FAILED');
    this.node?.emit('quest-result', {
      questId: q.def.questId,
      succeeded: ok,
      reward: ok ? q.def.reward : 0,
    });
    console.info(
      `[GameFlow] quest ${q.def.questId} ${ok ? 'COMPLETE' : 'FAILED'} (rule ${q.def.successRule})`
    );
    this.clearQuestContainer();
  }

  /** Human-readable success threshold for the debug bridge. */
  private questThreshold(rule: QuestLevelDef['successRule']): string {
    switch (rule) {
      case 'protect':
        return 'no guarded NPC killed';
      case 'sheep':
        return '≥5 sheep saved';
      case 'gold':
        return '≤3 gold bars taken';
      case 'cones':
        return '≥10 cones collected';
      case 'repair':
        return '≥2 turrets repaired';
      case 'combat':
        return 'clear the wave';
    }
  }

  // ── castle damage ───────────────────────────────────────────────────────────

  private onCastleDamaged(amount: number): void {
    // A destroyed castle in survival takes us to 'wave-failed', where more
    // damage must not re-trigger the loss (nor while the result is up).
    if (this.state === 'result' || this.state === 'wave-failed') return;
    // Umbrella (shop device): an invisible shield under 75% HP.
    if (session.isOwned('umbrella') && this.castleHp < this.castleMaxHp * 0.75) {
      amount *= UMBRELLA_FACTOR;
    }
    this.castleHp = Math.max(0, this.castleHp - amount);
    this.hpBar?.setValue(this.castleHpFraction);
    if (this.castleHpFraction <= 0.35 && this.castleHp > 0) {
      this.scene?.audio.play(SFX.warning, { bus: 'sfx' });
    }
    if (this.castleHp <= 0) {
      // Survival (surv_zh): spend a life and replay the wave; only when the
      // pool is empty does the castle falling end the run.
      if (this.mode === 'survival' && this.lives > 0) {
        this.lives -= 1;
        this.restoreCheckpoint();
        this.spawner?.stopWave();
        this.spawner?.despawnAll();
        this.enterState('wave-failed');
        return;
      }
      this.victory = false;
      this.spawner?.stopWave();
      this.enterState('result');
    }
  }

  /** Roll the round back to the current wave's checkpoint (survival retry). */
  private restoreCheckpoint(): void {
    this.castleHp = this.checkpointHp;
    this.score = this.checkpointScore;
    this.kills = this.checkpointKills;
    session.setGold(this.checkpointGold);
    this.hpBar?.setValue(this.castleHpFraction);
    this.updateGoldLabel();
  }

  private onFightPressed(): void {
    if (this.state !== 'shop') return;
    this.scene?.audio.play(SFX.click, { bus: 'sfx' });
    // Start-of-mission shop → begin THIS mission's battle. The wave is already set
    // from `startMission` in onStart (scene-per-level), so no advance here.
    this.enterState('countdown');
  }

  private async onMenuPressed(): Promise<void> {
    if (this.state !== 'result' || !this.scene) return;
    this.scene.audio.play(SFX.click, { bus: 'sfx' });
    // Campaign returns to the map (retry / next region); survival to the menu.
    const target =
      this.mode === 'campaign'
        ? this.config.mapScene || 'res://src/assets/scenes/map.pix3scene'
        : this.config.menuScene || 'res://src/assets/scenes/menu.pix3scene';
    await this.scene.changeScene(String(target), { transition: 'fade' });
  }

  private enterState(next: FlowState): void {
    const wasShop = this.state === 'shop';
    const wasWave = this.state === 'wave';
    this.state = next;
    this.stateTime = 0;

    // Leaving a wave (including a defeat that skips evaluateQuest): tidy the
    // placeholder cargo container so it doesn't linger over the shop/result.
    if (wasWave && next !== 'wave') this.clearQuestContainer();

    if (this.shopOverlay) this.shopOverlay.visible = next === 'shop';
    if (this.resultOverlay) this.resultOverlay.visible = next === 'result';
    // ShopController gates its buttons on these (invisible controls still hit-test).
    if (next === 'shop') {
      this.node?.emit('shop-opened');
    } else if (wasShop) {
      this.node?.emit('shop-closed');
    }

    switch (next) {
      case 'countdown':
        this.setLabel(this.centerLabel, '');
        if (this.mode === 'survival') {
          this.setLabelKey(this.waveLabel, 'game.wave', { n: this.wave });
        } else {
          this.setLabelKey(this.waveLabel, 'game.mission-wave', {
            name: this.tr(missionNameKey(this.wave)),
            wave: this.wave,
            total: this.spawner?.waveCount ?? 1,
          });
        }
        break;
      case 'wave':
        this.setLabel(this.centerLabel, '');
        this.airSupportTimer = 0;
        if (this.mode === 'survival') {
          // Checkpoint the wave-start state so a lost life can replay this wave
          // from exactly here (HP/score/kills/gold roll back on failure). On a
          // retry these were just restored, so re-snapshotting is idempotent.
          this.checkpointHp = this.castleHp;
          this.checkpointScore = this.score;
          this.checkpointKills = this.kills;
          this.checkpointGold = session.gold;
          this.spawner?.startSurvivalWave(this.wave);
        } else {
          this.spawner?.startWave(this.wave);
        }
        // The bridge crew hears this and hauls segments in — in BOTH modes:
        // the original sets c_enTP = 4 (four transporters) for survival too,
        // so they fly in and build the bridge at the start of the run. The
        // BridgeController is idempotent, so once built it stays for the run.
        this.node?.emit('mission-started', this.wave);
        // Arm the quest tracker (campaign quest levels only) + show the objective
        // banner + spawn the cargo container; no-op on ordinary/survival waves.
        this.initQuest(this.wave);
        break;
      case 'intermission':
        this.setLabelKey(this.centerLabel, 'game.wave-cleared', { n: this.wave });
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
        break;
      case 'wave-failed':
        // Plural-aware ('… — 1 LIFE LEFT' vs '… — N LIVES LEFT'); transient banner,
        // so resolving once via trPlural (no live key binding) is fine.
        this.setLabel(
          this.centerLabel,
          this.scene?.localization.trPlural('game.wave-failed', this.lives) ?? ''
        );
        this.scene?.audio.play(SFX.warning, { bus: 'sfx' });
        break;
      case 'shop':
        this.setLabel(this.centerLabel, '');
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
        break;
      case 'result': {
        this.setLabel(this.centerLabel, '');
        // Joe (and anyone else who cares) hears about the outcome.
        this.node?.emit('game-over', this.victory);
        const total = Math.floor(this.battleTime);
        const time = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
        if (this.mode === 'survival') {
          this.setLabelKey(this.resultTitle, 'game.game-over');
          this.setLabelKey(this.resultStats, 'game.result.survival', {
            score: this.score,
            kills: this.kills,
            time,
            waves: this.wave,
          });
        } else {
          this.setLabelKey(this.resultTitle, this.victory ? 'game.victory' : 'game.defeat');
          if (this.victory) {
            this.setLabelKey(this.resultStats, 'game.result.victory', {
              gold: Math.floor(session.gold),
            });
          } else {
            this.setLabelKey(this.resultStats, 'game.result.defeat');
          }
        }
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
        break;
      }
    }
  }

  private updateGoldLabel(): void {
    this.setLabelKey(this.goldLabel, 'hud.gold', { amount: Math.floor(session.gold) });
  }

  /** Set a literal (clears any bound translation key — see Label2D.setText). */
  private setLabel(label: RuntimeLabel2D | null, text: string): void {
    label?.setText(text);
  }

  /** Bind a label to a translation key — re-resolves live on locale switch. */
  private setLabelKey(label: RuntimeLabel2D | null, key: string, params?: TrParams): void {
    label?.setTextKey(key, params);
  }

  /** Translate a key through the scene's localization (echoes the key when inert). */
  private tr(key: string): string {
    return this.scene?.localization.tr(key) ?? key;
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
}
