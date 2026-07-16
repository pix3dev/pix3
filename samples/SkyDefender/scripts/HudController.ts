import { Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import { GunController } from './GunController';
import { GameFlow } from './GameFlow';
import { Odometer } from './Odometer';

/** UIControl2D hides its canvas-text refresh behind a protected method. */
type RuntimeLabel2D = Label2D & { updateLabel(): void };

/**
 * HudController — drives the original-layout battle HUD:
 * - the round weapon buttons on the portrait cluster (click → select, the
 *   active one pops), mirroring keys 1-4;
 * - the mechanical odometers on the bottom panel (Clip / Ammo / Score / Time /
 *   Kills) managed at a higher level via attached Odometer components;
 * - the castle HP bar in the top frame (fill + `213/250` readout).
 */
export class HudController extends Script {
  private gun: GunController | null = null;
  private flow: GameFlow | null = null;
  private buttons: (NodeBase | null)[] = [];
  private odometers = new Map<string, Odometer>();
  private hpFill: Bar2D | null = null;
  private hpLabel: RuntimeLabel2D | null = null;
  private lastHpText = '';

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      gunNode: 'maingun',
      buttonPrefix: 'weapon-btn-',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'HudController',
      properties: [
        {
          name: 'gunNode',
          type: 'string',
          ui: { label: 'Gun Node', group: 'HUD' },
          getValue: (c: unknown) => (c as HudController).config.gunNode,
          setValue: (c: unknown, v: unknown) => {
            (c as HudController).config.gunNode = String(v);
          },
        },
      ],
      groups: { HUD: { label: 'Battle HUD', expanded: true } },
    };
  }

  onStart(): void {
    const gunNode = this.findNode(String(this.config.gunNode));
    this.gun =
      gunNode?.components.find((c): c is GunController => c instanceof GunController) ?? null;
    const gameRoot = this.findNode('game-root');
    this.flow = gameRoot?.components.find((c): c is GameFlow => c instanceof GameFlow) ?? null;

    const prefix = String(this.config.buttonPrefix);
    this.buttons = [1, 2, 3, 4].map(i => this.findNode(`${prefix}${i}`));
    this.buttons.forEach((button, index) => {
      button?.connect('click', this, () => this.gun?.selectWeapon(index));
    });

    for (const key of ['clip', 'ammo', 'score', 'time', 'kills']) {
      const group = this.findNode(`odo-${key}`);
      const odo = group?.getComponent(Odometer);
      if (odo) {
        this.odometers.set(key, odo);
      }
    }

    this.hpFill = this.findNode('hp-fill') as Bar2D | null;
    this.hpLabel = this.findNode('hp-label') as RuntimeLabel2D | null;
  }

  onUpdate(dt: number): void {
    this.updateButtons();
    this.updateOdometers();
    this.updateHp();
  }

  // ── weapon buttons ──────────────────────────────────────────────────────

  private updateButtons(): void {
    const gun = this.gun;
    if (!gun) return;
    this.buttons.forEach((button, index) => {
      if (!button) return;
      // Weapons the shop hasn't sold yet sit dark in the wheel (M4).
      if (!gun.isUnlocked(index)) {
        button.scale.set(1, 1, 1);
        (button as NodeBase & { opacity?: number }).opacity = 0.18;
        return;
      }
      const ammo = gun.getAmmo(index);
      const empty = ammo.mag <= 0 && ammo.reserve === 0;
      const selected = index === gun.currentIndex;
      const scale = selected ? 1.2 : 1;
      button.scale.set(scale, scale, 1);
      (button as NodeBase & { opacity?: number }).opacity = empty ? 0.35 : selected ? 1 : 0.72;
    });
  }

  // ── odometers ───────────────────────────────────────────────────────────

  private updateOdometers(): void {
    const gun = this.gun;
    const flow = this.flow;
    if (gun) {
      const ammo = gun.getAmmo(gun.currentIndex);
      this.odometers.get('clip')?.setValue(Math.max(0, ammo.mag));
      // Infinite reserve reads as a full drum (the M4 shop will sell refills).
      this.odometers.get('ammo')?.setValue(ammo.reserve < 0 ? 9999 : ammo.reserve);
    }
    if (flow) {
      this.odometers.get('score')?.setValue(flow.scoreValue);
      this.odometers.get('kills')?.setValue(flow.killsValue);
      const total = Math.floor(flow.battleTimeValue);
      const mmss = Math.floor(total / 60) * 100 + (total % 60);
      this.odometers.get('time')?.setValue(mmss);
    }
  }

  // ── castle HP ───────────────────────────────────────────────────────────

  private updateHp(): void {
    const flow = this.flow;
    if (!flow) return;
    this.hpFill?.setValue(flow.castleHpFraction);
    const text = `${Math.max(0, Math.round(flow.castleHpValue))}/${Math.round(flow.castleMaxHp)}`;
    if (text !== this.lastHpText && this.hpLabel) {
      this.lastHpText = text;
      this.hpLabel.label = text;
      this.hpLabel.updateLabel();
    }
  }
}
