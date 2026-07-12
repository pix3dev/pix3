import { injectable, inject } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { createDefaultQualitySettings, DEFAULT_TARGET_PLATFORM } from '@/core/ProjectManifest';
import {
  buildPreviewWsUrl,
  encodeBinaryFrame,
  guessMimeType,
  sha256Hex,
  type FileRequestMessage,
  type FileResponseHeader,
  type PreviewDeviceInfo,
  type PreviewJsonMessage,
  type PreviewLogEntryPayload,
  type PreviewMetricsSample,
  type PreviewPlayModeStatus,
  type PreviewSessionConfig,
  type ScriptBundleHeader,
} from '@/core/remote-preview/protocol';
import { ProjectStorageService } from './ProjectStorageService';
import { ScriptCompilerService } from './ScriptCompilerService';
import { LoggingService } from './LoggingService';
import { RemotePreviewTelemetryService } from './RemotePreviewTelemetryService';

export interface PreviewHostSessionInfo {
  readonly sessionId: string;
  readonly joinUrl: string;
  readonly agentToken: string;
  readonly expiresAt: number;
  /** Origin the session's HTTP API + relay live on (this editor's view of it). */
  readonly apiOrigin: string;
}

export interface PreviewHostState {
  readonly status: 'idle' | 'connecting' | 'online' | 'error';
  readonly session: PreviewHostSessionInfo | null;
  readonly playerCount: number;
  readonly errorMessage: string | null;
}

interface CreateSessionResponse {
  sessionId: string;
  hostToken: string;
  agentToken: string;
  guestToken: string;
  expiresAt: number;
  joinPath: string;
  serverUrl?: string | null;
}

/**
 * Where this editor reaches the preview server. Mirrors the ApiClient
 * convention: dev goes same-origin through the Vite proxy (target =
 * VITE_COLLAB_SERVER_URL, e.g. https://cloud.pix3.dev), production talks to
 * VITE_COLLAB_SERVER_URL directly. Empty string means same-origin.
 */
function resolvePreviewApiOrigin(): string {
  if (import.meta.env.DEV) {
    return '';
  }

  const configured = (import.meta.env.VITE_COLLAB_SERVER_URL as string | undefined)?.trim();
  return (configured || 'http://localhost:4001').replace(/\/+$/, '');
}

/**
 * Public base URL of the player page used in join links/QR (e.g. the deployed
 * editor origin, so phones can open it while this editor runs on localhost).
 * Defaults to this editor's own origin.
 */
function resolvePlayerBaseUrl(): string {
  const configured = (import.meta.env.VITE_PREVIEW_PLAYER_URL as string | undefined)?.trim();
  return (configured || location.origin).replace(/\/+$/, '');
}

const SCENE_UPDATE_DEBOUNCE_MS = 400;
const RECONNECT_DELAY_MS = 2000;
const SCRIPT_ENTRY_PATTERN = /extends\s+Script\b/;
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;

/**
 * Editor side of the remote preview relay: owns the preview session, serves
 * `res://` file requests from standalone players out of the local FS handle,
 * ships the compiled user-script bundle, and pushes `scene-updated` when
 * project files change (editor saves and external/agent edits both surface
 * through `fileRefreshSignal`).
 */
