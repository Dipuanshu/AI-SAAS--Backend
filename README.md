# AI SaaS – Backend

Multi-tenant SaaS backend: **Node.js + Express + TypeScript + PostgreSQL**.

Companies register themselves (free trial), then their people log in by **choosing the company first, then entering credentials**.
A platform **Super Admin** manages every company, plan and subscription expiry.

## Quick start

```bash
cp .env.example .env          # then edit DATABASE_URL, JWT_ACCESS_SECRET, SUPER_ADMIN_*
npm install
npm run migrate               # creates tables + default plans (Starter / Growth / Enterprise)
npm run seed                  # creates the Super Admin from SUPER_ADMIN_EMAIL / PASSWORD
npm run dev                   # http://localhost:4000   (GET /health)
npm test                      # integration tests (needs a database named aisaas_test)
```

Local PostgreSQL in one line:
`createuser -P aisaas && createdb -O aisaas aisaas && createdb -O aisaas aisaas_test`

## AI assistant (connector + chat)

After a company registers (it tells us its backend language), the admin downloads a **connector package** from the app.
One zip works for every language: it is a small zero-dependency Node program (or Docker image) that runs next to the
company's backend, learns the API routes (OpenAPI/Swagger JSON, a Postman collection, or by watching live traffic in
*record mode*) and registers them here as **tools**. Employees then chat with the assistant; it calls those tools **as that
user** (the user signs in once with their software login; the connector keeps the token, we never store the password).

```
Company backend  <--HTTP-->  Connector (their network)  --outbound only-->  This API  <-->  Chat app / LLM
```

Safety design

* Tools are filtered per role before the model sees them, and re-checked at execution (role, enabled, delete allowed, schema).
* Anything that changes data needs the user's confirmation click; deletes are off until the admin allows them.
* The company's own backend still enforces its permissions (calls use the user's own token); sensitive fields are
  stripped by the connector (`redactFields`) and again here before anything reaches the model.
* Tool/doc output is wrapped as untrusted data; every call is written to `ai_action_logs`.
* The connector key is derived from the connector id + version (nothing secret is stored) and can be rotated.
* Each conversation freezes its system prompt and tool list, which keeps prompt caching and the models' "preserved
  thinking" rule (no history edits) intact.

Run it locally without your own backend:

```bash
node connector/examples/demo-api/server.js      # demo "company software" on :3100 (admin@demo.test / admin123 ...)
# in the app: Setup → download the connector, set BACKEND_URL=http://localhost:3100 in its .env, run `node connector.js`
```

No API key yet? `LLM_PROVIDER=mock` runs the complete flow with a tiny rule-based stand-in model.

## Roles

| Role | Scope | Can do |
|---|---|---|
| `super_admin` | platform | everything under `/api/admin/*` |
| `company_admin` | one company | manage users, company profile, audit log |
| `manager` | one company | view users |
| `employee`, `viewer` | one company | dashboard, own profile |

## Multi-tenancy & security notes

* Shared schema; every tenant row carries `company_id` and **every query is scoped by the caller's company** (covered by tests).
* Users are unique per `(company, email)` – the same email can exist in two companies.
* Passwords: bcrypt. Access token = short-lived JWT (15 min); refresh tokens are random, stored **hashed**, rotated on use, and reuse of a rotated token revokes the whole session family.
* Every request re-reads user + company from the DB, so **suspending a company / disabling a user is instant**.
* Expired subscription ⇒ business endpoints answer `402 SUBSCRIPTION_EXPIRED` (profile / subscription / dashboard stay available so the admin can see the renew screen).
* Login/register endpoints are rate limited; `helmet`, strict CORS (`CORS_ORIGINS`), JSON body limit.
* Plan seat limit (`max_users`) is enforced when creating/re-activating users.

## API overview

All errors: `{ "error": { "code": "...", "message": "..." } }`. Auth: `Authorization: Bearer <accessToken>`.

**Public**
* `GET  /api/plans`
* `POST /api/auth/register-company` `{companyName, adminName, email, password, companyPhone?, planCode?}`
* `GET  /api/auth/companies?q=` – company picker (min 2 chars, active companies only)
* `POST /api/auth/login` `{companySlug, email, password}`
* `POST /api/auth/admin/login` `{email, password}`
* `POST /api/auth/refresh` · `POST /api/auth/logout` `{refreshToken}`

**Signed in** – `GET /api/auth/me`, `POST /api/auth/change-password`

**Company** (`/api/company`) – `GET|PATCH /profile`, `GET /subscription`, `GET /dashboard`,
`GET|POST /users`, `PATCH|DELETE /users/:id`, `POST /users/:id/reset-password`, `GET /audit-logs`

**AI** – `GET|POST /api/company/ai/*` (admin: overview, connector, download-link, tools, settings, knowledge, logs) ·
`/api/chat/*` (status, conversations, message, actions/:id/confirm|cancel, connect) · `/api/connector/*` (used by the connector)

**Super Admin** (`/api/admin`)
* `GET /stats` – companies, trials, paying, expired, expiring in 7/30 days, MRR …
* `GET /companies?search=&status=all|active|trial|expired|expiring|suspended&plan=&expiringDays=&sort=&page=&limit=`
* `GET /companies/:id` · `PATCH /companies/:id` · `GET /companies/:id/users`
* `POST /companies/:id/subscription` `{planCode, kind, billingCycle, durationDays|expiresAt, amount?, carryOverRemaining?, notes?}`
* `POST /companies/:id/extend` `{days}` · `POST /companies/:id/suspend` `{reason?}` · `POST /companies/:id/activate`
* `DELETE /companies/:id` `{confirmSlug}`
* `GET|POST /plans` · `PATCH /plans/:id` · `GET /audit-logs`

## Production checklist

* Set a strong `JWT_ACCESS_SECRET` (≥ 32 chars), `NODE_ENV=production`, `DATABASE_SSL=true` for managed Postgres, and exact `CORS_ORIGINS`.
* `npm run build && npm start` (migrations run automatically on boot).
* Put it behind HTTPS (the app trusts one proxy hop in production).
