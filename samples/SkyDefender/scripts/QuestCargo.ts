import { Script, Sprite2D } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const SAVE_SOUND = 'res://src/assets/audio/other/money.mp3';
const MISS_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';

/** Free-fall gravity, stage px/s² (matches FallingMine's tuned feel). */
const GRAVITY = 380;
/** Below the islands — the cargo is gone (missed the container). */
const FLOOR_Y = -300;

/**
 * QuestCargo — the payload a carrier NPC drops when its cargo hitbox is shot off
 * (see QuestNpc). Mirrors the FallingMine free-fall model: gravity + inherited
 * leftward momentum + a lazy tumble. On landing:
 *
 * - inside the stage-local container rect (`containerX/Y/W/H` — the boat / cup /
 *   truck) → `quest-cargo-saved {questId, payloadType}` (a coin chime + a small
 *   sparkle);
 * - otherwise, once it falls past the islands → `quest-cargo-lost {questId,
 *   payloadType}`.
 *
 * Both signals go to `game-root`, where GameFlow's quest tracker counts them
 * (sheep saved / gold taken / cones collected — see GameFlow.debugInspect('quest')).
 */
export class QuestCargo extends Script {
  private vy = 0;
  private done = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      payloadType: 0,
      payloadTex: '',
      questId: '',
      containerX: 0,
      containerY: -170,
      containerW: 360,
      containerH: 90,
      vx: 0,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Quest Cargo' },
      getValue: (c: unknown) => (c as QuestCargo).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as QuestCargo).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'QuestCargo',
      properties: [
        num('payloadType', 'Payload Type'),
        num('containerX', 'Container X'),
        num('containerY', 'Container Y'),
        num('containerW', 'Container W'),
        num('containerH', 'Container H'),
      ],
      groups: { 'Quest Cargo': { label: 'Quest Cargo', expanded: true } },
    };
  }

  onStart(): void {
    // Re-texture the cargo sprite to the payload art (gold bar / sheep / cone).
    const path = String(this.config.payloadTex ?? '');
    const sprite = this.node instanceof Sprite2D ? this.node : null;
    const loader = this.scene?.getAssetLoader();
    if (path && sprite && loader) {
      void loader
        .loadTexture(path)
        .then(tex => {
          sprite.setTexture(tex);
          sprite.resetToOriginalSize();
        })
        .catch(() => console.warn(`[QuestCargo] missing payload texture ${path}`));
    }
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.done) return;

    this.vy -= GRAVITY * dt;
    node.position.y += this.vy * dt;
    const vx = Number(this.config.vx) || 0;
    if (vx !== 0) {
      node.position.x += vx * dt;
      this.config.vx = vx * Math.max(0, 1 - 1.2 * dt);
    }
    node.rotation.z += 1.1 * dt;

    const x = node.position.x;
    const y = node.position.y;
    const cx = Number(this.config.containerX);
    const cy = Number(this.config.containerY);
    const halfW = Number(this.config.containerW) / 2;
    const halfH = Number(this.config.containerH) / 2;

    // Landed in the container: within its x-span and dropped onto its top surface.
    if (this.vy < 0 && y <= cy + halfH && y >= cy - halfH - 20 && x >= cx - halfW && x <= cx + halfW) {
      this.land(true);
    } else if (y < FLOOR_Y) {
      this.land(false);
    }
  }

  private land(saved: boolean): void {
    const node = this.node;
    if (!node || this.done) return;
    this.done = true;
    const signal = saved ? 'quest-cargo-saved' : 'quest-cargo-lost';
    this.findNode('game-root')?.emit(signal, {
      questId: String(this.config.questId),
      payloadType: Number(this.config.payloadType),
    });
    this.scene?.audio.play(saved ? SAVE_SOUND : MISS_SOUND, {
      bus: 'sfx',
      pitchVariation: 0.1,
    });
    if (saved) {
      void this.scene
        ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
        .then(fx => {
          fx.position.set(node.position.x, node.position.y, 0);
          fx.scale.set(0.4, 0.4, 1);
        })
        .catch(() => undefined);
    }
    node.queueFree();
  }
}
