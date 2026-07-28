import { injectable, inject } from '@/fw/di';
import { setNetworkPrefabTable, type NetPeer, type NetworkStatus } from '@pix3/runtime';
import { appState } from '@/state';
import { collectNetKindPrefabPaths } from '@/core/net-kind-paths';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { PreviewHostService } from '@/services/play/PreviewHostService';

/**
 * "Play Online" — the editor half of a multiplayer session (plan step 1.5).
 *
 * One button has to arrange four things, in this order, and the order is the whole design:
 *
 * 1. **Scan the project for spawnable prefabs** and install the resulting `netKindTable`. The wire
 *    `Kind` is an index into it, so it must exist *before* anything joins, and every participant in
 *    this session gets the same list — the joiners receive it over the preview relay's session
 *    config rather than deriving their own.
 * 2. **Start the preview relay.** In Phase 1 a joiner has no published build to download, so it
 *    streams `res://` assets from this editor exactly as remote preview does. Publishing (Phase 2)
 *    retires this half; the room half is unchanged by it.
 * 3. **Create the room** through pix3-cloud, which is the only party holding the fabric's service
 *    token and signing secret, and mint this editor's host token.
 * 4. **Connect before the scene starts**, so a script's `onStart` already sees `net.isOnline` and
 *    can spawn its avatar without a "wait until connected" dance.
 *
 * The room outlives a scene restart on purpose (D5): restarting a level must not evict everyone.
 * It dies when this session stops, or on the fabric's idle TTL if the editor simply goes away.
 */

const SERVER_BASE_URL = import.meta.env.VITE_COLLAB_SERVER_URL || 'http://localhost:4001';
/** Dev goes same-origin through the Vite proxy; production talks to the collab server directly. */
const API_ORIGIN = import.meta.env.DEV ? '' : SERVER_BASE_URL;

/** Directories never walked when scanning for prefabs — tooling, build output, dependencies. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.pix3',
  'node_modules',
  'dist',
  'build',
  'out',
  '.vscode',
  '.idea',
]);

/** Bounds the project walk so a pathological folder cannot hang the button. */
const MAX_SCAN_ENTRIES = 20_000;

/** The room as pix3-cloud described it. */
export interface OnlineRoomInfo {
  readonly roomId: string;
  readonly wsUrl: string;
  readonly mode: string;
  readonly tickHz: number;
  readonly maxPlayers: number;
  readonly maxVisibleEntities: number;
  readonly aoiRadius: number;
  readonly world: { readonly originX: number; readonly originY: number; readonly size: number };
}

/** What the Game tab card renders. */
export interface OnlineSessionState {
  readonly status: 'idle' | 'starting' | 'online' | 'error';
  /** Live transport status once a session exists; `'offline'` before and after. */
  readonly networkStatus: NetworkStatus;
  readonly room: OnlineRoomInfo | null;
  /** Link (and QR payload) a second player opens. Carries the room id, never a token. */
  readonly joinUrl: string | null;
  readonly clientId: number;
  readonly isHost: boolean;
  readonly peers: readonly NetPeer[];
  /** Smoothed round-trip time in milliseconds. */
  readonly rtt: number;
  /** Replicated entities this client can currently see (AOI-limited). */
  readonly entityCount: number;
  /** Size of the installed prefab kind table. */
  readonly prefabCount: number;
  readonly errorMessage: string | null;
}

interface RoomSessionResponse {
  room: {
    roomId: string;
    mode?: string;
    tickHz?: number;
    maxPlayers?: number;
    maxVisibleEntities?: number;
    aoiRadius?: number;
    world?: { originX: number; originY: number; size: number };
  };
  wsUrl: string;
  token: string;
  expiresAt: number;
  identity?: { displayName?: string };
}

const IDLE_STATE: OnlineSessionState = {
  status: 'idle',
  networkStatus: 'offline',
  room: null,
  joinUrl: null,
  clientId: 0,
  isHost: false,
  peers: [],
  rtt: 0,
  entityCount: 0,
  prefabCount: 0,
  errorMessage: null,
};

