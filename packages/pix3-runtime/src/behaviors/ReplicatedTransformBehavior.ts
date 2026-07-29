/**
 * `core:ReplicatedTransform` — moves one bound entity's transform across the wire.
 *
 * **Owner side.** Every send tick it quantizes the node's transform through the room's
 * `WorldQuantizer`, publishes it, and then **writes the dequantized values back onto the node**. The
 * spec is explicit about that last step: "an owning client publishes quantized values and renders
 * its own entity from the same dequantized values, so nobody chases divergence pops". The round trip
 * is a fixed point (requantizing a dequantized value lands on the same integer), so the write-back
 * costs at most one quantum — 1/16 unit in the default 4096 world — and buys exact agreement with
 * what every peer sees.
 *
 * **Remote side.** Records go into a snapshot buffer stamped with their arrival time, and the node
 * renders at `now − delay` by interpolating between the two bracketing samples. This is *timed*
 * interpolation, not a per-frame `lerp(current, target, k)`: advancing the clock is what moves the
 * node, so the motion is identical at 30, 60 and 144 fps, and a frame-rate-dependent lerp's
 * "smoothing that is also a variable lag" is gone.
 *
 * The delay is adaptive — roughly **two tick intervals plus measured jitter** (Valve's
 * `cl_interp_ratio 2` rule), with the tick interval read from `WelcomeEvent.TickHz`. Two intervals
 * is the smallest window that still has a *next* sample to interpolate towards after one late
 * arrival; the jitter term buys the rest.
 *
 * The `Teleport` mask bit means **snap**: a respawn or a warp is a discontinuity, and interpolating
 * across it would slide the node through the world instead of putting it where it belongs.
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { Node2D } from '../nodes/Node2D';
import type { NetBindingListener } from '../core/NetworkNodeBinder';
import type { NetworkNodeBinder } from '../core/NetworkNodeBinder';
import type { NetEntityChange, NetworkService } from '../net/NetworkService';
import { isNetTeleport } from '../net/NetworkService';
import { NetworkedNodeBehavior } from './NetworkedNodeBehavior';

const TWO_PI = Math.PI * 2;

/** Fallback tick interval before a `WelcomeEvent` says otherwise (20 Hz is the room default). */
const DEFAULT_TICK_INTERVAL_MS = 50;

/** Interpolation delay bounds. Below the floor a single late frame stalls; above the ceiling it lags. */
const MIN_INTERPOLATION_DELAY_MS = 20;
const MAX_INTERPOLATION_DELAY_MS = 500;

/** How fast the jitter estimate follows the measured inter-arrival error. */
const JITTER_SMOOTHING = 0.2;

/** Samples older than this behind the render cursor are dropped. */
const BUFFER_RETENTION_MS = 1000;

/** Hard cap so a hidden tab's backlog cannot grow without bound. */
const MAX_BUFFERED_SAMPLES = 64;

/** Which two world axes the wire's X/Y drive. */
export type ReplicatedPlane = 'xy' | 'xz';

interface TransformSample {
  /** Arrival time on the component's clock. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/** Shortest-arc interpolation between two angles, both already wrapped into `[0, 2π)`. */
function lerpAngle(from: number, to: number, alpha: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) {
    delta -= TWO_PI;
  } else if (delta < -Math.PI) {
    delta += TWO_PI;
  }
  return from + delta * alpha;
}

export class ReplicatedTransformBehavior extends Script {
  /** Clock for arrival stamps and the render cursor. Overridable so a test can drive it. */
  timeSource: () => number = () => Date.now();

  private boundNetId = 0;
  private listener: NetBindingListener | null = null;

