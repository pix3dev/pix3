/**
 * `NetworkService` behaviour, driven through a fake socket and fake timers.
 *
 * **Every frame in this file is built with the codec in `./protocol`**, never with hand-written
 * bytes: that codec is already pinned to the shared golden-vector file, so re-pinning bytes here
 * would only duplicate a contract test and rot the first time a layout changes. What is asserted
 * here is the *session*: handshake order, sequencing, registry ordering, dirty detection, the pump,
 * resume, and offline safety.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkService, type NetworkVisibilitySource } from './NetworkService';
import type { WsLikeSocket } from './WsTransport';
import {
  createEntityWireState,
  createWelcomeEvent,
  decodeControlMessage,
  DELTA_PACKET_HEADER_SIZE,
  DeltaMask,
  encodeControlMessage,
  framePayload,
  frameTypeId,
  FrameFlags,
  FULL_RECORD_SIZE,
  MessageTypeIds,
  packNetId,
  patchSectionCount,
  patchSnapshotPacketCount,
  patchSnapshotPacketFrameFlags,
  RejectCode,
  SECTION_COUNT_SIZE,
  SignalTarget,
  SNAPSHOT_PACKET_HEADER_SIZE,
  updateRecordSize,
  writeDeltaPacketHeader,
  writeFullRecord,
  writeRemovedSlot,
  writeSectionCountPlaceholder,
  writeSnapshotPacketHeader,
  writeUpdateRecord,
  type EntityWireState,
  type WelcomeEvent,
} from './protocol';

// ── Fake socket ──────────────────────────────────────────────────────────────

class FakeSocket implements WsLikeSocket {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  deliver(frame: Uint8Array): void {
    this.onmessage?.({
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    } as MessageEvent);
  }

  serverClose(code = 1006, reason = '', wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }

  /** Frames this client sent, decoded back into control messages (hot packets are skipped). */
  controlMessages() {
    return this.sent
      .map(frame => decodeControlMessage(frameTypeId(frame), framePayload(frame)))
      .filter(message => message !== undefined);
  }

  typeIds(): number[] {
    return this.sent.map(frame => frameTypeId(frame));
  }
}

// ── Frame builders (all through the codec) ───────────────────────────────────

const WORLD = { originX: -2048, originY: -2048, size: 4096 };

function welcome(overrides: Partial<WelcomeEvent> = {}): Uint8Array {
  const body: WelcomeEvent = {
    ...createWelcomeEvent(),
    clientId: 7,
    roomId: 'room-1',
    tickHz: 20,
    serverTimeMs: 1_700_000_000_000,
    serverTick: 42,
    aoiRadius: 512,
    maxPlayers: 8,
    protocolVersion: 2,
    worldOriginX: WORLD.originX,
    worldOriginY: WORLD.originY,
    worldSize: WORLD.size,
    mode: 0,
    maxVisibleEntities: 64,
    hostClientId: 7,
    resumeKey: new Uint8Array(16).fill(0xa5),
    resumed: false,
    ...overrides,
  };
  return encodeControlMessage({ typeId: MessageTypeIds.WelcomeEvent, body });
}

function entityState(overrides: Partial<EntityWireState> = {}): EntityWireState {
  return { ...createEntityWireState(), kind: 1, ownerId: 7, ...overrides };
}

interface SnapshotRecordInput {
  netId: number;
  state: EntityWireState;
}

function snapshot(seq: number, records: SnapshotRecordInput[], final = true): Uint8Array {
  const buffer = new ArrayBuffer(SNAPSHOT_PACKET_HEADER_SIZE + records.length * FULL_RECORD_SIZE);
  const view = new DataView(buffer);
  let offset = writeSnapshotPacketHeader(view, 0, seq, 100);
  for (const record of records) {
    offset += writeFullRecord(view, offset, record.netId, record.state);
  }
  patchSnapshotPacketCount(view, records.length);
  if (final) {
    patchSnapshotPacketFrameFlags(view, FrameFlags.Final);
  }
  return new Uint8Array(buffer);
}

interface DeltaInput {
  removedSlots?: number[];
  enters?: SnapshotRecordInput[];
  updates?: { slot: number; mask: number; state: EntityWireState }[];
}

