process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://aisaas:aisaas@localhost:5432/aisaas_test';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startFakeOpenRouter, FakeOpenRouter } from './helpers';

describe('OpenRouter adapter', () => {
  let fake: FakeOpenRouter;
  let mod: typeof import('../src/modules/ai/llm/openrouter');
  let env: typeof import('../src/config/env').env;
  before(async () => {
    fake = await startFakeOpenRouter({ badModel: 'bad/model:free', forbiddenModel: 'forbidden/model:free' });
    ({ env } = await import('../src/config/env'));
    mod = await import('../src/modules/ai/llm/openrouter');
    env.llm.openrouter.baseUrl = fake.url;
    env.llm.openrouter.apiKey = 'test-key';
  });
  after(() => fake.close());

  it('converts Anthropic-style history to OpenAI chat messages', () => {
    const msgs = mod.toOpenAiMessages('SYS', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 't1', name: 'listProducts', input: { q: 'a' } }, { type: 'tool_use', id: 't2', name: 'getMe', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'DATA' }, { type: 'tool_result', tool_use_id: 't2', content: 'ERR', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'x', input: {} }] },
    ]);
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
    assert.equal(msgs[2].tool_calls.length, 2);
    assert.equal(msgs[2].tool_calls[0].function.arguments, '{"q":"a"}');
    assert.equal(msgs[4].content, 'ERR\n(This call failed.)');
    assert.equal(msgs[5].content, null); // tool-call-only turn
    assert.ok(!JSON.stringify(msgs).includes('thinking'));
  });

  it('simplifies schemas the cheaper providers reject', () => {
    const [t] = mod.toOpenAiTools([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: { x: { type: ['string', 'null'] }, y: { type: 'array', items: { type: ['integer', 'null'] } } } } }]);
    assert.equal((t as any).function.parameters.properties.x.type, 'string');
    assert.equal((t as any).function.parameters.properties.y.items.type, 'integer');
  });

  it('parses tool calls, tolerating broken JSON arguments', () => {
    const r = mod.fromOpenAiMessage({ content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'c2', function: { name: 'g', arguments: '{oops' } }] }, 'tool_calls');
    assert.equal(r.stopReason, 'tool_use');
    assert.deepEqual(r.content.map((b) => [b.type, b.name, b.input]), [['tool_use', 'f', { a: 1 }], ['tool_use', 'g', {}]]);
    assert.equal(mod.fromOpenAiMessage({ content: 'hello' }, 'stop').content[0]!.text, 'hello');
    assert.equal(mod.fromOpenAiMessage({ content: '' }, 'stop').content[0]!.type, 'text'); // never an empty reply
  });

  it('auto mode picks free tool-capable models only, preferred families first', async () => {
    env.llm.openrouter.model = 'auto';
    mod.resetModelCache();
    const ids = await mod.candidateModels();
    assert.deepEqual(ids, ['meta-llama/llama-3.3-70b-instruct:free', 'some/other:free']);
    env.llm.openrouter.model = 'a/one:free, b/two:free';
    assert.deepEqual(await mod.candidateModels(), ['a/one:free', 'b/two:free']);
  });

  it('treats a 403 on one model as model-specific and tries the next (only 401 means a bad key)', async () => {
    env.llm.openrouter.model = 'forbidden/model:free,good/model:free';
    const r = await mod.createOpenRouterLlm().complete({ system: 'S', tools: [], messages: [{ role: 'user', content: 'Question: hello' }] });
    assert.equal(r.content[0]!.type, 'text');
    assert.deepEqual(fake.requests.map((q) => q.model).slice(-2), ['forbidden/model:free', 'good/model:free']);
    // when every model fails, the real reason is reported
    env.llm.openrouter.model = 'forbidden/model:free';
    await assert.rejects(() => mod.createOpenRouterLlm().complete({ system: 'S', tools: [], messages: [{ role: 'user', content: 'x' }] }), /HTTP 403: Provider returned error - blocked by data policy/);
  });

  it('falls back to the next model, and reports a rejected key clearly', async () => {
    env.llm.openrouter.model = 'bad/model:free,good/model:free';
    const llm = mod.createOpenRouterLlm();
    const r = await llm.complete({ system: 'S', tools: [], messages: [{ role: 'user', content: 'Question: hello' }] });
    assert.equal(r.content[0]!.type, 'text');
    assert.deepEqual(fake.requests.map((q) => q.model).slice(-2), ['bad/model:free', 'good/model:free']);
    env.llm.openrouter.apiKey = 'wrong';
    await assert.rejects(() => llm.complete({ system: 'S', tools: [], messages: [{ role: 'user', content: 'x' }] }), /rejected the API key/);
    env.llm.openrouter.apiKey = 'test-key';
  });
});
