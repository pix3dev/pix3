import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';

/**
 * The cloud half of the Room Fabric handshake (plan decision D4).
 *
 * pix3-rooms deliberately knows nothing about accounts: it verifies an HS256 room token and a
 * service token, and nothing else. This module is the only place that holds either secret — it
 * creates rooms on the fabric's admin API and mints the per-client tokens that let a browser join
 * one. Neither secret ever reaches a client.
 */

/** Longest room id the fabric accepts, and the character class it allows. */
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Every fabric call is bounded: a hung fabric must not hold an editor's Play Online spinner open. */
const FABRIC_TIMEOUT_MS = 8_000;

/** Role claim values. The fabric passes the claim through; only this server assigns meaning to it. */
export type RoomRole = 'host' | 'player';

/** Who a minted token speaks for. */
export interface RoomIdentity {
  /** `user:<id>` for a signed-in account, `guest:<uuid>` otherwise (the fabric reads the prefix). */
  readonly sub: string;
  /** Display name the fabric may sanitise or truncate. */
  readonly displayName: string;
  /** True for an anonymous identity. */
  readonly guest: boolean;
  /** `host` may destroy the room through this server; `player` may only join it. */
  readonly role: RoomRole;
}

/** A minted room token and when it stops working. */
export interface MintedRoomToken {
  readonly token: string;
  /** Epoch milliseconds. After this the token can neither join nor resume. */
  readonly expiresAt: number;
}

/** A room as this server reports it to clients — the fabric's descriptor, minus nothing secret. */
export interface RoomSummary {
  readonly roomId: string;
  readonly projectId: string;
  readonly buildId: string;
  readonly mode: string;
  readonly tickHz: number;
  readonly maxPlayers: number;
  readonly playerCount: number;
  readonly maxVisibleEntities: number;
  readonly aoiRadius: number;
  readonly maxEntities: number;
  readonly idleTtlSeconds: number;
  readonly world: { readonly originX: number; readonly originY: number; readonly size: number };
  readonly allowedKinds: readonly number[];
}

/** What the fabric's admin API returns for one room. Fields we do not use are left undeclared. */
interface FabricRoomResponse {
  room?: {
    roomId?: string;
    projectId?: string;
    buildId?: string;
    mode?: string;
    tickHz?: number;
    maxPlayers?: number;
    maxVisibleEntities?: number;
    aoiRadius?: number;
    maxEntities?: number;
    idleTtlSeconds?: number;
    worldOriginX?: number;
    worldOriginY?: number;
    worldSize?: number;
    allowedKinds?: number[];
  };
  stats?: { playerCount?: number };
}

/** Room parameters a caller may choose. Everything omitted falls back to the fabric's defaults. */
export interface CreateRoomInput {
  roomId?: string;
  projectId: string;
  buildId?: string;
  maxPlayers?: number;
  tickHz?: number;
  aoiRadius?: number;
  idleTtlSeconds?: number;
  maxEntities?: number;
  maxVisibleEntities?: number;
  mode?: string;
  world?: { originX: number; originY: number; size: number };
  /** Kinds (indexes into the build's prefab table) this room accepts. Empty means "the default". */
  allowedKinds?: readonly number[];
}

/** A fabric call that failed, carrying the status this server should answer with. */
export class FabricError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'FabricError';
  }
}

/** True when the deployment has a fabric to talk to. Everything else answers 503 without it. */
export function isRoomsConfigured(): boolean {
  return config.ROOMS_ADMIN_URL.length > 0 && config.ROOMS_SERVICE_TOKEN.length > 0;
}

/**
 * The public WebSocket endpoint clients connect to. Derived from the admin URL because they are the
 * same host in every deployment we ship; `ROOMS_WS_URL` overrides it when they are not.
 */
export function resolveRoomsWsUrl(): string {
  if (config.ROOMS_WS_URL) {
    return config.ROOMS_WS_URL;
  }
  const base = config.ROOMS_ADMIN_URL;
  if (!base) {
    return '';
  }
  return `${base.replace(/^http/i, match => (match === 'HTTP' ? 'WS' : 'ws'))}/ws`;
}

