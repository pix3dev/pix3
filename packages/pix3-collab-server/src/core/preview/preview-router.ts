import { Router, type Request, type Response } from 'express';
import { WebSocket } from 'ws';
import { config } from '../../config.js';
import {
  previewSessionService,
  type PreviewRole,
  type PreviewSession,
} from './preview-service.js';

export const previewRouter = Router();

const COMMAND_ACK_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;

/** Actions the agent HTTP API accepts and where each one is routed. */
const HOST_COMMANDS = new Set(['reload-from-disk']);
const PLAYER_COMMANDS = new Set(['set-property', 'game-action', 'inspect', 'snapshot']);

function sessionStatusPayload(session: PreviewSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    hostOnline: session.sockets.host?.readyState === WebSocket.OPEN,
    playerCount: session.sockets.players.size,
    playModeStatus: session.playModeStatus,
    metricsUpdatedAt: session.metricsUpdatedAt,
    lastLogSeq: session.logSeq,
    hasScreenshot: session.screenshot !== null,
  };
}

/**
 * Anonymous preview sessions for local projects: no account required, access
 * is gated purely by the per-role tokens returned once at creation time.
 */
previewRouter.post('/sessions', (req: Request, res: Response) => {
  const session = previewSessionService.createSession();

  res.status(201).json({
    sessionId: session.id,
    hostToken: session.hostToken,
    agentToken: session.agentToken,
    guestToken: session.guestToken,
    expiresAt: session.expiresAt,
    previewPath: config.PREVIEW_PATH,
    // Public origin of this server (PREVIEW_PUBLIC_URL), or null when it is
    // reached same-origin/through a proxy. Lets join links carry an explicit
    // relay origin so players connect here directly from any page host.
    serverUrl: config.PREVIEW_PUBLIC_URL || null,
    joinPath: `/player.html?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.guestToken)}`,
  });
});

/** Session status; authenticated with any of the session's tokens. */
previewRouter.get('/sessions/:id', (req: Request, res: Response) => {
  const authenticated = authenticateRequest(req);
  if (!authenticated) {
    res.status(401).json({ error: 'Invalid session or token' });
    return;
  }

  previewSessionService.touch(authenticated.session);
  res.json(sessionStatusPayload(authenticated.session));
});

/**
 * Agent command endpoint. `restart` fans out to players; `reload-from-disk`
 * goes to the editor host; inspection/property commands go to the first
 * connected player and wait for its ack.
 */
previewRouter.post('/sessions/:id/commands', async (req: Request, res: Response) => {
  const authenticated = authenticateAgent(req, res);
  if (!authenticated) {
    return;
  }

  const { session } = authenticated;
  previewSessionService.touch(session);

  const body = (req.body ?? {}) as { action?: unknown; params?: unknown };
  const action = typeof body.action === 'string' ? body.action : '';
  const params = body.params ?? {};

  if (action === 'restart') {
    const delivered = broadcastToPlayers(session, { type: 'restart' });
    res.json({ ok: delivered > 0, action, delivered });
    return;
  }

  if (action === 'screenshot') {
    const requestedAt = Date.now();
    const delivered = broadcastToPlayers(session, {
      type: 'screenshot-request',
      requestId: previewSessionService.generateCommandId(),
    });
    if (delivered === 0) {
      res.status(409).json({ ok: false, action, error: 'no players connected' });
      return;
    }

    const screenshot = await previewSessionService.waitForScreenshot(
      session,
      requestedAt,
      SCREENSHOT_TIMEOUT_MS
    );
    if (!screenshot) {
      res.status(504).json({ ok: false, action, error: 'screenshot timed out' });
      return;
    }

    res.json({ ok: true, action, capturedAt: screenshot.capturedAt, bytes: screenshot.data.length });
    return;
  }

  if (HOST_COMMANDS.has(action)) {
    const host = session.sockets.host;
    if (!host || host.readyState !== WebSocket.OPEN) {
      res.status(409).json({ ok: false, action, error: 'host offline' });
      return;
    }

    const commandId = previewSessionService.generateCommandId();
    host.send(JSON.stringify({ type: 'command', commandId, action, params }));
    const ack = await previewSessionService.waitForAck(commandId, COMMAND_ACK_TIMEOUT_MS);
    if (!ack) {
      res.status(504).json({ ok: false, action, error: 'command timed out' });
      return;
    }

    res.json({ ok: ack.ok !== false, action, result: ack.result ?? null, error: ack.error ?? null });
    return;
  }

  if (PLAYER_COMMANDS.has(action)) {
    const player = firstOpenPlayer(session);
    if (!player) {
      res.status(409).json({ ok: false, action, error: 'no players connected' });
      return;
    }

    const commandId = previewSessionService.generateCommandId();
    player.send(JSON.stringify({ type: 'command', commandId, action, params }));
    const ack = await previewSessionService.waitForAck(commandId, COMMAND_ACK_TIMEOUT_MS);
    if (!ack) {
      res.status(504).json({ ok: false, action, error: 'command timed out' });
      return;
    }

    res.json({ ok: ack.ok !== false, action, result: ack.result ?? null, error: ack.error ?? null });
    return;
  }

  res.status(400).json({
    ok: false,
    error: `Unknown action: ${action || '(missing)'}`,
    supported: ['restart', 'reload-from-disk', 'screenshot', ...PLAYER_COMMANDS],
  });
});

