import { Request } from 'express';
import { PoolClient } from 'pg';
import { query } from '../db/pool';

interface AuditInput {
  companyId: string | null;
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Writes an audit row. Never throws: auditing must not break the request. */
export async function audit(input: AuditInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO audit_logs (company_id, user_id, action, entity, entity_id, meta, ip)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  const params = [
    input.companyId,
    input.userId ?? null,
    input.action,
    input.entity ?? null,
    input.entityId ?? null,
    JSON.stringify(input.meta ?? {}),
    input.ip ?? null,
  ];
  try {
    await (client ? client.query(sql, params) : query(sql, params));
  } catch (err) {
    console.error('audit log failed', err);
  }
}

export const auditFromReq = (req: Request, companyId: string | null, action: string, rest: Partial<AuditInput> = {}) =>
  audit({ companyId, userId: req.auth?.user.id, action, ip: req.ip, ...rest });
