import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://aisaas:aisaas@localhost:5432/aisaas'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtAccessSecret: required(
    'JWT_ACCESS_SECRET',
    nodeEnv === 'production' ? undefined : 'dev-only-insecure-access-secret-change-me',
  ),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  trialDays: Number(process.env.TRIAL_DAYS ?? 14),
  // Public URL of this API as seen by company connectors (used in the downloaded connector package).
  publicApiUrl: (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, ''),
  llm: {
    // 'anthropic' | 'openrouter' | 'mock'. Default: whichever key is present (Anthropic first), else not configured.
    provider: process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'none'),
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      // Comma separated list tried in order, or "auto" / empty = pick currently available FREE models that support tools.
      model: process.env.OPENROUTER_MODEL ?? 'auto',
      // Any OpenAI-compatible endpoint works (Groq, Together, a local Ollama ...): change the base URL + key.
      baseUrl: (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
      maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 2000),
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    effort: process.env.ANTHROPIC_EFFORT ?? 'medium',
    fallbacks: process.env.ANTHROPIC_FALLBACKS !== 'off',
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 8000),
  },
  chat: {
    maxAgentSteps: Number(process.env.CHAT_MAX_STEPS ?? 6),
    maxMessagesPerConversation: Number(process.env.CHAT_MAX_MESSAGES ?? 120),
    toolResultMaxChars: Number(process.env.CHAT_TOOL_RESULT_MAX_CHARS ?? 12000),
    toolTimeoutMs: Number(process.env.CHAT_TOOL_TIMEOUT_MS ?? 30000),
    maxToolsPerConversation: Number(process.env.CHAT_MAX_TOOLS ?? 60),
    perUserPerMinute: Number(process.env.CHAT_RATE_PER_MINUTE ?? 20),
  },
  superAdmin: {
    name: process.env.SUPER_ADMIN_NAME ?? 'Super Admin',
    email: process.env.SUPER_ADMIN_EMAIL ?? '',
    password: process.env.SUPER_ADMIN_PASSWORD ?? '',
  },
};

if (env.isProd && env.jwtAccessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be at least 32 characters in production');
}