/** Ring-buffered player logs; cursor-based via ?since=<seq>. */
previewRouter.get('/sessions/:id/logs', (req: Request, res: Response) => {
  const authenticated = authenticateAgent(req, res);
  if (!authenticated) {
    return;
  }

  const { session } = authenticated;
  previewSessionService.touch(session);

  const sinceRaw = req.query.since;
  const since = typeof sinceRaw === 'string' ? Number.parseInt(sinceRaw, 10) : 0;
  const entries = previewSessionService.getLogsSince(session, Number.isFinite(since) ? since : 0);

  res.json({
    entries,
    lastSeq: session.logSeq,
    playModeStatus: session.playModeStatus,
  });
});

/** Latest metrics sample reported by a player (1s aggregates). */
previewRouter.get('/sessions/:id/metrics', (req: Request, res: Response) => {
  const authenticated = authenticateAgent(req, res);
  if (!authenticated) {
    return;
  }

  const { session } = authenticated;
  previewSessionService.touch(session);

  res.json({
    sample: session.metrics,
    updatedAt: session.metricsUpdatedAt,
    playModeStatus: session.playModeStatus,
    playerCount: session.sockets.players.size,
  });
});

/** Latest player screenshot; ?fresh=true requests a new capture first. */
previewRouter.get('/sessions/:id/screenshot', async (req: Request, res: Response) => {
  const authenticated = authenticateAgent(req, res);
  if (!authenticated) {
    return;
  }

  const { session } = authenticated;
  previewSessionService.touch(session);

  let screenshot = session.screenshot;

  if (req.query.fresh === 'true' || req.query.fresh === '1') {
    const requestedAt = Date.now();
    const delivered = broadcastToPlayers(session, {
      type: 'screenshot-request',
      requestId: previewSessionService.generateCommandId(),
    });
    if (delivered > 0) {
      screenshot =
        (await previewSessionService.waitForScreenshot(
          session,
          requestedAt,
          SCREENSHOT_TIMEOUT_MS
        )) ?? session.screenshot;
    }
  }

  if (!screenshot) {
    res.status(404).json({ error: 'No screenshot captured yet' });
    return;
  }

  res.setHeader('content-type', screenshot.mimeType);
  res.setHeader('x-captured-at', String(screenshot.capturedAt));
  res.send(screenshot.data);
});

function broadcastToPlayers(session: PreviewSession, message: Record<string, unknown>): number {
  const encoded = JSON.stringify(message);
  let delivered = 0;
  for (const player of session.sockets.players.values()) {
    if (player.readyState === WebSocket.OPEN) {
      player.send(encoded);
      delivered += 1;
    }
  }
  return delivered;
}

function firstOpenPlayer(session: PreviewSession): WebSocket | null {
  for (const player of session.sockets.players.values()) {
    if (player.readyState === WebSocket.OPEN) {
      return player;
    }
  }
  return null;
}

function authenticateRequest(
  req: Request
): { session: PreviewSession; role: PreviewRole } | null {
  return previewSessionService.authenticate(req.params.id, extractToken(req));
}

/** Agent endpoints accept the agent token (curl workflow) or the host token. */
function authenticateAgent(
  req: Request,
  res: Response
): { session: PreviewSession; role: PreviewRole } | null {
  const authenticated = authenticateRequest(req);
  if (!authenticated) {
    res.status(401).json({ error: 'Invalid session or token' });
    return null;
  }

  if (authenticated.role === 'player') {
    res.status(403).json({ error: 'This endpoint requires the agent token' });
    return null;
  }

  return authenticated;
}

function extractToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  const queryToken = req.query.token;
  return typeof queryToken === 'string' ? queryToken : '';
}
