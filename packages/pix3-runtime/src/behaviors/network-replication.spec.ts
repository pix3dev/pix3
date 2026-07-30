/**
 * `core:NetworkedNode`, `core:ReplicatedTransform` and the `NetworkNodeBinder` between them, driven
 * through a fake socket, the real codec and fake timers.
 *
 * Two rules this file follows deliberately:
 *
 * - **Every frame goes through the codec** (`net/protocol`), never through hand-written bytes. That
 *   codec is already pinned to the shared golden-vector file, so re-pinning bytes here would only
 *   duplicate a contract test.
 * - **Time is advanced, not frames.** The whole point of a timed interpolation buffer is that the
 *   motion depends on the clock, so the tests move `Date.now` and assert the node followed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkService } from '../net/NetworkService';
import type { WsLikeSocket } from '../net/WsTransport';
import { NetKindTable } from '../net/net-kind-table';
import {
  createEntityWireState,
  createOwnerUpdateRecord,
  createWelcomeEvent,
  decodeControlMessage,
  DELTA_PACKET_HEADER_SIZE,
  DeltaMask,
  encodeControlMessage,
  ENTITY_UPDATE_PACKET_HEADER_SIZE,
  FrameFlags,
  framePayload,
  frameTypeId,
  FULL_RECORD_SIZE,
  MessageTypeIds,
  packNetId,
  patchSectionCount,
  patchSnapshotPacketCount,
  patchSnapshotPacketFrameFlags,
  readOwnerUpdateRecord,
  RejectCode,
  SECTION_COUNT_SIZE,
  SNAPSHOT_PACKET_HEADER_SIZE,
  updateRecordSize,
  WorldQuantizer,
  writeDeltaPacketHeader,
  writeFullRecord,
  writeRemovedSlot,
  writeSectionCountPlaceholder,
  writeSnapshotPacketHeader,
  writeUpdateRecord,
  type EntityWireState,
} from '../net/protocol';
import { SceneService, type SceneServiceDelegate } from '../core/SceneService';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { NetworkedNodeBehavior } from './NetworkedNodeBehavior';
import { ReplicatedTransformBehavior } from './ReplicatedTransformBehavior';

// ── Fake socket ──────────────────────────────────────────────────────────────

class FakeSocket implements WsLikeSocket {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  readonly sent: Uint8Array[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(): void {
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
}

// ── Frame builders (all through the codec) ───────────────────────────────────

const WORLD = { originX: -2048, originY: -2048, size: 4096 };
const LOCAL_CLIENT_ID = 7;
const PEER_CLIENT_ID = 9;
const PLAYER_PREFAB = 'res://prefabs/player.pix3scene';
const BOMB_PREFAB = 'res://prefabs/bomb.pix3scene';
const TICK_HZ = 20;

const quantizer = new WorldQuantizer(WORLD.originX, WORLD.originY, WORLD.size);

function welcomeFrame(): Uint8Array {
  return encodeControlMessage({
    typeId: MessageTypeIds.WelcomeEvent,
    body: {
      ...createWelcomeEvent(),
      clientId: LOCAL_CLIENT_ID,
      roomId: 'room-1',
      tickHz: TICK_HZ,
      serverTimeMs: 1_700_000_000_000,
      aoiRadius: 512,
      maxPlayers: 8,
      protocolVersion: 2,
      worldOriginX: WORLD.originX,
      worldOriginY: WORLD.originY,
      worldSize: WORLD.size,
      maxVisibleEntities: 64,
      hostClientId: LOCAL_CLIENT_ID,
      resumeKey: new Uint8Array(16).fill(0x5a),
    },
  });
}

interface RecordInput {
  netId: number;
  state: EntityWireState;
}

function entityAt(x: number, y: number, overrides: Partial<EntityWireState> = {}): EntityWireState {
  const q = { qx: 0, qy: 0 };
  quantizer.tryQuantizePosition(x, y, q);
  return {
    ...createEntityWireState(),
    kind: 0,
    ownerId: PEER_CLIENT_ID,
    qx: q.qx,
    qy: q.qy,
    ...overrides,
  };
}

function snapshotFrame(seq: number, records: RecordInput[]): Uint8Array {
  const buffer = new ArrayBuffer(SNAPSHOT_PACKET_HEADER_SIZE + records.length * FULL_RECORD_SIZE);
  const view = new DataView(buffer);
  let offset = writeSnapshotPacketHeader(view, 0, seq, 100);
  for (const record of records) {
    offset += writeFullRecord(view, offset, record.netId, record.state);
  }
  patchSnapshotPacketCount(view, records.length);
  patchSnapshotPacketFrameFlags(view, FrameFlags.Final);
  return new Uint8Array(buffer);
}

interface DeltaInput {
  removedSlots?: number[];
  enters?: RecordInput[];
  updates?: { slot: number; mask: number; state: EntityWireState }[];
}

function deltaFrame(seq: number, input: DeltaInput): Uint8Array {
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

/** A position update for an entity already in the client's known set. */
function moveUpdate(slot: number, x: number, y: number, teleport = false) {
  const state = entityAt(x, y);
  return {
    slot,
    mask: DeltaMask.X | DeltaMask.Y | (teleport ? DeltaMask.Teleport : 0),
    state,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * The delegate surface `SceneService` needs. Only `instantiatePrefab` matters here; the rest exist
 * because the interface does, and each one throwing would be worse than a documented stub.
 */
function createDelegate(
  instantiatePrefab: (
    path: string,
    parent?: NodeBase | null,
    instanceId?: string
  ) => Promise<NodeBase>
): SceneServiceDelegate {
  return {
    getActiveCameraNode: () => null,
    getActiveCamera2DNode: () => null,
    getInputService: () => {
      throw new Error('no InputService in this test');
    },
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1280, height: 720 }),
    setActiveCameraNode: () => undefined,
    findNodeById: () => null,
    getRootNodes: () => [],
    getAudioService: () => {
      throw new Error('no AudioService in this test');
    },
    getAssetLoader: () => {
      throw new Error('no AssetLoader in this test');
    },
    getResourceManager: () => {
      throw new Error('no ResourceManager in this test');
    },
    getECSService: () => null,
    getGameTime: () => {
      throw new Error('no GameTime in this test');
    },
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.reject(new Error('no scene loader in this test')),
    instantiatePrefab,
  };
}

