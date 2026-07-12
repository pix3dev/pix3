import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from '../../config.js';

export type PreviewRole = 'host' | 'agent' | 'player';

export interface PreviewLogEntry {
  seq: number;
  timestamp: number;
  level: string;
  message: string;
}

export interface PreviewScreenshot {
  data: Buffer;
  mimeType: string;
  capturedAt: number;
}

export interface PreviewPeerSockets {
  host: WebSocket | null;
  players: Map<string, WebSocket>;
}

export interface PreviewSession {
  readonly id: string;
  readonly createdAt: number;
  expiresAt: number;
  readonly hostToken: string;
  readonly agentToken: string;
  readonly guestToken: string;
  logs: PreviewLogEntry[];
  logSeq: number;
  metrics: unknown | null;
  metricsUpdatedAt: number | null;
  /** Static device facts reported by each connected player, keyed by clientId. */
  readonly deviceInfoByClient: Map<string, unknown>;
  screenshot: PreviewScreenshot | null;
  playModeStatus: string;
  /** Last session-config JSON message from the host, replayed to late-joining players. */
  cachedSessionConfig: string | null;
  /** Last script-bundle binary frame from the host, replayed to late-joining players. */
  cachedScriptBundle: Buffer | null;
  readonly sockets: PreviewPeerSockets;
}

const MAX_LOG_ENTRIES = 1000;

interface PendingAck {
  resolve(payload: Record<string, unknown> | null): void;
  timer: NodeJS.Timeout;
}

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function generateSessionId(): string {
  return randomBytes(9).toString('base64url');
}

export class PreviewSessionService {
  private readonly sessions = new Map<string, PreviewSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly pendingAcks = new Map<string, PendingAck>();
  private nextCommandId = 0;

  generateCommandId(): string {
    this.nextCommandId += 1;
    return `cmd-${Date.now()}-${this.nextCommandId}`;
  }

  /** Resolves with the ack payload, or null when the peer never acks in time. */
  waitForAck(commandId: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(commandId);
        resolve(null);
      }, timeoutMs);

      this.pendingAcks.set(commandId, { resolve, timer });
    });
  }

  resolveAck(commandId: string, payload: Record<string, unknown>): void {
    const pending = this.pendingAcks.get(commandId);
    if (!pending) {
      return;
    }

    this.pendingAcks.delete(commandId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  /** Polls until a screenshot captured at/after `sinceTimestamp` is stored. */
  async waitForScreenshot(
    session: PreviewSession,
    sinceTimestamp: number,
    timeoutMs: number
  ): Promise<PreviewScreenshot | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const screenshot = session.screenshot;
      if (screenshot && screenshot.capturedAt >= sinceTimestamp) {
        return screenshot;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  createSession(): PreviewSession {
    const now = Date.now();
    const session: PreviewSession = {
      id: generateSessionId(),
      createdAt: now,
      expiresAt: now + config.PREVIEW_SESSION_TTL_MS,
      hostToken: generateToken(),
      agentToken: generateToken(),
      guestToken: generateToken(),
      logs: [],
      logSeq: 0,
      metrics: null,
      metricsUpdatedAt: null,
      deviceInfoByClient: new Map(),
      screenshot: null,
      playModeStatus: 'idle',
      cachedSessionConfig: null,
      cachedScriptBundle: null,
      sockets: { host: null, players: new Map() },
    };

    this.sessions.set(session.id, session);
    this.ensureCleanupTimer();
    return session;
  }

  getSession(sessionId: string): PreviewSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.destroySession(session.id);
      return null;
    }

    return session;
  }

  authenticate(sessionId: string, token: string): { session: PreviewSession; role: PreviewRole } | null {
    const session = this.getSession(sessionId);
    if (!session || !token) {
      return null;
    }

    if (token === session.hostToken) {
      return { session, role: 'host' };
    }
    if (token === session.agentToken) {
      return { session, role: 'agent' };
    }
    if (token === session.guestToken) {
      return { session, role: 'player' };
    }

    return null;
  }

  /** Sliding expiration: any activity extends the session lifetime. */
  touch(session: PreviewSession): void {
    session.expiresAt = Date.now() + config.PREVIEW_SESSION_TTL_MS;
  }

  appendLog(session: PreviewSession, level: string, message: string, timestamp?: number): void {
    session.logSeq += 1;
    session.logs.push({
      seq: session.logSeq,
      timestamp: timestamp ?? Date.now(),
      level,
      message,
    });

    if (session.logs.length > MAX_LOG_ENTRIES) {
      session.logs.splice(0, session.logs.length - MAX_LOG_ENTRIES);
    }
  }

  getLogsSince(session: PreviewSession, sinceSeq: number): PreviewLogEntry[] {
    return session.logs.filter(entry => entry.seq > sinceSeq);
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      session.sockets.host?.close(1001, 'session closed');
    } catch {
      // Socket already gone.
    }
    for (const player of session.sockets.players.values()) {
      try {
        player.close(1001, 'session closed');
      } catch {
        // Socket already gone.
      }
    }
    session.sockets.players.clear();
    this.sessions.delete(sessionId);
  }

  destroyAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.destroySession(sessionId);
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions) {
        if (session.expiresAt <= now) {
          console.log(`[pix3-collab] Preview session expired: ${sessionId}`);
          this.destroySession(sessionId);
        }
      }

      if (this.sessions.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 60_000);
    this.cleanupTimer.unref();
  }
}

export const previewSessionService = new PreviewSessionService();
