import { PoolClient } from 'pg';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool';
import { buildInputSchema, SyncTool } from './schema';

export type Risk = 'read' | 'write' | 'delete';
export const ALL_ROLES = ['company_admin', 'manager', 'employee', 'viewer'] as const;

export const riskFor = (method: string): Risk => (method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'write');

/** Safe defaults: everyone may read, managers+admins may write, only admins may delete. */
export const defaultRolesFor = (risk: Risk): string[] =>
  risk === 'read' ? [...ALL_ROLES] : risk === 'write' ? ['company_admin', 'manager'] : ['company_admin'];

export const syncPayloadSchema = z.object({
  source: z.enum(['openapi', 'postman', 'recorded', 'manual']),
  specSource: z.string().max(300).optional(),
  authMode: z.enum(['none', 'static', 'login']).optional(),
  tools: z
    .array(
      z.object({
        method: z.string().transform((m) => m.toUpperCase()),
        path: z.string().min(1).max(500),
        operationId: z.string().max(200).optional(),
        summary: z.string().max(500).optional(),
        description: z.string().max(4000).optional(),
        tags: z.array(z.string().max(60)).max(10).optional(),
        parameters: z
          .array(z.object({ name: z.string().max(100), in: z.string(), required: z.boolean().optional(), description: z.string().max(500).optional(), schema: z.unknown().optional() }))
          .max(60)
          .optional(),
        requestBody: z.object({ required: z.boolean().optional(), description: z.string().max(500).optional(), schema: z.unknown().optional() }).nullable().optional(),
      }),
    )
    .max(1000),
});

const nameFrom = (method: string, path: string, operationId?: string): string => {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let base = operationId ? clean(operationId) : '';
  if (!base) {
    const segs = path.split('/').filter(Boolean).map((s) => (/^[{:]/.test(s) ? `by_${clean(s)}` : clean(s)));
    base = `${method.toLowerCase()}_${segs.join('_')}`;
  }
  return (base || method.toLowerCase()).slice(0, 56);
};

export interface SyncResult {
  added: number;
  updated: number;
  stale: number;
  total: number;
  skipped: number;
}

/**
 * Upserts discovered routes. Admin decisions (enabled, roles, edited description, risk) survive re-syncs.
 * A full OpenAPI/Postman sync marks routes that disappeared as stale instead of deleting them.
 */
export async function syncTools(companyId: string, connectorId: string, payload: z.infer<typeof syncPayloadSchema>): Promise<SyncResult> {
  const res: SyncResult = { added: 0, updated: 0, stale: 0, total: 0, skipped: 0 };
  await withTransaction(async (client: PoolClient) => {
    const existing = (await client.query('SELECT id, name, method, path FROM api_tools WHERE company_id = $1', [companyId])).rows;
    const byRoute = new Map(existing.map((r) => [`${r.method} ${r.path}`, r]));
    const usedNames = new Set(existing.map((r) => r.name as string));
    const seen = new Set<string>();

    for (const t of payload.tools as (SyncTool & { method: string })[]) {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(t.method) || !t.path.startsWith('/')) {
        res.skipped++;
        continue;
      }
      const key = `${t.method} ${t.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { schema, paramMap, hasBody } = buildInputSchema(t);
      const found = byRoute.get(key);

      if (found) {
        await client.query(
          `UPDATE api_tools SET operation_id = $2, summary = $3, description = $4, tags = $5, input_schema = $6,
             param_map = $7, has_body = $8, stale = false, updated_at = now() WHERE id = $1`,
          [found.id, t.operationId ?? null, t.summary ?? '', t.description ?? '', t.tags ?? [], JSON.stringify(schema), JSON.stringify(paramMap), hasBody],
        );
        res.updated++;
      } else {
        let name = nameFrom(t.method, t.path, t.operationId);
        for (let i = 2; usedNames.has(name); i++) name = `${nameFrom(t.method, t.path, t.operationId).slice(0, 52)}_${i}`;
        usedNames.add(name);
        const risk = riskFor(t.method);
        await client.query(
          `INSERT INTO api_tools (company_id, connector_id, name, method, path, operation_id, summary, description, tags,
             input_schema, param_map, has_body, risk, enabled, allowed_roles, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            companyId, connectorId, name, t.method, t.path, t.operationId ?? null, t.summary ?? '', t.description ?? '', t.tags ?? [],
            JSON.stringify(schema), JSON.stringify(paramMap), hasBody, risk,
            risk === 'read' && payload.source !== 'recorded', // learned-from-traffic routes have no description: admin must review them first
            defaultRolesFor(risk), payload.source,
          ],
        );
        res.added++;
      }
    }

    if (payload.source === 'openapi' || payload.source === 'postman') {
      const r = await client.query(
        `UPDATE api_tools SET stale = true, updated_at = now()
         WHERE company_id = $1 AND source = $2 AND stale = false AND (method || ' ' || path) <> ALL($3::text[])`,
        [companyId, payload.source, [...seen]],
      );
      res.stale = r.rowCount ?? 0;
    }
    res.total = seen.size;
    await client.query(
      `UPDATE connectors SET last_sync_at = now(), last_seen_at = now(), spec_source = COALESCE($2, spec_source),
         auth_mode = COALESCE($3, auth_mode) WHERE id = $1`,
      [connectorId, payload.specSource ?? payload.source, payload.authMode ?? null],
    );
  });
  return res;
}

export function mapTool(r: any) {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    path: r.path,
    summary: r.summary,
    description: r.description,
    customDescription: r.custom_description,
    effectiveDescription: effectiveDescription(r),
    tags: r.tags,
    risk: r.risk as Risk,
    enabled: r.enabled,
    allowedRoles: r.allowed_roles as string[],
    source: r.source,
    stale: r.stale,
    needsReview: r.source === 'recorded' && !r.custom_description,
    inputSchema: r.input_schema,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export const effectiveDescription = (r: any): string =>
  (r.custom_description || r.summary || r.description || `${r.method} ${r.path}`).toString().slice(0, 600);

export const getTool = async (companyId: string, id: string) =>
  (await query('SELECT * FROM api_tools WHERE company_id = $1 AND id = $2', [companyId, id])).rows[0];
