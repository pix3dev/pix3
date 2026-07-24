/**
 * engine-check: no built-in covers a floating enemy health bar that appears on
 * damage and auto-hides — `Bar2D` is the engine primitive (a status bar) and
 * `core:Fade` fades a node, but "spawn a bar over a unit, reveal it only after a
 * non-lethal hit, then fade it back out after a quiet interval" is game glue
 * (Godot/Unity ship the bar, not the enemy-HUD policy). So it lives here.
 */
import { Bar2D, Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';

/**
 * UnitHealthBar — a small floating HP bar for a combat unit. Attached at spawn
 * (WaveSpawner.attachHealthBar) to every damageable enemy EXCEPT the boss, which
 * carries its own dedicated HUD bar (`boss-hp`).
 *
 * It owns a `Bar2D` child hovering above the unit body and stays hidden until the
 * unit takes a hit it survives: the source enemy script emits `hp-changed(frac)`
 * (0..1) on its root node on every non-lethal body hit. The bar fades in on the
 * first such hit, tracks the fraction, and — a short quiet `holdTime` after the
 * last hit — fades back out. A unit killed on the first shot never emits, so its
 * bar never shows, exactly as asked.
 */
export class UnitHealthBar extends Script {
  private bar: Bar2D | null = null;
  /** Seconds of no-hit remaining before the bar fades out (0 = idle/hidden). */
  private holdRemaining = 0;
  private shown = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Vertical offset above the unit origin. 0 = auto (derive from body height).
      offsetY: 0,
      // Bar size. 0 width = auto (derive from body width, clamped).
      width: 0,
      height: 5,
      barColor: '#f2c53d',
      backColor: '#1c1c1c',
      borderColor: '#0c0c0c',
      // Fade timings + how long the bar lingers after the last hit.
      fadeIn: 0.15,
      fadeOut: 0.4,
      holdTime: 1.4,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'HealthBar', step },
      getValue: (c: unknown) => (c as UnitHealthBar).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as UnitHealthBar).config[name] = Number(v);
      },
    });
    const str = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'HealthBar' },
      getValue: (c: unknown) => (c as UnitHealthBar).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as UnitHealthBar).config[name] = String(v);
      },
    });
    return {
      nodeType: 'UnitHealthBar',
      properties: [
        num('offsetY', 'Offset Y (0 = auto)'),
        num('width', 'Width (0 = auto)'),
        num('height', 'Height'),
        str('barColor', 'Bar Color'),
        str('backColor', 'Background Color'),
        str('borderColor', 'Border Color'),
        num('fadeIn', 'Fade In (s)', 0.05),
        num('fadeOut', 'Fade Out (s)', 0.05),
        num('holdTime', 'Hold Time (s)', 0.1),
      ],
      groups: { HealthBar: { label: 'Unit Health Bar', expanded: true } },
    };
  }

  onStart(): void {
    const node = this.node;
    if (!node) return;

    const bodyW = this.readSize('width') ?? 34;
    const bodyH = this.readSize('height') ?? 40;
    const width = Number(this.config.width) || Math.max(24, Math.min(64, bodyW));
    const height = Math.max(2, Number(this.config.height));
    const offsetY = Number(this.config.offsetY) || bodyH / 2 + 12;

    const bar = new Bar2D({
      id: `${node.nodeId}:hpbar`,
      name: 'HP Bar',
      width,
      height,
      minValue: 0,
      maxValue: 1,
      value: 1,
      barColor: String(this.config.barColor),
      backBackgroundColor: String(this.config.backColor),
      showBorder: true,
      borderColor: String(this.config.borderColor),
      borderWidth: 1,
    });
    bar.position.set(0, offsetY);
    node.adoptChild(bar);
    // Start hidden (opacity 0, not drawn); the first non-lethal hit reveals it.
    bar.hide(0);
    this.bar = bar;

    node.connect('hp-changed', this, (fraction: unknown) => {
      this.onHpChanged(Number(fraction));
    });
  }

  onUpdate(dt: number): void {
    if (!this.shown || this.holdRemaining <= 0) return;
    this.holdRemaining -= dt;
    if (this.holdRemaining <= 0) {
      this.holdRemaining = 0;
      this.shown = false;
      this.bar?.hide(Math.max(0, Number(this.config.fadeOut)));
    }
  }

  private onHpChanged(fraction: number): void {
    const bar = this.bar;
    if (!bar || !Number.isFinite(fraction)) return;
    bar.setValue(Math.max(0, Math.min(1, fraction)));
    if (!this.shown) {
      this.shown = true;
      bar.show(Math.max(0, Number(this.config.fadeIn)));
    }
    // Refresh the linger window on every hit.
    this.holdRemaining = Math.max(0.1, Number(this.config.holdTime));
  }

  /** Read a numeric body dimension (`width`/`height`) off the host node if present. */
  private readSize(key: 'width' | 'height'): number | null {
    const value = (this.node as (NodeBase & Partial<Record<typeof key, number>>) | null)?.[key];
    return typeof value === 'number' && value > 0 ? value : null;
  }
}