function delta(seq: number, input: DeltaInput): Uint8Array {
  const removedSlots = input.removedSlots ?? [];
  const enters = input.enters ?? [];
  const updates = input.updates ?? [];

  const size =
    DELTA_PACKET_HEADER_SIZE +
    SECTION_COUNT_SIZE * 3 +
    removedSlots.length * 2 +
    enters.length * FULL_RECORD_SIZE +
    updates.reduce((total, update) => total + updateRecordSize(update.mask), 0);

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = writeDeltaPacketHeader(view, 0, seq, 100);

  const removedCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (const slot of removedSlots) {
    offset += writeRemovedSlot(view, offset, slot);
  }
  patchSectionCount(view, removedCountOffset, removedSlots.length);

  const enterCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (const record of enters) {
    offset += writeFullRecord(view, offset, record.netId, record.state);
  }
  patchSectionCount(view, enterCountOffset, enters.length);

  const updateCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (const update of updates) {
    offset += writeUpdateRecord(view, offset, update.slot, update.mask, update.state);
  }
  patchSectionCount(view, updateCountOffset, updates.length);

  return new Uint8Array(buffer);
}

/** One roster chunk. `final` false is a chunk of a roster that continues. */
function roster(entries: [clientId: number, displayName: string][], final = true): Uint8Array {
  return encodeControlMessage({
    typeId: MessageTypeIds.RoomRosterEvent,
    body: {
      clientIds: entries.map(([clientId]) => clientId),
      displayNames: entries.map(([, displayName]) => displayName),
      frameFlags: final ? FrameFlags.Final : FrameFlags.None,
    },
  });
}

// ── Harness ──────────────────────────────────────────────────────────────────

class FakeVisibility implements NetworkVisibilitySource {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function createHarness(options: { visibility?: NetworkVisibilitySource | null } = {}) {
  const sockets: FakeSocket[] = [];
  const service = new NetworkService({
    socketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    visibility: options.visibility ?? null,
    backoff: { initialDelayMs: 100, factor: 2, jitterRatio: 0, maxAttempts: 3 },
    random: () => 0.5,
  });

  const socket = (): FakeSocket => {
    const last = sockets[sockets.length - 1];
    if (!last) {
      throw new Error('no socket was created');
    }
    return last;
  };

  return { service, sockets, socket };
}

type Harness = ReturnType<typeof createHarness>;

async function join(h: Harness, welcomeFrame: Uint8Array = welcome()) {
  const promise = h.service.connect({
    url: 'wss://rooms.example/room-1',
    token: 'dev:ann:room-1',
    roomId: 'room-1',
    displayName: 'Ann',
  });
  h.socket().serverOpen();
  h.socket().deliver(welcomeFrame);
  return promise;
}

function countTypeId(socket: FakeSocket, typeId: number): number {
  return socket.typeIds().filter(id => id === typeId).length;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('NetworkService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('offline safety', () => {
    it('is a harmless no-op before connect', () => {
      const service = new NetworkService({ visibility: null });

      expect(service.status).toBe('offline');
      expect(service.isOnline).toBe(false);
      expect(service.clientId).toBe(0);
      expect(service.roomId).toBe('');
      expect(service.tickHz).toBe(0);
      expect(service.mode).toBe(0);
      expect(service.hostClientId).toBe(0);
      expect(service.isHost).toBe(false);
      expect(service.maxVisibleEntities).toBe(0);
      expect(service.maxPlayers).toBe(0);
      expect(service.aoiRadius).toBe(0);
      expect(service.rtt).toBe(0);
      expect(service.clockOffset).toBe(0);
      expect(service.quantizer).toBeNull();
      expect(service.sessionInfo).toBeNull();
      expect(service.peers).toEqual([]);
      expect(service.entityCount).toBe(0);
      expect(service.entities.size).toBe(0);
      expect(service.getEntity(1)).toBeUndefined();
      expect(service.resolveSlot(1)).toBe(0);
      expect(service.hasCompleteSnapshot).toBe(false);
      expect(service.isDesynced).toBe(false);
      expect(service.vars.size).toBe(0);
      expect(service.vars.get('phase')).toBeUndefined();
      expect(service.vars.getText('phase')).toBeUndefined();
      expect(service.vars.getJson('phase')).toBeUndefined();
      expect(service.vars.keys()).toEqual([]);
      expect(service.transportStats).toBeNull();

      expect(service.publish(1, { x: 1, y: 2 })).toBe(false);
      expect(service.emit('ping')).toBe(false);
      expect(service.sendChat('hi')).toBe(false);
      expect(service.requestResync()).toBe(false);
      expect(service.vars.set('phase', 'lobby')).toBe(false);

      const off = service.on('anything', () => undefined);
      off();
      service.off('anything');
      service.clearPublished(1);
      service.flush();
      service.disconnect();
      service.dispose();
      service.dispose();
      expect(service.status).toBe('offline');
    });

    it('rejects a connect after dispose instead of throwing', async () => {
      const service = new NetworkService({ visibility: null });
      service.dispose();
      await expect(
        service.connect({ url: 'wss://x', token: 't', roomId: 'r' })
      ).rejects.toMatchObject({ kind: 'cancelled' });
    });
  });