  private sendAccumulatorMs = 0;
  private readonly buffer: TransformSample[] = [];
  private lastArrivalMs = 0;
  private jitterMs = 0;
  /** Set by a `Teleport` record; consumed by the next render. */
  private snapPending = false;
  private readonly scratchSnap = { x: 0, y: 0 };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      sendRateHz: 20,
      replicateRotation: true,
      interpolationDelayMs: 0,
      plane: 'xy',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ReplicatedTransform',
      properties: [
        {
          name: 'sendRateHz',
          type: 'number',
          ui: {
            label: 'Send Rate (Hz)',
            description:
              'How often the owner publishes. The session still only sends what actually changed ' +
              '(dirty detection compares quantized integers), so an idle entity costs nothing.',
            group: 'Send',
            min: 1,
            max: 60,
            step: 1,
          },
          getValue: c => (c as ReplicatedTransformBehavior).config.sendRateHz,
          setValue: (c, v) => {
            const parsed = Number(v);
            (c as ReplicatedTransformBehavior).config.sendRateHz =
              Number.isFinite(parsed) && parsed > 0 ? Math.min(60, parsed) : 20;
          },
        },
        {
          name: 'replicateRotation',
          type: 'boolean',
          ui: {
            label: 'Replicate Rotation',
            description: 'Send rotation as well as position (256 steps per turn, 1.41°).',
            group: 'Send',
          },
          getValue: c => (c as ReplicatedTransformBehavior).config.replicateRotation !== false,
          setValue: (c, v) => {
            (c as ReplicatedTransformBehavior).config.replicateRotation = Boolean(v);
          },
        },
        {
          name: 'plane',
          type: 'select',
          ui: {
            label: 'Plane',
            description:
              "Which axes the wire's X/Y drive: xy for 2D nodes, xz for a top-down 3D game.",
            group: 'Send',
            options: ['xy', 'xz'],
          },
          getValue: c => (c as ReplicatedTransformBehavior).config.plane,
          setValue: (c, v) => {
            (c as ReplicatedTransformBehavior).config.plane = v === 'xz' ? 'xz' : 'xy';
          },
        },
        {
          name: 'interpolationDelayMs',
          type: 'number',
          ui: {
            label: 'Interpolation Delay (ms)',
            description:
              '0 = adaptive (two room ticks plus measured jitter). Raise it for a lossy link, ' +
              'lower it for a LAN — it is latency traded for smoothness.',
            group: 'Receive',
            min: 0,
            max: MAX_INTERPOLATION_DELAY_MS,
            step: 5,
          },
          getValue: c => (c as ReplicatedTransformBehavior).config.interpolationDelayMs,
          setValue: (c, v) => {
            const parsed = Number(v);
            (c as ReplicatedTransformBehavior).config.interpolationDelayMs =
              Number.isFinite(parsed) && parsed > 0
                ? Math.min(MAX_INTERPOLATION_DELAY_MS, parsed)
                : 0;
          },
        },
      ],
      groups: {
        Send: { label: 'Send (owner)', expanded: true },
        Receive: { label: 'Receive (remote)', expanded: true },
      },
    };
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  /** The bound entity, or `0`. */
  get netId(): number {
    return this.boundNetId;
  }

  /** True when this client publishes this transform rather than interpolating it. */
  get isOwner(): boolean {
    const networked = this.node?.getComponent(NetworkedNodeBehavior);
    if (networked) {
      return networked.isMine;
    }
    const network = this.network;
    return network !== null && this.boundNetId !== 0 && network.ownsEntity(this.boundNetId);
  }

  /** The interpolation delay in effect, in ms — the configured one, or the adaptive estimate. */
  get interpolationDelayMs(): number {
    const configured = Number(this.config.interpolationDelayMs) || 0;
    if (configured > 0) {
      return configured;
    }
    // Valve's `cl_interp_ratio 2`: two tick intervals is the smallest window that still leaves a
    // *next* sample to aim at after one late arrival. Jitter buys back the rest.
    const delay = this.tickIntervalMs * 2 + this.jitterMs;
    return Math.min(MAX_INTERPOLATION_DELAY_MS, Math.max(MIN_INTERPOLATION_DELAY_MS, delay));
  }

  /** How many samples the receive buffer is holding. */
  get bufferedSampleCount(): number {
    return this.buffer.length;
  }

  /**
   * Moves an owned entity discontinuously — a respawn, a warp. Sets the node, publishes with the
   * `Teleport` bit, and renders the dequantized result, so every peer snaps instead of sliding.
   */
  teleportTo(x: number, y: number, rotation?: number): void {
    const network = this.network;
    if (!network || this.boundNetId === 0) {
      return;
    }
    this.writeNodeTransform(x, y, rotation ?? this.readNodeRotation());
    this.publishFromNode(true);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onStart(): void {
    // An anchored 2D node recomputes its position from the authored anchor on *every* layout pass
    // (SceneRunner reflows the whole 2D tree each frame), which would overwrite a replicated
    // position on the remote side and publish the anchor instead of the gameplay position on the
    // owner's. The two are simply contradictory, so replication wins and says so once.
    const node = this.node;
    if (node instanceof Node2D && node.layoutEnabled) {
      console.warn(
        `[core:ReplicatedTransform] Disabling anchored layout on "${node.nodeId}": a replicated ` +
          'transform and the per-frame anchor reflow cannot both own the position.'
      );
      node.layoutEnabled = false;
    }

    this.rebind();
  }

  onUpdate(dt: number): void {
    if (this.boundNetId === 0) {
      // The spawn is asynchronous, so the first frames of an owner's life have no entity yet.
      this.rebind();
      if (this.boundNetId === 0) {
        return;
      }
    }

    if (this.isOwner) {
      this.tickOwner(dt);
    } else {
      this.tickRemote();
    }
  }

  override onDetach(): void {
    if (this.boundNetId !== 0) {
      this.binder?.setListener(this.boundNetId, null);
    }
    this.boundNetId = 0;
    this.listener = null;
    this.buffer.length = 0;
    super.onDetach();
  }

  // ── Owner ──────────────────────────────────────────────────────────────────

  private tickOwner(dt: number): void {
    const interval = 1000 / (Number(this.config.sendRateHz) || 20);
    this.sendAccumulatorMs += Math.max(0, dt) * 1000;
    if (this.sendAccumulatorMs < interval) {
      return;
    }
    // Consume whole intervals rather than resetting to zero: a long frame must not silently lower
    // the send rate below what the game asked for.
    this.sendAccumulatorMs %= interval;
    this.publishFromNode(false);
  }

  private publishFromNode(teleport: boolean): void {
    const network = this.network;
    const node = this.node;
    if (!network || !node) {
      return;
    }

    const { x, y } = this.readNodePosition();
    if (!network.snapPosition(x, y, this.scratchSnap)) {
      return;
    }
    const replicateRotation = this.config.replicateRotation !== false;
    const snappedRotation = replicateRotation
      ? network.snapRotation(this.readNodeRotation())
      : null;

    network.publish(this.boundNetId, {
      x: this.scratchSnap.x,
      y: this.scratchSnap.y,
      rotation: snappedRotation ?? undefined,
      teleport,
    });

    // Render exactly what the peers were told.
    this.writeNodeTransform(this.scratchSnap.x, this.scratchSnap.y, snappedRotation ?? undefined);
  }

  // ── Remote ─────────────────────────────────────────────────────────────────

  private tickRemote(): void {
    if (this.buffer.length === 0) {
      return;
    }

    if (this.snapPending) {
      this.snapPending = false;
      const latest = this.buffer[this.buffer.length - 1];
      this.buffer.length = 0;
      this.buffer.push(latest);
      this.writeNodeTransform(latest.x, latest.y, latest.rotation);
      return;
    }

    const renderTime = this.timeSource() - this.interpolationDelayMs;
    this.trimBuffer(renderTime);

    const first = this.buffer[0];
    if (renderTime <= first.t || this.buffer.length === 1) {
      // Not enough history yet (the delay is exactly the window we are waiting for), or a single
      // sample. Hold the oldest known state rather than extrapolating — Level 1 never guesses.
      this.writeNodeTransform(first.x, first.y, first.rotation);
      return;
    }

    const last = this.buffer[this.buffer.length - 1];
    if (renderTime >= last.t) {
      // The owner stopped sending (idle, or a stalled link). Hold the last known state; an
      // extrapolated position would have to be un-done the moment the next record lands.
      this.writeNodeTransform(last.x, last.y, last.rotation);
      return;
    }

    for (let i = this.buffer.length - 1; i > 0; i -= 1) {
      const to = this.buffer[i];
      const from = this.buffer[i - 1];
      if (renderTime < from.t) {
        continue;
      }
      const span = to.t - from.t;
      const alpha = span > 0 ? (renderTime - from.t) / span : 1;
      this.writeNodeTransform(
        from.x + (to.x - from.x) * alpha,
        from.y + (to.y - from.y) * alpha,
        lerpAngle(from.rotation, to.rotation, alpha)
      );
      return;
    }
  }

  /** Keeps one sample older than the render cursor — it is the `from` end of the interpolation. */
  private trimBuffer(renderTime: number): void {
    while (this.buffer.length > 2 && this.buffer[1].t <= renderTime) {
      this.buffer.shift();
    }
    while (this.buffer.length > 1 && renderTime - this.buffer[0].t > BUFFER_RETENTION_MS) {
      this.buffer.shift();
    }
    while (this.buffer.length > MAX_BUFFERED_SAMPLES) {
      this.buffer.shift();
    }
  }

  private handleChange(change: NetEntityChange): void {
    if (change.kind === 'leave') {
      this.buffer.length = 0;
      return;
    }

    const network = this.network;
    const quantizer = network?.quantizer;
    if (!quantizer) {
      return;
    }

    const now = this.timeSource();
    if (this.lastArrivalMs !== 0) {
      // Jitter is how far an arrival strayed from the tick cadence; the interpolation delay pays for
      // exactly that much irregularity.
      const error = Math.abs(now - this.lastArrivalMs - this.tickIntervalMs);
      this.jitterMs += (error - this.jitterMs) * JITTER_SMOOTHING;
    }
    this.lastArrivalMs = now;

    const sample: TransformSample = {
      t: now,
      x: quantizer.dequantizeX(change.entity.qx),
      y: quantizer.dequantizeY(change.entity.qy),
      rotation: (change.entity.qrot * TWO_PI) / 256,
    };

    // An enter is this client's first sight of the entity, and a `Teleport` is a declared
    // discontinuity: both snap, neither interpolates.
    if (change.kind === 'enter' || isNetTeleport(change.mask)) {
      this.snapPending = true;
      this.buffer.length = 0;
    }
    this.buffer.push(sample);
    if (this.buffer.length > MAX_BUFFERED_SAMPLES) {
      this.buffer.shift();
    }
  }

  // ── Binding ────────────────────────────────────────────────────────────────

  private rebind(): void {
    const node = this.node;
    const binder = this.binder;
    if (!node || !binder) {
      return;
    }

    const netId = node.getComponent(NetworkedNodeBehavior)?.netId || binder.getNetId(node);
    if (netId === this.boundNetId) {
      return;
    }

    if (this.boundNetId !== 0) {
      binder.setListener(this.boundNetId, null);
    }
    this.boundNetId = netId;
    this.buffer.length = 0;
    this.lastArrivalMs = 0;
    this.snapPending = false;
    if (netId === 0) {
      return;
    }

    this.listener ??= change => this.handleChange(change);
    binder.setListener(netId, this.listener);

    // The entity's `enter` fired before this component existed (the binder had to instantiate the
    // prefab first), so seed the buffer from the record that is already in the registry.
    const entity = this.network?.getEntity(netId);
    if (entity) {
      this.handleChange({ kind: 'enter', netId, entity, mask: 0 });
    }
  }

  // ── Transform mapping ──────────────────────────────────────────────────────

  private get plane(): ReplicatedPlane {
    return this.config.plane === 'xz' ? 'xz' : 'xy';
  }

  private readNodePosition(): { x: number; y: number } {
    const position = this.node?.position;
    if (!position) {
      return { x: 0, y: 0 };
    }
    return this.plane === 'xz'
      ? { x: position.x, y: position.z }
      : { x: position.x, y: position.y };
  }

  private readNodeRotation(): number {
    const rotation = this.node?.rotation;
    if (!rotation) {
      return 0;
    }
    return this.plane === 'xz' ? rotation.y : rotation.z;
  }

  private writeNodeTransform(x: number, y: number, rotation?: number): void {
    const node = this.node;
    if (!node) {
      return;
    }
    if (this.plane === 'xz') {
      node.position.x = x;
      node.position.z = y;
    } else {
      node.position.x = x;
      node.position.y = y;
    }
    if (rotation !== undefined && this.config.replicateRotation !== false) {
      if (this.plane === 'xz') {
        node.rotation.y = rotation;
      } else {
        node.rotation.z = rotation;
      }
    }
  }

  private get tickIntervalMs(): number {
    const tickHz = this.network?.tickHz ?? 0;
    return tickHz > 0 ? 1000 / tickHz : DEFAULT_TICK_INTERVAL_MS;
  }

  private get network(): NetworkService | null {
    return this.scene?.network ?? null;
  }

  private get binder(): NetworkNodeBinder | null {
    return this.scene?.netNodes ?? null;
  }
}
