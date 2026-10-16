import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env';
import { HttpError } from '../../../utils/httpError';
import { Llm, LlmRequest, LlmResponse } from './types';

// Models for which the server-side refusal fallback is available (see Anthropic docs: refusals and fallback).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function createAnthropicLlm(): Llm {
  const client = new Anthropic({ apiKey: env.llm.anthropicApiKey });
  const model = env.llm.model;
  let useFallbacks = env.llm.fallbacks && FALLBACK_MODELS.has(model);

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      // NOTE: no `thinking`, `temperature` or forced `tool_choice` are sent: current models run adaptive thinking
      // by default and reject those parameters. `system` and `tools` are frozen per conversation by the caller so the
      // prefix stays byte-identical across turns (prompt caching + preserved thinking).
      const params: any = {
        model,
        max_tokens: env.llm.maxTokens,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: env.llm.effort },
      };
      const call = (withFallbacks: boolean) =>
        withFallbacks
          ? (client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }) as Promise<any>)
          : (client.messages.create(params) as Promise<any>);

      let res: any;
      try {
        res = await call(useFallbacks);
      } catch (e) {
        if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
          useFallbacks = false; // this account/platform does not accept the fallback parameter: continue without it
          res = await call(false);
        } else if (e instanceof Anthropic.APIError) {
          console.error('Anthropic API error', e.status, e.message);
          throw new HttpError(e.status === 429 ? 429 : 502, 'LLM_ERROR', e.status === 429 ? 'The AI service is busy. Please try again in a moment.' : 'The AI service is unavailable right now. Please try again.');
        } else {
          throw e;
        }
      }

      if (res.stop_reason === 'refusal') {
        return { content: [{ type: 'text', text: 'I can’t help with that request.' }], stopReason: 'refusal' };
      }
      return { content: res.content as any[], stopReason: res.stop_reason ?? 'end_turn' };
    },
  };
}
