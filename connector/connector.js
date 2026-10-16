#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * AI SaaS Connector — one program for every backend language.
 *
 * It runs next to your backend (same server, container or network) and:
 *   1. learns your API routes   -> from an OpenAPI/Swagger spec, a Postman collection, or live traffic (record mode)
 *   2. registers them with the AI SaaS (names, parameters, types only - never your source code)
 *   3. executes the calls the AI assistant needs, against YOUR backend, using the signed-in user's own login
 *
 * It only makes OUTBOUND connections to the SaaS, so no inbound firewall port has to be opened.
 * Zero dependencies. Requires Node.js 18+.
 *
 *   node connector.js            run
 *   node connector.js --check    test everything and print a report (no polling)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const VERSION = '1.0.0';

// ------------------------------------------------------------------------------------------------ config
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* no .env file: fine */
  }
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

const DEFAULT_CONFIG = {
  backendUrl: 'http://localhost:3000',
  openapi: { url: '', file: '', probe: true, headers: {} },
  postmanFile: '',
  auth: {
    mode: 'none', // none | static | login
    static: { header: 'Authorization', value: '' },
    login: {
      path: '/auth/login',
      method: 'POST',
      contentType: 'json',
      body: { email: '{{username}}', password: '{{password}}' },
      tokenPath: 'token',
      header: 'Authorization',
      prefix: 'Bearer ',
      sessionMinutes: 480,
    },
  },
  redactFields: ['password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'api_key'],
  record: { enabled: false, port: 9090 },
  refreshMinutes: 30,
  timeoutMs: 20000,
  maxResponseBytes: 2000000,
};

function loadConfig(dir) {
  loadDotEnv(path.join(dir, '.env'));
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dir, 'connector.config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`connector.config.json is not valid JSON: ${e.message}`);
  }
  const cfg = deepMerge(DEFAULT_CONFIG, file);
  const env = process.env;
  if (env.BACKEND_URL) cfg.backendUrl = env.BACKEND_URL;
  if (env.OPENAPI_URL) cfg.openapi.url = env.OPENAPI_URL;
  if (env.OPENAPI_FILE) cfg.openapi.file = env.OPENAPI_FILE;
  if (env.POSTMAN_FILE) cfg.postmanFile = env.POSTMAN_FILE;
  if (env.AUTH_MODE) cfg.auth.mode = env.AUTH_MODE;
  if (env.STATIC_AUTH_VALUE) cfg.auth.static.value = env.STATIC_AUTH_VALUE;
  if (env.RECORD_MODE) cfg.record.enabled = env.RECORD_MODE === 'true';
  cfg.backendUrl = String(cfg.backendUrl).replace(/\/+$/, '');
  cfg.saasUrl = String(env.AISAAS_URL || '').replace(/\/+$/, '');
  cfg.key = String(env.AISAAS_CONNECTOR_KEY || '');
  return cfg;
}

// ------------------------------------------------------------------------------------------------ logging
const log = {
  info: (...a) => console.log(new Date().toISOString().slice(11, 19), '·', ...a),
  warn: (...a) => console.warn(new Date().toISOString().slice(11, 19), '! ', ...a),
  error: (...a) => console.error(new Date().toISOString().slice(11, 19), '✗ ', ...a),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ helpers
function getPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((o, k) => (o !== null && o !== undefined ? o[k] : undefined), obj);
}

/** Removes sensitive keys (case-insensitive) from any JSON value, in place of copying. */
function redact(value, fields, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  const set = new Set(fields.map((f) => String(f).toLowerCase()));
  const walk = (v, d) => {
    if (d > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (set.has(k.toLowerCase())) continue;
      out[k] = walk(x, d + 1);
    }
    return out;
  };
  return walk(value, depth);
}

const isSafeRelativePath = (p) =>
  typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('://') && !p.split('?')[0].split('/').includes('..') && !/[\s\\]/.test(p);

// ------------------------------------------------------------------------------------------------ OpenAPI
function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return {};
  return (
    ref
      .slice(2)
      .split('/')
      .reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc) || {}
  );
}

function deref(doc, node, seen = new Set(), depth = 0) {
  if (node === null || typeof node !== 'object') return node;
  if (depth > 8) return { type: 'object' };
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, seen, depth + 1));
  if (node.$ref) {
    if (seen.has(node.$ref)) return { type: 'object', description: '(recursive reference)' };
    return deref(doc, resolveRef(doc, node.$ref), new Set([...seen, node.$ref]), depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, seen, depth + 1);
  return out;
}

