import { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool';
import { forbidden, HttpError, unauthorized } from '../utils/httpError';
import { verifyAccessToken } from '../utils/tokens';
import { getCurrentSubscription, SubscriptionInfo } from '../services/subscription';

export type Role = 'super_admin' | 'company_admin' | 'manager' | 'employee' | 'viewer';

export interface AuthContext {
  user: { id: string; companyId: string | null; name: string; email: string; role: Role };
  company?: { id: string; name: string; slug: string; status: 'active' | 'suspended' };
  subscription?: SubscriptionInfo | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Validates the Bearer token and re-reads user + company from the DB on every request,
 * so deactivating a user or suspending a company takes effect immediately.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw unauthorized();
  const payload = verifyAccessToken(header.slice(7));

  const { rows } = await query(
    `SELECT u.id, u.company_id, u.name, u.email, u.role, u.is_active,
            c.name AS company_name, c.slug AS company_slug, c.status AS company_status
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [payload.sub],
  );
  const u = rows[0];
  if (!u || !u.is_active) throw unauthorized('Account is disabled', 'ACCOUNT_DISABLED');
  if (u.company_id && u.company_status === 'suspended') {
    throw new HttpError(403, 'COMPANY_SUSPENDED', 'This company account is suspended. Please contact support.');
  }

  req.auth = {
    user: { id: u.id, companyId: u.company_id, name: u.name, email: u.email, role: u.role },
    company: u.company_id
      ? { id: u.company_id, name: u.company_name, slug: u.company_slug, status: u.company_status }
      : undefined,
  };
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.user.role)) throw forbidden();
    next();
  };

/** Tenant routes only: ensures the caller belongs to a company and (optionally) has a live subscription. */
export function requireTenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.company) throw forbidden('This endpoint is only for company users');
  next();
}

export async function requireActiveSubscription(req: Request, _res: Response, next: NextFunction) {
  const companyId = req.auth!.company!.id;
  const sub = await getCurrentSubscription(companyId);
  req.auth!.subscription = sub;
  if (!sub || sub.status === 'expired') {
    throw new HttpError(
      402,
      'SUBSCRIPTION_EXPIRED',
      'Your subscription has expired. Please renew your plan to continue.',
    );
  }
  next();
}
