import { env } from '../../../config/env';
import { HttpError } from '../../../utils/httpError';
import { createAnthropicLlm } from './anthropic';
import { createMockLlm } from './mock';
import { Llm } from './types';

let instance: Llm | null = null;

export function getLlm(): Llm {
  if (instance) return instance;
  if (env.llm.provider === 'anthropic' && env.llm.anthropicApiKey) instance = createAnthropicLlm();
  else if (env.llm.provider === 'mock') instance = createMockLlm();
  else {
    throw new HttpError(503, 'LLM_NOT_CONFIGURED', 'The AI model is not configured on the server yet. Ask the platform owner to set ANTHROPIC_API_KEY.');
  }
  return instance;
}

export function llmStatus() {
  const configured = (env.llm.provider === 'anthropic' && !!env.llm.anthropicApiKey) || env.llm.provider === 'mock';
  return { configured, provider: configured ? env.llm.provider : 'none', model: env.llm.provider === 'anthropic' ? env.llm.model : env.llm.provider === 'mock' ? 'mock' : null };
}