function swaggerParamSchema(p) {
  const s = {};
  for (const k of ['type', 'format', 'enum', 'items', 'minimum', 'maximum', 'default', 'pattern', 'minLength', 'maxLength']) if (p[k] !== undefined) s[k] = p[k];
  return s;
}

function basePrefix(doc) {
  if (doc.swagger) return doc.basePath && doc.basePath !== '/' ? String(doc.basePath).replace(/\/+$/, '') : '';
  const url = doc.servers && doc.servers[0] && doc.servers[0].url;
  if (!url) return '';
  try {
    const p = url.startsWith('/') ? url : new URL(url.replace(/\{[^}]+\}/g, 'x')).pathname;
    return p === '/' ? '' : url.startsWith('/') ? url.replace(/\/+$/, '') : p.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Converts an OpenAPI 3.x / Swagger 2.0 document into the tool list the SaaS understands. */
function parseOpenApi(doc) {
  if (!doc || typeof doc !== 'object' || !doc.paths) throw new Error('This is not an OpenAPI/Swagger document (no "paths").');
  const prefix = basePrefix(doc);
  const tools = [];
  let skipped = 0;
  for (const [route, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op || typeof op !== 'object' || op.deprecated) continue;
      const params = [];
      let requestBody = null;
      let unsupportedBody = false;

      for (const raw of [...shared, ...(op.parameters || [])]) {
        const p = deref(doc, raw);
        if (!p || !p.name) continue;
        if (p.in === 'path' || p.in === 'query') {
          params.push({ name: p.name, in: p.in, required: !!p.required || p.in === 'path', description: p.description, schema: p.schema || swaggerParamSchema(p) });
        } else if (p.in === 'body') {
          requestBody = { required: !!p.required, description: p.description, schema: p.schema || { type: 'object' } };
        } else if (p.in === 'formData') {
          unsupportedBody = true;
        }
      }
      if (op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const content = rb.content || {};
        const jsonKey = Object.keys(content).find((k) => k === 'application/json') || Object.keys(content).find((k) => k.includes('json'));
        if (jsonKey) requestBody = { required: !!rb.required, description: rb.description, schema: content[jsonKey].schema || { type: 'object' } };
        else if (Object.keys(content).length) unsupportedBody = true; // multipart / file upload: not callable by the assistant
      }
      if (unsupportedBody && !requestBody) {
        skipped++;
        continue;
      }
      const m = method.toUpperCase();
      tools.push({
        method: m,
        path: prefix + route,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        parameters: params,
        requestBody,
      });
    }
  }
  return { tools, skipped };
}

// ------------------------------------------------------------------------------------------------ Postman
function inferSchema(sample, depth = 0) {
  if (sample === null) return { type: 'string', nullable: true };
  if (Array.isArray(sample)) return { type: 'array', items: depth > 3 || !sample.length ? {} : inferSchema(sample[0], depth + 1) };
  switch (typeof sample) {
    case 'number':
      return { type: Number.isInteger(sample) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      if (depth > 3) return { type: 'object' };
      const properties = {};
      for (const [k, v] of Object.entries(sample)) properties[k] = inferSchema(v, depth + 1);
      return { type: 'object', properties };
    }
    default:
      return { type: 'string' };
  }
}

