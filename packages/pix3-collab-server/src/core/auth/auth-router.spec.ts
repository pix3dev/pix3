// @vitest-environment node
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-up / sign-in flow, against a real sqlite file.
 *
 * This surface had no spec at all, which is how it kept an unthrottled login, an
 * email-enumeration timing oracle, a case-sensitive email column that registration and login
 * disagreed about, and a body that reached `db.prepare(...).get()` unvalidated.
 *
 * bcrypt cost is pinned to the minimum so the suite is not dominated by hashing; every assertion
 * here is about control flow, not about how expensive the hash is.
 */

let testDb: Database.Database | null = null;

vi.mock('../db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../db.js')>();
  return { ...actual, getDb: () => testDb! };
});

vi.mock('../../config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { config: { ...actual.config, PASSWORD_SALT_ROUNDS: 4, JWT_SECRET: 'test-secret' } };
});

const { runMigrations } = await import('../db.js');
const { authRouter } = await import('./auth-router.js');

let dbPath: string | null = null;
let server: http.Server | null = null;
let baseUrl = '';

/**
 * The rate limiters live in module scope, so their budgets persist for the whole file — which is
 * correct for a server and inconvenient for a suite where every request would otherwise arrive
 * from 127.0.0.1 and share one bucket.
 *
 * So the test app trusts a proxy header and each test sends its own client address. That keeps the
 * limiter under test (rather than reset or stubbed out) and exercises the thing that actually
 * matters about it: that budgets are per-key.
 */
async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRouter);

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** The address this test speaks from; set per test so budgets never collide. */
let clientIp = '10.0.0.1';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  setCookie: string | null;
}

async function rawPost(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
    body: JSON.stringify(body),
  });
}

async function post(pathname: string, body: unknown): Promise<JsonResponse> {
  const res = await rawPost(pathname, body);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    setCookie: res.headers.get('set-cookie'),
  };
}

/** A unique-per-call address, so the per-email login budget never collides between tests. */
function freshEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

let ipCounter = 0;
function freshClientIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 0xff}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `pix3-auth-${randomUUID()}.sqlite`);
  testDb = new Database(dbPath);
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);
  clientIp = freshClientIp();
  await startServer();
});

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = null;
  testDb?.close();
  testDb = null;
  if (dbPath) {
    fs.rmSync(dbPath, { force: true });
    dbPath = null;
  }
});

