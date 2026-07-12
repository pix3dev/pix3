import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  sha256Hex,
  type FileResponseHeader,
  type PreviewDeviceInfo,
  type PreviewJsonMessage,
  type PreviewLogEntryPayload,
  type PreviewMetricsSample,
  type PreviewPlayModeStatus,
  type PreviewSessionConfig,
  type ScreenshotHeader,
  type ScriptBundleHeader,
} from '@/core/remote-preview/protocol';

export interface PreviewFileProvider {
  readFile(path: string): Promise<Uint8Array>;
  readFileWithMeta(path: string): Promise<{ bytes: Uint8Array; mimeType: string; hash: string }>;
}

export interface PreviewPlayerClientEvents {
  onSessionConfig(config: PreviewSessionConfig): void;
  onScriptBundle(code: string, hash: string): void;
  onSceneUpdated(changedPaths: readonly string[] | null): void;
  onRestartRequested(): void;
  onScreenshotRequested(requestId: string | null): void;
  onConnectionStateChanged(state: PreviewConnectionState): void;
  /** Agent HTTP API command routed to this player; respond via sendCommandAck. */
  onCommand(commandId: string, action: string, params: unknown): void;
}

export type PreviewConnectionState =
  | 'connecting'
  | 'connected'
  | 'host-offline'
  | 'disconnected'
  | 'unauthorized';

interface PendingFileRequest {
  resolve(value: { bytes: Uint8Array; mimeType: string; hash: string; notModified: boolean }): void;
  reject(error: Error): void;
  timeoutId: number;
}

interface CachedFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly hash: string;
}

const FILE_REQUEST_TIMEOUT_MS = 30_000;
const FILE_CACHE_NAME = 'pix3-preview-files';
const LOG_FLUSH_INTERVAL_MS = 500;
const MAX_LOG_MESSAGE_LENGTH = 4000;
/**
 * Cap per flush window so a game logging every frame cannot flood the relay or
 * spend device CPU stringifying — the overflow is dropped and counted.
 */
const MAX_LOGS_PER_FLUSH = 25;
const RECONNECT_DELAY_MS = 2000;

/**
 * WebSocket client of the standalone player: talks to the editor host through
 * the collab server's `/preview` relay. Responsible for the file transfer
 * (request/response with content-hash revalidation + Cache API persistence),
 * log/metrics/status reporting, and surfacing host push messages.
 */
export class PreviewPlayerClient implements PreviewFileProvider {
  private socket: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly events: PreviewPlayerClientEvents;
  private readonly pendingFiles = new Map<string, PendingFileRequest>();
  private readonly memoryCache = new Map<string, CachedFile>();
  /** path → last known content hash (persisted so Cache API entries survive reloads). */
  private hashesByPath = new Map<string, string>();
  private readonly hashStorageKey: string;
  private nextRequestId = 0;
  private hostOnline = false;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private readonly pendingLogs: PreviewLogEntryPayload[] = [];
  private logFlushTimer: number | null = null;
  private droppedLogCount = 0;
  private deviceInfo: PreviewDeviceInfo | null = null;

  constructor(sessionId: string, wsUrl: string, events: PreviewPlayerClientEvents) {
    this.wsUrl = wsUrl;
    this.events = events;
    this.hashStorageKey = `pix3-preview-hashes:${sessionId}`;
    this.restoreHashes();
  }