function parsePostman(collection) {
  if (!collection || !Array.isArray(collection.item)) throw new Error('This is not a Postman collection (no "item" list).');
  const tools = [];
  const walk = (items, folder) => {
    for (const it of items) {
      if (Array.isArray(it.item)) {
        walk(it.item, [...folder, it.name]);
        continue;
      }
      const r = it.request;
      if (!r || !r.method) continue;
      const method = String(r.method).toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
      const url = typeof r.url === 'string' ? { raw: r.url } : r.url || {};
      let segs = url.path;
      if (!Array.isArray(segs)) {
        const raw = String(url.raw || '').replace(/^[a-z]+:\/\//i, '').replace(/^\{\{[^}]+\}\}/, '');
        segs = raw.split('?')[0].split('/').slice(raw.startsWith('/') ? 1 : 1).filter(Boolean);
      }
      const params = [];
      const routeSegs = segs.map((s) => {
        const m = /^:(\w+)$/.exec(s) || /^\{\{(\w+)\}\}$/.exec(s) || /^\{(\w+)\}$/.exec(s);
        if (!m) return s;
        params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
        return `{${m[1]}}`;
      });
      for (const q of url.query || []) if (q && q.key && !q.disabled) params.push({ name: q.key, in: 'query', required: false, description: q.description, schema: { type: 'string' } });
      let requestBody = null;
      if (r.body && r.body.mode === 'raw' && r.body.raw) {
        try {
          requestBody = { required: true, schema: inferSchema(JSON.parse(r.body.raw)) };
        } catch {
          requestBody = { required: false, schema: { type: 'object' } };
        }
      }
      tools.push({
        method,
        path: '/' + routeSegs.join('/'),
        summary: [folder.join(' / '), it.name].filter(Boolean).join(' - '),
        description: typeof r.description === 'string' ? r.description : r.description && r.description.content,
        parameters: params,
        requestBody,
      });
    }
  };
  walk(collection.item, []);
  return { tools, skipped: 0 };
}

// ------------------------------------------------------------------------------------------------ record mode
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksDynamic = (s) => /^\d+$/.test(s) || UUID.test(s) || /^[0-9a-f]{24}$/i.test(s);

/** /products/12/reviews/3 -> /products/{productId}/reviews/{reviewId} */
function normalizePath(p) {
  const segs = p.split('/').filter(Boolean);
  const used = new Set();
  const out = segs.map((s, i) => {
    if (!looksDynamic(s)) return s;
    const prev = (segs[i - 1] || 'item').replace(/[^A-Za-z0-9]/g, '');
    const singular = prev.endsWith('ies') ? `${prev.slice(0, -3)}y` : prev.endsWith('s') ? prev.slice(0, -1) : prev;
    let name = `${singular || 'item'}Id`;
    for (let n = 2; used.has(name); n++) name = `${singular}Id${n}`;
    used.add(name);
    return `{${name}}`;
  });
  return '/' + out.join('/');
}

function mergeSchema(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type === 'object' && b.type === 'object') {
    const properties = { ...(a.properties || {}) };
    for (const [k, v] of Object.entries(b.properties || {})) properties[k] = properties[k] ? mergeSchema(properties[k], v) : v;
    return { type: 'object', properties };
  }
  return a;
}

class Recorder {
  constructor() {
    this.routes = new Map();
    this.dirty = false;
  }
  add(method, rawPath, query, bodySample) {
    const clean = rawPath.split('?')[0];
    if (/\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|html)$/i.test(clean)) return;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    const route = normalizePath(clean);
    const key = `${method} ${route}`;
    const rec = this.routes.get(key) || { method, path: route, queryKeys: new Set(), body: null, count: 0 };
    rec.count++;
    for (const k of query.keys()) rec.queryKeys.add(k);
    if (bodySample !== undefined) rec.body = mergeSchema(rec.body, inferSchema(bodySample));
    this.routes.set(key, rec);
    this.dirty = true;
  }
  toTools() {
    return [...this.routes.values()].map((r) => {
      const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      for (const q of r.queryKeys) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
      return {
        method: r.method,
        path: r.path,
        summary: '',
        description: `Learned from live traffic (${r.count} call${r.count === 1 ? '' : 's'}). Add a clear description in the app before enabling.`,
        parameters: params,
        requestBody: r.body ? { required: false, schema: r.body } : null,
      };
    });
  }
}

/** Reverse proxy that learns routes (method, path pattern, parameter names, body field types - never values). */
function startRecorder(cfg, recorder) {
  const target = new URL(cfg.backendUrl);
  const lib = target.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 65536) chunks.push(c);
    });
    const url = new URL(req.url, 'http://x');
    const proxied = lib.request(
      { host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), method: req.method, path: req.url, headers: { ...req.headers, host: target.host } },
      (pr) => {
        res.writeHead(pr.statusCode || 502, pr.headers);
        pr.pipe(res);
        pr.on('end', () => {
          if ((pr.statusCode || 500) >= 500 || (pr.statusCode === 404)) return;
          let sample;
          if (chunks.length && /json/.test(req.headers['content-type'] || '')) {
            try {
              sample = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              /* ignore non-JSON */
            }
          }
          recorder.add(req.method, url.pathname, url.searchParams, sample);
        });
      },
    );
    proxied.on('error', (e) => {
      res.writeHead(502);
      res.end(`Connector proxy could not reach ${cfg.backendUrl}: ${e.message}`);
    });
    req.pipe(proxied);
  });
  server.listen(cfg.record.port, () => log.info(`Record mode: send traffic to http://localhost:${cfg.record.port} (forwarded to ${cfg.backendUrl}). Use your app/Postman through it.`));
  return server;
}

