import { EventEmitter } from 'events';
import { query } from '../../db/pool';

/** Wakes long-polling connectors / waiting callers inside this process (DB polling covers other instances). */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export async function enqueueJob(companyId: string, connectorId: string, type: 'call' | 'login' | 'logout', payload: unknown): Promise<string> {
  const { rows } = await query(
    `INSERT INTO connector_jobs (company_id, connector_id, type, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, connectorId, type, JSON.stringify(payload)],
  );
  bus.emit(`queue:${connectorId}`);
  return rows[0].id;
}

/** Atomically claims queued jobs for one connector. */
export async function claimJobs(connectorId: string, limit = 5) {
  await query(`UPDATE connector_jobs SET status = 'expired', finished_at = now()
               WHERE connector_id = $1 AND status IN ('queued','running') AND created_at < now() - interval '2 minutes'`, [connectorId]);
  const { rows } = await query(
    `UPDATE connector_jobs SET status = 'running', claimed_at = now()
     WHERE id IN (SELECT id FROM connector_jobs WHERE connector_id = $1 AND status = 'queued'
                  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
     RETURNING id, type, payload`,
    [connectorId, limit],
  );
  return rows as { id: string; type: string; payload: any }[];
}

export async function completeJob(connectorId: string, jobId: string, result: unknown): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE connector_jobs SET status = 'done', result = $3, finished_at = now()
     WHERE id = $1 AND connector_id = $2 AND status = 'running'`,
    [jobId, connectorId, JSON.stringify(result)],
  );
  if (rowCount) bus.emit(`done:${jobId}`);
  return !!rowCount;
}

export interface JobResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  code?: string;
  durationMs?: number;
}

/** Waits until the connector reports a result (or times out). */
export function waitForJob(jobId: string, timeoutMs: number): Promise<JobResult> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (r: JobResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      bus.off(`done:${jobId}`, check);
      resolve(r);
    };
    const check = async () => {
      const { rows } = await query('SELECT status, result FROM connector_jobs WHERE id = $1', [jobId]);
      const row = rows[0];
      if (row?.status === 'done') finish(row.result as JobResult);
      else if (row?.status === 'expired') finish({ ok: false, code: 'TIMEOUT', error: 'The connector did not respond in time.' });
    };
    const timer = setTimeout(async () => {
      await query(`UPDATE connector_jobs SET status = 'expired', finished_at = now() WHERE id = $1 AND status IN ('queued','running')`, [jobId]);
      finish({ ok: false, code: 'TIMEOUT', error: 'The connector did not respond in time. Is it running?' });
    }, timeoutMs);
    const poll = setInterval(() => void check(), 1000);
    bus.on(`done:${jobId}`, () => void check());
    void check();
  });
}