  describe('handshake', () => {
    it('sends HelloCommand as the very first frame', async () => {
      const h = createHarness();
      const promise = h.service.connect({
        url: 'wss://rooms.example/room-1',
        token: 'dev:ann:room-1',
        roomId: 'room-1',
        displayName: 'Ann',
      });
      h.socket().serverOpen();

      expect(h.socket().typeIds()[0]).toBe(MessageTypeIds.HelloCommand);
      const first = h.socket().controlMessages()[0];
      expect(first).toMatchObject({
        typeId: MessageTypeIds.HelloCommand,
        body: {
          protocolVersion: 2,
          token: 'dev:ann:room-1',
          roomId: 'room-1',
          displayName: 'Ann',
          capabilities: 0,
          resumeKey: null,
        },
      });

      h.socket().deliver(welcome());
      await promise;
    });

    it('resolves connect on WelcomeEvent and exposes the session', async () => {
      const h = createHarness();
      const info = await join(h);

      expect(info).toMatchObject({
        clientId: 7,
        roomId: 'room-1',
        tickHz: 20,
        mode: 0,
        protocolVersion: 2,
        maxPlayers: 8,
        maxVisibleEntities: 64,
        hostClientId: 7,
        resumed: false,
      });
      expect(h.service.isOnline).toBe(true);
      expect(h.service.status).toBe('online');
      expect(h.service.isHost).toBe(true);
      expect(h.service.quantizer?.size).toBe(WORLD.size);
      expect(h.service.peers).toEqual([{ clientId: 7, displayName: 'Ann', isLocal: true }]);
    });

    it('rejects with the mapped code on RejectedEvent', async () => {
      const h = createHarness();
      const promise = h.service.connect({
        url: 'wss://rooms.example/room-1',
        token: 'stale',
        roomId: 'room-1',
      });
      h.socket().serverOpen();
      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.RejectedEvent,
          body: { code: RejectCode.TokenExpired, message: 'token expired' },
        })
      );

      await expect(promise).rejects.toMatchObject({
        kind: 'rejected',
        rejectCode: RejectCode.TokenExpired,
        message: 'token expired',
      });
      expect(h.service.isOnline).toBe(false);
    });

    it('rejects when the socket closes before a welcome, and does not retry', async () => {
      const h = createHarness();
      const promise = h.service.connect({
        url: 'wss://rooms.example/room-1',
        token: 't',
        roomId: 'room-1',
      });
      h.socket().serverOpen();
      h.socket().serverClose(1006, 'gone');

      await expect(promise).rejects.toMatchObject({ kind: 'transport', closeCode: 1006 });
      vi.advanceTimersByTime(60_000);
      expect(h.sockets).toHaveLength(1);
    });

    it('ignores an unknown TypeId and counts it', async () => {
      const h = createHarness();
      await join(h);

      h.socket().deliver(new Uint8Array([200, 1, 2, 3]));

      expect(h.service.stats.unknownTypeIds).toBe(1);
      expect(h.service.isOnline).toBe(true);
    });
  });

  describe('entity registry', () => {
    it('completes a multi-frame snapshot only at Final', async () => {
      const h = createHarness();
      await join(h);

      const first = packNetId(1, 1);
      const second = packNetId(2, 1);

      h.socket().deliver(snapshot(0, [{ netId: first, state: entityState({ qx: 10 }) }], false));
      expect(h.service.hasCompleteSnapshot).toBe(false);
      expect(h.service.entityCount).toBe(0);

      h.socket().deliver(snapshot(1, [{ netId: second, state: entityState({ qx: 20 }) }], true));
      expect(h.service.hasCompleteSnapshot).toBe(true);
      expect(h.service.entityCount).toBe(2);
      expect(h.service.getEntity(first)?.qx).toBe(10);
      expect(h.service.getEntity(second)?.qx).toBe(20);
      expect(h.service.resolveSlot(1)).toBe(first);
      expect(h.service.resolveSlot(2)).toBe(second);
    });

    it('applies removals before enters, so a reused slot resolves to the new entity', async () => {
      const h = createHarness();
      await join(h);

      const oldEntity = packNetId(3, 1);
      const reused = packNetId(3, 2);
      h.socket().deliver(snapshot(0, [{ netId: oldEntity, state: entityState({ qx: 111 }) }]));
      expect(h.service.resolveSlot(3)).toBe(oldEntity);

      const changes: string[] = [];
      h.service.onEntitiesChange(batch => {
        for (const change of batch) {
          changes.push(`${change.kind}:${change.netId}`);
        }
      });

      // Same slot, despawned and respawned in one frame: the removal has to land first.
      h.socket().deliver(
        delta(1, {
          removedSlots: [3],
          enters: [{ netId: reused, state: entityState({ qx: 222, ownerId: 9 }) }],
        })
      );

      expect(changes).toEqual([`leave:${oldEntity}`, `enter:${reused}`]);
      expect(h.service.resolveSlot(3)).toBe(reused);
      expect(h.service.entityCount).toBe(1);
      expect(h.service.getEntity(reused)?.qx).toBe(222);
      expect(h.service.getEntity(oldEntity)).toBeUndefined();
    });

    it('merges masked updates onto known entities and counts unknown slots', async () => {
      const h = createHarness();
      await join(h);

      const netId = packNetId(5, 1);
      h.socket().deliver(
        snapshot(0, [{ netId, state: entityState({ qx: 100, qy: 200, qrot: 3, flags: 1 }) }])
      );

      h.socket().deliver(
        delta(1, {
          updates: [
            {
              slot: 5,
              mask: DeltaMask.X | DeltaMask.Rot,
              state: entityState({ qx: 150, qrot: 9 }),
            },
            // Slot 6 was never introduced by a full record — invariant 3 says count it and move on.
            { slot: 6, mask: DeltaMask.X, state: entityState({ qx: 1 }) },
          ],
        })
      );

      const entity = h.service.getEntity(netId);
      expect(entity?.qx).toBe(150);
      expect(entity?.qrot).toBe(9);
      // Unmasked fields are merged, never assigned: qy and flags survive.
      expect(entity?.qy).toBe(200);
      expect(entity?.flags).toBe(1);
      expect(h.service.stats.unknownSlotUpdates).toBe(1);
    });

    it('a snapshot replaces the visible set', async () => {
      const h = createHarness();
      await join(h);

      const stale = packNetId(1, 1);
      const fresh = packNetId(2, 1);
      h.socket().deliver(snapshot(0, [{ netId: stale, state: entityState() }]));
      h.socket().deliver(snapshot(1, [{ netId: fresh, state: entityState() }]));

      expect(h.service.entityCount).toBe(1);
      expect(h.service.getEntity(fresh)).toBeDefined();
      expect(h.service.getEntity(stale)).toBeUndefined();
    });
  });

  describe('sequencing', () => {
    it('sends exactly one ResyncCommand on a gap and ignores hot frames until the next snapshot', async () => {
      const h = createHarness();
      await join(h);

      const netId = packNetId(1, 1);
      h.socket().deliver(snapshot(0, [{ netId, state: entityState({ qx: 10 }) }]));
      h.socket().deliver(
        delta(1, { updates: [{ slot: 1, mask: DeltaMask.X, state: entityState({ qx: 20 }) }] })
      );
      expect(h.service.getEntity(netId)?.qx).toBe(20);

      // Seq 2 never arrived.
      h.socket().deliver(
        delta(3, { updates: [{ slot: 1, mask: DeltaMask.X, state: entityState({ qx: 30 }) }] })
      );
      expect(h.service.isDesynced).toBe(true);
      expect(h.service.hasCompleteSnapshot).toBe(false);
      expect(h.service.getEntity(netId)?.qx).toBe(20);
      expect(countTypeId(h.socket(), MessageTypeIds.ResyncCommand)).toBe(1);

      // Everything hot stays ignored, and no second resync is sent for the same gap.
      h.socket().deliver(
        delta(4, { updates: [{ slot: 1, mask: DeltaMask.X, state: entityState({ qx: 40 }) }] })
      );
      h.socket().deliver(delta(5, { removedSlots: [1] }));
      expect(h.service.getEntity(netId)?.qx).toBe(20);
      expect(countTypeId(h.socket(), MessageTypeIds.ResyncCommand)).toBe(1);
      expect(h.service.stats.seqGaps).toBe(1);

      // The snapshot is the cure: it is accepted even across the gap.
      h.socket().deliver(snapshot(6, [{ netId, state: entityState({ qx: 99 }) }]));
      expect(h.service.isDesynced).toBe(false);
      expect(h.service.hasCompleteSnapshot).toBe(true);
      expect(h.service.getEntity(netId)?.qx).toBe(99);

      // And normal deltas flow again.
      h.socket().deliver(
        delta(7, { updates: [{ slot: 1, mask: DeltaMask.X, state: entityState({ qx: 100 }) }] })
      );
      expect(h.service.getEntity(netId)?.qx).toBe(100);
    });

    it('wraps the sequence counter mod 2^16', async () => {
      const h = createHarness();
      await join(h);

      const netId = packNetId(1, 1);
      h.socket().deliver(snapshot(0xffff, [{ netId, state: entityState({ qx: 1 }) }]));
      h.socket().deliver(
        delta(0, { updates: [{ slot: 1, mask: DeltaMask.X, state: entityState({ qx: 2 }) }] })
      );

      expect(h.service.stats.seqGaps).toBe(0);
      expect(h.service.getEntity(netId)?.qx).toBe(2);
    });

    it('honours the 2/s resync quota', async () => {
      const h = createHarness();
      await join(h);

      expect(h.service.requestResync()).toBe(true);
      expect(h.service.requestResync()).toBe(true);
      expect(h.service.requestResync()).toBe(false);
      expect(h.service.stats.resyncsSent).toBe(2);
      expect(h.service.stats.resyncsSuppressed).toBe(1);

      vi.advanceTimersByTime(1001);
      expect(h.service.requestResync()).toBe(true);
      expect(h.service.stats.resyncsSent).toBe(3);
    });
  });

  describe('publishing and the pump', () => {
    it('does not re-send an entity whose float position moved less than a quantum', async () => {
      const h = createHarness();
      await join(h);
      const netId = packNetId(1, 1);
      const quantizer = h.service.quantizer;
      if (!quantizer) {
        throw new Error('the welcome should have produced a quantizer');
      }

      // One quantum is 4096 / 65535 ≈ 0.0625 world units. Start from a *dequantized* value so the
      // base sits in the middle of its step — the round-trip fixed point — instead of on a rounding
      // boundary, where a nudge of any size legitimately flips the integer.
      const baseX = quantizer.dequantizeX(32_800);
      const baseY = quantizer.dequantizeY(20_000);

      expect(h.service.publish(netId, { x: baseX, y: baseY })).toBe(true);
      vi.advanceTimersByTime(50);
      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(1);

      // Sub-quantum noise: quantizes to the same integers, so nothing is dirty.
      h.service.publish(netId, { x: baseX + 0.001, y: baseY - 0.002 });
      h.service.publish(netId, { x: baseX + 0.02, y: baseY - 0.02 });
      vi.advanceTimersByTime(200);
      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(1);
      expect(h.service.stats.entityRecordsSent).toBe(1);

      // A real move crosses a quantum boundary and goes out.
      h.service.publish(netId, { x: baseX + 5, y: baseY });
      vi.advanceTimersByTime(50);
      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(2);
      expect(h.service.stats.entityRecordsSent).toBe(2);
    });

    it('refuses a non-finite publish and counts it', async () => {
      const h = createHarness();
      await join(h);

      expect(h.service.publish(packNetId(1, 1), { x: Number.NaN, y: 0 })).toBe(false);
      expect(h.service.publish(packNetId(1, 1), { rotation: Number.POSITIVE_INFINITY })).toBe(
        false
      );
      expect(h.service.stats.nonFiniteRejected).toBe(2);

      vi.advanceTimersByTime(100);
      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(0);
    });

    it('splits more than 8 dirty entities across packets (the per-packet quota)', async () => {
      const h = createHarness();
      await join(h);

      for (let i = 1; i <= 9; i += 1) {
        h.service.publish(packNetId(i, 1), { x: i, y: i });
      }
      vi.advanceTimersByTime(50);

      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(2);
      expect(h.service.stats.entityRecordsSent).toBe(9);
    });

    it('runs on an interval — not rAF — and stops on dispose', async () => {
      const h = createHarness();
      await join(h);

      // A heartbeat goes out on the pump, with no animation frame anywhere in sight.
      vi.advanceTimersByTime(50);
      expect(countTypeId(h.socket(), MessageTypeIds.PingCommand)).toBe(1);

      vi.advanceTimersByTime(2000);
      expect(countTypeId(h.socket(), MessageTypeIds.PingCommand)).toBe(2);

      h.service.publish(packNetId(1, 1), { x: 1, y: 1 });
      vi.advanceTimersByTime(50);
      expect(countTypeId(h.socket(), MessageTypeIds.EntityUpdatePacket)).toBe(1);

      const socket = h.socket();
      const sentBefore = socket.sent.length;
      h.service.dispose();
      vi.advanceTimersByTime(60_000);
      expect(socket.sent.length).toBe(sentBefore + 1); // the LeaveCommand, and nothing after it
      expect(socket.typeIds()[sentBefore]).toBe(MessageTypeIds.LeaveCommand);
    });

    it('measures rtt and clock offset from the heartbeat', async () => {
      const h = createHarness();
      await join(h);

      vi.advanceTimersByTime(50);
      const ping = h
        .socket()
        .controlMessages()
        .find(message => message?.typeId === MessageTypeIds.PingCommand);
      expect(ping).toBeDefined();
      const clientTimeMs =
        ping && ping.typeId === MessageTypeIds.PingCommand ? ping.body.clientTimeMs : 0;

      vi.advanceTimersByTime(40);
      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.PongEvent,
          body: { clientTimeMs, serverTimeMs: Date.now() + 1000, serverTick: 1 },
        })
      );

      expect(h.service.rtt).toBe(40);
      expect(h.service.clockOffset).toBeCloseTo(1020, 0);
      expect(h.service.serverTimeMs).toBeCloseTo(Date.now() + 1020, 0);
    });
  });

  describe('reconnect and resume', () => {
    it('presents the resume key on the reconnect Hello', async () => {
      const h = createHarness();
      await join(h);

      h.socket().serverClose(1006, 'blip');
      expect(h.service.status).toBe('reconnecting');

      vi.advanceTimersByTime(100);
      expect(h.sockets).toHaveLength(2);
      h.socket().serverOpen();

      const hello = h.socket().controlMessages()[0];
      expect(hello?.typeId).toBe(MessageTypeIds.HelloCommand);
      if (hello?.typeId === MessageTypeIds.HelloCommand) {
        expect(hello.body.resumeKey).toEqual(new Uint8Array(16).fill(0xa5));
      }
    });

    it('keeps the registry when Resumed is true', async () => {
      const h = createHarness();
      await join(h);
      const netId = packNetId(1, 1);
      h.socket().deliver(snapshot(0, [{ netId, state: entityState({ qx: 33 }) }]));
      expect(h.service.entityCount).toBe(1);

      h.socket().serverClose(1006, 'blip');
      vi.advanceTimersByTime(100);
      h.socket().serverOpen();
      h.socket().deliver(welcome({ resumed: true, resumeKey: new Uint8Array(16).fill(0xb6) }));

      expect(h.service.isOnline).toBe(true);
      expect(h.service.sessionInfo?.resumed).toBe(true);
      expect(h.service.entityCount).toBe(1);
      expect(h.service.getEntity(netId)?.qx).toBe(33);
      // The known set is always rebuilt: the slot table waits for the fresh snapshot.
      expect(h.service.resolveSlot(1)).toBe(0);
      expect(h.service.hasCompleteSnapshot).toBe(false);
    });

    it('clears the registry when Resumed is false', async () => {
      const h = createHarness();
      await join(h);
      h.socket().deliver(snapshot(0, [{ netId: packNetId(1, 1), state: entityState() }]));
      expect(h.service.entityCount).toBe(1);

      h.socket().serverClose(1006, 'blip');
      vi.advanceTimersByTime(100);
      h.socket().serverOpen();
      h.socket().deliver(welcome({ resumed: false }));

      expect(h.service.isOnline).toBe(true);
      expect(h.service.entityCount).toBe(0);
      expect(h.service.hasCompleteSnapshot).toBe(false);
    });

    it('does not retry a permanent rejection', async () => {
      const h = createHarness();
      await join(h);

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.RejectedEvent,
          body: { code: RejectCode.SessionReplaced, message: 'replaced' },
        })
      );
      h.socket().serverClose(4008, 'replaced');

      vi.advanceTimersByTime(60_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.service.status).toBe('offline');
    });

    it('refuses a second connect while the first is still reconnecting', async () => {
      const h = createHarness();
      await join(h);
      h.socket().serverClose(1006, 'blip');
      expect(h.service.status).toBe('reconnecting');

      await expect(
        h.service.connect({ url: 'wss://elsewhere', token: 't', roomId: 'room-2' })
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(h.sockets).toHaveLength(1);
    });

    it('a first welcome claiming Resumed is treated as a fresh join', async () => {
      const h = createHarness();
      await join(h, welcome({ resumed: true }));
      expect(h.service.sessionInfo?.resumed).toBe(false);
    });
  });

  describe('peers, signals and room vars', () => {
    it('tracks peers and host migration', async () => {
      const h = createHarness();
      await join(h);
      const seen: number[] = [];
      h.service.onPeersChange(peers => seen.push(peers.length));

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.PeerJoinedEvent,
          body: { clientId: 9, displayName: 'Bob' },
        })
      );
      expect(h.service.peers).toHaveLength(2);
      expect(h.service.peers[1]).toEqual({ clientId: 9, displayName: 'Bob', isLocal: false });

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.HostChangedEvent,
          body: { hostClientId: 9, previousHostClientId: 7 },
        })
      );
      expect(h.service.hostClientId).toBe(9);
      expect(h.service.isHost).toBe(false);

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.PeerLeftEvent,
          body: { clientId: 9, reason: 1 },
        })
      );
      expect(h.service.peers).toHaveLength(1);
      expect(seen).toEqual([2, 2, 1]);
    });

    it('replaces the peer list with the roster, local client first', async () => {
      const h = createHarness();
      await join(h);
      // A joiner is not in its own PeerJoinedEvent fan-out, so until the roster lands it knows only
      // itself — from the welcome, under the name it asked for.
      expect(h.service.peers).toEqual([{ clientId: 7, displayName: 'Ann', isLocal: true }]);

      const seen: number[] = [];
      h.service.onPeersChange(peers => seen.push(peers.length));

      // The server enumerates its membership in no particular order; `peers` is still local-first.
      h.socket().deliver(
        roster([
          [9, 'Bob'],
          [7, 'Ann'],
          [11, 'Cat'],
        ])
      );

      expect(h.service.peers).toEqual([
        { clientId: 7, displayName: 'Ann', isLocal: true },
        { clientId: 9, displayName: 'Bob', isLocal: false },
        { clientId: 11, displayName: 'Cat', isLocal: false },
      ]);
      expect(seen).toEqual([3]);

      // The peer events keep carrying the deltas on top of it.
      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.PeerLeftEvent,
          body: { clientId: 9, reason: 1 },
        })
      );
      expect(h.service.peers.map(peer => peer.clientId)).toEqual([7, 11]);

      // And a later roster is full state, not a delta: whoever it omits is gone.
      h.socket().deliver(roster([[7, 'Ann']]));
      expect(h.service.peers).toEqual([{ clientId: 7, displayName: 'Ann', isLocal: true }]);
    });

    it('commits a chunked roster only at Final', async () => {
      const h = createHarness();
      await join(h);
      const seen: number[] = [];
      h.service.onPeersChange(peers => seen.push(peers.length));

      h.socket().deliver(
        roster(
          [
            [7, 'Ann'],
            [9, 'Bob'],
          ],
          false
        )
      );

      // Half a full-state message is not a state: nothing is applied and nobody is notified.
      expect(h.service.peers).toEqual([{ clientId: 7, displayName: 'Ann', isLocal: true }]);
      expect(seen).toEqual([]);

      h.socket().deliver(roster([[11, 'Cat']]));

      expect(h.service.peers.map(peer => peer.clientId)).toEqual([7, 9, 11]);
      expect(seen).toEqual([3]);
    });

    it('reconciles the peer list from the roster a resume answers with', async () => {
      const h = createHarness();
      await join(h);
      h.socket().deliver(
        roster([
          [7, 'Ann'],
          [9, 'Bob'],
        ])
      );
      expect(h.service.peers).toHaveLength(2);

      h.socket().serverClose(1006, 'blip');
      vi.advanceTimersByTime(100);
      h.socket().serverOpen();
      h.socket().deliver(welcome({ resumed: true }));

      // A resumed client must not reset its local state to find out what changed…
      expect(h.service.peers.map(peer => peer.clientId)).toEqual([7, 9]);

      // …so the roster is what retires the peer that left inside the grace, whose PeerLeftEvent this
      // client was not connected to receive, and what introduces the one that joined.
      h.socket().deliver(
        roster([
          [7, 'Ann'],
          [12, 'Dee'],
        ])
      );

      expect(h.service.peers).toEqual([
        { clientId: 7, displayName: 'Ann', isLocal: true },
        { clientId: 12, displayName: 'Dee', isLocal: false },
      ]);
    });

    it('routes emitted signals and dispatches inbound ones', async () => {
      const h = createHarness();
      await join(h);

      h.service.emit('shot', { dx: 1 }, { to: 'aoi' });
      h.service.emit('taunt', 'yo', { to: 42 });
      h.service.emit('rules', null, { to: 'server' });
      h.service.emit('hello');

      const emitted = h
        .socket()
        .controlMessages()
        .filter(message => message?.typeId === MessageTypeIds.EmitSignalCommand);
      expect(emitted).toHaveLength(4);
      expect(
        emitted.map(message =>
          message?.typeId === MessageTypeIds.EmitSignalCommand ? message.body.target : -1
        )
      ).toEqual([
        SignalTarget.AoiPeers,
        SignalTarget.SinglePeer,
        SignalTarget.Server,
        SignalTarget.AllPeers,
      ]);

      const received: { payload: string; from: number }[] = [];
      h.service.on('round-started', (payload, from) => {
        received.push({ payload: new TextDecoder().decode(payload), from });
      });
      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.SignalEvent,
          body: {
            senderClientId: 9,
            name: 'round-started',
            payload: new TextEncoder().encode('{"n":2}'),
          },
        })
      );

      expect(received).toEqual([{ payload: '{"n":2}', from: 9 }]);
    });

    it('survives a throwing signal handler', async () => {
      const h = createHarness();
      await join(h);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const seen: number[] = [];

      h.service.on('boom', () => {
        throw new Error('handler blew up');
      });
      h.service.on('boom', (_payload, from) => seen.push(from));

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.SignalEvent,
          body: { senderClientId: 3, name: 'boom', payload: new Uint8Array(0) },
        })
      );

      expect(seen).toEqual([3]);
      expect(h.service.stats.signalHandlerErrors).toBe(1);
      expect(h.service.isOnline).toBe(true);
      errorSpy.mockRestore();
    });

    it('replaces room vars on the first event and merges afterwards', async () => {
      const h = createHarness();
      await join(h);
      const changes: string[][] = [];
      h.service.onRoomVarsChange(keys => changes.push([...keys]));

      const encoder = new TextEncoder();
      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.RoomVarsChangedEvent,
          body: {
            keys: ['matchPhase', 'score'],
            values: [encoder.encode('lobby'), encoder.encode('0')],
          },
        })
      );
      expect(h.service.vars.getText('matchPhase')).toBe('lobby');
      expect(h.service.vars.size).toBe(2);

      h.socket().deliver(
        encodeControlMessage({
          typeId: MessageTypeIds.RoomVarsChangedEvent,
          body: { keys: ['matchPhase'], values: [encoder.encode('round')] },
        })
      );
      expect(h.service.vars.getText('matchPhase')).toBe('round');
      expect(h.service.vars.getText('score')).toBe('0');
      expect(changes).toEqual([['matchPhase', 'score'], ['matchPhase']]);

      // A client write is a request that goes out as SetRoomVarCommand.
      expect(h.service.vars.set('matchPhase', 'results')).toBe(true);
      expect(countTypeId(h.socket(), MessageTypeIds.SetRoomVarCommand)).toBe(1);
    });
  });

  describe('hidden tabs', () => {
    it('tells the server when the tab hides and un-hides', async () => {
      const visibility = new FakeVisibility();
      const h = createHarness({ visibility });
      await join(h);

      visibility.setHidden(true);
      visibility.setHidden(true); // no change, no frame
      visibility.setHidden(false);

      const prefs = h
        .socket()
        .controlMessages()
        .filter(message => message?.typeId === MessageTypeIds.SetClientPrefsCommand)
        .map(message =>
          message?.typeId === MessageTypeIds.SetClientPrefsCommand ? message.body.hidden : null
        );
      expect(prefs).toEqual([true, false]);
    });
  });
});
