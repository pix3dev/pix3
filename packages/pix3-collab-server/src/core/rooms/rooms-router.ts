import { Router, type Request, type Response } from 'express';
import { config } from '../../config.js';
import { attachOptionalAuth, type AuthenticatedRequest } from '../auth/auth-middleware.js';
import {
  createFabricRoom,
  createGuestIdentity,
  deleteFabricRoom,
  FabricError,
  getFabricRoom,
  isRoomsConfigured,
  isValidRoomId,
  mintRoomToken,
  resolveRoomsWsUrl,
  verifyRoomToken,
  type CreateRoomInput,
  type RoomIdentity,
  type RoomRole,
  type RoomSummary,
} from './rooms-service.js';

/**
 * `/api/rooms` — the editor's and the player page's door to the Room Fabric.
 *
 * Two verbs matter: **create** (an editor pressing Play Online, or later a published game's
 * join-or-create) and **join** (anyone with the link). Join is guest-first by design: needing an
 * account to enter a friend's room would kill the one flow this whole platform exists for.
 *
 * The fabric's service token and the HS256 signing secret live only on this server; a client gets a
 * single room-scoped, short-lived token and the WebSocket URL to spend it at.
 */
export const roomsRouter = Router();

/** Longest display name accepted. The fabric truncates too; this keeps junk off the wire early. */
const MAX_DISPLAY_NAME = 32;

/** A room's prefab-kind allowlist is bounded so a request cannot ask the fabric to hold a huge set. */
const MAX_ALLOWED_KINDS = 512;

roomsRouter.use(attachOptionalAuth);

/** Sliding-window room-creation budget per client IP. Joins are not bucketed — room caps bound them. */
const createBuckets = new Map<string, number[]>();

function rateLimitCreate(req: Request): boolean {
  const limit = config.ROOMS_CREATE_PER_MINUTE;
  if (limit <= 0) {
    return true;
  }

  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (createBuckets.get(key) ?? []).filter(at => at > windowStart);

  if (hits.length >= limit) {
    createBuckets.set(key, hits);
    return false;
  }

  hits.push(now);
  createBuckets.set(key, hits);

  // The map would otherwise grow one entry per IP forever; drop everything idle for a window.
  if (createBuckets.size > 4096) {
    for (const [ip, timestamps] of createBuckets) {
      if (timestamps.every(at => at <= windowStart)) {
        createBuckets.delete(ip);
      }
    }
  }

  return true;
}

/** Creates (or re-attaches to) a room and mints its host token. */
roomsRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  if (!isRoomsConfigured()) {
    res.status(503).json({
      error: 'rooms_not_configured',
      message: 'This server has no Room Fabric configured.',
    });
    return;
  }

  if (!rateLimitCreate(req)) {
    res.status(429).json({
      error: 'rate_limited',
      message: 'Too many rooms created from this address; wait a minute.',
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectId = readString(body.projectId, 128);
  if (!projectId) {
    res.status(400).json({ error: 'invalid_request', message: 'projectId is required.' });
    return;
  }

  const roomId = readString(body.roomId, 64);
  if (roomId && !isValidRoomId(roomId)) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'roomId must match [A-Za-z0-9_-]{1,64}.',
    });
    return;
  }

  const allowedKinds = readKinds(body.allowedKinds);
  if (allowedKinds === null) {
    res.status(400).json({
      error: 'invalid_request',
      message: `allowedKinds must be up to ${MAX_ALLOWED_KINDS} integers in 0…65535.`,
    });
    return;
  }

  const world = readWorld(body.world);
  if (world === null) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'world must be {originX, originY, size} with finite numbers and size > 0.',
    });
    return;
  }

  const input: CreateRoomInput = {
    roomId: roomId || undefined,
    projectId,
    buildId: readString(body.buildId, 64) || undefined,
    maxPlayers: readInt(body.maxPlayers),
    tickHz: readInt(body.tickHz),
    aoiRadius: readNumber(body.aoiRadius),
    idleTtlSeconds: readInt(body.idleTtlSeconds),
    maxEntities: readInt(body.maxEntities),
    maxVisibleEntities: readInt(body.maxVisibleEntities),
    mode: readString(body.mode, 32) || undefined,
    world: world ?? undefined,
    allowedKinds,
  };

  try {
    const room = await createFabricRoom(input);
    const identity = resolveIdentity(req, body.displayName, 'host');
    res.status(201).json(sessionPayload(room, identity));
  } catch (error) {
    respondFabricError(res, error);
  }
});

