import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool';
import { authenticate, requireActiveSubscription, requireRole, requireTenant } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { passwordSchema, emailSchema } from '../auth/schemas';
import { publicCompany, publicUser, revokeAllSessions } from '../auth/session';
import { getCurrentSubscription } from '../../services/subscription';
import { auditFromReq } from '../../utils/audit';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { hashPassword } from '../../utils/password';
import { likePattern, pageMeta, pageSchema } from '../../utils/pagination';

export const companyRouter = Router();
companyRouter.use(authenticate, requireTenant);

const companyId = (req: Request) => req.auth!.company!.id;
const ASSIGNABLE_ROLES = ['company_admin', 'manager', 'employee', 'viewer'] as const;

// --- Profile & subscription (available even when the subscription has expired) --------------------
companyRouter.get('/profile', async (req, res) => {
  const row = (await query('SELECT * FROM companies WHERE id = $1', [companyId(req)])).rows[0];
  res.json({ company: publicCompany(row) });
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
});

companyRouter.patch('/profile', requireRole('company_admin'), async (req, res) => {
  const b = parse(profileSchema, req.body);
  const row = (
    await query(
      `UPDATE companies SET
         name = COALESCE($2, name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         address = CASE WHEN $5::boolean THEN $6 ELSE address END,
         website = CASE WHEN $7::boolean THEN $8 ELSE website END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        companyId(req), b.name ?? null,
        'phone' in b, b.phone ?? null,
        'address' in b, b.address ?? null,
        'website' in b, b.website ?? null,
      ],
    )
  ).rows[0];
  await auditFromReq(req, companyId(req), 'company.profile_updated', { entity: 'company', entityId: companyId(req) });
  res.json({ company: publicCompany(row) });
});

companyRouter.get('/subscription', async (req, res) => {
  res.json({ subscription: await getCurrentSubscription(companyId(req)) });
});

companyRouter.get('/dashboard', async (req, res) => {
  const id = companyId(req);
  const [users, subscription] = await Promise.all([
    query(`SELECT role, count(*)::int AS n FROM users WHERE company_id = $1 AND is_active GROUP BY role`, [id]),
    getCurrentSubscription(id),
  ]);
  const byRole: Record<string, number> = {};
  for (const r of users.rows) byRole[r.role] = r.n;
  res.json({
    totalUsers: Object.values(byRole).reduce((a, b) => a + b, 0),
    usersByRole: byRole,
    subscription,
  });
});

// --- Users (need a live subscription) ---------------------------------------------------------------
companyRouter.use('/users', requireActiveSubscription);

companyRouter.get('/users', requireRole('company_admin', 'manager'), async (req, res) => {
  const { page, limit } = parse(pageSchema, req.query);
  const search = String(req.query.search ?? '').trim();
  const role = String(req.query.role ?? '');
  const where = ['company_id = $1'];
  const params: unknown[] = [companyId(req)];
  if (search) {
    params.push(likePattern(search));
    where.push(`(lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length})`);
  }
  if (ASSIGNABLE_ROLES.includes(role as any)) {
    params.push(role);
    where.push(`role = $${params.length}`);
  }
  const total = (await query(`SELECT count(*)::int AS n FROM users WHERE ${where.join(' AND ')}`, params)).rows[0].n;
  const { rows } = await query(
    `SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  );
  res.json({ items: rows.map(publicUser), ...pageMeta(page, limit, total) });
});

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(ASSIGNABLE_ROLES),
  phone: z.string().trim().max(30).optional(),
  jobTitle: z.string().trim().max(100).optional(),
});

