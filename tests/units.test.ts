import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInputSchema, sanitizeSchema, validateArgs } from '../src/modules/ai/schema';
import { redactValue, shrink } from '../src/modules/ai/redact';
import { rankTools } from '../src/modules/ai/toolSelect';
import { seal, unseal } from '../src/modules/ai/seal';
import { createZip } from '../src/services/zip';
import { unzipTo } from './helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const connector = require('../connector/connector.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const demo = require('../connector/examples/demo-api/server.js');

describe('schema helpers', () => {
  it('builds an input schema from path/query params and a body', () => {
    const { schema, paramMap, hasBody } = buildInputSchema({
      method: 'PATCH', path: '/products/{id}',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
        { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
      requestBody: { required: true, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, example: { name: 'x' } } },
    });
    assert.deepEqual(paramMap.map((p) => p.key), ['id', 'q']); // header params are never exposed
    assert.equal(hasBody, true);
    assert.deepEqual((schema as any).required, ['id', 'body']);
    assert.equal(((schema as any).properties.body as any).example, undefined);
  });

  it('keeps only known keywords and converts nullable', () => {
    const s = sanitizeSchema({ type: 'string', nullable: true, example: 'x', 'x-internal': 1, description: 'd' });
    assert.deepEqual(s, { type: ['string', 'null'], description: 'd' });
  });

  it('validates model-produced arguments', () => {
    const schema = { type: 'object', properties: { id: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] }, body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }, required: ['id'] };
    assert.equal(validateArgs(schema, { id: 3 }), null);
    assert.match(validateArgs(schema, {})!, /id is required/);
    assert.match(validateArgs(schema, { id: 'x' })!, /type integer/);
    assert.match(validateArgs(schema, { id: 1, kind: 'z' })!, /one of/);
    assert.match(validateArgs(schema, { id: 1, body: {} })!, /body.name is required/);
  });
});

describe('redaction and shrinking', () => {
  it('removes sensitive keys at any depth, case-insensitively', () => {
    const out: any = redactValue([{ a: 1, Password: 'x', nested: { token: 't', ok: true } }], ['password', 'token']);
    assert.deepEqual(out, [{ a: 1, nested: { ok: true } }]);
  });
  it('trims long arrays and stays valid JSON', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'item ' + i }));
    const s = shrink(big, 2000);
    assert.ok(s.length <= 2000);
    const parsed = JSON.parse(s);
    assert.ok(parsed.items.length < 500 && /Showing/.test(parsed._note));
  });
});

describe('tool selection', () => {
  it('ranks the relevant tools first', () => {
    const tools = [
      { name: 'listInvoices', text: 'List all invoices of customers' },
      { name: 'listProducts', text: 'List products with price and stock' },
      { name: 'createEmployee', text: 'Add a new employee' },
      { name: 'salesReport', text: 'Sales report totals' },
    ];
    assert.equal(rankTools(tools, 'what is the stock of rice products?', 1)[0]!.name, 'listProducts');
    assert.equal(rankTools(tools, 'employee add karna hai', 1)[0]!.name, 'createEmployee');
    assert.equal(rankTools(tools, 'anything', 10).length, 4);
  });
});

describe('seal / zip', () => {
  it('round-trips sealed secrets and rejects tampering', () => {
    const sealed = seal('cak_key', 'p@ss w0rd');
    assert.equal(unseal('cak_key', sealed), 'p@ss w0rd');
    assert.throws(() => unseal('other_key', sealed));
    assert.equal(connector.unseal('cak_key', sealed), 'p@ss w0rd'); // connector and server agree
  });
  it('writes a valid zip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
    const names = unzipTo(createZip([{ name: 'a/b.txt', data: 'hello ' + 'x'.repeat(5000) }, { name: 'c.sh', data: '#!/bin/sh\n', mode: 0o755 }]), dir);
    assert.deepEqual(names, ['a/b.txt', 'c.sh']);
    assert.equal(fs.readFileSync(path.join(dir, 'a/b.txt'), 'utf8').length, 5006);
  });
});

describe('connector: route discovery', () => {
  it('parses an OpenAPI 3 document with $refs and skips file uploads', () => {
    const { tools, skipped } = connector.parseOpenApi(demo.spec);
    assert.equal(skipped, 1);
    const names = tools.map((t: any) => `${t.method} ${t.path}`);
    assert.ok(names.includes('GET /products') && names.includes('PATCH /products/{id}') && !names.some((n: string) => n.includes('/upload')));
    const patch = tools.find((t: any) => t.method === 'PATCH');
    assert.equal(patch.parameters[0].name, 'id'); // path-level parameter inherited
    assert.deepEqual(patch.requestBody.schema.required, ['name', 'price']); // $ref resolved
  });

  it('parses Swagger 2 with basePath and body parameters', () => {
    const { tools } = connector.parseOpenApi({
      swagger: '2.0', basePath: '/api/v1',
      paths: { '/pets/{id}': { put: { operationId: 'updatePet', parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }, { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }] } } },
      definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
    });
    assert.equal(tools[0].path, '/api/v1/pets/{id}');
    assert.equal(tools[0].parameters[0].schema.type, 'integer');
    assert.equal(tools[0].requestBody.schema.properties.name.type, 'string');
  });

  it('survives recursive schemas', () => {
    const { tools } = connector.parseOpenApi({
      openapi: '3.0.0',
      paths: { '/tree': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } },
      components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } },
    });
    assert.equal(tools.length, 1);
    assert.ok(JSON.stringify(tools[0].requestBody.schema).length < 2000);
  });

  it('parses a Postman collection', () => {
    const { tools } = connector.parsePostman({
      item: [{ name: 'Shop', item: [
        { name: 'Get product', request: { method: 'GET', url: { raw: '{{base}}/products/:id?lang=en', path: ['products', ':id'], query: [{ key: 'lang', value: 'en' }] } } },
        { name: 'Create', request: { method: 'POST', url: { path: ['products'] }, body: { mode: 'raw', raw: '{"name":"x","price":5,"tags":["a"]}' } } },
      ] }],
    });
    assert.equal(tools[0].path, '/products/{id}');
    assert.deepEqual(tools[0].parameters.map((p: any) => p.in), ['path', 'query']);
    assert.equal(tools[1].requestBody.schema.properties.price.type, 'integer');
  });

  it('learns routes from traffic without keeping values', () => {
    assert.equal(connector.normalizePath('/products/12/reviews/3'), '/products/{productId}/reviews/{reviewId}');
    assert.equal(connector.normalizePath('/users/550e8400-e29b-41d4-a716-446655440000'), '/users/{userId}');
    const r = new connector.Recorder();
    r.add('POST', '/orders/7/items', new URLSearchParams('note=1'), { sku: 'secret-sku', qty: 2 });
    r.add('POST', '/orders/8/items', new URLSearchParams(), { sku: 'other', qty: 1, gift: true });
    const [t] = r.toTools();
    assert.equal(t.path, '/orders/{orderId}/items');
    assert.deepEqual(Object.keys(t.requestBody.schema.properties).sort(), ['gift', 'qty', 'sku']);
    assert.ok(!JSON.stringify(t).includes('secret-sku'));
    assert.ok(t.description.includes('2 calls'));
  });

  it('refuses unsafe paths', () => {
    for (const bad of ['http://evil.test/x', '//evil.test', '/a/../b', '/a b', 'relative', '/x\\y']) assert.equal(connector.isSafeRelativePath(bad), false, bad);
    assert.equal(connector.isSafeRelativePath('/products/1?x=1'), true);
  });
});
