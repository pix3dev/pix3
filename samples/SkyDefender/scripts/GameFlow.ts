import { registerGameDebug, Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema, TrParams } from '@pix3/runtime';
import { Vector3 } from 'three';
import { WaveSpawner } from './WaveSpawner';
import {
  AIR_SUPPORT_DAMAGE,
  AIR_SUPPORT_PERIOD,
  AIR_SUPPORT_TARGETS,
  missionNameKey,
  REPAIR_AMOUNT,
  SHOP_ITEMS,
  UMBRELLA_FACTOR,
} from './SdBalance';
import { session } from './SdSession';

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

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      countdownSeconds: 3,
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

    const fight = this.findNode('shop-fight-button');
    fight?.connect('click', this, () => this.onFightPressed());
    const toMenu = this.findNode('result-menu-button');
    toMenu?.connect('click', this, () => {
      void this.onMenuPressed();
    });

    // Campaign starts at the mission picked on the map (fallback: run frontier).
    if (this.mode === 'campaign') {
      const target = Math.floor(Number(globalThis.__SD_MISSION) || session.mission);
      this.wave = Math.min(Math.max(1, target), this.spawner?.waveCount ?? 1);
    }

    this.castleHp = this.castleMaxHp;
    this.hpBar?.setValue(1);
    if (this.shopOverlay) this.shopOverlay.visible = false;
    if (this.resultOverlay) this.resultOverlay.visible = false;
    this.updateGoldLabel();

    this.enterState('countdown');

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
      default:
        return { ok: false, error: `unknown query: ${query}` };
    }
  }

  /** Config fields worth reporting per behaviour/projectile component type. */
  private static readonly INSPECT_FIELDS: Record<string, string[]> = {
    'user:EnemyShell': ['mode', 'vx', 'vy', 'gravity', 'damage'],
    'user:EnemyBalloon': ['stopX', 'attackDamage', 'attackPeriod', 'gunType', 'castleDamage', 'bomber'],
    'user:CompoundBalloon': ['stopX', 'attackDamage', 'weaponClass', 'castleDamage'],
    'user:GroundVehicle': ['tip', 'stopX', 'attackDamage'],
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
        if (this.spawner?.isWaveClear()) {
          this.spawner.stopWave();
          if (this.mode === 'survival') {
            this.enterState('intermission');
          } else if (this.wave >= (this.spawner?.waveCount ?? 1)) {
            this.victory = true;
            session.unlockMission(this.wave + 1); // the map shows the campaign as cleared
            this.enterState('result');
          } else {
            session.unlockMission(this.wave + 1);
            this.enterState('shop');
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
    this.wave += 1; // progress was already unlocked when the wave cleared
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
    this.state = next;
    this.stateTime = 0;

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
