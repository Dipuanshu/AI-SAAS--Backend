// Lists OpenRouter models that are free AND support tool calling:  npm run llm:models
import 'dotenv/config';

async function main() {
  const base = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/models`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any[] = ((await res.json()) as any).data ?? [];
  const free = data
    .filter((m) => (String(m.id).endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)) && (m.supported_parameters ?? []).includes('tools'))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
  console.log(`${free.length} free models with tool calling:\n`);
  for (const m of free) console.log(`${String(m.id).padEnd(60)} ${String(m.context_length ?? '?').padStart(8)} tokens`);
  console.log('\nPut one (or several, comma separated) in .env:  OPENROUTER_MODEL=<id>   (or leave it as "auto")');
}

main().catch((e) => {
  console.error('Could not fetch the model list:', e.message);
  process.exit(1);
});
