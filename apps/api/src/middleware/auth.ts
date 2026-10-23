import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query } from '../db/index.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(user: AuthUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn as any }
  );
}

export const DEFAULT_DEV_USER_ID = '00000000-0000-0000-0000-000000000001';

export async function ensureDefaultUser(): Promise<AuthUser> {
  const existing = await query<AuthUser>('SELECT id, email, role FROM users WHERE id = $1', [DEFAULT_DEV_USER_ID]);
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const hash = await hashPassword('password123');
  const created = await query<AuthUser>(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'dev@docsearch.local', $2, 'admin')
     ON CONFLICT (id) DO NOTHING
     RETURNING id, email, role;`,
    [DEFAULT_DEV_USER_ID, hash]
  );
  if (created.rows.length > 0) {
    return created.rows[0];
  }
  return { id: DEFAULT_DEV_USER_ID, email: 'dev@docsearch.local', role: 'admin' };
}

/**
 * Authentication middleware.
 * Verifies JWT token from Authorization: Bearer <token>.
 * In development, if no token is provided, safely falls back to default dev user.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
      req.user = decoded;
      return next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired authentication token' });
      return;
    }
  }

  // Development fallback user
  if (config.nodeEnv !== 'development') {
    res.status(401).json({ error: 'Authentication token required' });
    return;
  }

  try {
    req.user = await ensureDefaultUser();
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication required' });
  }
}

/**
 * Strict authentication middleware (requires valid JWT, no fallback)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication token required' });
    return;
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