interface Harness {
  readonly service: NetworkService;
  readonly scene: SceneService;
  readonly socket: () => FakeSocket;
  /** Prefabs the fake loader was asked for, with the instance id replication chose. */
  readonly instantiated: { path: string; instanceId: string | undefined; node: NodeBase }[];
  /** What the fake loader returns for a path; defaults to a bare Node2D. */
  prefabFactory: (path: string, instanceId: string | undefined) => NodeBase;
}

function createHarness(): Harness {
  const sockets: FakeSocket[] = [];
  const service = new NetworkService({
    socketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    visibility: null,
    kindTable: new NetKindTable([PLAYER_PREFAB, BOMB_PREFAB]),
  });

  const scene = new SceneService();
  scene.setNetworkService(service);

  const harness: Harness = {
    service,
    scene,
    socket: () => {
      const last = sockets[sockets.length - 1];
      if (!last) {
        throw new Error('no socket was created');
      }
      return last;
    },
    instantiated: [],
    prefabFactory: (path, instanceId) => new Node2D({ id: instanceId ?? path }),
  };

  scene.setDelegate(
    createDelegate((path, _parent, instanceId) => {
      const node = harness.prefabFactory(path, instanceId);
      node.scene = scene;
      harness.instantiated.push({ path, instanceId, node });
      return Promise.resolve(node);
    })
  );
  // What `SceneRunner.runGraph` says once the graph is live. The binder refuses to spawn a remote
  // prefab before it, so a harness that stops at `setDelegate` is a scene that never started.
  scene.handleSceneStarted();

  return harness;
}

async function join(h: Harness): Promise<void> {
  const connected = h.service.connect({
    url: 'wss://rooms.example/room-1',
    token: 'dev:ann:room-1',
    roomId: 'room-1',
    displayName: 'Ann',
  });
  h.socket().serverOpen();
  h.socket().deliver(welcomeFrame());
  await connected;
}