// ------------------------------------------------------------------------------------------------ discovery
const SPEC_CANDIDATES = [
  '/openapi.json', '/swagger.json', '/v3/api-docs', '/api-docs', '/api-docs.json', '/docs.json', '/docs/api.json',
  '/docs/api-docs.json', '/swagger/v1/swagger.json', '/api/openapi.json', '/api/swagger.json', '/api/v1/openapi.json',
  '/api/schema/?format=json', '/api-json', '/docs-json', '/v2/api-docs', '/openapi', '/api-docs/v1/swagger.json',
];

async function fetchJson(url, headers = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function discover(cfg) {
  const attempts = [];
  if (cfg.openapi.file) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(cfg.openapi.file), 'utf8'));
    return { ...parseOpenApi(doc), source: 'openapi', specSource: `file:${cfg.openapi.file}` };
  }
  if (cfg.postmanFile) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(cfg.postmanFile), 'utf8'));
    return { ...parsePostman(doc), source: 'postman', specSource: `file:${cfg.postmanFile}` };
  }
  const urls = cfg.openapi.url ? [cfg.openapi.url] : cfg.openapi.probe ? SPEC_CANDIDATES.map((c) => cfg.backendUrl + c) : [];
  for (const u of urls) {
    try {
      const doc = await fetchJson(u, cfg.openapi.headers);
      if (doc && (doc.openapi || doc.swagger) && doc.paths) return { ...parseOpenApi(doc), source: 'openapi', specSource: u };
      attempts.push(`${u} -> not an OpenAPI document`);
    } catch (e) {
      attempts.push(`${u} -> ${e.message}`);
    }
  }
  const err = new Error('No API description found.');
  err.attempts = attempts;
  throw err;
}

