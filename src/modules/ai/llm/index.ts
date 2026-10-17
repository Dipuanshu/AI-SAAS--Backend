import { env } from '../../../config/env';
import { HttpError } from '../../../utils/httpError';
import { createAnthropicLlm } from './anthropic';
import { createMockLlm } from './mock';
import { createOpenRouterLlm } from './openrouter';
import { Llm } from './types';

let instance: Llm | null = null;

export function getLlm(): Llm {
  if (instance) return instance;
  if (env.llm.provider === 'anthropic' && env.llm.anthropicApiKey) instance = createAnthropicLlm();
  else if (env.llm.provider === 'openrouter' && env.llm.openrouter.apiKey) instance = createOpenRouterLlm();
  else if (env.llm.provider === 'mock') instance = createMockLlm();
  else {
    throw new HttpError(503, 'LLM_NOT_CONFIGURED', 'The AI model is not configured on the server yet. Ask the platform owner to set ANTHROPIC_API_KEY (or OPENROUTER_API_KEY).');
  }
  return instance;
}

/** For tests: forget the cached client so a different provider can be selected. */
export const resetLlm = () => {
  instance = null;
};

export function llmStatus() {
  const p = env.llm.provider;
  const configured = (p === 'anthropic' && !!env.llm.anthropicApiKey) || (p === 'openrouter' && !!env.llm.openrouter.apiKey) || p === 'mock';
  const model = p === 'anthropic' ? env.llm.model : p === 'openrouter' ? (env.llm.openrouter.model === 'auto' ? 'auto (free models)' : env.llm.openrouter.model) : p === 'mock' ? 'mock' : null;
  return { configured, provider: configured ? p : 'none', model };
}
