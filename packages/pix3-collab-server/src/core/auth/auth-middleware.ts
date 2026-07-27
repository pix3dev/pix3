import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { getDb } from '../db.js';

export interface JwtPayload {
  userId: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; username: string; is_admin: boolean };
}

function resolveCookieToken(req: Request): string | null {
  const token = req.cookies?.token;
  return typeof token === 'string' && token.trim().length > 0 ? token : null;
}

function resolveUserFromToken(token: string) {
  const payload = verifyToken(token);
  return getDb()
    .prepare('SELECT id, email, username, is_admin FROM users WHERE id = ?')
    .get(payload.userId) as
    | { id: string; email: string; username: string; is_admin: number }
    | undefined;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = resolveCookieToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const user = resolveUserFromToken(token);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = { ...user, is_admin: Boolean(user.is_admin) };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function attachOptionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const token = resolveCookieToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const user = resolveUserFromToken(token);
    if (user) {
      req.user = { ...user, is_admin: Boolean(user.is_admin) };
    }
  } catch {
    // Ignore invalid cookies here. Protected routes should use requireAuth.
  }

  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user?.is_admin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
