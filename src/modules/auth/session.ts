import { Request } from 'express';
import { PoolClient } from 'pg';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { newRefreshToken, hashToken, signAccessToken } from '../../utils/tokens';

export function publicUser(r: any) {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    email: r.email,
    phone: r.phone ?? null,
    role: r.role,
    jobTitle: r.job_title ?? null,
    isActive: r.is_active,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function publicCompany(r: any) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    email: r.email,
    phone: r.phone ?? null,
    address: r.address ?? null,
    website: r.website ?? null,
    logoUrl: r.logo_url ?? null,
    backendStack: r.backend_stack ?? null,
    status: r.status,
    suspendedReason: r.suspended_reason ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function issueSession(user: { id: string; role: string; company_id: string | null }, req: Request, client?: PoolClient) {
  const refreshToken = newRefreshToken();
  const expires = new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000);
  const sql = `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`;
  const params = [user.id, hashToken(refreshToken), expires, (req.headers['user-agent'] ?? '').slice(0, 255), req.ip ?? null];
  await (client ? client.query(sql, params) : query(sql, params));
  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role, cid: user.company_id }),
    refreshToken,
  };
}

export const revokeAllSessions = (userId: string) =>
  query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
