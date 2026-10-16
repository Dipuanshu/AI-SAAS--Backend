import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { parse } from '../../middleware/validate';
import { audit } from '../../utils/audit';
import { notFound, unauthorized } from '../../utils/httpError';
import { z } from 'zod';
import { ConnectorRow, verifyConnectorKey } from './connectorKey';
import { bus, claimJobs, completeJob } from './jobs';
import { buildConnectorPackage } from './package';
import { syncPayloadSchema, syncTools } from './tools';

/** Endpoints used by the connector program running at the company (authenticated with the connector key). */
export const gatewayRouter = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      connector?: ConnectorRow;
    }
  }
}

// Package download uses a short-lived signed link instead of the Authorization header.
gatewayRouter.get('/download/:token', async (req: Request, res: Response) => {
  let claims: any;
  try {
    claims = jwt.verify(String(req.params.token), env.jwtAccessSecret);
  } catch {
    throw unauthorized('This download link has expired. Create a new one in the app.', 'LINK_EXPIRED');
  }
  if (claims?.purpose !== 'connector-download') throw unauthorized('Invalid link', 'LINK_INVALID');
  const { rows } = await query(
    `SELECT c.id, c.key_version, co.name, co.slug, co.backend_stack, co.id AS company_id
     FROM connectors c JOIN companies co ON co.id = c.company_id WHERE c.id = $1 AND co.status = 'active'`,
    [claims.cid],
  );
  const c = rows[0];
  if (!c) throw notFound('Connector not found');
  const zip = buildConnectorPackage({ connectorId: c.id, keyVersion: c.key_version, companyName: c.name, stack: c.backend_stack });
  await audit({ companyId: c.company_id, userId: claims.uid ?? null, action: 'ai.connector_downloaded', ip: req.ip });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="ai-connector-${c.slug}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(zip);
});

async function authenticateConnector(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const connector = header.startsWith('Bearer ') ? await verifyConnectorKey(header.slice(7)) : null;
  if (!connector) throw unauthorized('Invalid connector key', 'CONNECTOR_KEY_INVALID');
  req.connector = connector;
  next();
}
gatewayRouter.use(authenticateConnector);

const helloSchema = z.object({
  version: z.string().max(40).optional(),
  hostname: z.string().max(120).optional(),
  authMode: z.enum(['none', 'static', 'login']).optional(),
});

async function touch(c: ConnectorRow, b: z.infer<typeof helloSchema>) {
  await query(
    `UPDATE connectors SET last_seen_at = now(), version = COALESCE($2, version), hostname = COALESCE($3, hostname),
       auth_mode = COALESCE($4, auth_mode) WHERE id = $1`,
    [c.id, b.version ?? null, b.hostname ?? null, b.authMode ?? null],
  );
}

gatewayRouter.post('/hello', async (req, res) => {
  const b = parse(helloSchema, req.body ?? {});
  const c = req.connector!;
  await touch(c, b);
  const company = (await query('SELECT name FROM companies WHERE id = $1', [c.company_id])).rows[0];
  const settings = (await query('SELECT redact_fields FROM ai_settings WHERE company_id = $1', [c.company_id])).rows[0];
  res.json({ ok: true, connectorId: c.id, companyName: company.name, redactFields: settings?.redact_fields ?? [] });
});

gatewayRouter.post('/tools/sync', async (req, res) => {
  const payload = parse(syncPayloadSchema, req.body);
  const c = req.connector!;
  const result = await syncTools(c.company_id, c.id, payload);
  await audit({ companyId: c.company_id, action: 'ai.tools_synced', meta: { source: payload.source, ...result } });
  res.json({ ok: true, ...result });
});

gatewayRouter.post('/poll', async (req, res) => {
  const b = parse(helloSchema, req.body ?? {});
  const c = req.connector!;
  await touch(c, b);
  let closed = false;
  req.on('close', () => (closed = true));

  let jobs = await claimJobs(c.id);
  const deadline = Date.now() + 20_000;
  while (!jobs.length && Date.now() < deadline && !closed) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        bus.off(`queue:${c.id}`, done);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      bus.once(`queue:${c.id}`, done);
    });
    if (!closed) jobs = await claimJobs(c.id);
  }
  if (jobs.length) await query('UPDATE connectors SET last_seen_at = now() WHERE id = $1', [c.id]);
  if (!closed) res.json({ jobs });
});

const resultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  body: z.unknown().optional(),
  error: z.string().max(2000).optional(),
  code: z.string().max(60).optional(),
  durationMs: z.number().optional(),
});

gatewayRouter.post('/jobs/:id/result', async (req, res) => {
  const result = parse(resultSchema, req.body);
  const accepted = await completeJob(req.connector!.id, String(req.params.id), result);
  res.json({ ok: accepted });
});
