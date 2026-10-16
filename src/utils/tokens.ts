import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthorized } from './httpError';

export interface AccessPayload {
  sub: string;
  role: string;
  cid: string | null;
}

export const signAccessToken = (p: AccessPayload) =>
  jwt.sign(p, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl } as SignOptions);

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.jwtAccessSecret) as unknown as AccessPayload;
  } catch {
    throw unauthorized('Invalid or expired token', 'TOKEN_INVALID');
  }
}

export const newRefreshToken = () => crypto.randomBytes(48).toString('hex');
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
