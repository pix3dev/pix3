import { Script } from '@pix3/runtime';
import type { PropertySchema, Sprite2D } from '@pix3/runtime';
import type { Texture } from 'three';

const ROTOR_FRAMES = 7;
const ROTOR_PATH = (i: number) =>
  `res://src/assets/textures/enemy/air/transporter/${String(i).padStart(5, '0')}.png`;
const DOCK_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
];

/** Module-level rotor frame cache shared by all four carriers. */
let rotorPromise: Promise<Texture[]> | null = null;

/**
 * BridgeTransporter — the "заград-отряд" carrier aerostat (decompiled v10.18
 * `class_72`): flies in from the right at 4 px/frame holding a truss segment
 * on its back, parks at `targetX` and stays there for the rest of the battle —
 * the bridge IS the row of parked carriers. Reports `transporter-arrived` on
 * `game-root`; BridgeController counts the arrivals. Not a combat unit — no
 * hitbox, can't be shot (original: hp 0 / tip 101).
 */
export class BridgeTransporter extends Script {
  private frames: Texture[] | null = null;
  private frameTime = 0;
  private bobTime = 0;
  private baseY: number | null = null;
  private arrived = false;
  private balloon: Sprite2D | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      targetX: 0,
      speed: 120,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Carrier' },
      getValue: (c: unknown) => (c as BridgeTransporter).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as BridgeTransporter).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'BridgeTransporter',
      properties: [num('targetX', 'Target X'), num('speed', 'Speed (px/s)')],
      groups: { Carrier: { label: 'Bridge Carrier', expanded: true } },
    };
  }

  onStart(): void {
    this.balloon = (this.node?.getChildByName('Carrier Balloon') ?? null) as Sprite2D | null;
    if (!rotorPromise) {
      const loader = this.scene?.getAssetLoader();
      if (loader) {
        rotorPromise = Promise.all(
          Array.from({ length: ROTOR_FRAMES }, (_, i) => loader.loadTexture(ROTOR_PATH(i)))
        );
      }
    }
    void rotorPromise?.then(frames => {
      this.frames = frames;
    });
  }

  onUpdate(dt: number): void {
    if (!this.node) return;
    if (this.baseY === null) {
      this.baseY = this.node.position.y;
    }

    // Rotor sequence: 7 frames shown at ~1/3 speed (GDD animation note).
    this.frameTime += dt;
    if (this.frames && this.balloon) {
      const frame = Math.floor(this.frameTime * 10) % ROTOR_FRAMES;
      this.balloon.setTexture(this.frames[frame]);
    }

    this.bobTime += dt;
    if (this.arrived) {
      // Parked: barely-visible hover so the bridge feels held aloft.
      this.node.position.y = this.baseY + Math.sin(this.bobTime * 1.3) * 1.2;
      return;
    }

    this.node.position.x -= Number(this.config.speed) * dt;
    this.node.position.y = this.baseY + Math.sin(this.bobTime * 2) * 2.5;

    const targetX = Number(this.config.targetX);
    if (this.node.position.x <= targetX) {
      this.node.position.x = targetX;
      this.arrived = true;
      const sound = DOCK_SOUNDS[Math.floor(Math.random() * DOCK_SOUNDS.length)];
      this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.08 });
      this.scene?.juice.shake('camera2d', { amplitude: 2, duration: 0.12 });
      this.findNode('game-root')?.emit('transporter-arrived');
    }
  }
}
