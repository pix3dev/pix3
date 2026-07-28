// @vitest-environment node
import type { AddressInfo } from 'net';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';

interface TestUser {
  id: string;
  email: string;
  username: string;
  is_admin: boolean;
}

const auth: { user: TestUser | null } = { user: null };

vi.mock('../auth/auth-middleware.js', () => ({
  attachOptionalAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    if (auth.user) {
      req.user = auth.user;
    }
    next();
  },
}));

const { roomsRouter } = await import('./rooms-router.js');

const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long';

/** What the fake fabric will answer `POST/GET /admin/rooms` with, and what it recorded. */
const fabric = {
  createStatus: 201,
  createBody: {} as unknown,
  getStatus: 200,
  getBody: {} as unknown,
  deleteStatus: 204,
  lastCreateBody: null as Record<string, unknown> | null,
  lastAuthorization: '',
  deletedRooms: [] as string[],
};

function roomResponse(overrides: Record<string, unknown> = {}, playerCount = 0): unknown {
  return {
    room: {
      roomId: 'arena-1',
      projectId: 'multiplayer-arena',
      buildId: 'dev',
      mode: 'Relay',
      tickHz: 20,
      maxPlayers: 8,
      maxVisibleEntities: 64,
      aoiRadius: 1200,
      maxEntities: 256,
      idleTtlSeconds: 300,
      worldOriginX: -2048,
      worldOriginY: -2048,
      worldSize: 4096,
      allowedKinds: [0, 1],
      ...overrides,
    },
    stats: { playerCount },
  };
}

let fabricServer: http.Server;
let apiServer: http.Server;
let apiUrl = '';

beforeAll(async () => {
  const fabricApp = express();
  fabricApp.use(express.json());
  fabricApp.post('/admin/rooms', (req, res) => {
    fabric.lastCreateBody = req.body as Record<string, unknown>;
    fabric.lastAuthorization = req.headers.authorization ?? '';
    res.status(fabric.createStatus).json(fabric.createBody);
  });
  fabricApp.get('/admin/rooms/:roomId', (_req, res) => {
    if (fabric.getStatus === 404) {
      res.status(404).json({ error: 'not_found', message: 'no such room' });
      return;
    }
    res.status(fabric.getStatus).json(fabric.getBody);
  });
  fabricApp.delete('/admin/rooms/:roomId', (req, res) => {
    fabric.deletedRooms.push(req.params.roomId);
    res.status(fabric.deleteStatus).end();
  });

  const api = express();
  api.use(express.json());
  api.use('/api/rooms', roomsRouter);

  fabricServer = await listen(fabricApp);
  apiServer = await listen(api);

  const fabricPort = (fabricServer.address() as AddressInfo).port;
  apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  Object.assign(config as unknown as Record<string, unknown>, {
    ROOMS_ADMIN_URL: `http://127.0.0.1:${fabricPort}`,
    ROOMS_SERVICE_TOKEN: 'test-service-token',
    ROOMS_WS_URL: '',
    ROOMS_JWT_SECRET: SECRET,
    ROOMS_TOKEN_ISSUER: 'pix3-cloud',
    ROOMS_TOKEN_AUDIENCE: 'pix3-rooms',
    ROOMS_TOKEN_TTL_SECONDS: 3600,
    ROOMS_CREATE_PER_MINUTE: 1000,
  });
});

afterAll(async () => {
  await Promise.all([close(fabricServer), close(apiServer)]);
});

afterEach(() => {
  auth.user = null;
  fabric.createStatus = 201;
  fabric.createBody = roomResponse();
  fabric.getStatus = 200;
  fabric.getBody = roomResponse();
  fabric.deleteStatus = 204;
  fabric.lastCreateBody = null;
  fabric.deletedRooms = [];
});

