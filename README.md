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
