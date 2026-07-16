import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { Vector3 } from 'three';

const SHOT_SOUND = 'res://src/assets/audio/guns/enemy/eshot1.mp3';

/**
 * AutoTurret — a castle turret from the shop (conf.xml <TRS>: TR1/TR2 dmg 10,
 * range 500 orig-px; the AA gun on floor 4 is the same script tuned up).
 * The node stays hidden until CastleController arms it; then it scans for the
 * nearest enemy in range, tracks it with the barrel and fires a straight
 * tracer (a small cannonball sprite child) on its period.
 */
export class AutoTurret extends Script {
  private cooldown = 0;
  private tracer: NodeBase | null = null;
  private tracerFlight = 0;
  private tracerVx = 0;
  private tracerVy = 0;
  private barrel: NodeBase | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      damage: 10,
      periodSec: 1,
      range: 260, // stage-local px (orig 500 screen px ≈ 260 stage units of reach)
      targetGroup: 'enemy',
      tracerSpeed: 420,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Turret', step },
      getValue: (c: unknown) => (c as AutoTurret).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as AutoTurret).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'AutoTurret',
      properties: [
        num('damage', 'Damage'),
        num('periodSec', 'Fire Period (s)', 0.1),
        num('range', 'Range (stage px)'),
        num('tracerSpeed', 'Tracer Speed (px/s)'),
      ],
      groups: { Turret: { label: 'Auto Turret', expanded: true } },
    };
  }

  onStart(): void {
    this.barrel = this.node?.children.find(
      c => (c as NodeBase).name === 'Turret Barrel'
    ) as NodeBase | null ?? null;
    this.tracer = this.node?.children.find(
      c => (c as NodeBase).name === 'Turret Tracer'
    ) as NodeBase | null ?? null;
    if (this.tracer) this.tracer.visible = false;
  }

  onUpdate(dt: number): void {
    const node = this.node;
    const scene = this.scene;
    if (!node || !scene || !node.visible) return;

    this.updateTracer(dt);

    this.cooldown -= dt;
    if (this.cooldown > 0) return;

    // Nearest enemy inside range (world-space query, stage may be scaled).
    const world = node.getWorldPosition(AutoTurret.scratch);
    const scale = Math.abs(node.getWorldScale(AutoTurret.scratch2).x) || 1;
    const range = Number(this.config.range) * scale;
    const hits = scene.collision2d.overlapCircle(
      world.x,
      world.y,
      range,
      String(this.config.targetGroup)
    );
    if (hits.length === 0) return;

    let best: NodeBase | null = null;
    let bestDist = Infinity;
    for (const hit of hits) {
      const p = hit.node.getWorldPosition(AutoTurret.scratch2);
      const d = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = hit.node;
      }
    }
    if (!best) return;

    this.cooldown = Math.max(0.2, Number(this.config.periodSec));
    this.fireAt(best, world, scale);
  }

  private fireAt(target: NodeBase, worldSelf: Vector3, worldScale: number): void {
    const node = this.node;
    if (!node) return;
    const targetWorld = target.getWorldPosition(AutoTurret.scratch2);
    const dx = targetWorld.x - worldSelf.x;
    const dy = targetWorld.y - worldSelf.y;
    const angle = Math.atan2(dy, dx);
    if (this.barrel) this.barrel.rotation.z = angle;

    // Damage lands instantly (the original turrets rarely missed); the tracer
    // is a purely visual round flying the same line.
    target.emit('damaged', Number(this.config.damage));
    this.scene?.audio.play(SHOT_SOUND, { bus: 'sfx', pitchVariation: 0.15, volumeVariation: 0.2 });

    if (this.tracer) {
      const dist = Math.hypot(dx, dy) / worldScale;
      const speed = Number(this.config.tracerSpeed);
      this.tracer.position.set(0, 0, 0);
      this.tracer.visible = true;
      this.tracerFlight = dist / speed;
      this.tracerVx = Math.cos(angle) * speed;
      this.tracerVy = Math.sin(angle) * speed;
    }
  }

  private updateTracer(dt: number): void {
    if (!this.tracer || !this.tracer.visible) return;
    this.tracerFlight -= dt;
    if (this.tracerFlight <= 0) {
      this.tracer.visible = false;
      return;
    }
    this.tracer.position.x += this.tracerVx * dt;
    this.tracer.position.y += this.tracerVy * dt;
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
}
