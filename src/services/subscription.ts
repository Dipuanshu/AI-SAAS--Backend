import { PoolClient } from 'pg';
import { query } from '../db/pool';

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'none';

export interface SubscriptionInfo {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  maxUsers: number;
  features: string[];
  currency: string;
  kind: 'trial' | 'paid' | 'complimentary';
  billingCycle: 'monthly' | 'yearly' | 'custom';
  startsAt: string;
  expiresAt: string;
  amount: number;
  notes: string | null;
  status: SubscriptionStatus;
  daysLeft: number;
}

const DAY = 86_400_000;

export function mapSubscription(r: any, now = new Date()): SubscriptionInfo {
  const expires = new Date(r.expires_at);
  const ms = expires.getTime() - now.getTime();
  const expired = ms <= 0;
  return {
    id: r.id,
    planId: r.plan_id,
    planCode: r.plan_code,
    planName: r.plan_name,
    maxUsers: r.max_users,
    features: r.features ?? [],
    currency: r.currency,
    kind: r.kind,
    billingCycle: r.billing_cycle,
    startsAt: new Date(r.starts_at).toISOString(),
    expiresAt: expires.toISOString(),
    amount: Number(r.amount),
    notes: r.notes,
    status: expired ? 'expired' : r.kind === 'trial' ? 'trial' : 'active',
    daysLeft: expired ? 0 : Math.ceil(ms / DAY),
  };
}

const SELECT = `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.max_users, p.features, p.currency
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id`;

export async function getCurrentSubscription(companyId: string, client?: PoolClient): Promise<SubscriptionInfo | null> {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(`${SELECT} WHERE s.company_id = $1 ORDER BY s.created_at DESC, s.id LIMIT 1`, [companyId]);
  return rows[0] ? mapSubscription(rows[0]) : null;
}

export async function getSubscriptionHistory(companyId: string): Promise<SubscriptionInfo[]> {
  const { rows } = await query(`${SELECT} WHERE s.company_id = $1 ORDER BY s.created_at DESC, s.id`, [companyId]);
  return rows.map((r) => mapSubscription(r));
}
