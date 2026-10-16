-- Core schema: plans, companies, subscriptions, users, sessions, audit log.
-- Multi-tenancy: shared schema, every tenant row carries company_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  price_monthly   numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  price_yearly    numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_yearly >= 0),
  currency        text NOT NULL DEFAULT 'INR',
  max_users       integer NOT NULL DEFAULT 5 CHECK (max_users > 0),
  features        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  email       citext NOT NULL,
  phone       text,
  address     text,
  website     text,
  logo_url    text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_reason text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_name_idx ON companies (lower(name));
CREATE INDEX companies_status_idx ON companies (status);

-- One row per subscription period; the newest row is the "current" one.
CREATE TABLE subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES plans(id),
  kind           text NOT NULL DEFAULT 'paid' CHECK (kind IN ('trial', 'paid', 'complimentary')),
  billing_cycle  text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly', 'custom')),
  starts_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  amount         numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at)
);
CREATE INDEX subscriptions_company_idx ON subscriptions (company_id, created_at DESC);
CREATE INDEX subscriptions_expiry_idx ON subscriptions (expires_at);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE, -- NULL = platform (super admin)
  name           text NOT NULL,
  email          citext NOT NULL,
  phone          text,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('super_admin', 'company_admin', 'manager', 'employee', 'viewer')),
  job_title      text,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (company_id IS NULL))
);
-- Same email may exist in different companies, but only once per company.
CREATE UNIQUE INDEX users_company_email_uq ON users (company_id, email) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX users_platform_email_uq ON users (email) WHERE company_id IS NULL;
CREATE INDEX users_company_idx ON users (company_id);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_company_idx ON audit_logs (company_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
