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
  superAdmin: {
    name: process.env.SUPER_ADMIN_NAME ?? 'Super Admin',
    email: process.env.SUPER_ADMIN_EMAIL ?? '',
    password: process.env.SUPER_ADMIN_PASSWORD ?? '',
  },
};

if (env.isProd && env.jwtAccessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be at least 32 characters in production');
}
