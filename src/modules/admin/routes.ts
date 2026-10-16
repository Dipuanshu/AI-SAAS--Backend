import { Request, Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { getCurrentSubscription, getSubscriptionHistory, mapSubscription } from '../../services/subscription';
import { auditFromReq } from '../../utils/audit';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { likePattern, pageMeta, pageSchema } from '../../utils/pagination';
import { publicCompany, publicUser, revokeAllSessions } from '../auth/session';
import { mapPlan } from '../plans/routes';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('super_admin'));

const DAY = 86_400_000;

// --- Dashboard -------------------------------------------------------------------------------------------
adminRouter.get('/stats', async (_req, res) => {
  const { rows } = await query(`
    WITH cur AS (
      SELECT DISTINCT ON (company_id) company_id, kind, billing_cycle, expires_at, amount
      FROM subscriptions ORDER BY company_id, created_at DESC, id
    )
    SELECT
      (SELECT count(*)::int FROM companies) AS total_companies,
      (SELECT count(*)::int FROM companies WHERE status = 'suspended') AS suspended,
      (SELECT count(*)::int FROM companies WHERE created_at > now() - interval '30 days') AS new_30d,
      (SELECT count(*)::int FROM cur JOIN companies c ON c.id = cur.company_id
         WHERE c.status = 'active' AND cur.expires_at > now() AND cur.kind = 'trial') AS on_trial,
      (SELECT count(*)::int FROM cur JOIN companies c ON c.id = cur.company_id
         WHERE c.status = 'active' AND cur.expires_at > now() AND cur.kind <> 'trial') AS paying,
      (SELECT count(*)::int FROM cur WHERE cur.expires_at <= now()) AS expired,
      (SELECT count(*)::int FROM cur WHERE cur.expires_at > now() AND cur.expires_at <= now() + interval '7 days') AS expiring_7d,
      (SELECT count(*)::int FROM cur WHERE cur.expires_at > now() AND cur.expires_at <= now() + interval '30 days') AS expiring_30d,
      (SELECT count(*)::int FROM users WHERE company_id IS NOT NULL AND is_active) AS total_users,
      (SELECT COALESCE(sum(CASE billing_cycle WHEN 'yearly' THEN amount / 12 WHEN 'monthly' THEN amount ELSE 0 END), 0)
         FROM cur WHERE kind = 'paid' AND expires_at > now()) AS mrr,
      (SELECT COALESCE(sum(amount), 0) FROM subscriptions) AS total_billed
  `);
  const r = rows[0];
  const byPlan = (
    await query(`
      WITH cur AS (SELECT DISTINCT ON (company_id) company_id, plan_id, expires_at FROM subscriptions ORDER BY company_id, created_at DESC, id)
      SELECT p.code, p.name, count(*)::int AS companies FROM cur JOIN plans p ON p.id = cur.plan_id
      WHERE cur.expires_at > now() GROUP BY p.code, p.name, p.sort_order ORDER BY p.sort_order`)
  ).rows;
  res.json({
    totalCompanies: r.total_companies,
    suspended: r.suspended,
    newLast30Days: r.new_30d,
    onTrial: r.on_trial,
    paying: r.paying,
    expired: r.expired,
    expiringIn7Days: r.expiring_7d,
    expiringIn30Days: r.expiring_30d,
    totalUsers: r.total_users,
    monthlyRecurringRevenue: Number(r.mrr),
    totalBilled: Number(r.total_billed),
    companiesByPlan: byPlan,
  });
});

// --- Companies --------------------------------------------------------------------------------------------
const LIST_SQL = `
  SELECT c.*,
    s.id AS sub_id, s.plan_id, s.kind, s.billing_cycle, s.starts_at, s.expires_at, s.amount, s.notes,
    p.code AS plan_code, p.name AS plan_name, p.max_users, p.features, p.currency,
    (SELECT count(*)::int FROM users u WHERE u.company_id = c.id AND u.is_active) AS user_count
  FROM companies c
  LEFT JOIN LATERAL (SELECT * FROM subscriptions x WHERE x.company_id = c.id ORDER BY x.created_at DESC, x.id LIMIT 1) s ON true
  LEFT JOIN plans p ON p.id = s.plan_id`;

