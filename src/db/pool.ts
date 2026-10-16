import { Pool, PoolClient, QueryResultRow } from 'pg';
import { env } from '../config/env';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function query<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
