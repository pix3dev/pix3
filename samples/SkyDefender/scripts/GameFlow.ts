import { registerGameDebug, Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import { WaveSpawner } from './WaveSpawner';

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

/** Menu → battle mode hand-off (until the M4 save/session service lands). */
declare global {
  // eslint-disable-next-line no-var
  var __SD_MODE: GameMode | undefined;
}

const SFX = {
  click: 'res://src/assets/audio/gui/unibat/unibat_press.mp3',
  panel: 'res://src/assets/audio/gui/ingame/ing_panel_move.mp3',
  warning: 'res://src/assets/audio/other/warning_scream.mp3',
};

/**
 * GameFlow — the battle round driver.
 * Campaign: countdown → wave → shop → wave … → result.
 * Survival (original mode): endless escalating waves with a short intermission
 * between them, score ×2, defeat ends the run.
 *
 * Economy and castle state flow in through signals on this node (`game-root`):
 * `unit-killed(score)` adds gold/score/kills, `castle-damaged(amount)` drains
 * the HP bar and triggers DEFEAT at zero.
 */
export class GameFlow extends Script {
  private state: FlowState = 'countdown';
  private mode: GameMode = 'campaign';
  private stateTime = 0;
  private wave = 1;
  private gold = 0;
  private score = 0;
  private kills = 0;
  private battleTime = 0;
  private castleHp = 1;
  private victory = true;

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
  get castleHpFraction(): number {
    return this.castleHp;
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
      ],
      groups: { Flow: { label: 'Game Flow', expanded: true } },
    };
  }

  onStart(): void {
    this.mode = globalThis.__SD_MODE === 'survival' ? 'survival' : 'campaign';
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
      this.gold += value;
      // Survival doubles the score (original rule).
      this.score += value * (this.mode === 'survival' ? 2 : 1);
      this.kills += 1;
      this.setLabel(this.goldLabel, `Gold: ${Math.floor(this.gold)}`);
    });
    this.node?.connect('castle-damaged', this, (amount: unknown) => {
      this.onCastleDamaged(Number(amount) || 0);
    });

    const fight = this.findNode('shop-fight-button');
    fight?.connect('click', this, () => this.onFightPressed());
    const toMenu = this.findNode('result-menu-button');
    toMenu?.connect('click', this, () => {
      void this.onMenuPressed();
    });

    this.castleHp = 1;
    this.hpBar?.setValue(1);
    if (this.shopOverlay) this.shopOverlay.visible = false;
    if (this.resultOverlay) this.resultOverlay.visible = false;

    this.enterState('countdown');

    // Expose the round to the engine debug bridge (`__PIX3_DEBUG__.game`) so the
    // agent harness can verify flow/economy from state instead of screenshots.
    this.disposeDebug = registerGameDebug({
      name: 'skydefender',
      version: 1,
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
      case 'damageCastle':
        this.onCastleDamaged(Number(args) || 0.25);
        return { ok: true, castleHp: this.castleHp };
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
      gold: Math.floor(this.gold),
      score: this.score,
      kills: this.kills,
      battleTime: Math.round(this.battleTime * 10) / 10,
      castleHp: Math.round(this.castleHp * 100) / 100,
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
            this.enterState('result');
          } else {
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

  private onCastleDamaged(amount: number): void {
    if (this.state === 'result') return;
    this.castleHp = Math.max(0, this.castleHp - amount);
    this.hpBar?.setValue(this.castleHp);
    if (this.castleHp <= 0.35 && this.castleHp > 0) {
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
    this.wave += 1;
    this.enterState('countdown');
  }

  private async onMenuPressed(): Promise<void> {
    if (this.state !== 'result' || !this.scene) return;
    this.scene.audio.play(SFX.click, { bus: 'sfx' });
    await this.scene.changeScene(String(this.config.menuScene), { transition: 'fade' });
  }

  private enterState(next: FlowState): void {
    this.state = next;
    this.stateTime = 0;

    if (this.shopOverlay) this.shopOverlay.visible = next === 'shop';
    if (this.resultOverlay) this.resultOverlay.visible = next === 'result';

    switch (next) {
      case 'countdown':
        this.setLabel(this.centerLabel, '');
        this.setLabel(
          this.waveLabel,
          this.mode === 'survival'
            ? `Wave ${this.wave}`
            : `Wave ${this.wave}/${this.spawner?.waveCount ?? 1}`
        );
        break;
      case 'wave':
        this.setLabel(this.centerLabel, '');
        if (this.mode === 'survival') {
          this.spawner?.startSurvivalWave(this.wave);
        } else {
          this.spawner?.startWave(this.wave);
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
              ? `The province is safe… for now. Gold earned: ${Math.floor(this.gold)}`
              : 'The castle has fallen. Joe will remember this.'
          );
        }
        this.scene?.audio.play(SFX.panel, { bus: 'sfx' });
        break;
      }
    }
  }

  private setLabel(label: RuntimeLabel2D | null, text: string): void {
    if (!label || label.label === text) return;
    label.label = text;
    label.updateLabel();
  }
}