/** Mints a join token for an existing room. No account required — this is the link a friend opens. */
roomsRouter.post('/:roomId/token', async (req: AuthenticatedRequest, res: Response) => {
  const roomId = req.params.roomId;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'invalid_request', message: 'Malformed room id.' });
    return;
  }

  try {
    const room = await getFabricRoom(roomId);
    if (!room) {
      res.status(404).json({ error: 'room_not_found', message: 'That room is no longer open.' });
      return;
    }

    if (room.maxPlayers > 0 && room.playerCount >= room.maxPlayers) {
      res.status(409).json({ error: 'room_full', message: 'That room is full.', room });
      return;
    }

    const identity = resolveIdentity(req, (req.body ?? {}).displayName, 'player');
    res.json(sessionPayload(room, identity));
  } catch (error) {
    respondFabricError(res, error);
  }
});

/** Public room status. Carries no token, so a lobby or a join page can poll it freely. */
roomsRouter.get('/:roomId', async (req: Request, res: Response) => {
  const roomId = req.params.roomId;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'invalid_request', message: 'Malformed room id.' });
    return;
  }

  try {
    const room = await getFabricRoom(roomId);
    if (!room) {
      res.status(404).json({ error: 'room_not_found', message: 'That room is no longer open.' });
      return;
    }
    res.json({ room });
  } catch (error) {
    respondFabricError(res, error);
  }
});

/**
 * Closes a room early. Authorised by the host token itself — holding it *is* the ownership proof,
 * which is why rooms need no table here. Rooms also die on their own idle TTL, so this is a
 * courtesy, not the safety net.
 */
roomsRouter.delete('/:roomId', async (req: Request, res: Response) => {
  const roomId = req.params.roomId;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'invalid_request', message: 'Malformed room id.' });
    return;
  }

  const claims = verifyRoomToken(extractBearer(req));
  if (!claims || claims.roomId !== roomId || claims.role !== 'host') {
    res.status(403).json({
      error: 'forbidden',
      message: 'Closing a room needs the host token it was created with.',
    });
    return;
  }

  try {
    const destroyed = await deleteFabricRoom(roomId);
    res.json({ ok: true, destroyed });
  } catch (error) {
    respondFabricError(res, error);
  }
});

function sessionPayload(room: RoomSummary, identity: RoomIdentity): Record<string, unknown> {
  const minted = mintRoomToken(room.roomId, identity);
  return {
    room,
    wsUrl: resolveRoomsWsUrl(),
    token: minted.token,
    expiresAt: minted.expiresAt,
    identity: {
      sub: identity.sub,
      displayName: identity.displayName,
      guest: identity.guest,
      role: identity.role,
    },
  };
}

/** A signed-in user speaks as themselves; everyone else gets a fresh guest subject. */
function resolveIdentity(
  req: AuthenticatedRequest,
  rawName: unknown,
  role: RoomRole
): RoomIdentity {
  const requested = readString(rawName, MAX_DISPLAY_NAME);

  if (req.user) {
    return {
      sub: `user:${req.user.id}`,
      displayName: requested || req.user.username || 'Player',
      guest: false,
      role,
    };
  }

  return createGuestIdentity(requested, role);
}

function respondFabricError(res: Response, error: unknown): void {
  if (error instanceof FabricError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error('[pix3-collab] rooms request failed', error);
  res.status(500).json({ error: 'internal_error', message });
}

function extractBearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readInt(value: unknown): number | undefined {
  const parsed = readNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

/** `null` means "present but malformed"; `undefined` means "absent". */
function readKinds(value: unknown): readonly number[] | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_KINDS) {
    return null;
  }

  const kinds: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 65535) {
      return null;
    }
    kinds.push(entry);
  }
  return kinds;
}

/** `null` means "present but malformed"; `undefined` means "absent". */
function readWorld(
  value: unknown
): { originX: number; originY: number; size: number } | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const originX = readNumber(raw.originX);
  const originY = readNumber(raw.originY);
  const size = readNumber(raw.size);
  if (originX === undefined || originY === undefined || size === undefined || size <= 0) {
    return null;
  }
  return { originX, originY, size };
}
