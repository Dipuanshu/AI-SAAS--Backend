#!/usr/bin/env node
'use strict';

/**
 * Demo "company software" used to try the AI connector without your own backend.
 * Zero dependencies:   node examples/demo-api/server.js        (listens on http://localhost:3100)
 *
 * Logins (POST /auth/login):
 *   admin@demo.test / admin123       role admin
 *   manager@demo.test / manager123   role manager
 *   employee@demo.test / employee123 role employee
 *
 * It enforces its own role checks, exactly like a real backend would.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3100);
const SECRET = process.env.DEMO_SECRET || 'demo-secret';

const users = [
  { id: 1, name: 'Asha Admin', email: 'admin@demo.test', password: 'admin123', role: 'admin', salary: 95000 },
  { id: 2, name: 'Manoj Manager', email: 'manager@demo.test', password: 'manager123', role: 'manager', salary: 70000 },
  { id: 3, name: 'Esha Employee', email: 'employee@demo.test', password: 'employee123', role: 'employee', salary: 40000 },
];

let nextProductId = 4;
const products = [
  { id: 1, name: 'Basmati Rice 5kg', category: 'grocery', price: 620, stock: 120 },
  { id: 2, name: 'Cotton Kurta', category: 'clothing', price: 899, stock: 35 },
  { id: 3, name: 'LED Bulb 9W', category: 'electronics', price: 110, stock: 0 },
];
const orders = [
  { id: 101, customer: 'Ravi Traders', total: 5400, status: 'delivered', createdAt: '2026-10-01' },
  { id: 102, customer: 'Mehta Stores', total: 1240, status: 'pending', createdAt: '2026-10-12' },
  { id: 103, customer: 'Ravi Traders', total: 899, status: 'pending', createdAt: '2026-10-14' },
];

// ------------------------------------------------------------------------------------------ tokens
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
const issue = (u) => {
  const body = b64({ sub: u.id, role: u.role, exp: Date.now() + 8 * 3600_000 });
  return `${body}.${sign(body)}`;
};
function verify(header) {
  const m = /^Bearer (.+)\.(.+)$/.exec(header || '');
  if (!m || sign(m[1]) !== m[2]) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString());
    return p.exp > Date.now() ? users.find((u) => u.id === p.sub) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------ OpenAPI
const spec = {
  openapi: '3.0.3',
  info: { title: 'Demo Store API', version: '1.0.0' },
  servers: [{ url: '/' }],
  paths: {
    '/auth/login': {
      post: {
        operationId: 'login',
        summary: 'Log in',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Login' } } } },
        responses: { 200: { description: 'ok' } },
      },
    },
    '/me': { get: { operationId: 'getMyProfile', summary: 'Get the signed-in user profile', responses: { 200: { description: 'ok' } } } },
    '/products': {
      get: {
        operationId: 'listProducts',
        summary: 'List products in the store',
        description: 'Returns products with price and stock. Filter by search text or category.',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Text to search in the product name' },
          { name: 'category', in: 'query', schema: { type: 'string', enum: ['grocery', 'clothing', 'electronics'] } },
        ],
        responses: { 200: { description: 'ok' } },
      },
      post: {
        operationId: 'createProduct',
        summary: 'Add a new product',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } } },
        responses: { 201: { description: 'created' } },
      },
    },
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { operationId: 'getProduct', summary: 'Get one product by id', responses: { 200: { description: 'ok' } } },
      patch: {
        operationId: 'updateProduct',
        summary: 'Update a product (price, stock, name)',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } } },
        responses: { 200: { description: 'ok' } },
      },
      delete: { operationId: 'deleteProduct', summary: 'Delete a product', responses: { 200: { description: 'ok' } } },
    },
    '/orders': {
      get: {
        operationId: 'listOrders',
        summary: 'List customer orders',
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'delivered'] } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/reports/sales': { get: { operationId: 'salesReport', summary: 'Sales report: totals for the business (admin only)', responses: { 200: { description: 'ok' } } } },
    '/employees': { get: { operationId: 'listEmployees', summary: 'List employees (managers and admins)', responses: { 200: { description: 'ok' } } } },
    '/upload': {
      post: {
        operationId: 'uploadFile',
        summary: 'Upload a file',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  components: {
    schemas: {
      Login: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
      ProductInput: {
        type: 'object',
        required: ['name', 'price'],
        properties: {
          name: { type: 'string', description: 'Product name' },
          category: { type: 'string', enum: ['grocery', 'clothing', 'electronics'] },
          price: { type: 'number', minimum: 0, description: 'Selling price in rupees' },
          stock: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};

// ------------------------------------------------------------------------------------------ server
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    } catch {
      return send(res, 400, { message: 'Invalid JSON' });
    }
    const route = `${req.method} ${url.pathname}`;
    console.log(new Date().toISOString().slice(11, 19), route, url.search);

    if (route === 'GET /openapi.json') return send(res, 200, spec);
    if (route === 'GET /health') return send(res, 200, { ok: true });
    if (route === 'POST /auth/login') {
      const u = users.find((x) => x.email === body.email && x.password === body.password);
      return u ? send(res, 200, { token: issue(u), user: { id: u.id, name: u.name, role: u.role } }) : send(res, 401, { message: 'Invalid email or password' });
    }

    const me = verify(req.headers.authorization);
    if (!me) return send(res, 401, { message: 'Login required' });
    const need = (...roles) => (roles.includes(me.role) ? true : (send(res, 403, { message: `Role "${me.role}" is not allowed to do this` }), false));

    if (route === 'GET /me') return send(res, 200, { id: me.id, name: me.name, role: me.role, email: me.email });

    if (route === 'GET /products') {
      const s = (url.searchParams.get('search') || '').toLowerCase();
      const c = url.searchParams.get('category');
      return send(res, 200, products.filter((p) => (!s || p.name.toLowerCase().includes(s)) && (!c || p.category === c)));
    }
    if (route === 'POST /products') {
      if (!need('admin', 'manager')) return;
      if (!body.name || typeof body.price !== 'number') return send(res, 400, { message: 'name and price are required' });
      const p = { id: nextProductId++, name: body.name, category: body.category || 'grocery', price: body.price, stock: body.stock || 0 };
      products.push(p);
      return send(res, 201, p);
    }
    const pm = /^\/products\/(\d+)$/.exec(url.pathname);
    if (pm) {
      const p = products.find((x) => x.id === Number(pm[1]));
      if (!p) return send(res, 404, { message: 'Product not found' });
      if (req.method === 'GET') return send(res, 200, p);
      if (req.method === 'PATCH') {
        if (!need('admin', 'manager')) return;
        Object.assign(p, Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'category', 'price', 'stock'].includes(k))));
        return send(res, 200, p);
      }
      if (req.method === 'DELETE') {
        if (!need('admin')) return;
        products.splice(products.indexOf(p), 1);
        return send(res, 200, { deleted: true });
      }
    }
    if (route === 'GET /orders') {
      if (!need('admin', 'manager')) return;
      const st = url.searchParams.get('status');
      return send(res, 200, orders.filter((o) => !st || o.status === st));
    }
    if (route === 'GET /reports/sales') {
      if (!need('admin')) return;
      return send(res, 200, { totalOrders: orders.length, totalRevenue: orders.reduce((a, o) => a + o.total, 0), pendingOrders: orders.filter((o) => o.status === 'pending').length });
    }
    if (route === 'GET /employees') {
      if (!need('admin', 'manager')) return;
      // Deliberately includes password + salary: the connector redacts `password`; roles decide who may call this at all.
      return send(res, 200, users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, salary: u.salary, password: u.password })));
    }
    return send(res, 404, { message: 'Not found' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Demo store API on http://localhost:${PORT}  (spec: /openapi.json)`));
} else {
  module.exports = { server, spec };
}