/** Attaches a node with the two components to the harness's scene. */
function createNetworkedNode(
  h: Harness,
  config: Record<string, unknown> = {},
  transformConfig: Record<string, unknown> = {}
) {
  const node = new Node2D({ id: 'avatar' });
  node.scene = h.scene;
  const networked = new NetworkedNodeBehavior('networked-1', 'core:NetworkedNode');
  Object.assign(networked.config, { prefabPath: PLAYER_PREFAB }, config);
  const transform = new ReplicatedTransformBehavior('transform-1', 'core:ReplicatedTransform');
  Object.assign(transform.config, transformConfig);
  node.addComponent(networked);
  node.addComponent(transform);
  return { node, networked, transform };
}

/** Answers the spawn request the client just sent. */
async function answerSpawn(
  h: Harness,
  netId: number,
  rejectCode: number = RejectCode.None
): Promise<void> {
  const requests = h
    .socket()
    .sent.map(frame => ({ typeId: frameTypeId(frame), frame }))
    .filter(entry => entry.typeId === MessageTypeIds.SpawnEntityRequest);
  const last = requests[requests.length - 1];
  if (!last) {
    throw new Error('no SpawnEntityRequest was sent');
  }
  const decoded = decodeSpawn(last.frame);
  h.socket().deliver(
    encodeControlMessage({
      typeId: MessageTypeIds.SpawnEntityResponse,
      body: { requestId: decoded.requestId, netId, rejectCode },
    })
  );
  await flushMicrotasks();
}

function decodeSpawn(frame: Uint8Array) {
  const message = decodeControlFrame(frame);
  if (message?.typeId !== MessageTypeIds.SpawnEntityRequest) {
    throw new Error('not a SpawnEntityRequest');
  }
  return message.body;
}

