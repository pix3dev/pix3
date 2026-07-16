import { Script } from '@pix3/runtime';
import type { Bar2D, Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import type { Mesh, MeshBasicMaterial, Texture } from 'three';
import { GunController } from './GunController';
import { GameFlow } from './GameFlow';

/** UIControl2D hides its canvas-text refresh behind a protected method. */
type RuntimeLabel2D = Label2D & { updateLabel(): void };

/** Digit strip: number_indicator.png is 0..9 stacked top-to-bottom, 10×140. */
const DIGIT_COUNT = 10;

interface OdometerWindow {
  /** Digit sprites left→right (most significant first). */
  digits: { node: NodeBase; material: MeshBasicMaterial | null }[];
  /** Currently shown value per digit (float — offsets lerp toward target). */
  shown: number[];
}

/**
 * HudController — drives the original-layout battle HUD:
 * - the round weapon buttons on the portrait cluster (click → select, the
 *   active one pops), mirroring keys 1-4;
 * - the mechanical odometers on the bottom panel (Clip / Ammo / Score / Time /
 *   Kills), rendered by sliding each digit's UV window along the
 *   number_indicator strip — no fonts, just like the Flash original;
 * - the castle HP bar in the top frame (fill + `213/250` readout).
 */
export class HudController extends Script {
  private gun: GunController | null = null;
  private flow: GameFlow | null = null;
  private buttons: (NodeBase | null)[] = [];
  private odometers = new Map<string, OdometerWindow>();
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
      if (!group) continue;
      const digits = group.children
        .filter((c): c is NodeBase => !!(c as NodeBase).nodeId)
        .map(node => ({ node, material: null as MeshBasicMaterial | null }));
      this.odometers.set(key, { digits, shown: digits.map(() => 0) });
    }

    this.hpFill = this.findNode('hp-fill') as Bar2D | null;
    this.hpLabel = this.findNode('hp-label') as RuntimeLabel2D | null;
  }

  onUpdate(dt: number): void {
    this.updateButtons();
    this.updateOdometers(dt);
    this.updateHp();
  }

  // ── weapon buttons ──────────────────────────────────────────────────────

  private updateButtons(): void {
    const gun = this.gun;
    if (!gun) return;
    this.buttons.forEach((button, index) => {
      if (!button) return;
      const ammo = gun.getAmmo(index);
      const empty = ammo.mag <= 0 && ammo.reserve === 0;
      const selected = index === gun.currentIndex;
      const scale = selected ? 1.2 : 1;
      button.scale.set(scale, scale, 1);
      (button as NodeBase & { opacity?: number }).opacity = empty ? 0.35 : selected ? 1 : 0.72;
    });
  }

  // ── odometers ───────────────────────────────────────────────────────────

  private updateOdometers(dt: number): void {
    const gun = this.gun;
    const flow = this.flow;
    if (gun) {
      const ammo = gun.getAmmo(gun.currentIndex);
      this.setOdometer('clip', Math.max(0, ammo.mag), dt);
      // Infinite reserve reads as a full drum (the M4 shop will sell refills).
      this.setOdometer('ammo', ammo.reserve < 0 ? 9999 : ammo.reserve, dt);
    }
    if (flow) {
      this.setOdometer('score', flow.scoreValue, dt);
      this.setOdometer('kills', flow.killsValue, dt);
      const total = Math.floor(flow.battleTimeValue);
      const mmss = Math.floor(total / 60) * 100 + (total % 60);
      this.setOdometer('time', mmss, dt);
    }
  }

  private setOdometer(key: string, value: number, dt: number): void {
    const odo = this.odometers.get(key);
    if (!odo) return;
    const count = odo.digits.length;
    const clamped = Math.max(0, Math.min(Math.pow(10, count) - 1, Math.floor(value)));

    for (let i = 0; i < count; i++) {
      const digit = Math.floor(clamped / Math.pow(10, count - 1 - i)) % 10;
      const slot = odo.digits[i];
      if (!slot.material) {
        slot.material = this.resolveStripMaterial(slot.node);
        if (!slot.material) continue;
      }
      // Ease the drum toward the target digit (short roll, snap when close).
      const target = digit;
      let shown = odo.shown[i];
      const diff = target - shown;
      shown = Math.abs(diff) < 0.02 ? target : shown + diff * Math.min(1, dt * 14);
      odo.shown[i] = shown;
      // Strip rows are top→bottom 0..9; UV origin is bottom-left.
      const map = slot.material.map;
      if (map) {
        map.repeat.y = 1 / DIGIT_COUNT;
        map.offset.y = 1 - (shown + 1) / DIGIT_COUNT;
      }
    }
  }

  /** Clone the digit-strip texture per window so each digit scrolls alone. */
  private resolveStripMaterial(node: NodeBase): MeshBasicMaterial | null {
    let material: MeshBasicMaterial | null = null;
    node.traverse(obj => {
      const mesh = obj as Mesh;
      if (!material && mesh.isMesh) {
        const mat = mesh.material as MeshBasicMaterial;
        if (mat.map) {
          const clone: Texture = mat.map.clone();
          clone.needsUpdate = true;
          mat.map = clone;
          material = mat;
        }
      }
    });
    return material;
  }

  // ── castle HP ───────────────────────────────────────────────────────────

  private updateHp(): void {
    const flow = this.flow;
    if (!flow) return;
    const fraction = flow.castleHpFraction;
    this.hpFill?.setValue(fraction);
    const text = `${Math.max(0, Math.round(fraction * 250))}/250`;
    if (text !== this.lastHpText && this.hpLabel) {
      this.lastHpText = text;
      this.hpLabel.label = text;
      this.hpLabel.updateLabel();
    }
  }
}
