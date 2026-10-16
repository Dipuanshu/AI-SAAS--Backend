import { Request, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { authenticate, requireActiveSubscription, requireTenant } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { auditFromReq } from '../../utils/audit';
import { badRequest } from '../../utils/httpError';
import { conversationView, deleteConversation, listConversations, resolveAction, sendMessage } from './agent';
import { isOnline } from './connectorKey';
import { Actor, connectUserAccount, disconnectUserAccount } from './exec';
import { llmStatus } from './llm';
import { getSettings } from './settings';

/** The assistant for every company user (/api/chat). Every request is scoped to the caller's own user + company. */
export const chatRouter = Router();
chatRouter.use(authenticate, requireTenant, requireActiveSubscription);

const actorOf = (req: Request): Actor => ({
  companyId: req.auth!.company!.id,
  companyName: req.auth!.company!.name,
  userId: req.auth!.user.id,
  userName: req.auth!.user.name,
  role: req.auth!.user.role,
});

const limiter = rateLimit({
  windowMs: 60_000,
  limit: env.chat.perUserPerMinute,
  keyGenerator: (req) => req.auth?.user.id ?? 'anon',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.isTest,
  validate: { keyGeneratorIpFallback: false },
  message: { error: { code: 'RATE_LIMITED', message: 'You are sending messages too fast. Please wait a moment.' } },
});

chatRouter.get('/status', async (req, res) => {
  const a = actorOf(req);
  const connector = (await query('SELECT * FROM connectors WHERE company_id = $1', [a.companyId])).rows[0];
  const settings = await getSettings(a.companyId);
  const tools = (
    await query(
      `SELECT count(*)::int AS n FROM api_tools WHERE company_id = $1 AND enabled AND NOT stale AND $2 = ANY(allowed_roles) AND ($3 OR risk <> 'delete')`,
      [a.companyId, a.role, settings.allowDelete],
    )
  ).rows[0].n;
  const docs = (await query('SELECT count(*)::int AS n FROM knowledge_docs WHERE company_id = $1', [a.companyId])).rows[0].n;
  const link = (await query('SELECT 1 FROM user_software_links WHERE user_id = $1', [a.userId])).rows[0];
  const llm = llmStatus();
  res.json({
    llmConfigured: llm.configured,
    connector: connector ? { online: isOnline(connector), authMode: connector.auth_mode } : null,
    connected: !!link,
    needsConnect: connector?.auth_mode === 'login' && !link,
    toolCount: tools,
    helpDocs: docs,
    // The assistant can always answer from help documents; live data needs an online connector and at least one tool.
    ready: llm.configured && (docs > 0 || (tools > 0 && !!connector)),
  });
});

chatRouter.get('/conversations', async (req, res) => res.json({ items: await listConversations(actorOf(req)) }));

chatRouter.get('/conversations/:id', async (req, res) => res.json(await conversationView(actorOf(req), String(req.params.id))));

chatRouter.delete('/conversations/:id', async (req, res) => {
  await deleteConversation(actorOf(req), String(req.params.id));
  res.json({ ok: true });
});

const messageSchema = z.object({ conversationId: z.string().uuid().nullable().optional(), message: z.string().trim().min(1).max(2000) });

chatRouter.post('/message', limiter, async (req, res) => {
  const b = parse(messageSchema, req.body);
  const actor = actorOf(req);
  const { conversationId, state } = await sendMessage(actor, b.conversationId ?? null, b.message);
  const view = await conversationView(actor, conversationId);
  res.json({ ...view, needsConnect: view.needsConnect || state.needsConnect });
});

for (const [name, approve] of [['confirm', true], ['cancel', false]] as const) {
  chatRouter.post(`/actions/:id/${name}`, limiter, async (req, res) => {
    const actor = actorOf(req);
    const { conversationId, state } = await resolveAction(actor, String(req.params.id), approve);
    await auditFromReq(req, actor.companyId, approve ? 'ai.action_confirmed' : 'ai.action_cancelled', { entity: 'pending_action', entityId: String(req.params.id) });
    const view = await conversationView(actor, conversationId);
    res.json({ ...view, needsConnect: view.needsConnect || state.needsConnect });
  });
}

// Per-user login to the company's software (the connector keeps the session; the password is never stored).
const connectLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, keyGenerator: (req) => req.auth?.user.id ?? 'anon', skip: () => env.isTest,
  validate: { keyGeneratorIpFallback: false }, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

chatRouter.post('/connect', connectLimiter, async (req, res) => {
  const b = parse(z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
  const r = await connectUserAccount(actorOf(req), b.username, b.password);
  if (!r.ok) throw badRequest(r.message ?? 'Could not connect', 'CONNECT_FAILED');
  await auditFromReq(req, req.auth!.company!.id, 'ai.account_connected');
  res.json({ ok: true });
});

chatRouter.post('/disconnect', async (req, res) => {
  await disconnectUserAccount(actorOf(req));
  res.json({ ok: true });
});