function mapCompanyRow(r: any) {
  return {
    ...publicCompany(r),
    userCount: r.user_count,
    subscription: r.sub_id ? mapSubscription({ ...r, id: r.sub_id }) : null,
  };
}

const listSchema = pageSchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(['all', 'active', 'trial', 'expired', 'expiring', 'suspended']).default('all'),
  plan: z.string().trim().optional(),
  expiringDays: z.coerce.number().int().min(1).max(365).default(7),
  sort: z.enum(['newest', 'oldest', 'name', 'expiry']).default('newest'),
});

adminRouter.get('/companies', async (req, res) => {
  const q = parse(listSchema, req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search) {
    params.push(likePattern(q.search));
    where.push(`(lower(c.name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length} OR c.slug LIKE $${params.length})`);
  }
  if (q.plan) {
    params.push(q.plan);
    where.push(`p.code = $${params.length}`);
  }
  switch (q.status) {
    case 'suspended': where.push(`c.status = 'suspended'`); break;
    case 'active': where.push(`c.status = 'active' AND s.expires_at > now() AND s.kind <> 'trial'`); break;
    case 'trial': where.push(`c.status = 'active' AND s.expires_at > now() AND s.kind = 'trial'`); break;
    case 'expired': where.push(`(s.id IS NULL OR s.expires_at <= now())`); break;
    case 'expiring':
      params.push(q.expiringDays);
      where.push(`s.expires_at > now() AND s.expires_at <= now() + ($${params.length} || ' days')::interval`);
      break;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = { newest: 'c.created_at DESC', oldest: 'c.created_at ASC', name: 'lower(c.name) ASC', expiry: 's.expires_at ASC NULLS FIRST' }[q.sort];

  const total = (await query(`SELECT count(*)::int AS n FROM (${LIST_SQL} ${whereSql}) t`, params)).rows[0].n;
  const { rows } = await query(`${LIST_SQL} ${whereSql} ORDER BY ${order}, c.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
  res.json({ items: rows.map(mapCompanyRow), ...pageMeta(q.page, q.limit, total) });
});

async function loadCompanyRow(id: string) {
  const row = (await query(`${LIST_SQL} WHERE c.id = $1`, [id])).rows[0];
  if (!row) throw notFound('Company not found');
  return row;
}

adminRouter.get('/companies/:id', async (req, res) => {
  const row = await loadCompanyRow(String(req.params.id));
  const [history, users, admin] = await Promise.all([
    getSubscriptionHistory(row.id),
    query(`SELECT role, count(*)::int AS n FROM users WHERE company_id = $1 GROUP BY role`, [row.id]),
    query(`SELECT * FROM users WHERE company_id = $1 AND role = 'company_admin' ORDER BY created_at LIMIT 1`, [row.id]),
  ]);
  res.json({
    company: mapCompanyRow(row),
    owner: admin.rows[0] ? publicUser(admin.rows[0]) : null,
    usersByRole: Object.fromEntries(users.rows.map((u) => [u.role, u.n])),
    subscriptionHistory: history,
  });
});

adminRouter.get('/companies/:id/users', async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE company_id = $1 ORDER BY created_at', [req.params.id]);
  res.json({ items: rows.map(publicUser) });
});

const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});

adminRouter.patch('/companies/:id', async (req, res) => {
  const b = parse(updateCompanySchema, req.body);
  await loadCompanyRow(String(req.params.id));
  await query(
    `UPDATE companies SET name = COALESCE($2, name),
       phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
       address = CASE WHEN $5::boolean THEN $6 ELSE address END, updated_at = now() WHERE id = $1`,
    [req.params.id, b.name ?? null, 'phone' in b, b.phone ?? null, 'address' in b, b.address ?? null],
  );
  await auditFromReq(req, String(req.params.id), 'admin.company_updated', { entity: 'company', entityId: String(req.params.id), meta: b });
  res.json({ company: mapCompanyRow(await loadCompanyRow(String(req.params.id))) });
});

adminRouter.post('/companies/:id/suspend', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
  const row = await loadCompanyRow(String(req.params.id));
  await query(`UPDATE companies SET status = 'suspended', suspended_reason = $2, updated_at = now() WHERE id = $1`, [row.id, reason ?? null]);
  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE company_id = $1)`,
    [row.id],
  );
  await auditFromReq(req, row.id, 'admin.company_suspended', { entity: 'company', entityId: row.id, meta: { reason } });
  res.json({ company: mapCompanyRow(await loadCompanyRow(row.id)) });
});

adminRouter.post('/companies/:id/activate', async (req, res) => {
  const row = await loadCompanyRow(String(req.params.id));
  await query(`UPDATE companies SET status = 'active', suspended_reason = NULL, updated_at = now() WHERE id = $1`, [row.id]);
  await auditFromReq(req, row.id, 'admin.company_activated', { entity: 'company', entityId: row.id });
  res.json({ company: mapCompanyRow(await loadCompanyRow(row.id)) });
});

adminRouter.delete('/companies/:id', async (req, res) => {
  const { confirmSlug } = parse(z.object({ confirmSlug: z.string() }), req.body ?? {});
  const row = await loadCompanyRow(String(req.params.id));
  if (confirmSlug !== row.slug) throw badRequest('confirmSlug does not match the company slug', 'CONFIRM_MISMATCH');
  await query('DELETE FROM companies WHERE id = $1', [row.id]);
  await auditFromReq(req, null, 'admin.company_deleted', { entity: 'company', entityId: row.id, meta: { name: row.name, slug: row.slug } });
  res.json({ ok: true });
});

// --- Subscriptions ----------------------------------------------------------------------------------------
const assignSchema = z
  .object({
    planCode: z.string().trim().min(1),
    kind: z.enum(['trial', 'paid', 'complimentary']).default('paid'),
    billingCycle: z.enum(['monthly', 'yearly', 'custom']).default('monthly'),
    durationDays: z.number().int().min(1).max(3650).optional(),
    expiresAt: z.coerce.date().optional(),
    amount: z.number().min(0).optional(),
    carryOverRemaining: z.boolean().default(false),
    notes: z.string().trim().max(500).optional(),
  });

adminRouter.post('/companies/:id/subscription', async (req: Request, res) => {
  const b = parse(assignSchema, req.body);
  const company = await loadCompanyRow(String(req.params.id));
  const plan = (await query('SELECT * FROM plans WHERE code = $1', [b.planCode])).rows[0];
  if (!plan) throw badRequest('Unknown plan', 'PLAN_NOT_FOUND');

  const now = new Date();
  const days = b.durationDays ?? (b.billingCycle === 'yearly' ? 365 : 30);
  let expires: Date;
  if (b.expiresAt) {
    expires = b.expiresAt;
  } else {
    const current = await getCurrentSubscription(company.id);
    const base = b.carryOverRemaining && current && current.status !== 'expired' ? new Date(current.expiresAt) : now;
    expires = new Date(base.getTime() + days * DAY);
  }
  if (expires <= now) throw badRequest('Expiry date must be in the future', 'BAD_EXPIRY');

  const amount = b.amount ?? (b.kind === 'paid' ? Number(b.billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly) : 0);
  const inserted = await withTransaction(async (client) =>
    (
      await client.query(
        `INSERT INTO subscriptions (company_id, plan_id, kind, billing_cycle, starts_at, expires_at, amount, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [company.id, plan.id, b.kind, b.billingCycle, now, expires, amount, b.notes ?? null, req.auth!.user.id],
      )
    ).rows[0],
  );
  await auditFromReq(req, company.id, 'admin.subscription_assigned', {
    entity: 'subscription', entityId: inserted.id, meta: { plan: plan.code, kind: b.kind, expiresAt: expires.toISOString(), amount },
  });
  res.status(201).json({ company: mapCompanyRow(await loadCompanyRow(company.id)) });
});

adminRouter.post('/companies/:id/extend', async (req, res) => {
  const { days } = parse(z.object({ days: z.number().int().min(1).max(3650) }), req.body);
  const company = await loadCompanyRow(String(req.params.id));
  if (!company.sub_id) throw conflict('Company has no subscription yet. Assign a plan first.', 'NO_SUBSCRIPTION');
  await query(
    `UPDATE subscriptions SET expires_at = GREATEST(expires_at, now()) + ($2 || ' days')::interval WHERE id = $1`,
    [company.sub_id, String(days)],
  );
  await auditFromReq(req, company.id, 'admin.subscription_extended', { entity: 'subscription', entityId: company.sub_id, meta: { days } });
  res.json({ company: mapCompanyRow(await loadCompanyRow(company.id)) });
});

// --- Plans ------------------------------------------------------------------------------------------------
const planBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(''),
  priceMonthly: z.number().min(0),
  priceYearly: z.number().min(0),
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  maxUsers: z.number().int().min(1).max(100000),
  features: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

adminRouter.get('/plans', async (_req, res) => {
  const { rows } = await query(`
    SELECT p.*, (SELECT count(*)::int FROM (
        SELECT DISTINCT ON (company_id) company_id, plan_id FROM subscriptions ORDER BY company_id, created_at DESC, id) c
        WHERE c.plan_id = p.id) AS companies
    FROM plans p ORDER BY p.sort_order, p.price_monthly`);
  res.json({ plans: rows.map((r) => ({ ...mapPlan(r), companies: r.companies })) });
});

adminRouter.post('/plans', async (req, res) => {
  const b = parse(planBody.extend({ code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,30}$/, 'use a-z, 0-9, - or _') }), req.body);
  const row = (
    await query(
      `INSERT INTO plans (code, name, description, price_monthly, price_yearly, currency, max_users, features, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.code, b.name, b.description, b.priceMonthly, b.priceYearly, b.currency, b.maxUsers, JSON.stringify(b.features), b.isActive, b.sortOrder],
    )
  ).rows[0];
  await auditFromReq(req, null, 'admin.plan_created', { entity: 'plan', entityId: row.id, meta: { code: b.code } });
  res.status(201).json({ plan: mapPlan(row) });
});

adminRouter.patch('/plans/:id', async (req, res) => {
  const b = parse(planBody.partial(), req.body);
  const row = (
    await query(
      `UPDATE plans SET
         name = COALESCE($2, name), description = COALESCE($3, description),
         price_monthly = COALESCE($4, price_monthly), price_yearly = COALESCE($5, price_yearly),
         currency = COALESCE($6, currency), max_users = COALESCE($7, max_users),
         features = COALESCE($8::jsonb, features), is_active = COALESCE($9, is_active),
         sort_order = COALESCE($10, sort_order), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.description ?? null, b.priceMonthly ?? null, b.priceYearly ?? null,
        b.currency ?? null, b.maxUsers ?? null, b.features ? JSON.stringify(b.features) : null, b.isActive ?? null, b.sortOrder ?? null,
      ],
    )
  ).rows[0];
  if (!row) throw notFound('Plan not found');
  await auditFromReq(req, null, 'admin.plan_updated', { entity: 'plan', entityId: row.id, meta: b });
  res.json({ plan: mapPlan(row) });
});

// --- Platform audit log -------------------------------------------------------------------------------------
adminRouter.get('/audit-logs', async (req, res) => {
  const { page, limit } = parse(pageSchema, req.query);
  const total = (await query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n;
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.email AS user_email, c.name AS company_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id LEFT JOIN companies c ON c.id = a.company_id
     ORDER BY a.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
  );
  res.json({
    items: rows.map((r) => ({
      id: Number(r.id), action: r.action, entity: r.entity, entityId: r.entity_id, meta: r.meta,
      userName: r.user_name, userEmail: r.user_email, companyName: r.company_name, createdAt: new Date(r.created_at).toISOString(),
    })),
    ...pageMeta(page, limit, total),
  });
});
