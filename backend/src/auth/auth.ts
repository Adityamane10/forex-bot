/**
 * Authentication & authorization. Password hashing (bcrypt), JWT sessions,
 * middleware for protected routes. WebSocket authentication is handled in the
 * socket layer. Secrets never reach the frontend.
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AuthUser } from '@fx/shared';
import { config } from '../config';
import { DataStore } from '../db/store';
import { logger } from '../core/logger';

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export class AuthService {
  constructor(private store: DataStore) {}

  async register(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const existing = await this.store.findOne<AuthUser & { passwordHash: string }>('users', { email: email.toLowerCase() });
    if (existing) throw new Error('email already registered');
    const passwordHash = await bcrypt.hash(password, 12);
    const user: AuthUser = {
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      role: 'USER',
      createdAt: Date.now(),
    };
    await this.store.insertOne('users', { ...user, passwordHash });
    const token = this.sign(user);
    return { token, user };
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const record = await this.store.findOne<AuthUser & { passwordHash: string }>('users', { email: email.toLowerCase() });
    if (!record) throw new Error('invalid credentials');
    const ok = await bcrypt.compare(password, record.passwordHash);
    if (!ok) throw new Error('invalid credentials');
    const user: AuthUser = { id: record.id, email: record.email, role: record.role, createdAt: record.createdAt };
    return { token: this.sign(user), user };
  }

  verify(token: string): AuthUser | null {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as { user: AuthUser };
      return payload.user ?? null;
    } catch {
      return null;
    }
  }

  private sign(user: AuthUser): string {
    return jwt.sign({ user }, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
  }

  middleware() {
    return (req: AuthedRequest, res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const user = this.verify(header.slice(7));
      if (!user) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      req.user = user;
      next();
    };
  }
}
