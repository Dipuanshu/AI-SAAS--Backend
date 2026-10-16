import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { query, withTransaction } from '../../db/pool';
import { authenticate } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { getCurrentSubscription } from '../../services/subscription';
import { audit } from '../../utils/audit';
import { badRequest, conflict, forbidden, HttpError, unauthorized } from '../../utils/httpError';
import { hashPassword, verifyPassword } from '../../utils/password';
import { uniqueCompanySlug } from '../../utils/slug';
import { STACKS } from '../ai/guide';
import { hashToken } from '../../utils/tokens';
import { issueSession, publicCompany, publicUser, revokeAllSessions } from './session';
import {
  adminLoginSchema,
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerCompanySchema,
} from './schemas';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again in a few minutes.' } },
});

async function sessionResponse(req: Request, userRow: any, companyRow: any | null) {
  const tokens = await issueSession(userRow, req);
  const subscription = companyRow ? await getCurrentSubscription(companyRow.id) : null;
  return {
    ...tokens,
    user: publicUser(userRow),
    company: companyRow ? publicCompany(companyRow) : null,
    subscription,
  };
}

// --- Company registration ----------------------------------------------------------------------
authRouter.post('/register-company', limiter, async (req: Request, res: Response) => {
  const body = parse(registerCompanySchema, req.body);

  const planRes = await query('SELECT * FROM plans WHERE code = $1 AND is_active = true', [body.planCode ?? 'starter']);
  const plan = planRes.rows[0];
  if (!plan) throw badRequest('Selected plan is not available', 'PLAN_NOT_FOUND');

  const dup = await query('SELECT 1 FROM companies WHERE email = $1', [body.email]);
  if (dup.rowCount) throw conflict('A company is already registered with this email', 'COMPANY_EXISTS');

  const slug = await uniqueCompanySlug(body.companyName);
  const passwordHash = await hashPassword(body.password);

  const { company, user } = await withTransaction(async (client) => {
    const c = (
      await client.query(
        `INSERT INTO companies (name, slug, email, phone, backend_stack) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [body.companyName, slug, body.email, body.companyPhone ?? null, STACKS.some((x) => x.id === body.backendStack) ? body.backendStack : null],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO subscriptions (company_id, plan_id, kind, billing_cycle, starts_at, expires_at, amount, notes)
       VALUES ($1,$2,'trial','custom', now(), now() + ($3 || ' days')::interval, 0, 'Free trial on registration')`,
      [c.id, plan.id, String(env.trialDays)],
    );
    const u = (
      await client.query(
        `INSERT INTO users (company_id, name, email, password_hash, role, last_login_at)
         VALUES ($1,$2,$3,$4,'company_admin', now()) RETURNING *`,
        [c.id, body.adminName, body.email, passwordHash],
      )
    ).rows[0];
    await audit({ companyId: c.id, userId: u.id, action: 'company.registered', entity: 'company', entityId: c.id, ip: req.ip }, client);
    return { company: c, user: u };
  });

  res.status(201).json(await sessionResponse(req, user, company));
});

// --- Company picker (step 1 of login) -----------------------------------------------------------
authRouter.get('/companies', limiter, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ companies: [] });
  const { rows } = await query(
    `SELECT name, slug FROM companies
     WHERE status = 'active' AND (lower(name) LIKE $1 OR slug LIKE $1)
     ORDER BY name LIMIT 10`,
    [`%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`],
  );
  res.json({ companies: rows });
});

// --- Login (step 2: credentials verified against our own users table) ----------------------------
authRouter.post('/login', limiter, async (req: Request, res: Response) => {
  const body = parse(loginSchema, req.body);
  const invalid = () => unauthorized('Invalid company, email or password', 'INVALID_CREDENTIALS');

  const company = (await query('SELECT * FROM companies WHERE slug = $1', [body.companySlug])).rows[0];
  const user = company
    ? (await query('SELECT * FROM users WHERE company_id = $1 AND email = $2', [company.id, body.email])).rows[0]
    : undefined;

  const ok = await verifyPassword(body.password, user?.password_hash);
  if (!company || !user || !ok) throw invalid();
  if (company.status === 'suspended') {
    throw new HttpError(403, 'COMPANY_SUSPENDED', 'This company account is suspended. Please contact support.');
  }
  if (!user.is_active) throw forbidden('Your account has been disabled. Contact your company admin.', 'ACCOUNT_DISABLED');

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit({ companyId: company.id, userId: user.id, action: 'auth.login', ip: req.ip });
  res.json(await sessionResponse(req, user, company));
});

authRouter.post('/admin/login', limiter, async (req: Request, res: Response) => {
  const body = parse(adminLoginSchema, req.body);
  const user = (await query(`SELECT * FROM users WHERE company_id IS NULL AND email = $1`, [body.email])).rows[0];
  const ok = await verifyPassword(body.password, user?.password_hash);
  if (!user || !ok) throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  if (!user.is_active) throw forbidden('Account disabled', 'ACCOUNT_DISABLED');
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit({ companyId: null, userId: user.id, action: 'auth.admin_login', ip: req.ip });
  res.json(await sessionResponse(req, user, null));
});

// --- Refresh (rotating, with reuse detection) -----------------------------------------------------
authRouter.post('/refresh', limiter, async (req: Request, res: Response) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  const row = (await query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)])).rows[0];
  if (!row) throw unauthorized('Session expired. Please log in again.', 'REFRESH_INVALID');
  if (row.revoked_at) {
    // A rotated token was presented again => likely stolen. Kill every session of this user.
    await revokeAllSessions(row.user_id);
    throw unauthorized('Session expired. Please log in again.', 'REFRESH_INVALID');
  }
  if (new Date(row.expires_at) < new Date()) throw unauthorized('Session expired. Please log in again.', 'REFRESH_INVALID');

  const user = (await query('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
  if (!user || !user.is_active) throw unauthorized('Account is disabled', 'ACCOUNT_DISABLED');
  let company = null;
  if (user.company_id) {
    company = (await query('SELECT * FROM companies WHERE id = $1', [user.company_id])).rows[0];
    if (company.status === 'suspended') throw new HttpError(403, 'COMPANY_SUSPENDED', 'This company account is suspended.');
  }
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  res.json(await sessionResponse(req, user, company));
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
  if (token) await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
  res.json({ ok: true });
});

// --- Current user -------------------------------------------------------------------------------
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { user, company } = req.auth!;
  const userRow = (await query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  const companyRow = company ? (await query('SELECT * FROM companies WHERE id = $1', [company.id])).rows[0] : null;
  res.json({
    user: publicUser(userRow),
    company: companyRow ? publicCompany(companyRow) : null,
    subscription: companyRow ? await getCurrentSubscription(companyRow.id) : null,
  });
});

authRouter.post('/change-password', authenticate, async (req: Request, res: Response) => {
  const body = parse(changePasswordSchema, req.body);
  const row = (await query('SELECT * FROM users WHERE id = $1', [req.auth!.user.id])).rows[0];
  if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
    throw badRequest('Current password is incorrect', 'WRONG_PASSWORD');
  }
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await hashPassword(body.newPassword), row.id]);
  await revokeAllSessions(row.id);
  await audit({ companyId: row.company_id, userId: row.id, action: 'auth.password_changed', ip: req.ip });
  // Issue a fresh session so the caller stays logged in on this device.
  res.json({ ok: true, ...(await issueSession(row, req)) });
});