/** True when `value` is a room id the fabric would accept. */
export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

/**
 * Signs a room token.
 *
 * The claim set is exactly what `JwtRoomTokenValidator` pins: HS256, our issuer, the `pix3-rooms`
 * audience, a required expiry, and a `roomId` bound to one room — a token for a friend's room must
 * not open every room on the server.
 */
export function mintRoomToken(roomId: string, identity: RoomIdentity): MintedRoomToken {
  const secret = config.ROOMS_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new FabricError(
      503,
      'rooms_not_configured',
      'ROOMS_JWT_SECRET must be at least 32 bytes to mint a room token the fabric will accept.'
    );
  }

  const ttlSeconds = Math.max(60, config.ROOMS_TOKEN_TTL_SECONDS);
  const token = jwt.sign(
    {
      roomId,
      name: identity.displayName,
      guest: identity.guest,
      role: identity.role,
    },
    secret,
    {
      algorithm: 'HS256',
      subject: identity.sub,
      issuer: config.ROOMS_TOKEN_ISSUER,
      audience: config.ROOMS_TOKEN_AUDIENCE,
      expiresIn: ttlSeconds,
    }
  );

  return { token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

/**
 * Reads a room token back. Used only to authorise `DELETE /api/rooms/:id`: the host token is the
 * proof of ownership, which is why no rooms table exists.
 */
export function verifyRoomToken(
  token: string
): { sub: string; roomId: string; role: RoomRole } | null {
  try {
    const payload = jwt.verify(token, config.ROOMS_JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: config.ROOMS_TOKEN_ISSUER,
      audience: config.ROOMS_TOKEN_AUDIENCE,
    }) as { sub?: string; roomId?: string; role?: string };

    if (typeof payload.roomId !== 'string' || typeof payload.sub !== 'string') {
      return null;
    }

    return {
      sub: payload.sub,
      roomId: payload.roomId,
      role: payload.role === 'host' ? 'host' : 'player',
    };
  } catch {
    return null;
  }
}

/** A fresh anonymous identity. Guests are first-class: joining a game must never need an account. */
export function createGuestIdentity(displayName: string, role: RoomRole): RoomIdentity {
  return {
    sub: `guest:${randomUUID()}`,
    displayName: displayName || 'Guest',
    guest: true,
    role,
  };
}