function decodeControlFrame(frame: Uint8Array) {
  return decodeControlMessage(frameTypeId(frame), framePayload(frame));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** The owner update records the pump actually sent, decoded with the codec. */
function sentOwnerUpdates(h: Harness) {
  const record = createOwnerUpdateRecord();
  const results: { netId: number; mask: number; qx: number; qy: number; qrot: number }[] = [];
  for (const frame of h.socket().sent) {
    if (frameTypeId(frame) !== MessageTypeIds.EntityUpdatePacket) {
      continue;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const count = view.getUint8(5);
    let offset = ENTITY_UPDATE_PACKET_HEADER_SIZE;
    for (let i = 0; i < count; i += 1) {
      if (!readOwnerUpdateRecord(view, offset, record)) {
        break;
      }
      offset += record.bytesRead;
      results.push({
        netId: record.netId,
        mask: record.mask,
        qx: record.state.qx,
        qy: record.state.qy,
        qrot: record.state.qrot,
      });
    }
  }
  return results;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('networked node replication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    NodeBase.flushFreeQueue();
  });

  describe('spawning the local avatar', () => {
    it('spawns on start and binds the minted netId', async () => {
      const h = await createJoinedHarness();
      const { node, networked } = createNetworkedNode(h);

      node.tick(0);
      const netId = packNetId(3, 1);
      await answerSpawn(h, netId);

      expect(networked.netId).toBe(netId);
      expect(networked.isBound).toBe(true);
      expect(networked.isMine).toBe(true);
      expect(networked.ownerId).toBe(LOCAL_CLIENT_ID);
      expect(h.scene.netNodes.getNode(netId)).toBe(node);
      expect(h.scene.netNodes.getNetId(node)).toBe(netId);
      // Its own avatar is not a "remote" binding: the binder must never instantiate a second copy.
      expect(h.scene.netNodes.isRemote(netId)).toBe(false);
      expect(h.instantiated).toHaveLength(0);
    });

    it('reports why a refused spawn produced no entity, without throwing', async () => {
      const h = await createJoinedHarness();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { node, networked } = createNetworkedNode(h);

      node.tick(0);
      await answerSpawn(h, 0, RejectCode.EntityLimitReached);

      expect(networked.isBound).toBe(false);
      expect(networked.spawnError?.kind).toBe('entity-limit');
      warn.mockRestore();
    });

    it('does not spawn when spawnOnStart is off', async () => {
      const h = await createJoinedHarness();
      const { node, networked } = createNetworkedNode(h, { spawnOnStart: false });

      node.tick(0);
      await flushMicrotasks();

      expect(networked.isBound).toBe(false);
      expect(h.service.stats.spawnsSent).toBe(0);
    });

    it('despawns and unbinds on detach', async () => {
      const h = await createJoinedHarness();
      const { node, networked } = createNetworkedNode(h);
      node.tick(0);
      const netId = packNetId(3, 1);
      await answerSpawn(h, netId);

      node.removeComponent(networked);

      expect(networked.netId).toBe(0);
      expect(h.scene.netNodes.getNode(netId)).toBeNull();
      expect(h.service.stats.despawnsSent).toBe(1);
      expect(h.service.ownsEntity(netId)).toBe(false);
    });
  });

  describe('a peer entering and leaving', () => {
    it('instantiates the prefab under a net: instance id and frees it on leave', async () => {
      const h = await createJoinedHarness();
      const netId = packNetId(12, 4);

      h.socket().deliver(snapshotFrame(0, [{ netId, state: entityAt(0, 0, { kind: 0 }) }]));
      await flushMicrotasks();

      expect(h.instantiated).toHaveLength(1);
      expect(h.instantiated[0].path).toBe(PLAYER_PREFAB);
      // D6: the same entity derives the same child ids on every client.
      expect(h.instantiated[0].instanceId).toBe(`net:${netId}`);
      const remoteNode = h.instantiated[0].node;
      expect(h.scene.netNodes.getNode(netId)).toBe(remoteNode);
      expect(h.scene.netNodes.isRemote(netId)).toBe(true);

      h.socket().deliver(deltaFrame(1, { removedSlots: [12] }));
      await flushMicrotasks();

      expect(h.scene.netNodes.getNode(netId)).toBeNull();
      expect(h.scene.netNodes.stats.remoteFreed).toBe(1);
      // queueFree, so the node dies at the end of the frame rather than mid-traversal.
      const disposed = vi.spyOn(remoteNode, 'dispose');
      NodeBase.flushFreeQueue();
      expect(disposed).toHaveBeenCalled();
    });

    it('holds an enter that lands before the scene runs, and spawns it when the scene starts', async () => {
      // The join order guarantees this window: the session connects first (a script's onStart must
      // already see `net.isOnline`), so the first snapshot routinely arrives while the scene is
      // still loading. It must be held, not dropped and not counted as a failure.
      const h = await createJoinedHarness();
      h.scene.setDelegate(null);
      h.scene.setDelegate(
        createDelegate((path, _parent, instanceId) => {
          const node = h.prefabFactory(path, instanceId);
          node.scene = h.scene;
          h.instantiated.push({ path, instanceId, node });
          return Promise.resolve(node);
        })
      );
      const netId = packNetId(14, 2);

      h.socket().deliver(snapshotFrame(0, [{ netId, state: entityAt(0, 0, { kind: 0 }) }]));
      await flushMicrotasks();

      expect(h.instantiated).toHaveLength(0);
      expect(h.scene.netNodes.stats.instantiateFailures).toBe(0);

      h.scene.handleSceneStarted();
      await flushMicrotasks();

      expect(h.instantiated).toHaveLength(1);
      expect(h.scene.netNodes.getNode(netId)).toBe(h.instantiated[0].node);
    });

    it('ignores an enter whose kind is not in this build', async () => {
      const h = await createJoinedHarness();
      const netId = packNetId(13, 1);

      h.socket().deliver(snapshotFrame(0, [{ netId, state: entityAt(0, 0, { kind: 900 }) }]));
      await flushMicrotasks();

      expect(h.instantiated).toHaveLength(0);
      expect(h.scene.netNodes.stats.unknownKinds).toBe(1);
      expect(h.service.isOnline).toBe(true);
    });

    it('never instantiates a second node for an entity this client owns', async () => {
      const h = await createJoinedHarness();
      const { node } = createNetworkedNode(h);
      node.tick(0);
      const netId = packNetId(3, 1);
      await answerSpawn(h, netId);

      // The owner sees its own entity in its own AOI set — that enter must not spawn a duplicate.
      h.socket().deliver(
        snapshotFrame(0, [{ netId, state: entityAt(0, 0, { ownerId: LOCAL_CLIENT_ID }) }])
      );
      await flushMicrotasks();

      expect(h.instantiated).toHaveLength(0);
      expect(h.scene.netNodes.getNode(netId)).toBe(node);
    });
  });

  describe('the owner side of core:ReplicatedTransform', () => {
    it('publishes quantized values and renders the node from the dequantized ones', async () => {
      const h = await createJoinedHarness();
      const { node, transform } = createNetworkedNode(h, {}, { sendRateHz: 20 });
      node.tick(0);
      const netId = packNetId(3, 1);
      await answerSpawn(h, netId);

      // A position deliberately off the quantization grid.
      node.position.set(100.031_25 + 0.02, -37.7, 0);
      node.rotation.z = 1.0;
      node.tick(0.05);

      const q = { qx: 0, qy: 0 };
      quantizer.tryQuantizePosition(100.051_25, -37.7, q);
      const expectedX = quantizer.dequantizeX(q.qx);
      const expectedY = quantizer.dequantizeY(q.qy);

      // Rendered from the dequantized values — the owner sees exactly what its peers will.
      expect(node.position.x).toBe(expectedX);
      expect(node.position.y).toBe(expectedY);
      expect(node.position.x).not.toBe(100.051_25);
      expect(transform.isOwner).toBe(true);

      h.service.flush();
      const updates = sentOwnerUpdates(h);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ netId, qx: q.qx, qy: q.qy });
      // The published integers are exactly the ones the node now renders.
      expect(quantizer.dequantizeX(updates[0].qx)).toBe(node.position.x);
    });

    it('publishes at the configured rate, not once per frame', async () => {
      const h = await createJoinedHarness();
      const { node } = createNetworkedNode(h, {}, { sendRateHz: 10 });
      node.tick(0);
      await answerSpawn(h, packNetId(3, 1));

      // Ten 16 ms frames = 160 ms = one 100 ms interval plus change → two sends at most.
      for (let i = 0; i < 10; i += 1) {
        node.position.x += 5;
        node.tick(0.016);
        h.service.flush();
      }

      expect(sentOwnerUpdates(h).length).toBe(1);
    });

    it('sends the Teleport bit for a discontinuity', async () => {
      const h = await createJoinedHarness();
      const { node, transform } = createNetworkedNode(h);
      node.tick(0);
      await answerSpawn(h, packNetId(3, 1));
      // One tick to adopt the netId the async spawn just minted.
      node.tick(0);

      transform.teleportTo(500, -500);
      h.service.flush();

      const updates = sentOwnerUpdates(h);
      expect(updates).toHaveLength(1);
      expect(updates[0].mask & DeltaMask.Teleport).toBe(DeltaMask.Teleport);
    });
  });

  describe('the remote side of core:ReplicatedTransform', () => {
    /** A peer's avatar, already instantiated and bound, with its components started. */
    async function createRemote(interpolationDelayMs = 100) {
      const h = await createJoinedHarness();
      const netId = packNetId(20, 1);
      h.prefabFactory = (_path, instanceId) => {
        const node = new Node2D({ id: instanceId ?? 'remote' });
        const networked = new NetworkedNodeBehavior('n', 'core:NetworkedNode');
        networked.config.prefabPath = PLAYER_PREFAB;
        const transform = new ReplicatedTransformBehavior('t', 'core:ReplicatedTransform');
        transform.config.interpolationDelayMs = interpolationDelayMs;
        node.addComponent(networked);
        node.addComponent(transform);
        return node;
      };

      h.socket().deliver(snapshotFrame(0, [{ netId, state: entityAt(0, 0) }]));
      await flushMicrotasks();

      const node = h.instantiated[0].node;
      const transform = node.getComponent(ReplicatedTransformBehavior);
      if (!transform) {
        throw new Error('the remote prefab has no ReplicatedTransform');
      }
      node.tick(0);
      return { h, node, transform, netId };
    }

    it('binds to the entity the binder instantiated it for, and never publishes', async () => {
      const { h, transform, netId } = await createRemote();

      expect(transform.netId).toBe(netId);
      expect(transform.isOwner).toBe(false);

      h.service.flush();
      expect(sentOwnerUpdates(h)).toHaveLength(0);
    });

    it('interpolates on the clock, not on the frame count', async () => {
      const { h, node, transform } = await createRemote(100);

      // Two samples 100 ms apart: x = 0 at t0, x = 100 at t0 + 100.
      h.socket().deliver(deltaFrame(1, { updates: [moveUpdate(20, 0, 0)] }));
      vi.advanceTimersByTime(100);
      h.socket().deliver(deltaFrame(2, { updates: [moveUpdate(20, 100, 0)] }));
      // The snapshot that introduced the entity seeded a sample too, so three are buffered.
      expect(transform.bufferedSampleCount).toBe(3);

      // Render cursor sits `delay` behind now, so right after the second sample it is at the first.
      node.tick(0.016);
      // Within one quantum (4096/65535 ≈ 0.0625) of the sample, because the wire value *is* the
      // quantized integer.
      expect(node.position.x).toBeCloseTo(0, 1);

      // Advancing the CLOCK by half the sample gap walks the cursor half way — the frame count is
      // irrelevant, which is exactly what a frame-rate-dependent lerp could not promise.
      vi.advanceTimersByTime(50);
      node.tick(0.016);
      expect(node.position.x).toBeCloseTo(50, 0);

      // The same elapsed time delivered in one big frame lands in the same place.
      const halfway = node.position.x;
      vi.advanceTimersByTime(25);
      node.tick(0.5);
      const oneBigFrame = node.position.x;
      expect(oneBigFrame).toBeGreaterThan(halfway);
      expect(oneBigFrame).toBeCloseTo(75, 0);

      // Ticking without advancing the clock moves nothing.
      node.tick(0.016);
      node.tick(0.016);
      expect(node.position.x).toBeCloseTo(oneBigFrame, 6);
    });

    it('snaps on a Teleport record instead of sliding through the world', async () => {
      const { h, node } = await createRemote(100);

      h.socket().deliver(deltaFrame(1, { updates: [moveUpdate(20, 0, 0)] }));
      vi.advanceTimersByTime(100);
      h.socket().deliver(deltaFrame(2, { updates: [moveUpdate(20, 900, -400, true)] }));

      node.tick(0.016);

      // No interpolation window, no half-way position: the node is simply *there*.
      const q = { qx: 0, qy: 0 };
      quantizer.tryQuantizePosition(900, -400, q);
      expect(node.position.x).toBeCloseTo(quantizer.dequantizeX(q.qx), 3);
      expect(node.position.y).toBeCloseTo(quantizer.dequantizeY(q.qy), 3);
    });

    it('derives an adaptive delay of two tick intervals plus jitter', async () => {
      const { transform } = await createRemote(0);

      // TickHz 20 → 50 ms interval → 100 ms of pure cadence before any jitter is measured.
      expect(transform.interpolationDelayMs).toBeCloseTo(100, 5);
    });

    it('unbinds when the entity despawns', async () => {
      const { h, node, transform, netId } = await createRemote();

      h.socket().deliver(deltaFrame(1, { removedSlots: [20] }));
      await flushMicrotasks();

      expect(h.scene.netNodes.getNode(netId)).toBeNull();
      expect(transform.bufferedSampleCount).toBe(0);

      NodeBase.flushFreeQueue();
      // The free drained the subtree's components, which is what unbinds the transform.
      expect(node.components).toHaveLength(0);
      expect(transform.netId).toBe(0);
    });
  });

  describe('anchored 2D layout', () => {
    it('turns anchoring off, because the per-frame reflow would overwrite the position', async () => {
      const h = await createJoinedHarness();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const node = new Node2D({ id: 'anchored', layout: { enabled: true } });
      node.scene = h.scene;
      const transform = new ReplicatedTransformBehavior('t', 'core:ReplicatedTransform');
      node.addComponent(transform);

      expect(node.layoutEnabled).toBe(true);
      node.tick(0);

      expect(node.layoutEnabled).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('anchored layout'));
      warn.mockRestore();
    });
  });
});

async function createJoinedHarness(): Promise<Harness> {
  const h = createHarness();
  await join(h);
  return h;
}
