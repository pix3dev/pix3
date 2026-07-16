import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';

const FIRE_FRAME_COUNT = 23;
const FIRE_FRAME = (i: number) =>
  `res://src/assets/textures/sfx/fire/burn${String(58 + i).padStart(4, '0')}.png`;
const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const IGNITE_SOUND = 'res://src/assets/audio/fire/fire_short.mp3';
const IMPACT_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';

/** Fire frames are shared by every wreck instance. */
let fireFramesPromise: Promise<Texture[]> | null = null;

/**
 * BurningWreck — the GDD "падение с горением": a dead hull falls like a comet
 * with two flame foci (100% / 57% alpha per the original), flames oriented
 * against the motion, then detonates on impact at bridge level (the explosion
 * prefab it spawns carries the shockwave). Spawned via `scene.instantiate`;
 * the spawner sets `texturePath` (the dead unit's sprite) + initial velocity.
 */
export class BurningWreck extends Script {
  private sprite: Sprite2D | null = null;
  private fires: Sprite2D[] = [];
  private frames: Texture[] | null = null;
  private vx = 0;
  private vy = 0;
  private time = 0;
  private done = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      texturePath: '',
      startVx: -20,
      startVy: 0,
      gravity: 260,
      spinDegPerSec: 35,
      impactY: -195,
      fireFps: 20,
      explosionScale: 1,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Wreck', step },
      getValue: (c: unknown) => (c as BurningWreck).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as BurningWreck).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'BurningWreck',
      properties: [
        num('gravity', 'Gravity (px/s²)', 10),
        num('spinDegPerSec', 'Spin (deg/s)'),
        num('impactY', 'Impact Y (stage px)'),
        num('fireFps', 'Fire FPS'),
      ],
      groups: { Wreck: { label: 'Burning Wreck', expanded: true } },
    };
  }

  onStart(): void {
    this.vx = Number(this.config.startVx);
    this.vy = Number(this.config.startVy);

    const spriteNode = this.node?.getChildByName('Wreck Sprite') ?? null;
    this.sprite = spriteNode instanceof Sprite2D ? spriteNode : null;
    this.fires = (this.node?.children ?? []).filter(
      (c): c is Sprite2D => c instanceof Sprite2D && c.name.startsWith('Fire')
    );

    const texturePath = String(this.config.texturePath ?? '');
    if (texturePath && this.sprite) {
      void this.scene
        ?.getAssetLoader()
        .loadTexture(texturePath)
        .then(tex => {
          this.sprite?.setTexture(tex);
          if (this.sprite) this.sprite.visible = true;
        })
        .catch(() => undefined);
    }

    if (!fireFramesPromise) {
      const loader = this.scene?.getAssetLoader();
      if (loader) {
        fireFramesPromise = Promise.all(
          Array.from({ length: FIRE_FRAME_COUNT }, (_, i) => loader.loadTexture(FIRE_FRAME(i)))
        );
      }
    }
    void fireFramesPromise?.then(frames => {
      this.frames = frames;
    });

    this.scene?.audio.play(IGNITE_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.done) return;
    this.time += dt;

    // Comet fall.
    this.vy -= Number(this.config.gravity) * dt;
    node.position.x += this.vx * dt;
    node.position.y += this.vy * dt;
    node.rotation.z += (Number(this.config.spinDegPerSec) * Math.PI / 180) * dt;

    // Flames: loop the sequence, keep them pointing against the motion
    // (counter-rotate the parent spin so the trail reads as trajectory).
    const motionAngle = Math.atan2(this.vy, this.vx);
    const flameAngle = motionAngle + Math.PI / 2 - node.rotation.z;
    if (this.frames) {
      const frame = Math.floor(this.time * Number(this.config.fireFps));
      this.fires.forEach((fire, i) => {
        fire.setTexture(this.frames![(frame + i * 7) % FIRE_FRAME_COUNT]);
        fire.rotation.z = flameAngle;
      });
    }

    // Off the sides — just vanish; below impact level — detonate.
    if (node.position.x < -460 || node.position.x > 480 || this.time > 8) {
      this.finish(false);
      return;
    }
    if (node.position.y <= Number(this.config.impactY)) {
      this.finish(true);
    }
  }

  private finish(explode: boolean): void {
    const node = this.node;
    if (!node || this.done) return;
    this.done = true;

    if (explode && this.scene) {
      const x = node.position.x;
      const y = node.position.y;
      const scale = Number(this.config.explosionScale) || 1;
      this.scene.audio.play(IMPACT_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
      void this.scene
        .instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
        .then(fx => {
          fx.position.set(x, y, 0);
          fx.scale.set(scale, scale, 1);
        })
        .catch(() => undefined);
      this.emitToGameRoot('wreck-impact', x, y);
    }
    node.queueFree();
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }

  /** Spawner hook: set trajectory + payload in one call (config-safe). */
  static configure(target: NodeBase, texturePath: string, vx: number, vy: number, explosionScale = 1): void {
    const comp = target.components.find((c): c is BurningWreck => c instanceof BurningWreck);
    if (!comp) return;
    comp.config.texturePath = texturePath;
    comp.config.startVx = vx;
    comp.config.startVy = vy;
    comp.config.explosionScale = explosionScale;
  }
}
