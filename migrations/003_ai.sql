-- AI layer: connector (installed at the company), discovered API tools, knowledge base, chat, confirmations, logs.

ALTER TABLE companies ADD COLUMN backend_stack text;

CREATE TABLE ai_settings (
  company_id    uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  about         text NOT NULL DEFAULT '',
  allow_delete  boolean NOT NULL DEFAULT false,
  redact_fields text[] NOT NULL DEFAULT ARRAY['password','passwordhash','password_hash','token','accesstoken','refreshtoken','secret','apikey','api_key','otp'],
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One connector per company. Its secret key is derived from (id, key_version), never stored.
CREATE TABLE connectors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  key_version   integer NOT NULL DEFAULT 1,
  auth_mode     text NOT NULL DEFAULT 'none' CHECK (auth_mode IN ('none', 'static', 'login')),
  version       text,
  hostname      text,
  spec_source   text,
  last_seen_at  timestamptz,
  last_sync_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tools (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connector_id       uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  name               text NOT NULL,
  method             text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path               text NOT NULL,
  operation_id       text,
  summary            text NOT NULL DEFAULT '',
  description        text NOT NULL DEFAULT '',
  custom_description text,
  tags               text[] NOT NULL DEFAULT '{}',
  input_schema       jsonb NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
  param_map          jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_body           boolean NOT NULL DEFAULT false,
  risk               text NOT NULL CHECK (risk IN ('read', 'write', 'delete')),
  enabled            boolean NOT NULL DEFAULT false,
  allowed_roles      text[] NOT NULL DEFAULT ARRAY['company_admin','manager','employee','viewer'],
  source             text NOT NULL DEFAULT 'openapi' CHECK (source IN ('openapi', 'postman', 'recorded', 'manual')),
  stale              boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, method, path),
  UNIQUE (company_id, name)
);
CREATE INDEX api_tools_company_idx ON api_tools (company_id);

-- Work queue between the SaaS and the connector (the connector only makes outbound calls).
CREATE TABLE connector_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connector_id  uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('call', 'login', 'logout')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'expired')),
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX connector_jobs_queue_idx ON connector_jobs (connector_id, status, created_at);

-- Which users connected their own login of the company's software (tokens live only inside the connector).
CREATE TABLE user_software_links (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connected_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title       text NOT NULL,
  content     text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content)) STORED
);
CREATE INDEX knowledge_docs_company_idx ON knowledge_docs (company_id);
CREATE INDEX knowledge_docs_tsv_idx ON knowledge_docs USING gin (tsv);

CREATE TABLE chat_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'New chat',
  -- Frozen at the first message so every later request is byte-identical (prompt caching + preserved thinking).
  system_prompt text NOT NULL,
  tools         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_map      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_user_idx ON chat_conversations (user_id, updated_at DESC);

CREATE TABLE chat_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         jsonb NOT NULL,          -- exactly what is sent to / received from the model
  display_text    text,                    -- what the user typed (content may carry extra context)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, id);

CREATE TABLE pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  tool_id         uuid REFERENCES api_tools(id) ON DELETE SET NULL,
  tool_use_id     text NOT NULL,
  tool_name       text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary         text NOT NULL DEFAULT '',
  turn_results    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled', 'expired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX pending_actions_conv_idx ON pending_actions (conversation_id, status);

CREATE TABLE ai_action_logs (
  id              bigserial PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id uuid,
  tool_name       text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  args_summary    text NOT NULL DEFAULT '',
  status          text NOT NULL,
  http_status     integer,
  duration_ms     integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_action_logs_company_idx ON ai_action_logs (company_id, id DESC);
