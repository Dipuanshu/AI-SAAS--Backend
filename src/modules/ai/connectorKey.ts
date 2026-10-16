import crypto from 'crypto';
import { env } from '../../config/env';
import { query } from '../../db/pool';

/**
 * The connector key is derived, not stored: key = cak_<connectorId>.<HMAC(secret, id:version)>.
 * Re-downloading the package therefore never changes the key; rotating just bumps key_version.
 */
const secret = () => crypto.createHmac('sha256', env.jwtAccessSecret).update('connector-key-v1').digest();

const sign = (id: string, version: number) =>
  crypto.createHmac('sha256', secret()).update(`${id}:${version}`).digest('base64url');

export const makeConnectorKey = (id: string, version: number) => `cak_${id}.${sign(id, version)}`;

export interface ConnectorRow {
  id: string;
  company_id: string;
  key_version: number;
  auth_mode: 'none' | 'static' | 'login';
  version: string | null;
  hostname: string | null;
  spec_source: string | null;
  last_seen_at: Date | null;
  last_sync_at: Date | null;
}

export async function verifyConnectorKey(key: string): Promise<ConnectorRow | null> {
  const m = /^cak_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(key.trim());
  if (!m) return null;
  const { rows } = await query<ConnectorRow>(
    `SELECT c.* FROM connectors c JOIN companies co ON co.id = c.company_id
     WHERE c.id = $1 AND co.status = 'active'`,
    [m[1]],
  );
  const row = rows[0];
  if (!row) return null;
  const expected = Buffer.from(sign(row.id, row.key_version));
  const given = Buffer.from(m[2]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return row;
}

/** A connector counts as online if it polled/synced in the last 60 seconds. */
export const isOnline = (c: Pick<ConnectorRow, 'last_seen_at'> | null | undefined) =>
  !!c?.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60_000;