companyRouter.post('/users', requireRole('company_admin'), async (req, res) => {
  const b = parse(createUserSchema, req.body);
  const id = companyId(req);
  const passwordHash = await hashPassword(b.password);
  const user = await withTransaction(async (client) => {
    await client.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [id]); // serialise seat checks
    const sub = await getCurrentSubscription(id, client);
    const used = (await client.query('SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND is_active', [id])).rows[0].n;
    if (sub && used >= sub.maxUsers) {
      throw conflict(`Your ${sub.planName} plan allows up to ${sub.maxUsers} users. Upgrade your plan to add more.`, 'USER_LIMIT_REACHED');
    }
    return (
      await client.query(
        `INSERT INTO users (company_id, name, email, password_hash, role, phone, job_title)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, b.name, b.email, passwordHash, b.role, b.phone ?? null, b.jobTitle ?? null],
      )
    ).rows[0];
  }).catch((e) => {
    if (e?.code === '23505') throw conflict('A user with this email already exists in your company', 'USER_EXISTS');
    throw e;
  });
  await auditFromReq(req, id, 'user.created', { entity: 'user', entityId: user.id, meta: { email: user.email, role: user.role } });
  res.status(201).json({ user: publicUser(user) });
});

async function loadUser(req: Request) {
  const row = (await query('SELECT * FROM users WHERE id = $1 AND company_id = $2', [req.params.id, companyId(req)])).rows[0];
  if (!row) throw notFound('User not found');
  return row;
}

async function assertAnotherAdminRemains(req: Request, excludeUserId: string) {
  const n = (
    await query(
      `SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND role = 'company_admin' AND is_active AND id <> $2`,
      [companyId(req), excludeUserId],
    )
  ).rows[0].n;
  if (n === 0) throw badRequest('At least one active company admin is required', 'LAST_ADMIN');
}

const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  role: z.enum(ASSIGNABLE_ROLES).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  jobTitle: z.string().trim().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});

companyRouter.patch('/users/:id', requireRole('company_admin'), async (req, res) => {
  const b = parse(updateUserSchema, req.body);
  const target = await loadUser(req);
  const isSelf = target.id === req.auth!.user.id;
  const losesAdmin = target.role === 'company_admin' && (b.role && b.role !== 'company_admin' || b.isActive === false);
  if (isSelf && (b.isActive === false || (b.role && b.role !== target.role))) {
    throw forbidden('You cannot change your own role or deactivate yourself', 'SELF_CHANGE');
  }
  if (losesAdmin) await assertAnotherAdminRemains(req, target.id);
  if (b.isActive === true && !target.is_active) {
    const sub = await getCurrentSubscription(companyId(req));
    const used = (await query('SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND is_active', [companyId(req)])).rows[0].n;
    if (sub && used >= sub.maxUsers) throw conflict('User limit of your plan reached', 'USER_LIMIT_REACHED');
  }

  const row = (
    await query(
      `UPDATE users SET
         name = COALESCE($3, name),
         role = COALESCE($4, role),
         phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
         job_title = CASE WHEN $7::boolean THEN $8 ELSE job_title END,
         is_active = COALESCE($9, is_active),
         updated_at = now()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [target.id, companyId(req), b.name ?? null, b.role ?? null, 'phone' in b, b.phone ?? null, 'jobTitle' in b, b.jobTitle ?? null, b.isActive ?? null],
    )
  ).rows[0];
  if (b.isActive === false || (b.role && b.role !== target.role)) await revokeAllSessions(target.id);
  await auditFromReq(req, companyId(req), 'user.updated', { entity: 'user', entityId: target.id, meta: b });
  res.json({ user: publicUser(row) });
});

companyRouter.post('/users/:id/reset-password', requireRole('company_admin'), async (req, res) => {
  const { newPassword } = parse(z.object({ newPassword: passwordSchema }), req.body);
  const target = await loadUser(req);
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await hashPassword(newPassword), target.id]);
  await revokeAllSessions(target.id);
  await auditFromReq(req, companyId(req), 'user.password_reset', { entity: 'user', entityId: target.id });
  res.json({ ok: true });
});

companyRouter.delete('/users/:id', requireRole('company_admin'), async (req, res) => {
  const target = await loadUser(req);
  if (target.id === req.auth!.user.id) throw forbidden('You cannot delete yourself', 'SELF_CHANGE');
  if (target.role === 'company_admin') await assertAnotherAdminRemains(req, target.id);
  await query('DELETE FROM users WHERE id = $1 AND company_id = $2', [target.id, companyId(req)]);
  await auditFromReq(req, companyId(req), 'user.deleted', { entity: 'user', entityId: target.id, meta: { email: target.email } });
  res.json({ ok: true });
});

// --- Audit log -----------------------------------------------------------------------------------------
companyRouter.get('/audit-logs', requireRole('company_admin'), requireActiveSubscription, async (req: Request, res: Response) => {
  const { page, limit } = parse(pageSchema, req.query);
  const id = companyId(req);
  const total = (await query('SELECT count(*)::int AS n FROM audit_logs WHERE company_id = $1', [id])).rows[0].n;
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.email AS user_email FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.company_id = $1 ORDER BY a.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    [id],
  );
  res.json({
    items: rows.map((r) => ({
      id: Number(r.id), action: r.action, entity: r.entity, entityId: r.entity_id, meta: r.meta,
      userName: r.user_name, userEmail: r.user_email, createdAt: new Date(r.created_at).toISOString(),
    })),
    ...pageMeta(page, limit, total),
  });
});
