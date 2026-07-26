import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { hashPassword, comparePassword } from './password.js';
import { signToken, requireAuth, AuthenticatedRequest } from './auth-middleware.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
};

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      res.status(400).json({ error: 'email, username, and password are required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM users WHERE email = ? OR username = ?')
      .get(email, username);

    if (existing) {
      res.status(409).json({ error: 'User with this email or username already exists' });
      return;
    }

    const id = crypto.randomUUID();
    const password_hash = await hashPassword(password);

    db.prepare(
      'INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)'
    ).run(id, email, username, password_hash);

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

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const db = getDb();
    const user = db
      .prepare('SELECT id, email, username, password_hash, is_admin FROM users WHERE email = ?')
      .get(email) as
      | { id: string; email: string; username: string; password_hash: string; is_admin: number }
      | undefined;

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
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