function listen(app: express.Express): Promise<http.Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('rooms router', () => {
  it('creates a room on the fabric and mints a host token bound to it', async () => {
    fabric.createBody = roomResponse();

    const { status, body } = await post('/api/rooms', {
      projectId: 'multiplayer-arena',
      roomId: 'arena-1',
      maxPlayers: 8,
      allowedKinds: [0, 1],
      world: { originX: -2048, originY: -2048, size: 4096 },
      displayName: 'Host',
    });

    expect(status).toBe(201);
    expect(fabric.lastAuthorization).toBe('Bearer test-service-token');
    expect(fabric.lastCreateBody).toMatchObject({
      projectId: 'multiplayer-arena',
      roomId: 'arena-1',
      maxPlayers: 8,
      allowedKinds: [0, 1],
      worldOriginX: -2048,
      worldSize: 4096,
    });

    const claims = jwt.verify(body.token as string, SECRET, {
      algorithms: ['HS256'],
      issuer: 'pix3-cloud',
      audience: 'pix3-rooms',
    }) as Record<string, unknown>;

    expect(claims.roomId).toBe('arena-1');
    expect(claims.role).toBe('host');
    expect(claims.guest).toBe(true);
    expect(String(claims.sub)).toMatch(/^guest:/);
    // The WS URL is derived from the admin URL, so one env var configures both.
    expect(body.wsUrl).toBe(`${config.ROOMS_ADMIN_URL.replace('http', 'ws')}/ws`);
    expect((body.room as Record<string, unknown>).roomId).toBe('arena-1');
  });

  it('speaks for the signed-in account when there is one', async () => {
    auth.user = { id: 'u-7', email: 'a@b.c', username: 'igor', is_admin: false };

    const { body } = await post('/api/rooms', { projectId: 'p' });
    const claims = jwt.decode(body.token as string) as Record<string, unknown>;

    expect(claims.sub).toBe('user:u-7');
    expect(claims.guest).toBe(false);
    expect(claims.name).toBe('igor');
  });

  it('refuses a request with no projectId, and a malformed room id', async () => {
    expect((await post('/api/rooms', {})).status).toBe(400);
    expect((await post('/api/rooms', { projectId: 'p', roomId: 'has spaces' })).status).toBe(400);
    expect((await post('/api/rooms', { projectId: 'p', allowedKinds: [0, 70000] })).status).toBe(
      400
    );
    expect(
      (await post('/api/rooms', { projectId: 'p', world: { originX: 0, originY: 0, size: 0 } }))
        .status
    ).toBe(400);
  });

  it('reports a refused service token as a server-side fault, not the caller’s', async () => {
    fabric.createStatus = 401;
    fabric.createBody = {};

    const { status, body } = await post('/api/rooms', { projectId: 'p' });

    expect(status).toBe(502);
    expect(body.error).toBe('fabric_error');
  });

  it('passes a field rejection from the fabric through with its own code', async () => {
    fabric.createStatus = 400;
    fabric.createBody = { error: 'invalid_request', message: 'tickHz out of range' };

    const { status, body } = await post('/api/rooms', { projectId: 'p', tickHz: 9999 });

    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.message).toBe('tickHz out of range');
  });

  it('mints a guest join token for a live room', async () => {
    fabric.getBody = roomResponse({}, 2);

    const { status, body } = await post('/api/rooms/arena-1/token', { displayName: 'Phone' });
    const claims = jwt.decode(body.token as string) as Record<string, unknown>;

    expect(status).toBe(200);
    expect(claims.roomId).toBe('arena-1');
    expect(claims.role).toBe('player');
    expect(claims.name).toBe('Phone');
  });

  it('answers 404 for a swept room and 409 for a full one', async () => {
    fabric.getStatus = 404;
    expect((await post('/api/rooms/arena-1/token', {})).status).toBe(404);

    fabric.getStatus = 200;
    fabric.getBody = roomResponse({ maxPlayers: 2 }, 2);
    const full = await post('/api/rooms/arena-1/token', {});
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('room_full');
  });

  it('destroys a room only for the holder of its host token', async () => {
    const created = await post('/api/rooms', { projectId: 'p', roomId: 'arena-1' });
    const hostToken = created.body.token as string;
    const joinToken = (await post('/api/rooms/arena-1/token', {})).body.token as string;

    const anonymous = await fetch(`${apiUrl}/api/rooms/arena-1`, { method: 'DELETE' });
    expect(anonymous.status).toBe(403);

    const asPlayer = await fetch(`${apiUrl}/api/rooms/arena-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${joinToken}` },
    });
    expect(asPlayer.status).toBe(403);

    // A host token for a *different* room must not close this one.
    const foreign = jwt.sign({ roomId: 'other', role: 'host' }, SECRET, {
      subject: 'guest:x',
      issuer: 'pix3-cloud',
      audience: 'pix3-rooms',
      expiresIn: 60,
    });
    const asForeignHost = await fetch(`${apiUrl}/api/rooms/arena-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(asForeignHost.status).toBe(403);
    expect(fabric.deletedRooms).toEqual([]);

    const asHost = await fetch(`${apiUrl}/api/rooms/arena-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(asHost.status).toBe(200);
    expect(fabric.deletedRooms).toEqual(['arena-1']);
  });

  it('answers 503 while no fabric is configured', async () => {
    const previous = config.ROOMS_ADMIN_URL;
    Object.assign(config as unknown as Record<string, unknown>, { ROOMS_ADMIN_URL: '' });

    const { status, body } = await post('/api/rooms', { projectId: 'p' });

    expect(status).toBe(503);
    expect(body.error).toBe('rooms_not_configured');

    Object.assign(config as unknown as Record<string, unknown>, { ROOMS_ADMIN_URL: previous });
  });

  it('buckets room creation per address', async () => {
    Object.assign(config as unknown as Record<string, unknown>, { ROOMS_CREATE_PER_MINUTE: 2 });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await post('/api/rooms', { projectId: 'p' })).status);
    }

    expect(statuses.filter(status => status === 429).length).toBeGreaterThan(0);

    Object.assign(config as unknown as Record<string, unknown>, { ROOMS_CREATE_PER_MINUTE: 1000 });
  });
});
