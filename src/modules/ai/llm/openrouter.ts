import { env } from '../../../config/env';
import { HttpError } from '../../../utils/httpError';
import { Block, Llm, LlmMessage, LlmRequest, LlmResponse, LlmTool } from './types';

/**
 * Adapter for OpenRouter (https://openrouter.ai) and any other OpenAI-compatible chat API.
 * Conversations are stored in Anthropic's block format; this file translates to/from the OpenAI chat format
 * (system / user / assistant{tool_calls} / tool) so the rest of the app does not care which provider is used.
 */

// Used only when the live model list cannot be fetched. Free models change often: prefer OPENROUTER_MODEL=auto.
const STATIC_FALLBACK = ['openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b-instruct:free', 'mistralai/mistral-small-3.2-24b-instruct:free'];
// Families that are reliable at function calling go first when auto-picking.
const PREFERRED = [/gpt-oss/, /llama-3\.3/, /qwen/, /deepseek/, /mistral/, /gemini/, /glm/, /kimi/, /gemma/];

// ------------------------------------------------------------------------------------------------ translation
/** Some providers reject `type: ["string","null"]`; collapse to the first non-null type. */
export function simplifySchema(node: any): any {
  if (Array.isArray(node)) return node.map(simplifySchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) out[k] = simplifySchema(v);
  if (Array.isArray(out.type)) out.type = out.type.find((t: string) => t !== 'null') ?? 'string';
  return out;
}

export const toOpenAiTools = (tools: LlmTool[]) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: simplifySchema(t.input_schema) } }));

const textOf = (blocks: Block[]) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const asString = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? textOf(c as Block[]) : JSON.stringify(c ?? ''));

export function toOpenAiMessages(system: string, messages: LlmMessage[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const text = textOf(m.content);
      // thinking / other provider-specific blocks are dropped: other providers cannot read them
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become `tool` messages, normal text stays a user message
    for (const b of m.content.filter((x) => x.type === 'tool_result')) {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: asString(b.content) + (b.is_error ? '\n(This call failed.)' : '') });
    }
    const text = textOf(m.content);
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

export function fromOpenAiMessage(msg: any, finish: string | undefined): LlmResponse {
  const content: Block[] = [];
  const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => p?.text ?? '').join('') : '';
  if (text.trim()) content.push({ type: 'text', text: text.trim() });
  let n = 0;
  for (const c of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      const parsed = typeof c.function?.arguments === 'string' && c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {};
      if (parsed && typeof parsed === 'object') input = parsed;
    } catch {
      /* invalid JSON from the model: the missing-argument check will tell it to retry */
    }
    content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${n++}`, name: c.function?.name ?? '', input });
  }
  if (!content.length) content.push({ type: 'text', text: 'I could not produce an answer. Please try again.' });
  return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn' };
}

// ------------------------------------------------------------------------------------------------ model selection
let discovered: { at: number; ids: string[] } | null = null;

async function discoverFreeModels(): Promise<string[]> {
  if (discovered && Date.now() - discovered.at < 3_600_000) return discovered.ids;
  try {
    const res = await fetch(`${env.llm.openrouter.baseUrl}/models`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any[] = ((await res.json()) as any).data ?? [];
    const usable = data.filter((m) => {
      const free = String(m.id).endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
      return free && (m.supported_parameters ?? []).includes('tools') && (m.context_length ?? 0) >= 8000;
    });
    const rank = (id: string) => {
      const i = PREFERRED.findIndex((re) => re.test(id));
      return i < 0 ? PREFERRED.length : i;
    };
    usable.sort((a, b) => rank(a.id) - rank(b.id) || (b.context_length ?? 0) - (a.context_length ?? 0));
    const ids = usable.map((m) => m.id as string).slice(0, 6);
    if (ids.length) {
      discovered = { at: Date.now(), ids };
      return ids;
    }
  } catch (e) {
    console.warn('OpenRouter model discovery failed, using the built-in list:', (e as Error).message);
  }
  return STATIC_FALLBACK;
}

export async function candidateModels(): Promise<string[]> {
  const configured = env.llm.openrouter.model.trim();
  if (configured && configured !== 'auto') return configured.split(',').map((s) => s.trim()).filter(Boolean);
  return discoverFreeModels();
}

export const resetModelCache = () => {
  discovered = null;
};

// ------------------------------------------------------------------------------------------------ the client
class RetryNext extends Error {}

async function callOnce(model: string, body: Record<string, unknown>): Promise<LlmResponse> {
  const res = await fetch(`${env.llm.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.llm.openrouter.apiKey}`,
      'HTTP-Referer': 'https://github.com/ai-saas',
      'X-Title': 'AI SaaS assistant',
    },
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(90_000),
  });
  const json: any = await res.json().catch(() => ({}));
  const apiError: string | null = json?.error?.message ?? (res.ok ? null : `HTTP ${res.status}`);
  // OpenRouter often puts the real upstream reason in error.metadata.raw ("Provider returned error" alone says little)
  const raw = json?.error?.metadata?.raw ? ` - ${String(typeof json.error.metadata.raw === 'string' ? json.error.metadata.raw : JSON.stringify(json.error.metadata.raw)).slice(0, 240)}` : '';
  const code = Number(json?.error?.code) || res.status;
  const detail = `${apiError ?? 'empty response'}${raw}`;

  // Only 401 means the key itself is wrong. 403 / 404 / 429 / 5xx are usually about THIS model (privacy settings,
  // moderation, no tool support, rate limit, upstream outage): another model may still work.
  if (code === 401) {
    throw new HttpError(502, 'LLM_AUTH', `The AI provider rejected the API key (${apiError}). Check the key in .env (OPENROUTER_API_KEY or OPENAI_API_KEY); create a new one at https://openrouter.ai/keys if needed.`);
  }
  if (!res.ok || json?.error || !json?.choices?.[0]) {
    console.warn(`LLM model ${model} failed (HTTP ${res.status}${code !== res.status ? `, code ${code}` : ''}): ${detail}`);
    const e = new RetryNext(detail);
    (e as any).status = code;
    throw e;
  }
  return fromOpenAiMessage(json.choices[0].message, json.choices[0].finish_reason);
}

export function createOpenRouterLlm(): Llm {
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        messages: toOpenAiMessages(req.system, req.messages),
        max_tokens: env.llm.openrouter.maxTokens,
        ...(req.tools.length ? { tools: toOpenAiTools(req.tools), tool_choice: 'auto' } : {}),
      };
      const models = await candidateModels();
      let lastStatus = 0;
      let lastError = '';
      for (const model of models) {
        try {
          return await callOnce(model, body);
        } catch (e) {
          if (!(e instanceof RetryNext)) {
            if (e instanceof HttpError) throw e;
            lastError = (e as Error).message; // network / timeout
            continue;
          }
          lastStatus = (e as any).status;
          lastError = e.message;
        }
      }
      resetModelCache(); // the list may be stale: look again next time
      if (lastStatus === 429) throw new HttpError(429, 'LLM_BUSY', 'The free AI models are busy or you hit the daily free limit. Please try again in a minute.');
      throw new HttpError(502, 'LLM_ERROR', `The AI service could not answer (${(lastStatus ? `HTTP ${lastStatus}: ` : '') + (lastError.slice(0, 200) || 'no model available')}). Please try again.`);
    },
  };
}