@injectable()
export class PreviewHostService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(RemotePreviewTelemetryService)
  private readonly telemetry!: RemotePreviewTelemetryService;

  private socket: WebSocket | null = null;
  private hostToken = '';
  private state: PreviewHostState = {
    status: 'idle',
    session: null,
    playerCount: 0,
    errorMessage: null,
  };
  private readonly listeners = new Set<(state: PreviewHostState) => void>();
  private scriptBundle: { code: string; hash: string } | null = null;
  private disposeProjectSubscription?: () => void;
  private disposeScenesSubscription?: () => void;
  private lastFileRefreshSignal = 0;
  private lastActiveScenePath = '';
  private updateTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private stopping = false;

  getState(): PreviewHostState {
    return this.state;
  }

  isActive(): boolean {
    return this.state.status === 'connecting' || this.state.status === 'online';
  }

  subscribe(listener: (state: PreviewHostState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Create (or reuse) the preview session and connect as host. */
  async start(): Promise<PreviewHostSessionInfo> {
    if (this.state.session && this.isActive()) {
      return this.state.session;
    }

    this.stopping = false;
    this.setState({ status: 'connecting', errorMessage: null });

    try {
      const session = this.state.session ?? (await this.createSession());
      this.setState({ session });
      await this.connect(session);
      this.watchProjectChanges();
      await this.writeSessionFile(session);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: 'error', errorMessage: message });
      throw error;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.updateTimer !== null) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    this.disposeScenesSubscription?.();
    this.disposeScenesSubscription = undefined;
    this.socket?.close();
    this.socket = null;
    this.scriptBundle = null;
    this.hostToken = '';
    void this.removeSessionFile();
    this.telemetry.reset();
    this.setState({ status: 'idle', session: null, playerCount: 0, errorMessage: null });
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  /** Broadcast a restart to all connected players. */
  requestPlayersRestart(): void {
    this.sendJson({ type: 'restart' });
  }

  // ── Session / connection ───────────────────────────────────────────────────

  private async createSession(): Promise<PreviewHostSessionInfo> {
    const apiOrigin = resolvePreviewApiOrigin();
    const response = await fetch(`${apiOrigin}/api/preview/sessions`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(
        `Failed to create a preview session (HTTP ${response.status}). Is the collab server running?`
      );
    }

    const payload = (await response.json()) as CreateSessionResponse;
    this.hostToken = payload.hostToken;

    // When the server advertises its public origin (PREVIEW_PUBLIC_URL, e.g.
    // https://cloud.pix3.dev), bake it into the join link so the player
    // connects to that relay directly no matter where the page is hosted.
    const serverUrl = (payload.serverUrl ?? '').replace(/\/+$/, '');
    const relaySuffix = serverUrl ? `&relay=${encodeURIComponent(serverUrl)}` : '';

    return {
      sessionId: payload.sessionId,
      joinUrl: `${resolvePlayerBaseUrl()}${payload.joinPath}${relaySuffix}`,
      agentToken: payload.agentToken,
      expiresAt: payload.expiresAt,
      apiOrigin: serverUrl || apiOrigin || location.origin,
    };
  }

  private async connect(session: PreviewHostSessionInfo): Promise<void> {
    const wsUrl = buildPreviewWsUrl(
      resolvePreviewApiOrigin() || location.origin,
      session.sessionId,
      this.hostToken
    );

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.setState({ status: 'online', errorMessage: null });
        void this.publishSessionState();
        resolve();
      });

      socket.addEventListener('message', event => {
        if (typeof event.data === 'string') {
          void this.handleTextMessage(event.data);
        }
      });

      socket.addEventListener('close', () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        if (this.stopping) {
          return;
        }
        this.setState({ status: 'connecting' });
        this.scheduleReconnect();
        reject(new Error('Preview connection closed'));
      });

      socket.addEventListener('error', () => {
        // close handler drives the retry.
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== null || !this.state.session) {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const session = this.state.session;
      if (!session || this.stopping) {
        return;
      }
      this.connect(session).catch(() => {
        // scheduleReconnect re-arms from the close handler.
      });
    }, RECONNECT_DELAY_MS);
  }

  // ── Incoming messages ──────────────────────────────────────────────────────

  private async handleTextMessage(raw: string): Promise<void> {
    let message: PreviewJsonMessage;
    try {
      message = JSON.parse(raw) as PreviewJsonMessage;
    } catch {
      return;
    }

    const from = typeof message.from === 'string' ? message.from : '';

    switch (message.type) {
      case 'hello':
      case 'peer-status': {
        const playerCount = typeof message.playerCount === 'number' ? message.playerCount : 0;
        this.setState({ playerCount });
        this.telemetry.handlePlayerCount(playerCount);
        break;
      }
      case 'file-request':
        await this.handleFileRequest(message as FileRequestMessage);
        break;
      case 'log': {
        const entries = Array.isArray(message.entries) ? message.entries : [];
        if (from) {
          this.telemetry.handleLogEntries(from, entries as PreviewLogEntryPayload[]);
        }
        break;
      }
      case 'metrics': {
        if (from && message.sample && typeof message.sample === 'object') {
          this.telemetry.handleMetrics(from, message.sample as PreviewMetricsSample);
        }
        break;
      }
      case 'status': {
        if (from && typeof message.playModeStatus === 'string') {
          this.telemetry.handleStatus(
            from,
            message.playModeStatus as PreviewPlayModeStatus,
            typeof message.detail === 'string' ? message.detail : undefined
          );
        }
        break;
      }
      case 'device-info': {
        if (from && message.info && typeof message.info === 'object') {
          this.telemetry.handleDeviceInfo(from, message.info as PreviewDeviceInfo);
        }
        break;
      }
      case 'command':
        await this.handleAgentCommand(message);
        break;
      default:
        break;
    }
  }

  /**
   * Agent HTTP API commands routed to the host. `reload-from-disk` recompiles
   * the script bundle and pushes `scene-updated`; players then re-read every
   * file straight from the on-disk project, so agent edits land without the
   * editor UI having to reload anything itself.
   */
  private async handleAgentCommand(message: PreviewJsonMessage): Promise<void> {
    const commandId = typeof message.commandId === 'string' ? message.commandId : '';
    const action = typeof message.action === 'string' ? message.action : '';
    if (!commandId) {
      return;
    }

    if (action !== 'reload-from-disk') {
      this.sendJson({
        type: 'command-ack',
        commandId,
        ok: false,
        error: `unknown host action: ${action}`,
      });
      return;
    }

    try {
      await this.publishSessionState(true);
      this.sendJson({ type: 'command-ack', commandId, ok: true, result: { reloaded: true } });
    } catch (error) {
      this.sendJson({
        type: 'command-ack',
        commandId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleFileRequest(message: FileRequestMessage): Promise<void> {
    const requestId = message.requestId;
    const target = message.from ?? '';
    const path = (message.path ?? '').replace(/^res:\/\//i, '').replace(/^\/+/, '');

    const respond = (
      header: Omit<FileResponseHeader, 'type' | 'requestId' | 'to' | 'path'>,
      payload?: Uint8Array
    ): void => {
      this.sendBinary(
        {
          type: 'file-response',
          requestId,
          to: target,
          path,
          ...header,
        },
        payload ?? new Uint8Array(0)
      );
    };

    if (!path || path.split('/').includes('..')) {
      respond({ ok: false, error: `Invalid path: ${message.path}` });
      return;
    }

    try {
      const blob = await this.storage.readBlob(path);
      const buffer = await blob.arrayBuffer();
      const hash = await sha256Hex(buffer);

      if (message.knownHash && message.knownHash === hash) {
        respond({ ok: true, hash, notModified: true });
        return;
      }

      respond(
        { ok: true, hash, mimeType: blob.type || guessMimeType(path) },
        new Uint8Array(buffer)
      );
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ── Publishing project state to players ────────────────────────────────────

  private watchProjectChanges(): void {
    if (this.disposeProjectSubscription) {
      return;
    }

    this.lastFileRefreshSignal = appState.project.fileRefreshSignal ?? 0;
    this.lastActiveScenePath = this.resolveEntryScenePath();

    this.disposeProjectSubscription = subscribe(appState.project, () => {
      const signal = appState.project.fileRefreshSignal ?? 0;
      if (signal !== this.lastFileRefreshSignal) {
        this.lastFileRefreshSignal = signal;
        this.queueSceneUpdate();
      }
    });

    this.disposeScenesSubscription = subscribe(appState.scenes, () => {
      const entryScenePath = this.resolveEntryScenePath();
      if (entryScenePath && entryScenePath !== this.lastActiveScenePath) {
        this.lastActiveScenePath = entryScenePath;
        this.queueSceneUpdate();
      }
    });
  }

  private queueSceneUpdate(): void {
    if (this.updateTimer !== null) {
      window.clearTimeout(this.updateTimer);
    }

    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = null;
      void this.publishSessionState(true);
    }, SCENE_UPDATE_DEBOUNCE_MS);
  }

  /** Send session-config (+ script bundle when changed), optionally followed by scene-updated. */
  private async publishSessionState(notifySceneUpdated = false): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const bundle = await this.compileScriptBundle();
      const bundleChanged = bundle?.hash !== this.scriptBundle?.hash;
      this.scriptBundle = bundle;

      const config = this.buildSessionConfig(bundle?.hash ?? null);
      this.sendJson({ type: 'session-config', config });

      if (bundle && bundleChanged) {
        const header: ScriptBundleHeader = { type: 'script-bundle', hash: bundle.hash };
        this.sendBinary(header, new TextEncoder().encode(bundle.code));
      }

      if (notifySceneUpdated) {
        this.sendJson({ type: 'scene-updated' });
      }
    } catch (error) {
      this.logger.error('[Remote Preview] Failed to publish project state to players', error);
    }
  }

  private buildSessionConfig(scriptBundleHash: string | null): PreviewSessionConfig {
    const manifest = appState.project.manifest;
    const quality = manifest?.quality ?? createDefaultQualitySettings(DEFAULT_TARGET_PLATFORM);

    return {
      projectName: appState.project.projectName ?? 'Pix3 Project',
      entryScenePath: this.resolveEntryScenePath(),
      viewportBaseSize: {
        width: manifest?.viewportBaseSize?.width ?? 1920,
        height: manifest?.viewportBaseSize?.height ?? 1080,
      },
      quality: {
        antialias: quality.antialias,
        shadows: quality.shadows,
        maxPixelRatio: quality.maxPixelRatio,
      },
      scriptBundleHash,
    };
  }

  private resolveEntryScenePath(): string {
    const activeSceneId = appState.scenes.activeSceneId;
    const activeDescriptor = activeSceneId ? appState.scenes.descriptors[activeSceneId] : null;
    const activePath = activeDescriptor?.filePath ?? '';
    if (activePath) {
      return activePath.replace(/^res:\/\//i, '');
    }

    const configured = appState.project.manifest?.defaultExportScenePath ?? '';
    if (configured) {
      return configured.replace(/^res:\/\//i, '');
    }

    const firstDescriptor = Object.values(appState.scenes.descriptors)[0];
    return (firstDescriptor?.filePath ?? '').replace(/^res:\/\//i, '');
  }

  // ── Agent handshake file ───────────────────────────────────────────────────

  /**
   * `.pix3/preview-session.json` is the agent's entry point: a CLI agent
   * working in the project folder finds it and drives the session over the
   * HTTP API with the agent token (see the pix3-remote-preview skill).
   */
  private async writeSessionFile(session: PreviewHostSessionInfo): Promise<void> {
    try {
      try {
        await this.storage.createDirectory('.pix3');
      } catch {
        // Directory already exists.
      }

      const payload = {
        sessionId: session.sessionId,
        // Prefers the server's advertised public origin (agents can then hit
        // e.g. cloud.pix3.dev directly, independent of this dev server).
        apiBaseUrl: `${session.apiOrigin}/api/preview`,
        agentToken: session.agentToken,
        joinUrl: session.joinUrl,
        expiresAt: session.expiresAt,
      };
      await this.storage.writeTextFile(
        '.pix3/preview-session.json',
        JSON.stringify(payload, null, 2) + '\n'
      );
    } catch (error) {
      this.logger.warn(
        '[Remote Preview] Could not write .pix3/preview-session.json (agent HTTP API discovery)',
        error
      );
    }
  }

  private async removeSessionFile(): Promise<void> {
    try {
      await this.storage.deleteEntry('.pix3/preview-session.json');
    } catch {
      // Nothing to remove.
    }
  }

  // ── Script bundle ──────────────────────────────────────────────────────────

  private async compileScriptBundle(): Promise<{ code: string; hash: string } | null> {
    const files = await this.collectScriptFiles();
    if (files.size === 0) {
      return null;
    }

    const entryFiles = Array.from(files.entries())
      .filter(([, content]) => SCRIPT_ENTRY_PATTERN.test(content))
      .map(([path]) => path);
    if (entryFiles.length === 0) {
      return null;
    }

    const result = await this.compiler.bundle(files, entryFiles, async filePath => {
      try {
        return await this.storage.readTextFile(filePath);
      } catch {
        return null;
      }
    });

    if (!result.code || result.code.trim().length === 0) {
      return null;
    }

    const hash = await sha256Hex(new TextEncoder().encode(result.code));
    return { code: result.code, hash };
  }

  private async collectScriptFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();

    for (const directory of SCRIPT_DIRECTORIES) {
      const paths = await this.collectScriptPaths(directory);
      for (const path of paths) {
        try {
          files.set(path, await this.storage.readTextFile(path));
        } catch {
          // Files disappearing mid-scan are fine.
        }
      }
    }

    return files;
  }

  private async collectScriptPaths(directory: string): Promise<string[]> {
    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.storage.listDirectory(directory);
    } catch {
      return [];
    }

    const result: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        result.push(...(await this.collectScriptPaths(entry.path)));
        continue;
      }

      const lower = entry.path.toLowerCase();
      if (!lower.endsWith('.ts') && !lower.endsWith('.js')) {
        continue;
      }
      if (EXCLUDED_SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix))) {
        continue;
      }

      result.push(entry.path);
    }

    return result;
  }

  // ── Low-level send helpers ─────────────────────────────────────────────────

  private sendJson(message: PreviewJsonMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private sendBinary(header: PreviewJsonMessage, payload: Uint8Array): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(encodeBinaryFrame(header, payload));
    }
  }

  private setState(patch: Partial<PreviewHostState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
