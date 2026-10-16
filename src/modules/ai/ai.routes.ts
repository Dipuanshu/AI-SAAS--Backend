import { Request, Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { authenticate, requireActiveSubscription, requireRole, requireTenant } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { auditFromReq } from '../../utils/audit';
import { badRequest, notFound } from '../../utils/httpError';
import { likePattern, pageMeta, pageSchema } from '../../utils/pagination';
import { buildGuide, STACKS } from './guide';
import { isOnline, makeConnectorKey } from './connectorKey';
import { llmStatus } from './llm';
import { getSettings } from './settings';
import { ALL_ROLES, mapTool } from './tools';

/** Company-admin endpoints to set up and manage the AI assistant (/api/company/ai). */
export const companyAiRouter = Router();
companyAiRouter.use(authenticate, requireTenant, requireRole('company_admin'), requireActiveSubscription);

const cid = (req: Request) => req.auth!.company!.id;
const getConnector = async (companyId: string) => (await query('SELECT * FROM connectors WHERE company_id = $1', [companyId])).rows[0];

function mapConnector(c: any) {
  if (!c) return null;
  return {
    id: c.id,
    online: isOnline(c),
    lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
    lastSyncAt: c.last_sync_at ? new Date(c.last_sync_at).toISOString() : null,
    authMode: c.auth_mode,
    specSource: c.spec_source,
    version: c.version,
    hostname: c.hostname,
    createdAt: new Date(c.created_at).toISOString(),
  };
}

companyAiRouter.get('/overview', async (req, res) => {
  const id = cid(req);
  const company = (await query('SELECT backend_stack FROM companies WHERE id = $1', [id])).rows[0];
  const connector = await getConnector(id);
  const stats = (
    await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE enabled AND NOT stale)::int AS enabled,
              count(*) FILTER (WHERE source = 'recorded' AND custom_description IS NULL AND NOT stale)::int AS needs_review,
              count(*) FILTER (WHERE stale)::int AS stale
       FROM api_tools WHERE company_id = $1`,
      [id],
    )
  ).rows[0];
  const knowledge = (await query('SELECT count(*)::int AS n FROM knowledge_docs WHERE company_id = $1', [id])).rows[0].n;
  const chats = (await query('SELECT count(*)::int AS n FROM chat_conversations WHERE company_id = $1', [id])).rows[0].n;
  const guide = buildGuide(company.backend_stack);
  const connected = !!connector?.last_seen_at;
  res.json({
    stack: company.backend_stack,
    stackLabel: guide.stack.label,
    guide: guide.steps,
    stacks: STACKS.map((s) => ({ id: s.id, label: s.label })),
    connector: mapConnector(connector),
    tools: { total: stats.total, enabled: stats.enabled, needsReview: stats.needs_review, stale: stats.stale },
    knowledgeDocs: knowledge,
    settings: await getSettings(id),
    llm: llmStatus(),
    checklist: [
      { id: 'connector', title: 'Create & download the connector', done: !!connector },
      { id: 'connected', title: 'Run it next to your backend', done: connected },
      { id: 'routes', title: 'Routes discovered', done: stats.total > 0 },
      { id: 'review', title: 'Review & enable API tools', done: stats.enabled > 0 },
      { id: 'test', title: 'Ask the assistant something', done: chats > 0 },
    ],
  });
});

companyAiRouter.put('/stack', async (req, res) => {
  const { stack } = parse(z.object({ stack: z.string().refine((s) => STACKS.some((x) => x.id === s), 'unknown stack') }), req.body);
  await query('UPDATE companies SET backend_stack = $2, updated_at = now() WHERE id = $1', [cid(req), stack]);
  res.json({ ok: true });
});

// --- Connector ----------------------------------------------------------------------------------------------
companyAiRouter.post('/connector', async (req, res) => {
  const id = cid(req);
  await query('INSERT INTO connectors (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [id]);
  await auditFromReq(req, id, 'ai.connector_created');
  res.status(201).json({ connector: mapConnector(await getConnector(id)) });
});

companyAiRouter.get('/connector/key', async (req, res) => {
  const c = await getConnector(cid(req));
  if (!c) throw notFound('Create the connector first');
  await auditFromReq(req, cid(req), 'ai.connector_key_viewed');
  res.json({ key: makeConnectorKey(c.id, c.key_version), saasUrl: env.publicApiUrl });
});

companyAiRouter.post('/connector/rotate-key', async (req, res) => {
  const { rows } = await query('UPDATE connectors SET key_version = key_version + 1 WHERE company_id = $1 RETURNING *', [cid(req)]);
  if (!rows[0]) throw notFound('Create the connector first');
  await auditFromReq(req, cid(req), 'ai.connector_key_rotated');
  res.json({ key: makeConnectorKey(rows[0].id, rows[0].key_version) });
});

companyAiRouter.post('/connector/download-link', async (req, res) => {
  const id = cid(req);
  await query('INSERT INTO connectors (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [id]);
  const c = await getConnector(id);
  const token = jwt.sign({ purpose: 'connector-download', cid: c.id, uid: req.auth!.user.id }, env.jwtAccessSecret, { expiresIn: '15m' });
  res.json({ path: `/api/connector/download/${token}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
});

// --- Tools ----------------------------------------------------------------------------------------------------
const listSchema = pageSchema.extend({
  search: z.string().trim().optional(),
  risk: z.enum(['all', 'read', 'write', 'delete']).default('all'),
  status: z.enum(['all', 'enabled', 'disabled', 'review', 'stale']).default('all'),
});

companyAiRouter.get('/tools', async (req, res) => {
  const q = parse(listSchema, req.query);
  const where = ['company_id = $1'];
  const params: unknown[] = [cid(req)];
  if (q.search) {
    params.push(likePattern(q.search));
    where.push(`(lower(name) LIKE $${params.length} OR lower(path) LIKE $${params.length} OR lower(summary || ' ' || coalesce(custom_description, '')) LIKE $${params.length})`);
  }
  if (q.risk !== 'all') {
    params.push(q.risk);
    where.push(`risk = $${params.length}`);
  }
  if (q.status === 'enabled') where.push('enabled AND NOT stale');
  if (q.status === 'disabled') where.push('NOT enabled AND NOT stale');
  if (q.status === 'review') where.push(`source = 'recorded' AND custom_description IS NULL AND NOT stale`);
  if (q.status === 'stale') where.push('stale');
  const w = where.join(' AND ');
  const total = (await query(`SELECT count(*)::int AS n FROM api_tools WHERE ${w}`, params)).rows[0].n;
  const { rows } = await query(`SELECT * FROM api_tools WHERE ${w} ORDER BY path, method LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
  res.json({ items: rows.map(mapTool), ...pageMeta(q.page, q.limit, total) });
});

const toolPatch = z.object({
  enabled: z.boolean().optional(),
  allowedRoles: z.array(z.enum(ALL_ROLES)).max(4).optional(),
  customDescription: z.string().trim().max(600).nullable().optional(),
  risk: z.enum(['read', 'write', 'delete']).optional(),
});

companyAiRouter.patch('/tools/:id', async (req, res) => {
  const b = parse(toolPatch, req.body);
  const { rows } = await query(
    `UPDATE api_tools SET
       enabled = COALESCE($3, enabled),
       allowed_roles = COALESCE($4, allowed_roles),
       custom_description = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE custom_description END,
       risk = COALESCE($7, risk),
       updated_at = now()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [req.params.id, cid(req), b.enabled ?? null, b.allowedRoles ?? null, 'customDescription' in b, b.customDescription ?? null, b.risk ?? null],
  );
  if (!rows[0]) throw notFound('Tool not found');
  await auditFromReq(req, cid(req), 'ai.tool_updated', { entity: 'api_tool', entityId: rows[0].id, meta: { name: rows[0].name, ...b } });
  res.json({ tool: mapTool(rows[0]) });
});

companyAiRouter.post('/tools/bulk', async (req, res) => {
  const b = parse(z.object({ action: z.enum(['enable-read', 'disable-all']) }), req.body);
  const r =
    b.action === 'enable-read'
      ? await query(`UPDATE api_tools SET enabled = true, updated_at = now() WHERE company_id = $1 AND risk = 'read' AND NOT stale AND NOT (source = 'recorded' AND custom_description IS NULL)`, [cid(req)])
      : await query(`UPDATE api_tools SET enabled = false, updated_at = now() WHERE company_id = $1`, [cid(req)]);
  await auditFromReq(req, cid(req), 'ai.tools_bulk', { meta: b });
  res.json({ changed: r.rowCount });
});

// --- Settings -------------------------------------------------------------------------------------------------
const settingsSchema = z.object({
  about: z.string().trim().max(4000).optional(),
  allowDelete: z.boolean().optional(),
  redactFields: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

companyAiRouter.get('/settings', async (req, res) => res.json({ settings: await getSettings(cid(req)) }));

companyAiRouter.put('/settings', async (req, res) => {
  const b = parse(settingsSchema, req.body);
  await getSettings(cid(req));
  await query(
    `UPDATE ai_settings SET about = COALESCE($2, about), allow_delete = COALESCE($3, allow_delete),
       redact_fields = COALESCE($4, redact_fields), updated_at = now() WHERE company_id = $1`,
    [cid(req), b.about ?? null, b.allowDelete ?? null, b.redactFields ? b.redactFields.map((f) => f.toLowerCase()) : null],
  );
  await auditFromReq(req, cid(req), 'ai.settings_updated', { meta: { allowDelete: b.allowDelete } });
  res.json({ settings: await getSettings(cid(req)) });
});

// --- Knowledge base (help answers without calling any API) ------------------------------------------------------
const docSchema = z.object({ title: z.string().trim().min(2).max(160), content: z.string().trim().min(5).max(20000) });
const mapDoc = (r: any) => ({ id: r.id, title: r.title, content: r.content, updatedAt: new Date(r.updated_at).toISOString() });

companyAiRouter.get('/knowledge', async (req, res) => {
  const { rows } = await query('SELECT * FROM knowledge_docs WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 200', [cid(req)]);
  res.json({ items: rows.map(mapDoc) });
});

companyAiRouter.post('/knowledge', async (req, res) => {
  const b = parse(docSchema, req.body);
  const count = (await query('SELECT count(*)::int AS n FROM knowledge_docs WHERE company_id = $1', [cid(req)])).rows[0].n;
  if (count >= 200) throw badRequest('You can store up to 200 help documents', 'LIMIT');
  const { rows } = await query('INSERT INTO knowledge_docs (company_id, title, content, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [cid(req), b.title, b.content, req.auth!.user.id]);
  res.status(201).json({ doc: mapDoc(rows[0]) });
});

companyAiRouter.put('/knowledge/:id', async (req, res) => {
  const b = parse(docSchema, req.body);
  const { rows } = await query('UPDATE knowledge_docs SET title = $3, content = $4, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *', [req.params.id, cid(req), b.title, b.content]);
  if (!rows[0]) throw notFound('Document not found');
  res.json({ doc: mapDoc(rows[0]) });
});

companyAiRouter.delete('/knowledge/:id', async (req, res) => {
  const r = await query('DELETE FROM knowledge_docs WHERE id = $1 AND company_id = $2', [req.params.id, cid(req)]);
  if (!r.rowCount) throw notFound('Document not found');
  res.json({ ok: true });
});

// --- Activity of the assistant --------------------------------------------------------------------------------------
companyAiRouter.get('/logs', async (req, res) => {
  const { page, limit } = parse(pageSchema, req.query);
  const total = (await query('SELECT count(*)::int AS n FROM ai_action_logs WHERE company_id = $1', [cid(req)])).rows[0].n;
  const { rows } = await query(
    `SELECT l.*, u.name AS user_name FROM ai_action_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.company_id = $1 ORDER BY l.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    [cid(req)],
  );
  res.json({
    items: rows.map((r) => ({
      id: Number(r.id), userName: r.user_name, tool: r.tool_name, method: r.method, path: r.path, args: r.args_summary,
      status: r.status, httpStatus: r.http_status, durationMs: r.duration_ms, error: r.error, createdAt: new Date(r.created_at).toISOString(),
    })),
    ...pageMeta(page, limit, total),
  });
});
