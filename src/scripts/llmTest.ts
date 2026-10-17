// Checks that the configured AI provider/key/model works and can call tools:  npm run llm:test
import 'dotenv/config';
import { env } from '../config/env';
import { llmStatus, getLlm } from '../modules/ai/llm';

async function main() {
  const st = llmStatus();
  console.log('Provider:', st.provider, '| model:', st.model);
  if (!st.configured) {
    console.error('Not configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (or LLM_PROVIDER=mock) in .env');
    process.exit(1);
  }
  if (st.provider === 'openrouter') {
    // Tells apart "the key is wrong" from "this model is busy": OpenRouter can describe the key itself.
    try {
      const r = await fetch(`${env.llm.openrouter.baseUrl}/auth/key`, { headers: { Authorization: `Bearer ${env.llm.openrouter.apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (r.status === 401) {
        console.error('\n✗ OpenRouter says this API key is INVALID (deleted, revoked or mistyped).\n  Create a new key at https://openrouter.ai/keys and put it in .env, then run this again.');
        process.exit(1);
      }
      if (r.ok) {
        const k: any = ((await r.json()) as any).data ?? {};
        console.log(`✓ Key is valid${k.label ? ` (${k.label})` : ''} | free tier: ${k.is_free_tier ?? '?'} | used: ${k.usage ?? '?'} | limit: ${k.limit ?? 'none'}`);
      } else {
        console.log(`(could not check the key: HTTP ${r.status})`);
      }
    } catch (e: any) {
      console.log(`(could not reach ${env.llm.openrouter.baseUrl}: ${e.message})`);
    }
  }
  const llm = getLlm();
  const tools = [{ name: 'get_weather', description: 'Get the current weather of a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const system = 'You are a helpful assistant. Use the tools when needed.';

  console.log('\n1) asking: "What is the weather in Pune?"');
  const first = await llm.complete({ system, tools, messages: [{ role: 'user', content: 'What is the weather in Pune?' }] });
  const use = first.content.find((b) => b.type === 'tool_use');
  if (!use) {
    console.log('   The model answered without calling the tool:', JSON.stringify(first.content).slice(0, 200));
    console.log('   (Works, but this model is weak at tool calling. Try another one with: npm run llm:models)');
    return;
  }
  console.log('   ✓ tool call:', use.name, JSON.stringify(use.input));

  console.log('2) sending the tool result back');
  const second = await llm.complete({
    system, tools,
    messages: [
      { role: 'user', content: 'What is the weather in Pune?' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '{"temp_c": 29, "sky": "clear"}' }] },
    ],
  });
  console.log('   ✓ answer:', second.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 300));
  console.log('\nAll good: this provider can run the assistant.');
}

main().catch((e) => {
  console.error('\nFailed:', e.message ?? e);
  process.exit(1);
});
