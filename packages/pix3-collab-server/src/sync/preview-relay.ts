import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  previewSessionService,
  type PreviewRole,
  type PreviewSession,
} from '../core/preview/preview-service.js';

/**
 * Preview relay — a deliberately dumb WebSocket router between one editor
 * (`host`) and any number of standalone players (`player`) inside a preview
 * session. The server does not interpret game data; it only routes frames and
 * mirrors a few player reports (logs / metrics / status / screenshots) into
 * the session's ring buffers so the agent HTTP API can read them.
 *
 * Text frames are JSON messages `{ type, ... }`. Binary frames are
 * `[4-byte BE header length][UTF-8 JSON header][payload]`; the header carries
 * the same `{ type, ... }` shape as text messages.
 *
 * Routing rules:
 * - host → `session-config` (cached), `scene-updated`, `restart`,
 *   `screenshot-request` → broadcast to players;
 *   binary `script-bundle` (cached) → broadcast to players;
 *   binary `file-response` → routed to header.to player.
 * - player → `file-request` → forwarded to host with `from: clientId`;
 *   `log` / `metrics` / `status` → stored + forwarded to host;
 *   binary `screenshot` → stored + forwarded to host.
 */

const MAX_HEADER_BYTES = 64 * 1024;

interface RelayPeer {
  readonly session: PreviewSession;
  readonly role: PreviewRole;
  readonly clientId: string;
  readonly socket: WebSocket;
}

interface JsonMessage {
  type: string;
  [key: string]: unknown;
}

export interface PreviewRelayServer {
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void;
  destroy(): Promise<void>;
}

function encodeBinaryFrame(header: JsonMessage, payload: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf-8');
  const frame = Buffer.alloc(4 + headerBytes.length + payload.length);
  frame.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(frame, 4);
  payload.copy(frame, 4 + headerBytes.length);
  return frame;
}

function decodeBinaryFrame(frame: Buffer): { header: JsonMessage; payload: Buffer } | null {
  if (frame.length < 4) {
    return null;
  }

  const headerLength = frame.readUInt32BE(0);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || 4 + headerLength > frame.length) {
    return null;
  }

  try {
    const header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf-8')) as JsonMessage;
    if (typeof header?.type !== 'string') {
      return null;
    }
    return { header, payload: frame.subarray(4 + headerLength) };
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, message: JsonMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendBinary(socket: WebSocket, frame: Buffer): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(frame, { binary: true });
  }
}

function broadcastToPlayers(session: PreviewSession, data: string | Buffer): void {
  for (const player of session.sockets.players.values()) {
    if (player.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (typeof data === 'string') {
      player.send(data);
    } else {
      player.send(data, { binary: true });
    }
  }
}

function notifyPeerStatus(session: PreviewSession): void {
  const message: JsonMessage = {
    type: 'peer-status',
    hostOnline: session.sockets.host?.readyState === WebSocket.OPEN,
    playerCount: session.sockets.players.size,
  };
  const encoded = JSON.stringify(message);

  const host = session.sockets.host;
  if (host && host.readyState === WebSocket.OPEN) {
    host.send(encoded);
  }
  broadcastToPlayers(session, encoded);
}

function normalizeLogLevel(level: unknown): string {
  return level === 'warn' || level === 'error' || level === 'info' || level === 'debug'
    ? level
    : 'info';
}

function handleHostText(peer: RelayPeer, raw: string, message: JsonMessage): void {
  const { session } = peer;

  switch (message.type) {
    case 'session-config':
      session.cachedSessionConfig = raw;
      broadcastToPlayers(session, raw);
      break;
    case 'scene-updated':
    case 'restart':
    case 'screenshot-request':
      broadcastToPlayers(session, raw);
      break;
    case 'play-mode-status':
      if (typeof message.status === 'string') {
        session.playModeStatus = message.status;
      }
      break;
    case 'command-ack':
      if (typeof message.commandId === 'string') {
        previewSessionService.resolveAck(message.commandId, message);
      }
      break;
    default:
      // Unknown host messages are broadcast to players so the protocol can
      // grow without a relay redeploy.
      broadcastToPlayers(session, raw);
      break;
  }
}

function handleHostBinary(peer: RelayPeer, frame: Buffer, header: JsonMessage): void {
  const { session } = peer;

  if (header.type === 'script-bundle') {
    session.cachedScriptBundle = frame;
    broadcastToPlayers(session, frame);
    return;
  }

  if (header.type === 'file-response') {
    const target = typeof header.to === 'string' ? session.sockets.players.get(header.to) : null;
    if (target) {
      sendBinary(target, frame);
    }
    return;
  }

  broadcastToPlayers(session, frame);
}

function handlePlayerText(peer: RelayPeer, message: JsonMessage): void {
  const { session, clientId } = peer;
  const host = session.sockets.host;

  switch (message.type) {
    case 'file-request': {
      if (host) {
        sendJson(host, { ...message, from: clientId });
      } else {
        sendJson(peer.socket, {
          type: 'file-response-error',
          requestId: message.requestId,
          error: 'host-offline',
        });
      }
      break;
    }
    case 'log': {
      const entries = Array.isArray(message.entries) ? message.entries : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.message !== 'string') {
          continue;
        }
        previewSessionService.appendLog(
          session,
          normalizeLogLevel(record.level),
          record.message,
          typeof record.timestamp === 'number' ? record.timestamp : undefined
        );
      }
      if (host) {
        sendJson(host, { ...message, from: clientId });
      }
      break;
    }
    case 'metrics': {
      session.metrics = message.sample ?? null;
      session.metricsUpdatedAt = Date.now();
      if (host) {
        sendJson(host, { ...message, from: clientId });
      }
      break;
    }
    case 'device-info': {
      session.deviceInfoByClient.set(clientId, message.info ?? null);
      if (host) {
        sendJson(host, { ...message, from: clientId });
      }
      break;
    }
    case 'status': {
      if (typeof message.playModeStatus === 'string') {
        session.playModeStatus = message.playModeStatus;
      }
      if (host) {
        sendJson(host, { ...message, from: clientId });
      }
      break;
    }
    case 'command-ack': {
      if (typeof message.commandId === 'string') {
        previewSessionService.resolveAck(message.commandId, message);
      }
      break;
    }
    default: {
      if (host) {
        sendJson(host, { ...message, from: clientId });
      }
      break;
    }
  }
}

