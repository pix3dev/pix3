import { registerGameDebug, Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import { Vector3 } from 'three';
import { WaveSpawner } from './WaveSpawner';
import {
  AIR_SUPPORT_DAMAGE,
  AIR_SUPPORT_PERIOD,
  AIR_SUPPORT_TARGETS,
  MISSIONS,
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

type FlowState = 'countdown' | 'wave' | 'intermission' | 'shop' | 'result';

type GameMode = 'campaign' | 'survival';

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
        this.setLabel(this.centerLabel, remaining > 0 ? String(remaining) : 'FIGHT!');
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
    if (this.state === 'result') return;
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
      this.victory = false;
      this.spawner?.stopWave();
      this.enterState('result');
    }
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
        this.setLabel(
          this.waveLabel,
          this.mode === 'survival'
            ? `Wave ${this.wave}`
            : `${MISSIONS[this.wave - 1]?.name ?? 'Mission'} — ${this.wave}/${this.spawner?.waveCount ?? 1}`
        );
        break;
      case 'wave':
        this.setLabel(this.centerLabel, '');
        this.airSupportTimer = 0;
        if (this.mode === 'survival') {
          this.spawner?.startSurvivalWave(this.wave);
        } else {
          this.spawner?.startWave(this.wave);
          // The bridge crew hears this and starts hauling segments in
          // (campaign only; once built it stays for the rest of the run).
          this.node?.emit('mission-started', this.wave);
        }
        break;
      case 'intermission':
        this.setLabel(this.centerLabel, `WAVE ${this.wave} CLEARED`);
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
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
          this.setLabel(this.resultTitle, 'GAME OVER');
          this.setLabel(
            this.resultStats,
            `Score ${this.score} — Kills ${this.kills} — Time ${time} — Waves ${this.wave}`
          );
        } else {
          this.setLabel(this.resultTitle, this.victory ? 'VICTORY!' : 'DEFEAT');
          this.setLabel(
            this.resultStats,
            this.victory
              ? `The province is safe… for now. Gold earned: ${Math.floor(session.gold)}`
              : 'The castle has fallen. Joe will remember this.'
          );
        }
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
        break;
      }
    }
  }

  private updateGoldLabel(): void {
    this.setLabel(this.goldLabel, `Gold: ${Math.floor(session.gold)}`);
  }

  private setLabel(label: RuntimeLabel2D | null, text: string): void {
    if (!label || label.label === text) return;
    label.label = text;
    label.updateLabel();
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
}
