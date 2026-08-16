import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { rateLimit } from '../rate-limit.js';
import { hashPassword, comparePassword, comparePasswordAgainstDummy } from './password.js';
import { signToken, requireAuth, AuthenticatedRequest } from './auth-middleware.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
};

export const authRouter = Router();

/**
 * Login is bucketed per IP *and* per email, and either bucket alone answers 429.
 *
 * Per-email because the attack that matters is one password against many accounts as much as many
 * passwords against one; per-IP because a botnet spreads the email side out. The email budget is the
 * tighter of the two — a real person mistypes a password a handful of times, not twenty.
 */
const loginByIp = rateLimit({
  limit: 20,
  windowMs: 5 * 60_000,
  message: 'Too many sign-in attempts from this address. Wait a few minutes and try again.',
});

const loginByEmail = rateLimit({
  limit: 8,
  windowMs: 5 * 60_000,
  keyResolver: req => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? `email:${email.trim().toLowerCase()}` : 'email:(none)';
  },
  message: 'Too many sign-in attempts for this account. Wait a few minutes and try again.',
});

/** Registration is per-IP only; there is no prior identity to bucket on. */
const registerByIp = rateLimit({
  limit: 5,
  windowMs: 60 * 60_000,
  message: 'Too many accounts created from this address. Try again later.',
});

/**
 * Registration input limits.
 *
 * Bounds, not policy: the point is that `email` and `username` land in a UNIQUE index and a JWT
 * payload, and neither had any length or shape check at all — a non-string reached
 * `db.prepare(...).get()` directly, where better-sqlite3 throws and the handler answers 500 instead
 * of 400. The password floor is the pre-existing six characters, kept so no current account becomes
 * unrepresentable.
 */
const MAX_EMAIL_LENGTH = 254; // RFC 5321 path limit.
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 40;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 200; // bcrypt truncates past 72 bytes; refuse rather than silently cut.

/**
 * Deliberately permissive: one `@`, something either side, no whitespace. A stricter pattern
 * rejects addresses that genuinely exist, and the authoritative check for an email is whether mail
 * to it arrives — which this server does not do.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Usernames appear in presence UI and project member lists, so they stay to printable text. */
const USERNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

type Registration = { email: string; username: string; password: string } | { error: string };

function readRegistration(body: unknown): Registration {
  const raw = (body ?? {}) as { email?: unknown; username?: unknown; password?: unknown };

  if (
    typeof raw.email !== 'string' ||
    typeof raw.username !== 'string' ||
    typeof raw.password !== 'string'
  ) {
    return { error: 'email, username, and password are required' };
  }

  // Stored lowercase so the UNIQUE index and every later lookup agree on identity.
  const email = raw.email.trim().toLowerCase();
  const username = raw.username.trim();
  const password = raw.password;

  if (!email || !username || !password) {
    return { error: 'email, username, and password are required' };
  }

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { error: 'Enter a valid email address' };
  }

  if (
    username.length < MIN_USERNAME_LENGTH ||
    username.length > MAX_USERNAME_LENGTH ||
    !USERNAME_PATTERN.test(username)
  ) {
    return {
      error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters, starting with a letter or digit`,
    };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }

  return { email, username, password };
}

authRouter.post('/register', registerByIp, async (req: Request, res: Response) => {
  try {
    const credentials = readRegistration(req.body);
    if ('error' in credentials) {
      res.status(400).json({ error: credentials.error });
      return;
    }

    const { email, username, password } = credentials;

    const db = getDb();
    // LOWER on the stored side too: the UNIQUE constraint is case-sensitive, so a plain `=` would
    // let `A@b.c` register alongside `a@b.c` and then only one of them could ever sign in.
    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?')
      .get(email, username.toLowerCase());

    if (existing) {
      res.status(409).json({ error: 'User with this email or username already exists' });
      return;
    }

    const id = crypto.randomUUID();
    const password_hash = await hashPassword(password);

    db.prepare('INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)').run(
      id,
      email,
      username,
      password_hash
    );

    const token = signToken({ userId: id, email });
    res.cookie('token', token, COOKIE_OPTIONS);
    // `is_admin` travels with every user payload (register/login/me): the editor drives admin-only
    // chrome off it, and omitting it here left a freshly signed-in admin looking like a plain user
    // until the next reload re-read /me.
    res.status(201).json({ id, email, username, is_admin: false, token });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/login', loginByIp, loginByEmail, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const db = getDb();
    // LOWER, to match registration: the column is case-sensitive, and an address that differs only
    // in case is the same address to every mail server on earth.
    const user = db
      .prepare(
        'SELECT id, email, username, password_hash, is_admin FROM users WHERE LOWER(email) = ?'
      )
      .get(email.toLowerCase()) as
      | { id: string; email: string; username: string; password_hash: string; is_admin: number }
      | undefined;

    // The unknown-user branch burns an equivalent bcrypt comparison before answering. Returning
    // early here is what made response time an email-enumeration oracle.
    const valid = user
      ? await comparePassword(password, user.password_hash)
      : await comparePasswordAgainstDummy(password);

    if (!user || !valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = signToken({ userId: user.id, email: user.email });
    res.cookie('token', token, COOKIE_OPTIONS);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      is_admin: Boolean(user.is_admin),
      token,
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  // Re-sign a fresh token so the client always has a valid one for WebSocket auth
  const token = signToken({ userId: req.user!.id, email: req.user!.email });
  res.json({ ...req.user, token });
});