/** Creates a room on the fabric. Idempotent for a repeated `roomId` — the fabric hands the live one back. */
export async function createFabricRoom(input: CreateRoomInput): Promise<RoomSummary> {
  const body: Record<string, unknown> = {
    roomId: input.roomId,
    projectId: input.projectId,
    buildId: input.buildId,
    maxPlayers: input.maxPlayers,
    tickHz: input.tickHz,
    aoiRadius: input.aoiRadius,
    idleTtlSeconds: input.idleTtlSeconds,
    maxEntities: input.maxEntities,
    maxVisibleEntities: input.maxVisibleEntities,
    mode: input.mode,
  };

  if (input.world) {
    body.worldOriginX = input.world.originX;
    body.worldOriginY = input.world.originY;
    body.worldSize = input.world.size;
  }
  if (input.allowedKinds && input.allowedKinds.length > 0) {
    body.allowedKinds = [...input.allowedKinds];
  }

  for (const key of Object.keys(body)) {
    if (body[key] === undefined) {
      delete body[key];
    }
  }

  const response = await fabricFetch('/admin/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return toSummary(await readJson(response));
}

/** Fetches a room, or `null` when the fabric has no such room (it may have been swept). */
export async function getFabricRoom(roomId: string): Promise<RoomSummary | null> {
  const response = await fabricFetch(`/admin/rooms/${encodeURIComponent(roomId)}`, {
    method: 'GET',
  });
  if (response.status === 404) {
    return null;
  }
  return toSummary(await readJson(response));
}

/** Destroys a room. `false` means it was already gone, which is not an error. */
export async function deleteFabricRoom(roomId: string): Promise<boolean> {
  const response = await fabricFetch(`/admin/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
  });
  if (response.status === 404) {
    return false;
  }
  await readJson(response, { allowEmpty: true });
  return true;
}

/**
 * The fabric's own `GET /admin/stats`: version, commit, resource use, transport counters and every
 * live room, passed through verbatim.
 *
 * Deliberately untyped beyond `Record`: this server does not interpret the fabric's operational
 * numbers, it only relays them to the dashboard, and re-declaring that whole shape here would mean
 * two definitions to keep in step for zero gain. The fabric's contract lives in its own repo.
 */
export async function fetchFabricStats(): Promise<Record<string, unknown>> {
  const response = await fabricFetch('/admin/stats', { method: 'GET' });
  const text = await response.text();

  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 502 : response.status;
    throw new FabricError(
      status,
      response.status === 401 || response.status === 403 ? 'fabric_unauthorized' : 'fabric_error',
      `The Room Fabric answered HTTP ${response.status} for /admin/stats.`
    );
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new FabricError(502, 'fabric_error', 'The Room Fabric returned a body that is not JSON.');
  }
}

async function fabricFetch(path: string, init: RequestInit): Promise<Response> {
  if (!isRoomsConfigured()) {
    throw new FabricError(
      503,
      'rooms_not_configured',
      'This server has no Room Fabric configured (set ROOMS_ADMIN_URL and ROOMS_SERVICE_TOKEN).'
    );
  }

  try {
    return await fetch(`${config.ROOMS_ADMIN_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${config.ROOMS_SERVICE_TOKEN}`,
      },
      signal: AbortSignal.timeout(FABRIC_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FabricError(502, 'fabric_unreachable', `The Room Fabric did not answer: ${message}`);
  }
}

async function readJson(
  response: Response,
  options: { allowEmpty?: boolean } = {}
): Promise<FabricRoomResponse> {
  const text = await response.text();

  if (!response.ok) {
    // The fabric answers 401 with no body at all, and every other error with
    // {error, message, fields}. Surfacing its code keeps a misconfigured service token
    // distinguishable from a rejected field.
    let code = 'fabric_error';
    let message = `The Room Fabric answered HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      code = typeof parsed.error === 'string' ? parsed.error : code;
      message = typeof parsed.message === 'string' ? parsed.message : message;
    } catch {
      // Body was empty or not JSON; the defaults above already say enough.
    }
    // A bad service token is our misconfiguration, not the caller's request.
    const status = response.status === 401 || response.status === 403 ? 502 : response.status;
    throw new FabricError(status, code, message);
  }

  if (!text && options.allowEmpty) {
    return {};
  }

  try {
    return JSON.parse(text) as FabricRoomResponse;
  } catch {
    throw new FabricError(502, 'fabric_error', 'The Room Fabric returned a body that is not JSON.');
  }
}

function toSummary(payload: FabricRoomResponse): RoomSummary {
  const room = payload.room ?? {};
  if (typeof room.roomId !== 'string' || room.roomId.length === 0) {
    throw new FabricError(502, 'fabric_error', 'The Room Fabric returned a room with no id.');
  }

  return {
    roomId: room.roomId,
    projectId: room.projectId ?? '',
    buildId: room.buildId ?? '',
    mode: room.mode ?? 'Relay',
    tickHz: room.tickHz ?? 0,
    maxPlayers: room.maxPlayers ?? 0,
    playerCount: payload.stats?.playerCount ?? 0,
    maxVisibleEntities: room.maxVisibleEntities ?? 0,
    aoiRadius: room.aoiRadius ?? 0,
    maxEntities: room.maxEntities ?? 0,
    idleTtlSeconds: room.idleTtlSeconds ?? 0,
    world: {
      originX: room.worldOriginX ?? 0,
      originY: room.worldOriginY ?? 0,
      size: room.worldSize ?? 0,
    },
    allowedKinds: room.allowedKinds ?? [],
  };
}
