import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { BRIDGE, DECK_MINE } from './SdBalance';
import { session } from './SdSession';

const TRANSPORTER_PREFAB = 'res://src/assets/prefabs/transporter.pix3scene';
const MINE_PREFAB = 'res://src/assets/prefabs/falling-mine.pix3scene';

/** Half of a truss segment (151 px wide) for span checks. */
const SEGMENT_HALF = 75.5;

/**
 * BridgeController — assembles the enemy bridge at mission start, exactly like
 * the original (decompiled v10.18): four transporter aerostats launch one by
 * one (~1.7 s apart), fly in from the right and park at the segment slots,
 * building the bridge from the castle outward. When the last one docks the
 * bridge is "ready" (`bridge-ready` on `game-root`) and the ground assault may
 * begin. Also owns the Crazy Mineman shop effect: while the bridge stands, a
 * mine waits on the deck and blows up the first vehicle that rolls over it
 * (respawns after a pause).
 */
export class BridgeController extends Script {
  private building = false;
  private built = false;
  private launched = 0;
  private arrived = 0;
  private launchTimer = 0;
  private mineAlive = false;
  private mineRespawn = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      mineX: DECK_MINE.x,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'BridgeController',
      properties: [
        {
          name: 'mineX',
          type: 'number',
          ui: { label: 'Deck Mine X', group: 'Bridge' },
          getValue: (c: unknown) => (c as BridgeController).config.mineX,
          setValue: (c: unknown, v: unknown) => {
            (c as BridgeController).config.mineX = Number(v);
          },
        },
      ],
      groups: { Bridge: { label: 'Bridge', expanded: true } },
    };
  }

  /** True once every carrier has parked (ground units may cross). */
  get isReady(): boolean {
    return this.built;
  }

  /** Deck surface height for anything that lands on the bridge. */
  get deckTopY(): number {
    return BRIDGE.deckTopY;
  }

  /** Is there bridge deck under stage-local x right now? */
  isSpanAt(x: number): boolean {
    for (let i = 0; i < this.arrived; i++) {
      if (Math.abs(x - BRIDGE.segmentX[i]) <= SEGMENT_HALF) return true;
    }
    return false;
  }

  onStart(): void {
    const root = this.findNode('game-root');
    root?.connect('mission-started', this, () => {
      if (!this.built && !this.building) {
        this.building = true;
        this.launched = 0;
        this.arrived = 0;
        // First carrier launches immediately, the rest follow staggered.
        this.launchTimer = BRIDGE.stagger;
      }
    });
    root?.connect('transporter-arrived', this, () => {
      this.arrived = Math.min(BRIDGE.segmentX.length, this.arrived + 1);
      if (this.arrived >= BRIDGE.segmentX.length && !this.built) {
        this.built = true;
        this.building = false;
        // The horn moment: the last platform slams in, the assault begins.
        this.scene?.juice.shake('camera2d', { amplitude: 5, duration: 0.25 });
        root?.emit('bridge-ready');
      }
    });
    root?.connect('deck-mine-exploded', this, () => {
      this.mineAlive = false;
      this.mineRespawn = DECK_MINE.respawnSec;
    });
  }

  onUpdate(dt: number): void {
    // Staggered carrier launches (the original spawns one every ~50 ticks).
    if (this.building && this.launched < BRIDGE.segmentX.length) {
      this.launchTimer += dt;
      if (this.launchTimer >= BRIDGE.stagger) {
        this.launchTimer = 0;
        this.spawnCarrier(this.launched);
        this.launched += 1;
      }
    }

    // Crazy Mineman: keep a live mine on the deck while the bridge stands.
    if (this.built && session.isOwned('mine-defender')) {
      if (this.mineRespawn > 0) {
        this.mineRespawn -= dt;
      } else if (!this.mineAlive) {
        this.mineAlive = true;
        this.plantMine();
      }
    }
  }

  private spawnCarrier(index: number): void {
    const scene = this.scene;
    if (!scene || !this.node) return;
    void scene
      .instantiate(TRANSPORTER_PREFAB, { parent: this.node })
      .then(node => {
        node.position.set(BRIDGE.spawnX + index * 20, BRIDGE.deckY, 0);
        const logic = node.components.find(
          c => (c as { type?: string }).type === 'user:BridgeTransporter'
        ) as { config?: Record<string, unknown> } | undefined;
        if (logic?.config) {
          logic.config.targetX = BRIDGE.segmentX[index];
          logic.config.speed = BRIDGE.speed;
        }
      })
      .catch(err => console.warn('[BridgeController] carrier spawn failed', err));
  }

  private plantMine(): void {
    const scene = this.scene;
    if (!scene || !this.node) return;
    void scene
      .instantiate(MINE_PREFAB, { parent: this.node })
      .then(node => {
        node.position.set(Number(this.config.mineX), BRIDGE.deckTopY + 9, 0);
        const logic = node.components.find(
          c => (c as { type?: string }).type === 'user:FallingMine'
        ) as { config?: Record<string, unknown> } | undefined;
        if (logic?.config) {
          logic.config.planted = true;
          logic.config.damage = DECK_MINE.damage;
          logic.config.radius = DECK_MINE.radius;
        }
      })
      .catch(err => {
        this.mineAlive = false;
        console.warn('[BridgeController] mine spawn failed', err);
      });
  }
}