  connect(): void {
    if (this.disposed) {
      return;
    }

    this.events.onConnectionStateChanged('connecting');
    const socket = new WebSocket(this.wsUrl);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.events.onConnectionStateChanged(this.hostOnline ? 'connected' : 'host-offline');
      this.sendDeviceInfo();
    });

    socket.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else if (typeof event.data === 'string') {
        this.handleTextMessage(event.data);
      }
    });

    socket.addEventListener('close', event => {
      this.rejectAllPending(new Error('preview connection closed'));
      if (this.disposed) {
        return;
      }

      if (event.code === 4001 || event.code === 1008) {
        this.events.onConnectionStateChanged('unauthorized');
        return;
      }

      this.events.onConnectionStateChanged('disconnected');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The close handler drives reconnects; nothing else to do here.
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.logFlushTimer !== null) {
      window.clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    this.rejectAllPending(new Error('preview client disposed'));
    this.socket?.close();
    this.socket = null;
  }

  isHostOnline(): boolean {
    return this.hostOnline;
  }

  // ── PreviewFileProvider ────────────────────────────────────────────────────

  async readFile(path: string): Promise<Uint8Array> {
    const file = await this.readFileWithMeta(path);
    return file.bytes;
  }

  async readFileWithMeta(
    path: string
  ): Promise<{ bytes: Uint8Array; mimeType: string; hash: string }> {
    const cached = this.memoryCache.get(path);
    if (cached) {
      return cached;
    }

    const knownHash = this.hashesByPath.get(path);
    const response = await this.requestFile(path, knownHash);

    if (response.notModified && knownHash) {
      const persisted = await this.readFromPersistentCache(knownHash);
      if (persisted) {
        const file: CachedFile = {
          bytes: persisted.bytes,
          mimeType: persisted.mimeType,
          hash: knownHash,
        };
        this.memoryCache.set(path, file);
        return file;
      }

      // The persistent cache lost the payload — re-request without a hash.
      const fresh = await this.requestFile(path, undefined);
      return this.storeFile(path, fresh);
    }

    return this.storeFile(path, response);
  }

  /** Drop cached content so the next read re-fetches (hash revalidation keeps transfers cheap). */
  invalidateFiles(changedPaths: readonly string[] | null): void {
    if (changedPaths === null) {
      this.memoryCache.clear();
      return;
    }

    for (const rawPath of changedPaths) {
      const path = rawPath.replace(/^res:\/\//i, '').replace(/^\/+/, '');
      this.memoryCache.delete(path);
      this.hashesByPath.delete(path);
    }
    this.persistHashes();
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  /** Remembered and (re)sent whenever a connection or host appears. */
  setDeviceInfo(info: PreviewDeviceInfo): void {
    this.deviceInfo = info;
    this.sendDeviceInfo();
  }

  reportLog(level: PreviewLogEntryPayload['level'], message: string): void {
    if (this.pendingLogs.length >= MAX_LOGS_PER_FLUSH) {
      this.droppedLogCount += 1;
      return;
    }

    this.pendingLogs.push({
      level,
      message:
        message.length > MAX_LOG_MESSAGE_LENGTH
          ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}…`
          : message,
      timestamp: Date.now(),
    });

    if (this.logFlushTimer === null) {
      this.logFlushTimer = window.setTimeout(() => {
        this.logFlushTimer = null;
        this.flushLogs();
      }, LOG_FLUSH_INTERVAL_MS);
    }
  }

  reportMetrics(sample: PreviewMetricsSample): void {
    this.sendJson({ type: 'metrics', sample });
  }

  reportStatus(playModeStatus: PreviewPlayModeStatus, detail?: string): void {
    this.sendJson({ type: 'status', playModeStatus, ...(detail ? { detail } : {}) });
  }

  sendCommandAck(commandId: string, ok: boolean, result?: unknown, error?: string): void {
    this.sendJson({
      type: 'command-ack',
      commandId,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    });
  }

  sendScreenshot(blob: Blob, requestId: string | null): void {
    void blob.arrayBuffer().then(buffer => {
      const header: ScreenshotHeader = {
        type: 'screenshot',
        mimeType: blob.type || 'image/jpeg',
        ...(requestId ? { requestId } : {}),
      };
      this.sendBinary(header, new Uint8Array(buffer));
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private handleTextMessage(raw: string): void {
    let message: PreviewJsonMessage;
    try {
      message = JSON.parse(raw) as PreviewJsonMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'hello':
      case 'peer-status': {
        const hostOnline = message.hostOnline === true;
        const changed = hostOnline !== this.hostOnline;
        this.hostOnline = hostOnline;
        if (changed || message.type === 'hello') {
          this.events.onConnectionStateChanged(hostOnline ? 'connected' : 'host-offline');
        }
        // The relay only forwards to a live host, so (re)introduce this device
        // whenever a host (re)appears.
        if (changed && hostOnline) {
          this.sendDeviceInfo();
        }
        break;
      }
      case 'session-config': {
        const config = message.config as PreviewSessionConfig | undefined;
        if (config && typeof config.entryScenePath === 'string') {
          this.events.onSessionConfig(config);
        }
        break;
      }
      case 'scene-updated': {
        const changedPaths = Array.isArray(message.changedPaths)
          ? (message.changedPaths as string[])
          : null;
        this.invalidateFiles(changedPaths);
        this.events.onSceneUpdated(changedPaths);
        break;
      }
      case 'restart':
        this.events.onRestartRequested();
        break;
      case 'screenshot-request':
        this.events.onScreenshotRequested(
          typeof message.requestId === 'string' ? message.requestId : null
        );
        break;
      case 'command': {
        if (typeof message.commandId === 'string' && typeof message.action === 'string') {
          this.events.onCommand(message.commandId, message.action, message.params);
        }
        break;
      }
      case 'file-response-error': {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const pending = this.pendingFiles.get(requestId);
        if (pending) {
          this.pendingFiles.delete(requestId);
          window.clearTimeout(pending.timeoutId);
          pending.reject(new Error(String(message.error ?? 'file request failed')));
        }
        break;
      }
      default:
        break;
    }
  }

  private handleBinaryMessage(frame: ArrayBuffer): void {
    const decoded = decodeBinaryFrame(frame);
    if (!decoded) {
      return;
    }

    if (decoded.header.type === 'file-response') {
      this.handleFileResponse(decoded.header as FileResponseHeader, decoded.payload);
      return;
    }

    if (decoded.header.type === 'script-bundle') {
      const header = decoded.header as ScriptBundleHeader;
      const code = new TextDecoder().decode(decoded.payload);
      this.events.onScriptBundle(code, header.hash);
    }
  }

  private handleFileResponse(header: FileResponseHeader, payload: Uint8Array): void {
    const pending = this.pendingFiles.get(header.requestId);
    if (!pending) {
      return;
    }

    this.pendingFiles.delete(header.requestId);
    window.clearTimeout(pending.timeoutId);

    if (!header.ok) {
      pending.reject(new Error(header.error ?? `Failed to load ${header.path}`));
      return;
    }

    pending.resolve({
      bytes: payload,
      mimeType: header.mimeType ?? 'application/octet-stream',
      hash: header.hash ?? '',
      notModified: header.notModified === true,
    });
  }

  private requestFile(
    path: string,
    knownHash: string | undefined
  ): Promise<{ bytes: Uint8Array; mimeType: string; hash: string; notModified: boolean }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('preview connection is not open'));
        return;
      }

      const requestId = `file-${this.nextRequestId++}`;
      const timeoutId = window.setTimeout(() => {
        this.pendingFiles.delete(requestId);
        reject(new Error(`Timed out loading ${path}`));
      }, FILE_REQUEST_TIMEOUT_MS);

      this.pendingFiles.set(requestId, { resolve, reject, timeoutId });
      this.sendJson({
        type: 'file-request',
        requestId,
        path,
        ...(knownHash ? { knownHash } : {}),
      });
    });
  }

  private async storeFile(
    path: string,
    response: { bytes: Uint8Array; mimeType: string; hash: string }
  ): Promise<CachedFile> {
    const file: CachedFile = {
      bytes: response.bytes,
      mimeType: response.mimeType,
      hash: response.hash || (await sha256Hex(response.bytes)),
    };

    this.memoryCache.set(path, file);
    this.hashesByPath.set(path, file.hash);
    this.persistHashes();
    void this.writeToPersistentCache(file);
    return file;
  }

  private async readFromPersistentCache(
    hash: string
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    try {
      const cache = await caches.open(FILE_CACHE_NAME);
      const response = await cache.match(this.cacheKeyForHash(hash));
      if (!response) {
        return null;
      }

      const buffer = await response.arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  private async writeToPersistentCache(file: CachedFile): Promise<void> {
    try {
      const cache = await caches.open(FILE_CACHE_NAME);
      const bytes = new Uint8Array(file.bytes.byteLength);
      bytes.set(file.bytes);
      await cache.put(
        this.cacheKeyForHash(file.hash),
        new Response(new Blob([bytes]), { headers: { 'content-type': file.mimeType } })
      );
    } catch {
      // Persistent caching is best-effort (e.g. private browsing).
    }
  }

  private cacheKeyForHash(hash: string): string {
    return `${location.origin}/__pix3_preview__/${hash}`;
  }

  private restoreHashes(): void {
    try {
      const raw = localStorage.getItem(this.hashStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      this.hashesByPath = new Map(Object.entries(parsed));
    } catch {
      this.hashesByPath = new Map();
    }
  }

  private persistHashes(): void {
    try {
      localStorage.setItem(
        this.hashStorageKey,
        JSON.stringify(Object.fromEntries(this.hashesByPath))
      );
    } catch {
      // Best-effort persistence.
    }
  }

  private flushLogs(): void {
    if (this.pendingLogs.length === 0 && this.droppedLogCount === 0) {
      return;
    }

    const entries = this.pendingLogs.splice(0, this.pendingLogs.length);
    if (this.droppedLogCount > 0) {
      entries.push({
        level: 'warn',
        message: `[Pix3 Player] Dropped ${this.droppedLogCount} log entries (rate limit)`,
        timestamp: Date.now(),
      });
      this.droppedLogCount = 0;
    }
    this.sendJson({ type: 'log', entries });
  }

  private sendDeviceInfo(): void {
    if (this.deviceInfo) {
      this.sendJson({ type: 'device-info', info: this.deviceInfo });
    }
  }

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

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingFiles.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingFiles.clear();
  }
}
