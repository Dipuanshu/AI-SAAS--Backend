// Integration tests: run against a real PostgreSQL database (aisaas_test by default).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://aisaas:aisaas@localhost:5432/aisaas_test';
process.env.SUPER_ADMIN_EMAIL = 'root@platform.test';
process.env.SUPER_ADMIN_PASSWORD = 'RootPass123';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let server: Server;
let base: string;
let pool: typeof import('../src/db/pool').pool;

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const registerBody = (name: string, email: string) => ({ companyName: name, adminName: 'Owner', email, password: 'Passw0rd1' });

describe('AI SaaS backend', () => {
  let adminToken: string;
  let acme: { token: string; refresh: string; slug: string; id: string };
  let globex: { token: string; slug: string; id: string };

  before(async () => {
    ({ pool } = await import('../src/db/pool'));
    const { migrate } = await import('../src/db/migrate');
    const { seedSuperAdmin } = await import('../src/db/seed');
    const { createApp } = await import('../src/app');
    await migrate(false);
    await pool.query('TRUNCATE audit_logs, refresh_tokens, subscriptions, users, companies RESTART IDENTITY CASCADE');
    await pool.query("DELETE FROM plans WHERE code NOT IN ('starter','growth','enterprise')");
    await seedSuperAdmin();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  it('lists public plans', async () => {
    const r = await api('GET', '/api/plans');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plans.map((p: any) => p.code), ['starter', 'growth', 'enterprise']);
  });

  it('registers a company with a trial subscription', async () => {
    const r = await api('POST', '/api/auth/register-company', { body: registerBody('Acme Industries', 'owner@acme.test') });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'company_admin');
    assert.equal(r.body.company.slug, 'acme-industries');
    assert.equal(r.body.subscription.status, 'trial');
    assert.ok(r.body.subscription.daysLeft >= 13);
    acme = { token: r.body.accessToken, refresh: r.body.refreshToken, slug: r.body.company.slug, id: r.body.company.id };

    const g = await api('POST', '/api/auth/register-company', { body: registerBody('Globex', 'owner@globex.test') });
    globex = { token: g.body.accessToken, slug: g.body.company.slug, id: g.body.company.id };
  });

  it('rejects duplicate company email and weak input', async () => {
    const dup = await api('POST', '/api/auth/register-company', { body: registerBody('Other', 'OWNER@acme.test') });
    assert.equal(dup.status, 409);
    const weak = await api('POST', '/api/auth/register-company', { body: { ...registerBody('X Co', 'x@x.test'), password: 'short' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'VALIDATION_ERROR');
  });

  it('searches companies (step 1 of login)', async () => {
    const r = await api('GET', '/api/auth/companies?q=acm');
    assert.deepEqual(r.body.companies, [{ name: 'Acme Industries', slug: 'acme-industries' }]);
    assert.deepEqual((await api('GET', '/api/auth/companies?q=a')).body.companies, []);
  });

  it('logs in only with the right company + credentials', async () => {
    const ok = await api('POST', '/api/auth/login', { body: { companySlug: acme.slug, email: 'owner@acme.test', password: 'Passw0rd1' } });
    assert.equal(ok.status, 200);
    const badPw = await api('POST', '/api/auth/login', { body: { companySlug: acme.slug, email: 'owner@acme.test', password: 'wrong-pass1' } });
    assert.equal(badPw.status, 401);
    const wrongCo = await api('POST', '/api/auth/login', { body: { companySlug: globex.slug, email: 'owner@acme.test', password: 'Passw0rd1' } });
    assert.equal(wrongCo.status, 401);
    const noCo = await api('POST', '/api/auth/login', { body: { companySlug: 'nope', email: 'owner@acme.test', password: 'Passw0rd1' } });
    assert.equal(noCo.status, 401);
  });

  it('enforces role permissions inside a company', async () => {
    const mk = (role: string, email: string) =>
      api('POST', '/api/company/users', { token: acme.token, body: { name: `${role} user`, email, password: 'Passw0rd1', role } });
    assert.equal((await mk('employee', 'emp@acme.test')).status, 201);
    assert.equal((await mk('manager', 'mgr@acme.test')).status, 201);
    assert.equal((await mk('employee', 'EMP@acme.test')).status, 409);

    const login = (email: string) => api('POST', '/api/auth/login', { body: { companySlug: acme.slug, email, password: 'Passw0rd1' } });
    const emp = (await login('emp@acme.test')).body.accessToken;
    const mgr = (await login('mgr@acme.test')).body.accessToken;

    assert.equal((await api('GET', '/api/company/users', { token: emp })).status, 403);
    assert.equal((await api('GET', '/api/company/users', { token: mgr })).status, 200);
    assert.equal((await api('POST', '/api/company/users', { token: mgr, body: { name: 'Zed', email: 'z@acme.test', password: 'Passw0rd1', role: 'employee' } })).status, 403);
    assert.equal((await api('GET', '/api/admin/stats', { token: acme.token })).status, 403);
    assert.equal((await api('GET', '/api/company/dashboard', { token: emp })).status, 200);
    assert.equal((await api('GET', '/api/company/users')).status, 401);
  });

  it('keeps tenants isolated', async () => {
    const list = await api('GET', '/api/company/users', { token: globex.token });
    assert.equal(list.body.total, 1);
    const acmeUsers = await api('GET', '/api/company/users', { token: acme.token });
    const foreignId = acmeUsers.body.items.find((u: any) => u.email === 'emp@acme.test').id;
    assert.equal((await api('PATCH', `/api/company/users/${foreignId}`, { token: globex.token, body: { name: 'Hacked' } })).status, 404);
    assert.equal((await api('DELETE', `/api/company/users/${foreignId}`, { token: globex.token })).status, 404);
    // Same email can exist in another company.
    const dupEmail = await api('POST', '/api/company/users', { token: globex.token, body: { name: 'Emp', email: 'emp@acme.test', password: 'Passw0rd1', role: 'employee' } });
    assert.equal(dupEmail.status, 201);
  });

  it('protects the last admin and self changes', async () => {
    const me = (await api('GET', '/api/auth/me', { token: acme.token })).body.user;
    assert.equal((await api('DELETE', `/api/company/users/${me.id}`, { token: acme.token })).status, 403);
    assert.equal((await api('PATCH', `/api/company/users/${me.id}`, { token: acme.token, body: { role: 'employee' } })).status, 403);
  });

  it('enforces the plan user limit', async () => {
    // starter allows 5 users; acme has 3 (owner, employee, manager)
    for (const n of [1, 2]) {
      assert.equal((await api('POST', '/api/company/users', { token: acme.token, body: { name: `U${n}`, email: `u${n}@acme.test`, password: 'Passw0rd1', role: 'viewer' } })).status, 201);
    }
    const over = await api('POST', '/api/company/users', { token: acme.token, body: { name: 'U3', email: 'u3@acme.test', password: 'Passw0rd1', role: 'viewer' } });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'USER_LIMIT_REACHED');
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const first = await api('POST', '/api/auth/refresh', { body: { refreshToken: acme.refresh } });
    assert.equal(first.status, 200);
    const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: acme.refresh } });
    assert.equal(reuse.status, 401);
    // reuse revoked the whole family, including the newly issued token
    const afterReuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: first.body.refreshToken } });
    assert.equal(afterReuse.status, 401);
  });

  describe('super admin', () => {
    before(async () => {
      const r = await api('POST', '/api/auth/admin/login', { body: { email: 'root@platform.test', password: 'RootPass123' } });
      assert.equal(r.status, 200);
      adminToken = r.body.accessToken;
    });

    it('rejects company users on the admin login and bad passwords', async () => {
      assert.equal((await api('POST', '/api/auth/admin/login', { body: { email: 'owner@acme.test', password: 'Passw0rd1' } })).status, 401);
      assert.equal((await api('POST', '/api/auth/admin/login', { body: { email: 'root@platform.test', password: 'nope-nope1' } })).status, 401);
    });

    it('shows stats and filters the company list', async () => {
      const stats = await api('GET', '/api/admin/stats', { token: adminToken });
      assert.equal(stats.body.totalCompanies, 2);
      assert.equal(stats.body.onTrial, 2);
      const trial = await api('GET', '/api/admin/companies?status=trial', { token: adminToken });
      assert.equal(trial.body.total, 2);
      assert.equal((await api('GET', '/api/admin/companies?status=expired', { token: adminToken })).body.total, 0);
      const search = await api('GET', '/api/admin/companies?search=glob', { token: adminToken });
      assert.equal(search.body.items[0].name, 'Globex');
      assert.equal(search.body.items[0].subscription.planCode, 'starter');
    });

    it('assigns a paid plan and extends it', async () => {
      const r = await api('POST', `/api/admin/companies/${acme.id}/subscription`, {
        token: adminToken, body: { planCode: 'growth', billingCycle: 'yearly', notes: 'Paid via bank transfer' },
      });
      assert.equal(r.status, 201);
      const sub = r.body.company.subscription;
      assert.equal(sub.planCode, 'growth');
      assert.equal(sub.status, 'active');
      assert.equal(sub.amount, 29990);
      assert.ok(sub.daysLeft >= 364);

      const ext = await api('POST', `/api/admin/companies/${acme.id}/extend`, { token: adminToken, body: { days: 30 } });
      assert.ok(ext.body.company.subscription.daysLeft >= 394);

      const detail = await api('GET', `/api/admin/companies/${acme.id}`, { token: adminToken });
      assert.equal(detail.body.subscriptionHistory.length, 2);
      assert.equal(detail.body.owner.email, 'owner@acme.test');
      // user limit now follows the Growth plan (25)
      assert.equal((await api('POST', '/api/company/users', { token: acme.token, body: { name: 'U3', email: 'u3@acme.test', password: 'Passw0rd1', role: 'viewer' } })).status, 201);
    });

    it('blocks business endpoints when the subscription expires, and restores on extend', async () => {
      await pool.query(`UPDATE subscriptions SET starts_at = now() - interval '10 days', expires_at = now() - interval '1 day' WHERE company_id = $1`, [globex.id]);
      const blocked = await api('GET', '/api/company/users', { token: globex.token });
      assert.equal(blocked.status, 402);
      assert.equal(blocked.body.error.code, 'SUBSCRIPTION_EXPIRED');
      const sub = await api('GET', '/api/company/subscription', { token: globex.token });
      assert.equal(sub.body.subscription.status, 'expired');
      assert.equal((await api('GET', '/api/admin/companies?status=expired', { token: adminToken })).body.total, 1);

      await api('POST', `/api/admin/companies/${globex.id}/extend`, { token: adminToken, body: { days: 15 } });
      assert.equal((await api('GET', '/api/company/users', { token: globex.token })).status, 200);
    });

    it('finds companies expiring soon', async () => {
      await api('POST', `/api/admin/companies/${globex.id}/subscription`, {
        token: adminToken, body: { planCode: 'starter', durationDays: 5, amount: 500 },
      });
      const r = await api('GET', '/api/admin/companies?status=expiring&expiringDays=7', { token: adminToken });
      assert.deepEqual(r.body.items.map((c: any) => c.name), ['Globex']);
      assert.equal((await api('POST', `/api/admin/companies/${globex.id}/subscription`, { token: adminToken, body: { planCode: 'nope' } })).status, 400);
    });

    it('suspends and re-activates a company immediately', async () => {
      const s = await api('POST', `/api/admin/companies/${globex.id}/suspend`, { token: adminToken, body: { reason: 'Payment overdue' } });
      assert.equal(s.body.company.status, 'suspended');
      const withOldToken = await api('GET', '/api/company/users', { token: globex.token });
      assert.equal(withOldToken.status, 403);
      assert.equal(withOldToken.body.error.code, 'COMPANY_SUSPENDED');
      const login = await api('POST', '/api/auth/login', { body: { companySlug: globex.slug, email: 'owner@globex.test', password: 'Passw0rd1' } });
      assert.equal(login.body.error.code, 'COMPANY_SUSPENDED');
      assert.equal((await api('GET', '/api/auth/companies?q=globex')).body.companies.length, 0);

      await api('POST', `/api/admin/companies/${globex.id}/activate`, { token: adminToken });
      assert.equal((await api('GET', '/api/company/users', { token: globex.token })).status, 200);
    });

    it('manages plans', async () => {
      const created = await api('POST', '/api/admin/plans', {
        token: adminToken,
        body: { code: 'promo', name: 'Promo', priceMonthly: 1, priceYearly: 10, maxUsers: 3, features: ['One', 'Two'] },
      });
      assert.equal(created.status, 201);
      assert.equal((await api('POST', '/api/admin/plans', { token: adminToken, body: { code: 'promo', name: 'Promo', priceMonthly: 1, priceYearly: 10, maxUsers: 3 } })).status, 409);
      const patched = await api('PATCH', `/api/admin/plans/${created.body.plan.id}`, { token: adminToken, body: { isActive: false, priceMonthly: 2 } });
      assert.equal(patched.body.plan.isActive, false);
      assert.equal(patched.body.plan.priceMonthly, 2);
      const pub = await api('GET', '/api/plans');
      assert.ok(!pub.body.plans.some((p: any) => p.code === 'promo'));
      const reg = await api('POST', '/api/auth/register-company', { body: { ...registerBody('Late Co', 'l@l.test'), planCode: 'promo' } });
      assert.equal(reg.status, 400);
    });

    it('deletes a company only with slug confirmation', async () => {
      assert.equal((await api('DELETE', `/api/admin/companies/${globex.id}`, { token: adminToken, body: { confirmSlug: 'wrong' } })).status, 400);
      assert.equal((await api('DELETE', `/api/admin/companies/${globex.id}`, { token: adminToken, body: { confirmSlug: globex.slug } })).status, 200);
      assert.equal((await api('GET', `/api/admin/companies/${globex.id}`, { token: adminToken })).status, 404);
    });

    it('records an audit trail', async () => {
      const r = await api('GET', '/api/admin/audit-logs?limit=100', { token: adminToken });
      const actions = r.body.items.map((i: any) => i.action);
      for (const a of ['company.registered', 'admin.subscription_assigned', 'admin.plan_created', 'admin.company_deleted']) {
        assert.ok(actions.includes(a), `missing ${a}`);
      }
      const own = await api('GET', '/api/company/audit-logs', { token: acme.token });
      assert.equal(own.status, 200);
      assert.ok(own.body.items.every((i: any) => i.action));
    });
  });

  it('changes password and revokes old sessions', async () => {
    const login = await api('POST', '/api/auth/login', { body: { companySlug: acme.slug, email: 'emp@acme.test', password: 'Passw0rd1' } });
    const bad = await api('POST', '/api/auth/change-password', { token: login.body.accessToken, body: { currentPassword: 'nope', newPassword: 'NewPassw0rd' } });
    assert.equal(bad.status, 400);
    const ok = await api('POST', '/api/auth/change-password', { token: login.body.accessToken, body: { currentPassword: 'Passw0rd1', newPassword: 'NewPassw0rd' } });
    assert.equal(ok.status, 200);
    assert.equal((await api('POST', '/api/auth/refresh', { body: { refreshToken: login.body.refreshToken } })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { companySlug: acme.slug, email: 'emp@acme.test', password: 'NewPassw0rd' } })).status, 200);
  });

  it('returns JSON 404s and rejects malformed JSON', async () => {
    assert.equal((await api('GET', '/api/nothing')).status, 404);
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
  });
});