describe('POST /api/auth/register', () => {
  it('creates an account and sets an httpOnly session cookie', async () => {
    const email = freshEmail();
    const res = await post('/api/auth/register', {
      email,
      username: 'Newcomer',
      password: 'hunter2',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, username: 'Newcomer', is_admin: false });
    expect(res.setCookie).toContain('token=');
    expect(res.setCookie?.toLowerCase()).toContain('httponly');
  });

  it('stores the email lowercased so the UNIQUE index matches how login looks it up', async () => {
    const email = freshEmail();
    await post('/api/auth/register', {
      email: email.toUpperCase(),
      username: `u${randomUUID().slice(0, 8)}`,
      password: 'hunter2',
    });

    const row = testDb!.prepare('SELECT email FROM users').get() as { email: string };
    expect(row.email).toBe(email.toLowerCase());
  });

  it('refuses a duplicate that differs only in case', async () => {
    const email = freshEmail();
    await post('/api/auth/register', { email, username: 'First', password: 'hunter2' });

    const res = await post('/api/auth/register', {
      email: email.toUpperCase(),
      username: 'Second',
      password: 'hunter2',
    });

    expect(res.status).toBe(409);
  });

  it.each([
    ['a non-string email', { email: 42, username: 'Someone', password: 'hunter2' }],
    ['an object password', { email: 'a@b.co', username: 'Someone', password: { $ne: null } }],
    ['a missing username', { email: 'a@b.co', password: 'hunter2' }],
    ['an email with no @', { email: 'not-an-email', username: 'Someone', password: 'hunter2' }],
    ['an email with whitespace', { email: 'a b@c.co', username: 'Someone', password: 'hunter2' }],
    ['a one-character username', { email: 'a@b.co', username: 'x', password: 'hunter2' }],
    ['a username of punctuation', { email: 'a@b.co', username: '!!!', password: 'hunter2' }],
    ['a short password', { email: 'a@b.co', username: 'Someone', password: '12345' }],
    [
      'a 201-character password',
      { email: 'a@b.co', username: 'Someone', password: 'x'.repeat(201) },
    ],
  ])('rejects %s with 400, not 500', async (_label, body) => {
    const res = await post('/api/auth/register', body);

    expect(res.status).toBe(400);
    expect(testDb!.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('accepts a long unicode display name', async () => {
    // The username rule must not be so tight that real names bounce off it.
    const res = await post('/api/auth/register', {
      email: freshEmail(),
      username: 'Игорь Гриценко',
      password: 'hunter2',
    });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/auth/login', () => {
  const password = 'hunter2';
  let email: string;

  beforeEach(async () => {
    email = freshEmail();
    await post('/api/auth/register', { email, username: `u${randomUUID().slice(0, 8)}`, password });
  });

  it('signs in with the right password', async () => {
    const res = await post('/api/auth/login', { email, password });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect(res.setCookie).toContain('token=');
  });

  it('signs in regardless of the email’s case', async () => {
    const res = await post('/api/auth/login', { email: email.toUpperCase(), password });

    expect(res.status).toBe(200);
  });

  it('rejects the wrong password', async () => {
    const res = await post('/api/auth/login', { email, password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.setCookie).toBeNull();
  });

  it('answers an unknown account identically to a wrong password', async () => {
    const unknown = await post('/api/auth/login', { email: freshEmail(), password });
    const wrong = await post('/api/auth/login', { email, password: 'wrong' });

    // Same status and same body: the response must not distinguish "no such user" either.
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  // The cost side of the oracle is asserted in `password.spec.ts`, against the bcrypt calls
  // themselves: over HTTP at a test salt-round, request overhead swamps the difference and the
  // assertion passes whether or not the fix is present.

  it('rejects a missing or non-string body with 400', async () => {
    expect((await post('/api/auth/login', {})).status).toBe(400);
    expect((await post('/api/auth/login', { email: 42, password: 1 })).status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('throttles repeated failures against one account', async () => {
    const email = freshEmail();
    await post('/api/auth/register', {
      email,
      username: `u${randomUUID().slice(0, 8)}`,
      password: 'hunter2',
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await post('/api/auth/login', { email, password: 'wrong' })).status);
    }

    expect(statuses).toContain(429);
    // Throttling must arrive after some real attempts, not instead of them.
    expect(statuses.filter(status => status === 401).length).toBeGreaterThan(0);
  });

  it('tells a throttled client when to retry', async () => {
    const email = freshEmail();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await post('/api/auth/login', { email, password: 'wrong' });
    }

    const res = await rawPost('/api/auth/login', { email, password: 'wrong' });

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('throttles one account without touching another client', async () => {
    // Per-key budgets are the whole point: one hammered account must not lock out the rest.
    const victim = freshEmail();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await post('/api/auth/login', { email: victim, password: 'wrong' });
    }
    expect((await post('/api/auth/login', { email: victim, password: 'wrong' })).status).toBe(429);

    clientIp = freshClientIp();
    const bystander = freshEmail();
    const registered = await post('/api/auth/register', {
      email: bystander,
      username: `u${randomUUID().slice(0, 8)}`,
      password: 'hunter2',
    });

    expect(registered.status).toBe(201);
    expect((await post('/api/auth/login', { email: bystander, password: 'hunter2' })).status).toBe(
      200
    );
  });

  it('throttles account creation per address', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push(
        (
          await post('/api/auth/register', {
            email: freshEmail(),
            username: `u${randomUUID().slice(0, 8)}`,
            password: 'hunter2',
          })
        ).status
      );
    }

    expect(statuses.filter(status => status === 201).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
  });
});
