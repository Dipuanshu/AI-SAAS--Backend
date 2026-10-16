// End-to-end: SaaS API + the REAL connector program (from the downloaded zip) + the demo company backend + mock model.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://aisaas:aisaas@localhost:5432/aisaas_test';
process.env.LLM_PROVIDER = 'mock';

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { unzipTo } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const demo = require('../connector/examples/demo-api/server.js');

let saas: Server;
let base = '';
let demoBase = '';
let pool: typeof import('../src/db/pool').pool;
let connector: ChildProcess | null = null;
let connectorLog = '';
let dir = '';

async function api(method: string, p: string, o: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const demoCall = async (method: string, p: string, token?: string, body?: unknown) => {
  const res = await fetch(demoBase + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
};
const until = async (fn: () => Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for condition\n' + connectorLog.slice(-1500));
};
const lastAssistant = (v: any) => [...v.items].reverse().find((i: any) => i.role === 'assistant')?.text ?? '';

describe('AI assistant end to end', () => {
  let admin = '';
  let acmeId = '';
  let manager = '';
  let employee = '';
  let other = '';
  let convAdmin = '';

  const login = async (slug: string, email: string, password = 'Passw0rd1') => (await api('POST', '/api/auth/login', { body: { companySlug: slug, email, password } })).body.accessToken as string;
  const ask = async (token: string, message: string, conversationId: string | null = null) => api('POST', '/api/chat/message', { token, body: { message, conversationId } });
  const connect = (token: string, username: string, password: string) => api('POST', '/api/chat/connect', { token, body: { username, password } });

  before(async () => {
    ({ pool } = await import('../src/db/pool'));
    const { migrate } = await import('../src/db/migrate');
    const { createApp } = await import('../src/app');
    await migrate(false);
    await pool.query('TRUNCATE audit_logs, refresh_tokens, subscriptions, users, companies RESTART IDENTITY CASCADE');
    saas = createApp().listen(0);
    base = `http://127.0.0.1:${(saas.address() as AddressInfo).port}`;
    await new Promise<void>((r) => demo.server.listen(0, r));
    demoBase = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (connector) {
      const exited = new Promise((r) => connector!.once('exit', r));
      connector.kill();
      await exited;
    }
    await new Promise<void>((r) => {
      saas.close(() => r());
      saas.closeAllConnections();
    });
    demo.server.close();
    await new Promise((r) => setTimeout(r, 300));
    await pool.end();
  });

  it('registers a company with its backend language and shows a tailored guide', async () => {
    const r = await api('POST', '/api/auth/register-company', { body: { companyName: 'Acme Store', adminName: 'Asha', email: 'asha@acme.test', password: 'Passw0rd1', backendStack: 'python-fastapi' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.company.backendStack, 'python-fastapi');
    admin = r.body.accessToken;
    acmeId = r.body.company.id;
    const o = await api('GET', '/api/company/ai/overview', { token: admin });
    assert.equal(o.body.stackLabel, 'Python – FastAPI');
    assert.ok(o.body.guide.find((s: any) => s.id === 'describe').text.includes('/openapi.json'));
    assert.equal(o.body.checklist.filter((c: any) => c.done).length, 0);
    assert.equal(o.body.llm.configured, true);
  });

  it('only company admins can manage the AI setup', async () => {
    for (const role of ['manager', 'employee']) {
      await api('POST', '/api/company/users', { token: admin, body: { name: role, email: `${role}@acme.test`, password: 'Passw0rd1', role } });
    }
    manager = await login('acme-store', 'manager@acme.test');
    employee = await login('acme-store', 'employee@acme.test');
    assert.equal((await api('GET', '/api/company/ai/overview', { token: manager })).status, 403);
    assert.equal((await api('GET', '/api/company/ai/tools', { token: employee })).status, 403);
    assert.equal((await api('POST', '/api/company/ai/connector', { token: employee })).status, 403);
  });

  it('downloads the connector package through a signed link', async () => {
    assert.equal((await api('POST', '/api/company/ai/connector', { token: admin })).status, 201);
    const link = await api('POST', '/api/company/ai/connector/download-link', { token: admin });
    const res = await fetch(base + link.body.path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-'));
    const names = unzipTo(Buffer.from(await res.arrayBuffer()), dir);
    for (const n of ['ai-connector/connector.js', 'ai-connector/.env', 'ai-connector/README.md', 'ai-connector/Dockerfile', 'ai-connector/docker-compose.yml']) assert.ok(names.includes(n), n);
    const readme = fs.readFileSync(path.join(dir, 'ai-connector/README.md'), 'utf8');
    assert.ok(readme.includes('FastAPI') && readme.includes('Acme Store'));
    const key = (await api('GET', '/api/company/ai/connector/key', { token: admin })).body.key;
    assert.ok(fs.readFileSync(path.join(dir, 'ai-connector/.env'), 'utf8').includes(key));
    // bad / tampered links are refused
    assert.equal((await fetch(base + '/api/connector/download/garbage')).status, 401);
  });

  it('the connector connects, discovers the demo API and registers its routes', async () => {
    const cdir = path.join(dir, 'ai-connector');
    const env = fs.readFileSync(path.join(cdir, '.env'), 'utf8').replace(/AISAAS_URL=.*/, `AISAAS_URL=${base}`).replace(/BACKEND_URL=.*/, `BACKEND_URL=${demoBase}`);
    fs.writeFileSync(path.join(cdir, '.env'), env);
    connector = spawn(process.execPath, ['connector.js'], { cwd: cdir, env: { PATH: process.env.PATH ?? '' } });
    connector.stdout!.on('data', (d) => (connectorLog += d));
    connector.stderr!.on('data', (d) => (connectorLog += d));
    await until(async () => (await api('GET', '/api/company/ai/overview', { token: admin })).body.tools.total > 0);
    const o = (await api('GET', '/api/company/ai/overview', { token: admin })).body;
    assert.equal(o.connector.online, true);
    assert.equal(o.connector.authMode, 'login');
    assert.match(o.connector.specSource, /openapi\.json$/);
    assert.equal(o.tools.total, 10); // 11 operations minus the multipart upload
    assert.equal(o.tools.enabled, 6); // read-only routes on by default, everything that changes data off
    assert.ok(connectorLog.includes('Synced 10 routes'));
  });

  it('lets the admin review tools: descriptions, roles, enabling writes', async () => {
    const list = (await api('GET', '/api/company/ai/tools?limit=50', { token: admin })).body.items as any[];
    const byName = (n: string) => list.find((t) => t.name === n)!;
    const login = byName('login');
    assert.equal(login.risk, 'write');
    assert.equal(login.enabled, false);
    assert.deepEqual(byName('deleteProduct').allowedRoles, ['company_admin']);
    assert.deepEqual(byName('createProduct').allowedRoles, ['company_admin', 'manager']);

    const patch = (id: string, body: unknown) => api('PATCH', `/api/company/ai/tools/${id}`, { token: admin, body });
    assert.equal((await patch(byName('createProduct').id, { enabled: true })).status, 200);
    assert.equal((await patch(byName('updateProduct').id, { enabled: true })).status, 200);
    assert.equal((await patch(byName('deleteProduct').id, { enabled: true })).status, 200);
    // reports: admin only; employees list: admin+manager
    await patch(byName('salesReport').id, { allowedRoles: ['company_admin'] });
    await patch(byName('listEmployees').id, { allowedRoles: ['company_admin', 'manager'], customDescription: 'List staff members of the company' });
    const emp = (await api('GET', '/api/company/ai/tools?search=staff', { token: admin })).body.items[0];
    assert.equal(emp.effectiveDescription, 'List staff members of the company');
    assert.equal((await patch(byName('listProducts').id, { allowedRoles: ['nobody'] })).status, 400);
    assert.equal((await api('PATCH', `/api/company/ai/tools/${byName('listProducts').id}`, { token: manager, body: { enabled: false } })).status, 403);
  });

  it('asks the user to connect their software login first (per-user token, never an admin key)', async () => {
    const r = await ask(admin, 'show products');
    assert.equal(r.status, 200);
    assert.equal(r.body.needsConnect, true);
    assert.match(lastAssistant(r.body), /NOT_CONNECTED/);
    convAdmin = r.body.conversation.id;
    assert.equal((await connect(admin, 'admin@demo.test', 'wrong')).status, 400);
    assert.equal((await connect(admin, 'admin@demo.test', 'admin123')).status, 200);
    // the sealed password must not remain in the queue
    const jobs = (await pool.query(`SELECT payload FROM connector_jobs WHERE type = 'login'`)).rows;
    assert.ok(jobs.every((j) => !JSON.stringify(j.payload).includes('admin123')));
  });

  it('answers with live data once connected, calling the backend as that user', async () => {
    const r = await ask(admin, 'show products');
    const text = lastAssistant(r.body);
    assert.match(text, /Basmati Rice/);
    assert.equal(r.body.items.filter((i: any) => i.role === 'assistant').at(-1).steps[0].tool, 'listProducts');
    assert.equal(r.body.needsConnect, false);
  });

  it('shows each role only the tools it may use, and the backend enforces its own rules too', async () => {
    // employee: no tool for sales reports or staff, even though the model would like to call them
    assert.match(lastAssistant((await ask(employee, 'show sales report')).body), /do not have a tool/);
    assert.match(lastAssistant((await ask(employee, 'list employees salary')).body), /do not have a tool/);
    // manager: staff yes, sales report no
    assert.equal((await connect(manager, 'manager@demo.test', 'manager123')).status, 200);
    assert.match(lastAssistant((await ask(manager, 'sales report please')).body), /do not have a tool/);
    const staff = lastAssistant((await ask(manager, 'list employees')).body);
    assert.match(staff, /Asha Admin/);
    assert.ok(!staff.includes('admin123') && !staff.includes('manager123'), 'passwords must be redacted by the connector');
    // admin: reports work
    assert.match(lastAssistant((await ask(admin, 'sales report')).body), /"totalRevenue":7539/);
    // employee is allowed to read orders in the SaaS but the company backend says 403 -> the assistant explains
    assert.equal((await connect(employee, 'employee@demo.test', 'employee123')).status, 200);
    const orders = lastAssistant((await ask(employee, 'show my orders')).body);
    assert.match(orders, /HTTP 403/);
    assert.match(orders, /lacks permission|not allowed/i);
  });

  it('asks for confirmation before changing anything and can be cancelled', async () => {
    const before = (await demoCall('GET', '/products', (await demoCall('POST', '/auth/login', undefined, { email: 'admin@demo.test', password: 'admin123' })).body.token)).body.length;
    const r = await ask(manager, 'add product called Soap at price 50');
    assert.equal(r.body.pending.length, 1);
    assert.equal(r.body.pending[0].method, 'POST');
    assert.deepEqual(r.body.pending[0].args.body, { name: 'Soap', price: 50 });
    // nothing has happened yet
    const adminTok = (await demoCall('POST', '/auth/login', undefined, { email: 'admin@demo.test', password: 'admin123' })).body.token;
    assert.equal((await demoCall('GET', '/products', adminTok)).body.length, before);
    // cannot chat on until it is resolved
    assert.equal((await ask(manager, 'hello', r.body.conversation.id)).status, 409);
    // another user cannot confirm it
    assert.equal((await api('POST', `/api/chat/actions/${r.body.pending[0].id}/confirm`, { token: employee })).status, 404);
    const c = await api('POST', `/api/chat/actions/${r.body.pending[0].id}/cancel`, { token: manager });
    assert.equal(c.body.pending.length, 0);
    assert.match(lastAssistant(c.body), /declined/);
    assert.equal((await demoCall('GET', '/products', adminTok)).body.length, before);
    // and a handled action cannot be used twice
    assert.equal((await api('POST', `/api/chat/actions/${r.body.pending[0].id}/confirm`, { token: manager })).status, 409);
  });

  it('performs the change after the user confirms', async () => {
    const r = await ask(manager, 'add product called Soap at price 50');
    const done = await api('POST', `/api/chat/actions/${r.body.pending[0].id}/confirm`, { token: manager });
    assert.equal(done.status, 200);
    assert.match(lastAssistant(done.body), /HTTP 201 OK/);
    const adminTok = (await demoCall('POST', '/auth/login', undefined, { email: 'admin@demo.test', password: 'admin123' })).body.token;
    assert.ok((await demoCall('GET', '/products?search=soap', adminTok)).body.some((p: any) => p.name === 'Soap' && p.price === 50));
  });

  it('keeps deletes off until the company allows them, then still confirms', async () => {
    assert.match(lastAssistant((await ask(admin, 'delete product 2')).body), /do not have a tool/);
    assert.equal((await api('PUT', '/api/company/ai/settings', { token: admin, body: { allowDelete: true } })).status, 200);
    // an older conversation keeps its frozen tool list; a new one sees the tool
    const r = await ask(admin, 'delete product 2');
    assert.equal(r.body.pending.length, 1);
    assert.equal(r.body.pending[0].method, 'DELETE');
    const done = await api('POST', `/api/chat/actions/${r.body.pending[0].id}/confirm`, { token: admin });
    assert.match(lastAssistant(done.body), /HTTP 200 OK/);
    const adminTok = (await demoCall('POST', '/auth/login', undefined, { email: 'admin@demo.test', password: 'admin123' })).body.token;
    assert.equal((await demoCall('GET', '/products/2', adminTok)).status, 404);
    // a manager has the tool disabled for their role: the backend never gets called
    assert.match(lastAssistant((await ask(manager, 'delete product 1')).body), /do not have a tool/);
  });

  it('re-checks permissions at execution time even if the conversation was created earlier', async () => {
    const r = await ask(manager, 'add product called Candle at price 90');
    // admin removes the manager role from the tool before the manager confirms
    const tool = (await api('GET', '/api/company/ai/tools?search=createProduct', { token: admin })).body.items[0];
    await api('PATCH', `/api/company/ai/tools/${tool.id}`, { token: admin, body: { allowedRoles: ['company_admin'] } });
    const done = await api('POST', `/api/chat/actions/${r.body.pending[0].id}/confirm`, { token: manager });
    assert.match(lastAssistant(done.body), /not allowed|not available/i);
    await api('PATCH', `/api/company/ai/tools/${tool.id}`, { token: admin, body: { allowedRoles: ['company_admin', 'manager'] } });
  });

  it('answers how-to questions from the help documents without any API call', async () => {
    const add = await api('POST', '/api/company/ai/knowledge', { token: admin, body: { title: 'Returns', content: 'To return an item open Orders, choose the order and press Return within 7 days.' } });
    assert.equal(add.status, 201);
    const r = await ask(employee, 'how do I return an item?');
    assert.match(lastAssistant(r.body), /open Orders/);
    assert.equal(r.body.items.at(-1).steps.length, 0);
  });

  it('keeps conversations private and records an audit trail', async () => {
    assert.equal((await api('GET', `/api/chat/conversations/${convAdmin}`, { token: employee })).status, 404);
    assert.equal((await api('GET', `/api/chat/conversations/${convAdmin}`, { token: admin })).status, 200);
    const list = await api('GET', '/api/chat/conversations', { token: manager });
    assert.ok(list.body.items.length >= 3 && list.body.items.every((c: any) => typeof c.title === 'string'));
    const logs = (await api('GET', '/api/company/ai/logs?limit=100', { token: admin })).body.items as any[];
    const statuses = new Set(logs.map((l) => l.status));
    for (const s of ['ok', 'awaiting_confirmation', 'cancelled', 'http_error', 'not_connected']) assert.ok(statuses.has(s), `missing log status ${s}`);
    assert.ok(logs.every((l) => !JSON.stringify(l).includes('admin123')));
    assert.equal((await api('GET', '/api/company/ai/logs', { token: employee })).status, 403);
  });

  it('isolates companies from each other', async () => {
    const r = await api('POST', '/api/auth/register-company', { body: { companyName: 'Other Co', adminName: 'Omar', email: 'omar@other.test', password: 'Passw0rd1' } });
    other = r.body.accessToken;
    assert.equal((await api('GET', `/api/chat/conversations/${convAdmin}`, { token: other })).status, 404);
    const o = (await api('GET', '/api/company/ai/overview', { token: other })).body;
    assert.equal(o.tools.total, 0);
    assert.equal(o.connector, null);
    assert.equal((await api('GET', '/api/company/ai/tools', { token: other })).body.total, 0);
    const chat = await ask(other, 'show products');
    assert.match(lastAssistant(chat.body), /do not have a tool/);
  });

  it('starts tools switched off and admin-only when one shared service key is used', async () => {
    const { makeConnectorKey } = await import('../src/modules/ai/connectorKey');
    const co = (await pool.query(`SELECT id FROM companies WHERE slug = 'other-co'`)).rows[0];
    const c = (await pool.query(`INSERT INTO connectors (company_id) VALUES ($1) RETURNING id, key_version`, [co.id])).rows[0];
    const sync = await fetch(base + '/api/connector/tools/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeConnectorKey(c.id, c.key_version)}` },
      body: JSON.stringify({ source: 'openapi', authMode: 'static', tools: [{ method: 'GET', path: '/payroll', summary: 'Payroll' }] }),
    });
    assert.equal(sync.status, 200);
    const t = (await api('GET', '/api/company/ai/tools', { token: other })).body.items[0];
    assert.equal(t.enabled, false);
    assert.deepEqual(t.allowedRoles, ['company_admin']);
  });

  it('rotating the key locks the old connector out', async () => {
    const old = (await api('GET', '/api/company/ai/connector/key', { token: admin })).body.key;
    const fresh = (await api('POST', '/api/company/ai/connector/rotate-key', { token: admin })).body.key;
    assert.notEqual(old, fresh);
    const hello = (k: string) => fetch(base + '/api/connector/hello', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: '{}' });
    assert.equal((await hello(old)).status, 401);
    assert.equal((await hello(fresh)).status, 200);
    assert.equal((await hello(old.slice(0, -3) + 'abc')).status, 401);
  });

  it('suspending a company stops its connector and assistant immediately', async () => {
    await pool.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [acmeId]);
    assert.equal((await ask(admin, 'show products')).status, 403);
    await pool.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [acmeId]);
  });
});