@injectable()
export class OnlineSessionService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(PreviewHostService)
  private readonly previewHost!: PreviewHostService;

  @inject(GamePlaySessionService)
  private readonly gamePlaySession!: GamePlaySessionService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  private state: OnlineSessionState = IDLE_STATE;
  private readonly listeners = new Set<(state: OnlineSessionState) => void>();
  private hostToken = '';
  private startPromise: Promise<OnlineSessionState> | null = null;
  private readonly disposers: (() => void)[] = [];
  private pollTimer: number | null = null;

  getState(): OnlineSessionState {
    return this.state;
  }

  isActive(): boolean {
    return this.state.status === 'starting' || this.state.status === 'online';
  }

  subscribe(listener: (state: OnlineSessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Creates the room and joins it. Safe to call twice — the second caller awaits the first.
   * Resolves once this editor is a member; the caller then starts play mode.
   */
  start(): Promise<OnlineSessionState> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.state.status === 'online') {
      return Promise.resolve(this.state);
    }

    const promise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async startInternal(): Promise<OnlineSessionState> {
    this.setState({ status: 'starting', errorMessage: null });

    try {
      const prefabs = await this.collectPrefabPaths();
      // Installing an empty table is legitimate (a game may replicate only authored nodes later),
      // but spawn() will refuse every path, so say so once rather than at the first failed spawn.
      setNetworkPrefabTable(prefabs);
      this.previewHost.setNetKindTable(prefabs);
      if (prefabs.length === 0) {
        this.logger.warn(
          '[Play Online] This project has no spawnable prefabs (nothing under a prefabs/ folder). ' +
            'Nothing can be replicated until one exists.'
        );
      }

      const preview = await this.previewHost.start();
      const session = await this.createRoom(prefabs.length);

      this.hostToken = session.token;
      const room: OnlineRoomInfo = {
        roomId: session.room.roomId,
        wsUrl: session.wsUrl,
        mode: session.room.mode ?? 'Relay',
        tickHz: session.room.tickHz ?? 0,
        maxPlayers: session.room.maxPlayers ?? 0,
        maxVisibleEntities: session.room.maxVisibleEntities ?? 0,
        aoiRadius: session.room.aoiRadius ?? 0,
        world: session.room.world ?? { originX: 0, originY: 0, size: 0 },
      };

      const joinUrl = appendRoomParam(preview.joinUrl, room.roomId);
      this.setState({ room, joinUrl, prefabCount: prefabs.length });

      const network = this.gamePlaySession.getNetworkService();
      this.attachNetworkListeners();

      await network.connect({
        url: room.wsUrl,
        token: session.token,
        roomId: room.roomId,
        displayName: session.identity?.displayName || 'Editor',
      });

      this.setState({ status: 'online', errorMessage: null });
      this.syncFromNetwork();
      this.startPolling();
      this.logger.info(
        `[Play Online] Joined room ${room.roomId} as client ${network.clientId} — invite: ${joinUrl}`
      );

      return this.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.detachNetworkListeners();
      this.setState({ status: 'error', errorMessage: message });
      this.logger.error('[Play Online] Failed to start an online session', error);
      throw error;
    }
  }

  /**
   * Leaves the room and asks pix3-cloud to close it. Closing is a courtesy — the fabric sweeps an
   * empty room on its own TTL — so a failure here is logged, never surfaced as a blocking error.
   */
  async stop(): Promise<void> {
    this.detachNetworkListeners();
    this.stopPolling();
    this.gamePlaySession.getNetworkService().disconnect();

    const roomId = this.state.room?.roomId;
    const token = this.hostToken;
    this.hostToken = '';
    this.setState({ ...IDLE_STATE });

    if (!roomId || !token) {
      return;
    }

    try {
      await fetch(`${API_ORIGIN}/api/rooms/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        credentials: 'include',
      });
    } catch (error) {
      this.logger.warn(
        `[Play Online] Could not close room ${roomId}; it will expire on its idle TTL.`,
        error
      );
    }
  }

  dispose(): void {
    this.detachNetworkListeners();
    this.stopPolling();
    this.listeners.clear();
  }

  // ── Room creation ──────────────────────────────────────────────────────────

  private async createRoom(prefabCount: number): Promise<RoomSessionResponse> {
    const projectId = resolveProjectId();
    // The room's allowlist is the whole kind table: in the editor every prefab in the project is
    // legitimately spawnable. A published build narrows this to what it actually ships.
    const allowedKinds = Array.from({ length: prefabCount }, (_, index) => index);

    const response = await fetch(`${API_ORIGIN}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        projectId,
        buildId: 'editor',
        displayName: 'Editor',
        allowedKinds,
      }),
    });

    const payload = (await response.json().catch(() => null)) as
      | (RoomSessionResponse & { error?: string; message?: string })
      | null;

    if (!response.ok || !payload?.room?.roomId) {
      const detail = payload?.message ?? `HTTP ${response.status}`;
      throw new Error(
        response.status === 503
          ? 'This pix3 cloud has no Room Fabric configured (ROOMS_ADMIN_URL / ROOMS_SERVICE_TOKEN).'
          : `Could not create a room: ${detail}`
      );
    }

    return payload;
  }

  // ── Project scan ───────────────────────────────────────────────────────────

  /** Walks the project folder and returns the canonical prefab list (see `@/core/net-kind-paths`). */
  private async collectPrefabPaths(): Promise<string[]> {
    const found: string[] = [];
    const queue: string[] = ['.'];
    let visited = 0;

    while (queue.length > 0 && visited < MAX_SCAN_ENTRIES) {
      const directory = queue.shift() as string;
      let entries;
      try {
        entries = await this.storage.listDirectory(directory);
      } catch {
        continue;
      }

      for (const entry of entries) {
        visited += 1;
        if (entry.kind === 'directory') {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) {
            queue.push(entry.path);
          }
          continue;
        }
        found.push(entry.path);
      }
    }

    return collectNetKindPrefabPaths(found);
  }

  // ── Live state ─────────────────────────────────────────────────────────────

  private attachNetworkListeners(): void {
    this.detachNetworkListeners();
    const network = this.gamePlaySession.getNetworkService();

    this.disposers.push(
      network.onStatusChange(() => this.syncFromNetwork()),
      network.onPeersChange(() => this.syncFromNetwork()),
      network.onError(error => {
        this.setState({ errorMessage: error.message });
      })
    );
  }

  private detachNetworkListeners(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }

  /** RTT and entity counts change continuously and have no event; 1 Hz is plenty for a card. */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => this.syncFromNetwork(), 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private syncFromNetwork(): void {
    const network = this.gamePlaySession.getNetworkService();
    this.setState({
      networkStatus: network.status,
      clientId: network.clientId,
      isHost: network.isHost,
      peers: network.peers,
      rtt: Math.round(network.rtt),
      entityCount: network.entityCount,
    });
  }

  private setState(patch: Partial<OnlineSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

/** The join link carries only the room id — each joiner mints its own guest token. */
function appendRoomParam(joinUrl: string, roomId: string): string {
  const separator = joinUrl.includes('?') ? '&' : '?';
  return `${joinUrl}${separator}room=${encodeURIComponent(roomId)}`;
}

/**
 * A stable-ish id for the project, used by the fabric for grouping and quotas. A cloud project has a
 * real id; a local folder only has its name, which is good enough for a dev session.
 */
function resolveProjectId(): string {
  const id = appState.project.id ?? '';
  if (id) {
    return id.slice(0, 128);
  }
  const name = (appState.project.projectName ?? 'pix3-project').replace(/[^A-Za-z0-9_-]+/g, '-');
  return name.slice(0, 128) || 'pix3-project';
}