// ------------------------------------------------------------------------------------------------ SaaS client
async function saas(cfg, apiPath, body, timeoutMs = 40000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.saasUrl + apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((json.error && json.error.message) || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------------------------------------ calling your backend
const sessions = new Map(); // userRef -> { token, expires }

/** The SaaS encrypts a user's software password with the connector key, so it is never stored in plaintext in transit queues. */
function unseal(key, sealed) {
  const buf = Buffer.from(String(sealed), 'base64');
  const k = crypto.createHash('sha256').update(`seal:${key}`).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function authHeaders(cfg, userRef) {
  const a = cfg.auth;
  if (a.mode === 'static' && a.static.value) return { headers: { [a.static.header || 'Authorization']: a.static.value } };
  if (a.mode === 'login') {
    const s = sessions.get(userRef);
    if (!s || s.expires < Date.now()) {
      sessions.delete(userRef);
      return { error: { ok: false, code: 'NOT_CONNECTED', error: 'The user has not connected their software login (or it expired).' } };
    }
    return { headers: { [a.login.header || 'Authorization']: (a.login.prefix || '') + s.token } };
  }
  return { headers: {} };
}

async function backendRequest(cfg, method, urlPath, { query, body, headers }) {
  if (!isSafeRelativePath(urlPath)) return { ok: false, code: 'BAD_PATH', error: 'Refused: invalid path.' };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else if (v !== undefined && v !== null) qs.append(k, String(v));
  }
  const url = cfg.backendUrl + urlPath + (qs.toString() ? `?${qs}` : '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const hasBody = body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE';
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, cfg.maxResponseBytes).toString('utf8');
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text.slice(0, 5000);
    }
    return { ok: true, status: res.status, body: parsed, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, code: e.name === 'AbortError' ? 'TIMEOUT' : 'BACKEND_UNREACHABLE', error: e.name === 'AbortError' ? 'Your backend took too long to respond.' : `Cannot reach your backend at ${cfg.backendUrl}: ${e.cause && e.cause.code ? e.cause.code : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function handleJob(cfg, job) {
  const p = job.payload || {};
  if (job.type === 'call') {
    const auth = authHeaders(cfg, p.userRef);
    if (auth.error) return auth.error;
    const r = await backendRequest(cfg, String(p.method || '').toUpperCase(), p.path, { query: p.query, body: p.body, headers: auth.headers });
    if (r.ok && r.status === 401 && cfg.auth.mode === 'login') {
      sessions.delete(p.userRef);
      return { ok: false, code: 'NOT_CONNECTED', error: 'Your software login expired. Please reconnect.' };
    }
    if (r.ok) r.body = redact(r.body, cfg.redactFields);
    return r;
  }
  if (job.type === 'login') {
    const l = cfg.auth.login;
    if (cfg.auth.mode !== 'login') return { ok: false, code: 'NOT_NEEDED', error: 'This connector does not use per-user login.' };
    let password;
    try {
      password = unseal(cfg.key, p.sealedPassword);
    } catch {
      return { ok: false, code: 'BAD_SEAL', error: 'Could not read the login request. Is the connector key up to date?' };
    }
    const fill = (v) => (typeof v === 'string' ? v.replace(/\{\{username\}\}/g, () => p.username).replace(/\{\{password\}\}/g, () => password) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
    const bodyObj = fill(l.body);
    let r;
    if (l.contentType === 'form') {
      const form = new URLSearchParams(bodyObj).toString();
      try {
        const res = await fetch(cfg.backendUrl + l.path, { method: l.method || 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form });
        r = { ok: true, status: res.status, body: await res.json().catch(() => null) };
      } catch (e) {
        r = { ok: false, code: 'BACKEND_UNREACHABLE', error: `Cannot reach your backend: ${e.message}` };
      }
    } else {
      r = await backendRequest(cfg, l.method || 'POST', l.path, { body: bodyObj, headers: {} });
    }
    if (!r.ok) return r;
    const token = r.status >= 200 && r.status < 300 ? getPath(r.body, l.tokenPath) : undefined;
    if (!token || typeof token !== 'string') return { ok: false, code: 'LOGIN_FAILED', error: 'Login failed. Check the username and password of your software.' };
    sessions.set(p.userRef, { token, expires: Date.now() + (l.sessionMinutes || 480) * 60000 });
    return { ok: true, status: 200, body: { connected: true } }; // the token itself never leaves this process
  }
  if (job.type === 'logout') {
    sessions.delete(p.userRef);
    return { ok: true, status: 200, body: { connected: false } };
  }
  return { ok: false, code: 'UNKNOWN_JOB', error: `Unknown job type ${job.type}` };
}

// ------------------------------------------------------------------------------------------------ main
async function syncRoutes(cfg, recorder) {
  let found;
  try {
    found = await discover(cfg);
  } catch (e) {
    if (recorder && recorder.routes.size) found = null;
    else throw e;
  }
  if (found) {
    const r = await saas(cfg, '/api/connector/tools/sync', { source: found.source, specSource: found.specSource, authMode: cfg.auth.mode, tools: found.tools }, 120000);
    log.info(`Synced ${r.total} routes from ${found.specSource} (${r.added} new, ${r.updated} updated, ${r.stale} no longer in spec${found.skipped ? `, ${found.skipped} file-upload routes skipped` : ''}).`);
  }
  if (recorder && recorder.dirty) {
    recorder.dirty = false;
    const r = await saas(cfg, '/api/connector/tools/sync', { source: 'recorded', specSource: 'live traffic', authMode: cfg.auth.mode, tools: recorder.toTools() }, 60000);
    log.info(`Synced ${r.total} routes learned from traffic (${r.added} new). Review them in the app before enabling.`);
  }
}

function printDiscoveryHelp(err) {
  log.error('Could not find your API description automatically.');
  for (const a of err.attempts || []) console.log('   tried', a);
  console.log(`
  Fix it with ONE of these (see README.md):
   1. Set OPENAPI_URL in .env to the URL of your OpenAPI/Swagger JSON (for example http://localhost:3000/openapi.json)
   2. Export a Postman collection and set POSTMAN_FILE=./my-collection.json
   3. Turn on record mode ("record": {"enabled": true} in connector.config.json) and use your app through the proxy port`);
}

async function check(cfg) {
  let bad = 0;
  const ok = (m) => console.log('  ✓', m);
  const no = (m) => {
    bad++;
    console.log('  ✗', m);
  };
  console.log(`\nAI SaaS Connector ${VERSION} — self check\n`);
  if (!cfg.saasUrl || !cfg.key) no('AISAAS_URL / AISAAS_CONNECTOR_KEY missing in .env');
  else {
    try {
      const h = await saas(cfg, '/api/connector/hello', { version: VERSION, hostname: require('os').hostname(), authMode: cfg.auth.mode }, 15000);
      ok(`Connected to the AI SaaS as "${h.companyName}"`);
    } catch (e) {
      no(`Cannot use the AI SaaS (${cfg.saasUrl}): ${e.message}`);
    }
  }
  try {
    const r = await fetch(cfg.backendUrl, { signal: AbortSignal.timeout(8000) });
    ok(`Your backend answers at ${cfg.backendUrl} (HTTP ${r.status})`);
  } catch (e) {
    no(`Cannot reach your backend at ${cfg.backendUrl}: ${e.cause && e.cause.code ? e.cause.code : e.message}`);
  }
  try {
    const d = await discover(cfg);
    ok(`Found ${d.tools.length} API routes (${d.specSource})`);
  } catch (e) {
    no(e.message);
    printDiscoveryHelp(e);
  }
  console.log(`  · auth mode: ${cfg.auth.mode}${cfg.auth.mode === 'login' ? ` (users log in via ${cfg.auth.login.path})` : ''}`);
  console.log(bad ? `\n${bad} problem(s) found.\n` : '\nAll good. Run:  node connector.js\n');
  process.exit(bad ? 1 : 0);
}

async function main() {
  const cfg = loadConfig(process.cwd());
  if (process.argv.includes('--check')) return check(cfg);
  if (!cfg.saasUrl || !cfg.key) {
    log.error('AISAAS_URL and AISAAS_CONNECTOR_KEY must be set in .env (download the package again from the app if you lost them).');
    process.exit(1);
  }
  log.info(`AI SaaS Connector ${VERSION} → ${cfg.saasUrl} | backend ${cfg.backendUrl} | auth ${cfg.auth.mode}`);

  let hello;
  try {
    hello = await saas(cfg, '/api/connector/hello', { version: VERSION, hostname: require('os').hostname(), authMode: cfg.auth.mode }, 20000);
  } catch (e) {
    log.error(`Cannot connect to the AI SaaS: ${e.message}${e.status === 401 ? ' (wrong or rotated connector key)' : ''}`);
    process.exit(1);
  }
  log.info(`Connected as company "${hello.companyName}".`);
  if (Array.isArray(hello.redactFields)) cfg.redactFields = [...new Set([...cfg.redactFields, ...hello.redactFields])];

  const recorder = cfg.record.enabled ? new Recorder() : null;
  if (recorder) startRecorder(cfg, recorder);

  try {
    await syncRoutes(cfg, recorder);
  } catch (e) {
    if (e.attempts) printDiscoveryHelp(e);
    else log.error(`Route discovery failed: ${e.message}`);
    if (!recorder) log.warn('Continuing anyway: fix the setup and restart, or the assistant will have no routes to use.');
  }

  const resync = setInterval(() => syncRoutes(cfg, recorder).catch((e) => log.warn(`Re-sync failed: ${e.message}`)), Math.max(1, cfg.refreshMinutes) * 60000);
  const recSync = recorder ? setInterval(() => recorder.dirty && syncRoutes(cfg, recorder).catch((e) => log.warn(`Record sync failed: ${e.message}`)), 10000) : null;

  let running = true;
  const stop = () => {
    running = false;
    clearInterval(resync);
    if (recSync) clearInterval(recSync);
    log.info('Stopping…');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log.info('Waiting for questions from the AI assistant…  (Ctrl+C to stop)');
  let failures = 0;
  let unauthorized = 0;
  while (running) {
    try {
      const r = await saas(cfg, '/api/connector/poll', { version: VERSION, authMode: cfg.auth.mode }, 45000);
      failures = 0;
      unauthorized = 0;
      for (const job of r.jobs || []) {
        handleJob(cfg, job)
          .catch((e) => ({ ok: false, code: 'CONNECTOR_ERROR', error: e.message }))
          .then((result) => saas(cfg, `/api/connector/jobs/${job.id}/result`, result, 20000))
          .catch((e) => log.warn(`Could not report job ${job.id}: ${e.message}`));
      }
    } catch (e) {
      failures++;
      if (e.status === 401) {
        if (++unauthorized >= 3) {
          log.error('The connector key was rejected. Download the package again or copy the new key from the app (Setup → Connector).');
          process.exit(1);
        }
      } else {
        log.warn(`Lost connection to the AI SaaS (${e.message}). Retrying…`);
      }
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    log.error(e.stack || e.message);
    process.exit(1);
  });
} else {
  module.exports = { unseal, parseOpenApi, parsePostman, inferSchema, normalizePath, redact, isSafeRelativePath, Recorder, handleJob, loadConfig, DEFAULT_CONFIG, backendRequest, sessions, discover };
}