function handlePlayerBinary(peer: RelayPeer, frame: Buffer, header: JsonMessage, payload: Buffer): void {
  const { session } = peer;

  if (header.type === 'screenshot') {
    session.screenshot = {
      data: Buffer.from(payload),
      mimeType: typeof header.mimeType === 'string' ? header.mimeType : 'image/jpeg',
      capturedAt: Date.now(),
    };
  }

  const host = session.sockets.host;
  if (host) {
    sendBinary(host, encodeBinaryFrame({ ...header, from: peer.clientId }, Buffer.from(payload)));
  }
}

function attachPeer(peer: RelayPeer): void {
  const { session, role, clientId, socket } = peer;

  if (role === 'host') {
    const previousHost = session.sockets.host;
    if (previousHost && previousHost !== socket) {
      try {
        previousHost.close(4000, 'replaced by a new host connection');
      } catch {
        // Socket already gone.
      }
    }
    session.sockets.host = socket;
  } else {
    session.sockets.players.set(clientId, socket);
  }

  sendJson(socket, {
    type: 'hello',
    role,
    clientId,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    hostOnline: session.sockets.host?.readyState === WebSocket.OPEN,
    playerCount: session.sockets.players.size,
  });

  // Late joiners replay the cached host state so they can boot without the
  // host having to notice them first.
  if (role === 'player') {
    if (session.cachedSessionConfig) {
      socket.send(session.cachedSessionConfig);
    }
    if (session.cachedScriptBundle) {
      socket.send(session.cachedScriptBundle, { binary: true });
    }
  }

  notifyPeerStatus(session);

  socket.on('message', (data, isBinary) => {
    previewSessionService.touch(session);

    if (isBinary) {
      const frame = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const decoded = decodeBinaryFrame(frame);
      if (!decoded) {
        return;
      }
      if (role === 'host') {
        handleHostBinary(peer, frame, decoded.header);
      } else {
        handlePlayerBinary(peer, frame, decoded.header, decoded.payload);
      }
      return;
    }

    const raw = data.toString();
    let message: JsonMessage;
    try {
      message = JSON.parse(raw) as JsonMessage;
    } catch {
      return;
    }
    if (typeof message?.type !== 'string') {
      return;
    }

    if (message.type === 'ping') {
      sendJson(socket, { type: 'pong' });
      return;
    }

    if (role === 'host') {
      handleHostText(peer, raw, message);
    } else {
      handlePlayerText(peer, message);
    }
  });

  socket.on('error', error => {
    console.error(`[pix3-collab] Preview socket error (${role} ${clientId})`, error);
  });

  socket.on('close', () => {
    if (role === 'host') {
      if (session.sockets.host === socket) {
        session.sockets.host = null;
      }
    } else {
      session.sockets.players.delete(clientId);
      session.deviceInfoByClient.delete(clientId);
    }
    notifyPeerStatus(session);
  });
}

export function createPreviewRelayServer(): PreviewRelayServer {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  return {
    handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const sessionId = requestUrl.searchParams.get('session') ?? '';
      const token = requestUrl.searchParams.get('token') ?? '';

      const authenticated = previewSessionService.authenticate(sessionId, token);
      if (!authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // The agent interacts over HTTP; live sockets are host or player only.
      const role: PreviewRole = authenticated.role === 'host' ? 'host' : 'player';

      webSocketServer.handleUpgrade(request, socket, head, ws => {
        previewSessionService.touch(authenticated.session);
        attachPeer({
          session: authenticated.session,
          role,
          clientId: randomBytes(6).toString('base64url'),
          socket: ws,
        });
      });
    },

    async destroy(): Promise<void> {
      previewSessionService.destroyAll();
      await new Promise<void>(resolve => {
        webSocketServer.close(() => resolve());
      });
    },
  };
}
