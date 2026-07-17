import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { Vector3 } from 'three';
import { BridgeController } from './BridgeController';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const BOOM_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';

/** Free-fall gravity, stage px/s² (tuned against the original 30 fps feel). */
const GRAVITY = 380;

/**
 * FallingMine — the naval mine/bomb in three roles:
 * - **falling** (default): detaches from a shot-down aerostat and free-falls;
 *   landing on the bridge deck detonates it (splash-damages nearby enemies —
 *   the GDD's "гондола с минами падает на мост и задевает наземных"), missing
 *   the bridge drops it silently into the clouds below.
 * - **bomb** (`castleDamage > 0`, set by a bomber's release): keeps the
 *   carrier's momentum (`vx`) and, landing in the castle grounds (original:
 *   x < 210 → stage x < −110), hits the castle for `castleDamage`.
 * - **planted** (`planted: true`): the Crazy Mineman's deck mine — sits on the
 *   bridge and detonates under the first ground vehicle that rolls over it,
 *   then reports `deck-mine-exploded` so the controller can respawn it.
 */
export class FallingMine extends Script {
  private vy = 0;
  private done = false;
  private bridge: BridgeController | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      planted: false,
      damage: 60,
      radius: 45,
      // Bomb payload (bombers only; the plain S-mine leaves these at 0).
      castleDamage: 0,
      vx: 0,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Mine' },
      getValue: (c: unknown) => (c as FallingMine).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as FallingMine).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'FallingMine',
      properties: [
        {
          name: 'planted',
          type: 'boolean',
          ui: { label: 'Planted (deck mine)', group: 'Mine' },
          getValue: (c: unknown) => (c as FallingMine).config.planted,
          setValue: (c: unknown, v: unknown) => {
            (c as FallingMine).config.planted = Boolean(v);
          },
        },
        num('damage', 'Damage'),
        num('radius', 'Blast Radius (px)'),
      ],
      groups: { Mine: { label: 'Falling Mine', expanded: true } },
    };
  }

  onStart(): void {
    this.bridge =
      (this.findNode('bridge')?.components.find(
        (c): c is BridgeController => c instanceof BridgeController
      ) as BridgeController | undefined) ?? null;
  }

  onUpdate(dt: number): void {
    if (!this.node || this.done) return;

    if (this.config.planted === true) {
      this.watchForVehicles();
      return;
    }

    // Free fall with a lazy tumble (bombs also keep their carrier's momentum,
    // decaying — the original bomb drifts left as it falls).
    this.vy -= GRAVITY * dt;
    this.node.position.y += this.vy * dt;
    const vx = Number(this.config.vx) || 0;
    if (vx !== 0) {
      this.node.position.x += vx * dt;
      this.config.vx = vx * Math.max(0, 1 - 1.2 * dt);
    }
    this.node.rotation.z += 0.9 * dt;

    const x = this.node.position.x;
    const y = this.node.position.y;
    const castleDamage = Number(this.config.castleDamage) || 0;
    if (castleDamage > 0 && x <= -110 && y <= -150) {
      // Castle grounds (original: bombs landing at x < 210 hit the dom).
      this.findNode('game-root')?.emit('castle-damaged', castleDamage);
      this.scene?.juice.shake('camera2d', { amplitude: 6, duration: 0.2 });
      this.explode();
    } else if (this.bridge && y <= this.bridge.deckTopY + 6 && this.bridge.isSpanAt(x)) {
      this.explode();
    } else if (y < -290) {
      // Into the clouds below the islands — no harm done.
      this.done = true;
      this.node.queueFree();
    }
  }

  /** Planted mode: pop under the first ground vehicle that touches the mine. */
  private watchForVehicles(): void {
    const scene = this.scene;
    const node = this.node;
    if (!scene || !node) return;
    const pos = node.getWorldPosition(FallingMine.scratch);
    const scale = node.getWorldScale(FallingMine.scratch2);
    const s = Math.abs(scale.x) || 1;
    const hits = scene.collision2d.overlapCircle(pos.x, pos.y, 18 * s, 'enemy');
    for (const hit of hits) {
      const isVehicle = hit.node.components?.some(
        c => (c as { type?: string }).type === 'user:GroundVehicle'
      );
      if (isVehicle) {
        this.explode(true);
        return;
      }
    }
  }

  private explode(fromDeck = false): void {
    const scene = this.scene;
    const node = this.node;
    if (!scene || !node || this.done) return;
    this.done = true;

    const x = node.position.x;
    const y = node.position.y;
    scene.audio.play(BOOM_SOUND, { bus: 'sfx', pitchVariation: 0.1 });

    // Splash damage first (the explosion prefab adds its own shockwave shove).
    const pos = node.getWorldPosition(FallingMine.scratch);
    const scale = node.getWorldScale(FallingMine.scratch2);
    const s = Math.abs(scale.x) || 1;
    const radius = (Number(this.config.radius) || 45) * s;
    const damage = Number(this.config.damage) || 60;
    const damagedNodes = new Set<unknown>();
    for (const hit of scene.collision2d.overlapCircle(pos.x, pos.y, radius, 'enemy')) {
      if (damagedNodes.has(hit.node)) continue;
      damagedNodes.add(hit.node);
      hit.node.emit('damaged', damage);
    }

    void scene
      .instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y + 6, 0);
        fx.scale.set(0.7, 0.7, 1);
      })
      .catch(() => undefined);

    if (fromDeck || this.config.planted === true) {
      this.findNode('game-root')?.emit('deck-mine-exploded');
    }
    node.queueFree();
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
}
