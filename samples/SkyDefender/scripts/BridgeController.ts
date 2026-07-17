import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema, Sprite2D } from '@pix3/runtime';
import type { Texture } from 'three';
import { BRIDGE, DECK_MINE } from './SdBalance';
import { session } from './SdSession';

const TRANSPORTER_PREFAB = 'res://src/assets/prefabs/transporter.pix3scene';
const MINE_PREFAB = 'res://src/assets/prefabs/falling-mine.pix3scene';

/** Half of a truss segment (151 px wide) for span checks. */
const SEGMENT_HALF = 75.5;

/** Truss crumple frames (original bridge1 clip, frame 1 = intact). */
const CRUMPLE_FRAMES = 12;
const CRUMPLE_PATH = (i: number) =>
  `res://src/assets/textures/enemy/ground/bridge1/${String(i).padStart(5, '0')}.png`;
/** One crumple step every other original 30 fps tick. */
const CRUMPLE_STEP_SEC = 1 / 15;

/**
 * Which of the three inner segments sag once the bridge closes (original
 * method_111 `var_224` roll: one or two of TP1–TP3; the outermost TP4 never).
 */
const CRUMPLE_PATTERNS: number[][] = [[0], [1], [2], [0, 1], [0, 2], [1, 2]];

/** Original method_75: dm_bridge 2..12 → 0..9 crumple steps. */
const crumpleSteps = (dm: number): number => (dm >= 11 ? 9 : dm >= 3 ? dm - 2 : 0);

/**
 * BridgeController — assembles the enemy bridge at mission start, exactly like
 * the original (decompiled v10.18): four transporter aerostats launch one by
 * one (~1.7 s apart), fly in from the right and park at the segment slots,
 * building the bridge from the castle outward. When the last one docks the
 * bridge is "ready" (`bridge-ready` on `game-root`) and the ground assault may
 * begin. Also owns the Crazy Mineman shop effect: while the bridge stands, a
 * mine waits on the deck and blows up the first vehicle that rolls over it
 * (respawns after a pause).
 *
 * The finished bridge also settles under its own weight: one or two of the
 * inner truss segments crumple frame by frame (original `method_111` +
 * `method_113` — bridge1 clip frames, outboard carriers sliding 1 px per
 * step toward the castle).
 */
export class BridgeController extends Script {
  private building = false;
  private built = false;
  private launched = 0;
  private arrived = 0;
  private launchTimer = 0;
  private mineAlive = false;
  private mineRespawn = 0;
  /** Spawned carriers in segment order (castle outward). */
  private carriers: (NodeBase | null)[] = [];
  private crumpleFrames: Texture[] | null = null;
  /** Per-segment crumple: applied/target steps (index = segment). */
  private crumpleTargets: number[] = [];
  private crumpleApplied: number[] = [];
  private crumpleTimer = 0;
  private crumpling = false;

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
        // The last platform slams in: the span settles (crumple) and the
        // assault begins.
        this.scene?.juice.shake('camera2d', { amplitude: 5, duration: 0.25 });
        this.startCrumple();
        root?.emit('bridge-ready');
      }
    });

    // Warm the truss crumple frames so the sag starts without pop-in.
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      void Promise.all(
        Array.from({ length: CRUMPLE_FRAMES }, (_, i) => loader.loadTexture(CRUMPLE_PATH(i)))
      )
        .then(frames => {
          this.crumpleFrames = frames;
        })
        .catch(() => console.warn('[BridgeController] missing bridge1 crumple frames'));
    }
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

    this.updateCrumple(dt);

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
        this.carriers[index] = node;
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

  // ── truss settling (original method_111 / method_41 / method_113) ───────────

  private startCrumple(): void {
    const pattern =
      CRUMPLE_PATTERNS[Math.floor(Math.random() * CRUMPLE_PATTERNS.length)] ?? [0];
    this.crumpleTargets = BRIDGE.segmentX.map(() => 0);
    this.crumpleApplied = BRIDGE.segmentX.map(() => 0);
    for (const segment of pattern) {
      this.crumpleTargets[segment] = crumpleSteps(2 + Math.floor(Math.random() * 11));
    }
    this.crumpleTimer = 0;
    this.crumpling = this.crumpleTargets.some(t => t > 0);
  }

  private updateCrumple(dt: number): void {
    if (!this.crumpling || !this.crumpleFrames) return;
    this.crumpleTimer += dt;
    while (this.crumpleTimer >= CRUMPLE_STEP_SEC) {
      this.crumpleTimer -= CRUMPLE_STEP_SEC;
      let moved = false;
      for (let seg = 0; seg < this.crumpleTargets.length; seg++) {
        if (this.crumpleApplied[seg] >= this.crumpleTargets[seg]) continue;
        this.crumpleApplied[seg] += 1;
        moved = true;
        const frame = this.crumpleFrames[Math.min(this.crumpleApplied[seg], CRUMPLE_FRAMES - 1)];
        const sprite = this.carriers[seg]?.getChildByName('Carrier Segment') as
          | Sprite2D
          | undefined;
        if (frame && sprite?.setTexture) sprite.setTexture(frame);
        // Everything outboard slides 1 px toward the castle as the truss folds.
        for (let outer = seg + 1; outer < this.carriers.length; outer++) {
          const carrier = this.carriers[outer];
          if (carrier) carrier.position.x -= 1;
        }
      }
      if (!moved) {
        this.crumpling = false;
        break;
      }
    }
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
