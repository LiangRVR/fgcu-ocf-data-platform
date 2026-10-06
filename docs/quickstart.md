# 🚀 Quick Start: Supabase Connection

## What Has Been Set Up

### ✅ Environment Configuration

- Created `.env.local` for Supabase credentials
- Configured Supabase clients for browser and server in `lib/supabase/`
- Added proxy-based session refresh for authenticated dashboard routes

### ✅ Database Schema

The repository tracks a **forward-only chain of twenty-two migrations** ending with
`supabase/migrations/20261009000001_scholarship_void_serialization.sql`. The chain
is applied in order to a fresh, disposable **local Supabase (Docker)** instance
via `supabase start` + `supabase db reset`; it must **not** be pushed to the
hosted production database (see the production freeze below).

- **11-table schema** with advisor-backed auth, applied via the Git migration chain:
  - Core tables: `student`, `advisor`, `fellowship`, `application`,
    `advising_meeting`, `fellowship_thursday`, `scholarship_history`
  - Append-only corrections: `advising_meeting_amendment`,
    `fellowship_thursday_amendment`, `scholarship_history_amendment`
  - Server-only role-change lock: `advisor_role_lock` (never exposed to clients)
  - Auth chain (migrations 1–6): `20260305000000_initial_schema.sql` →
    `20260305000001_allow_anon_read.sql` → `20260305000002_allow_anon_write.sql`
    (temporary bootstrap) → `20260317000003_advisor_auth.sql` →
    `20260317000004_active_advisor_rls.sql` →
    `20260318000001_advisor_self_activation_lockdown.sql`
  - Advising ↔ application link: `20260929000001_advising_application_link.sql`
    (application cycle, nullable advising↔application link with direct +
    composite same-student FKs, creation metadata and trigger, advising indexes)
    and `20260930000002_advising_application_fk_indexes.sql`
  - Append-only history: `20260930000003_advising_meeting_append_only.sql` and
    `20260930000004_advising_meeting_amendments.sql`
  - Lifecycle + DELETE lockdown: `20260930000005_entity_lifecycle_archiving.sql`
    → `20260930000006_core_history_delete_lockdown.sql` →
    `20260930000007_lifecycle_review_remediation.sql`
  - Explicit Admin/Advisor roles and trusted provisioning:
    `20261001000001_explicit_admin_advisor_permissions.sql` →
    `20261002000001_advisor_self_service_role_reconciliation.sql`
  - Role-change lease/fencing (legacy) then atomic role change:
    `20261003000001_advisor_role_change_lock.sql` →
    `20261004000001_advisor_role_fenced_write.sql` →
    `20261005000001_advisor_role_fenced_read.sql` →
    `20261006000001_advisor_role_display_reconcile.sql` →
    `20261007000001_atomic_advisor_role_change.sql`
  - Historical integrity remediation: `20261008000001_historical_integrity_remediation.sql`
  - Scholarship terminal-Void serialization: `20261009000001_scholarship_void_serialization.sql`
- Documented in `docs/schema-reference.md` and `supabase/SCHEMA.md` (which
  contains the full ordered migration table)

> `20261008000001_historical_integrity_remediation.sql` (the
> `2026-10-06-historical-integrity-remediation` change) makes
> `fellowship_thursday` and `scholarship_history` append-only base records and
> adds the two amendment tables above (scholarship `Void` is terminal for
> operational counts but stays in the audit history); expands the
> application pipeline to nine database-enforced stages (`Did Not Submit`,
> `Withdrawn` added), pins the finalist flags to the stage, and bounds
> `application_year` to `NULL` or `2000–2100`; and requires a conducting
> `advisor_id` on new authenticated advising meetings while preserving legacy
> `NULL` rows.
>
> `20261009000001_scholarship_void_serialization.sql` is the current final
> migration. It closes the terminal-`Void` race left by the bare `EXISTS` check
> in the preceding migration: the amendment trigger now takes an exclusive lock
> on the parent `scholarship_history` row before the guard, so concurrent
> amendments for one award serialize (the loser re-evaluates against the
> committed state and is rejected), and a partial unique index enforces at most
> one `Void` per award as a declarative backstop. Amendment tables stay
> append-only; the trigger, RLS, and effective-value views are otherwise
> unchanged.

### ✅ Live Data and Auth Features

- Dashboard overview with KPI and recent-activity queries
- Advisor account page with profile editing, password updates, advisor-scoped meetings, and a meeting-derived student roster
- Students, applications, advising, fellowship Thursday, scholarship history, and fellowships all query live Supabase data
- Advising meetings are **append-only history**; corrections are recorded as
  `advising_meeting_amendment` rows, never as edits or deletes. Fellowship
  Thursday attendance and Scholarship History awards follow the same model:
  base rows are immutable, corrections are appended as
  `fellowship_thursday_amendment` / `scholarship_history_amendment` rows, and a
  scholarship `Void` excludes an award from operational counts while keeping
  it in the audit history.
- Student/fellowship **archive** and advisor **deactivate/reactivate** flows
  (`lifecycle_transition` RPC) with preserved historical relationships
- Explicit **Admin** / **Advisor** roles (effective admin = Auth claim + active
  bound advisor), with a protected server-side provisioning path for advisor
  accounts
- Login, sign-out, forgot-password, and reset-password flows are wired to Supabase Auth

### ✅ UI, Validation, and Tooling

- FGCU design system and responsive dashboard shell
- Zod validation for login, recovery, and account flows
- Type-safe database access via `types/database.ts`
- Connection test and type-generation scripts via `pnpm`
- Unit, contract (RLS), and E2E suites that run against an isolated
  Docker-local Supabase instance with synthetic fixtures

## ⚠️ Still Required From You

### 1. Get Supabase Credentials (only needed to run the hosted app)

> Local development and the full test suite use a **Docker-local Supabase
> instance** and need no hosted project. A hosted Supabase project is only
> required when you want to run the deployed application against a real
> backend.

If you do not already have a Supabase project:

1. Go to [supabase.com](https://supabase.com) and create a project.
2. Save the database password securely.
3. Choose the region closest to your users.

Once the project is ready:

1. Open **Settings → API**.
2. Copy the **Project URL**.
3. Copy the **anon public** key.
4. Save the **Project Reference ID** from **Settings → General**.

### 2. Update Environment Variables

Replace the placeholders in `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-actual-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

For **trusted local advisor provisioning** (admin pre-binding via the
server-only provisioning module, `lib/provisioning/*`), `.env.local` also needs
two **server-only** variables:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is a **secret**: never prefix it with
> `NEXT_PUBLIC_`, never commit it, and never send it to the browser or
> client-side code. It is read only in server code (never logged, never exposed
> via `NEXT_PUBLIC_`). Without `SUPABASE_URL` and
> `SUPABASE_SERVICE_ROLE_KEY`, advisor provisioning fails fast server-side with
> a configuration error.

#### Local mapping from `pnpm exec supabase status -o env`

The full test suite and provisioning use the Docker-local stack, which needs no
hosted project. After `pnpm exec supabase start` +
`pnpm exec supabase db reset --no-seed`, capture the runtime values with
`pnpm exec supabase status -o env` and map them into `.env.local` **by hand —
copy values, never print them, never commit them**:

| `supabase status -o env` output | App variable |
| --- | --- |
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL` |
| `ANON_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |

`APP_URL=http://localhost:3000` is also required server-side (auth redirects /
recovery links); it does not come from `supabase status -o env`.

### 3. Apply Database Schema and Auth Migrations

> ⚠️ **Production freeze (2026-09-25):** the steps below describe a
> fresh/disposable setup only. Do **not** apply the repository migrations to
> the hosted **production** database while provenance is unresolved —
> production is the physical-schema authority, its migration ledger records only
> `20260924065221_advisor_self_activation_lockdown`, and the deployed schema
> materially differs from this repository chain (which tracks twenty-two
> migrations). `supabase db push`, historical replay, and migration-history
> repair against production are prohibited until a separately approved
> reconciliation exists. See
> [`supabase/SCHEMA.md`](../supabase/SCHEMA.md#migration-deployment-freeze) and
> the approval-gated
> [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

#### Method A: Local Supabase (Docker) — recommended for development and testing

This is the supported local workflow; it applies the **full twenty-two-migration
chain** to a disposable Docker instance and requires no hosted project:

```bash
# Start the local stack (first run pulls Docker images)
pnpm exec supabase start

# Apply the full migration chain to a fresh local database (no seed)
pnpm exec supabase db reset --no-seed

# Capture the local runtime URLs/keys (used by tests and db:types)
pnpm exec supabase status -o env

# When finished
pnpm exec supabase stop --no-backup
```

`supabase db reset` applies every file in `supabase/migrations/` in order,
ending with `20261009000001_scholarship_void_serialization.sql`. Migrations 2 and 3
(`allow_anon_read`, `allow_anon_write`) are temporary bootstrap steps only;
after the full chain, authenticated active advisors are the intended steady
state.

The contract and E2E test suites run the same chain automatically against a
throwaway isolated instance (`scripts/test-support/supabase-isolation.mjs`) —
the repository's own `supabase/` project is never started, reset, or stopped.

#### Method B: Supabase Dashboard (fresh, disposable hosted project only)

> ⛔ These steps target a **fresh hosted project**, never production. Run the
> SQL in order and note the required ordering of the auth chain.

1. Open **SQL Editor** in your Supabase project.
2. Run `supabase/migrations/20260305000000_initial_schema.sql`.
3. Run `supabase/migrations/20260305000001_allow_anon_read.sql` (bootstrap only).
4. Run `supabase/migrations/20260305000002_allow_anon_write.sql` (bootstrap only).
5. Run `supabase/migrations/20260317000003_advisor_auth.sql`.
6. Backfill the real FGCU advisor emails into `public.advisor.email`.
7. Run `supabase/migrations/20260317000004_active_advisor_rls.sql`.
8. Run `supabase/migrations/20260318000001_advisor_self_activation_lockdown.sql` — must run **after** step 7; the auth chain is not complete without it.
9. Run the remaining forward-only migrations in order:
   `20260929000001_advising_application_link.sql`,
   `20260930000002_advising_application_fk_indexes.sql`,
   `20260930000003_advising_meeting_append_only.sql`,
   `20260930000004_advising_meeting_amendments.sql`,
   `20260930000005_entity_lifecycle_archiving.sql`,
   `20260930000006_core_history_delete_lockdown.sql`,
   `20260930000007_lifecycle_review_remediation.sql`,
   `20261001000001_explicit_admin_advisor_permissions.sql`,
   `20261002000001_advisor_self_service_role_reconciliation.sql`,
   `20261003000001_advisor_role_change_lock.sql`,
   `20261004000001_advisor_role_fenced_write.sql`,
   `20261005000001_advisor_role_fenced_read.sql`,
   `20261006000001_advisor_role_display_reconcile.sql`,
   `20261007000001_atomic_advisor_role_change.sql`,
   `20261008000001_historical_integrity_remediation.sql`,
   and `20261009000001_scholarship_void_serialization.sql` (last).
10. **Only after the full chain is applied (steps 2–9):** provision each advisor
    before first sign-in via the server-only provisioning module
    (`lib/provisioning/*`): it invites/creates the auth account and
    conditionally binds the returned Auth UUID to the unbound
    `public.advisor` row (`auth_user_id IS NULL`); one-time bind, no email
    self-link. Use the protected `/api/advisors` endpoints (effective-Admin
    only) — the provisioning key is a server secret. For local development it
    may exist only in an uncommitted, server-side `.env.local`; never commit,
    log, or prefix it with `NEXT_PUBLIC_`, and never send it to the browser.
    Hosted environments use a server-side secret store.
11. **Bootstrap the first effective Admin out of band first** — the protected
    `/api/advisors` path requires an existing effective Admin, so a fresh
    environment cannot create its own first Admin through the application. A
    trusted FGCU IT operator does this with the **service role / Supabase
    Admin API** (never a public bootstrap endpoint, never exposing secrets):
    (a) create the Auth user for a confirmed FGCU email with
    `app_metadata: { ocf_admin: true }` and capture the returned `user.id`;
    (b) pre-bind that exact UUID to the **active** `public.advisor` row's
    `auth_user_id` (one-time bind from the trusted `service_role`/DBA session)
    and set the `Admin` display role; (c) confirm the strict-boolean claim and
    the one-time binding are in place. After the first effective Admin exists,
    every other advisor is provisioned normally via step 10.
12. Verify the first active advisor (the bootstrapped Admin) can sign in — the
    pre-bound `auth_user_id` resolves their advisor row, `is_active` is `true`,
    and the strict-boolean `ocf_admin` claim grants effective admin.

> ❗ Do **not** use `npx supabase link` + `npx supabase db push` against the
> hosted **production** project: the production migration ledger records only
> `20260924065221_advisor_self_activation_lockdown`, while this repository
> tracks twenty-two migrations ending with
> `20261009000001_scholarship_void_serialization.sql`, and the deployed schema
> differs materially. Generic `db push`, historical replay, and
> migration-history repair against production are prohibited until a separately
> approved reconciliation exists.

### 4. Generate TypeScript Types

With a local Supabase instance running, regenerate types from the local
database (no project ID needed):

```bash
pnpm run db:types
```

This runs `supabase gen types --local > types/database.ts`. For a hosted
project, the equivalent is:

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```

### 5. Test Connection

```bash
pnpm run test:connection
```

Expected result (checks the core tables):

```text
✅ Environment variables are configured
✅ Successfully connected to Supabase
✅ Table 'student' exists
✅ Table 'advisor' exists
✅ Table 'fellowship' exists
✅ Table 'application' exists
✅ Table 'advising_meeting' exists
✅ Table 'fellowship_thursday' exists
✅ Table 'scholarship_history' exists
✨ Connection Test Complete
```

### 6. Start the App and Verify Auth

```bash
pnpm dev
```

Before relying on the app day to day:

1. Sign in as an advisor.
2. Open `/dashboard/account`.
3. Verify profile updates save.
4. Verify forgot-password sends a recovery email and `/reset-password` works.

## 🔧 Troubleshooting

### Environment variables not configured

- Make sure `.env.local` contains real values, not placeholders.
- Restart your terminal or editor after updating environment variables.

### Table does not exist

- The schema migration was not applied yet.
- Re-run `pnpm exec supabase start` then `pnpm exec supabase db reset --no-seed`
  against a fresh local instance, or re-run the Step 3 migration sequence.

### Permission denied or RLS errors

- After the final RLS migration, this is expected for unauthenticated users or inactive advisors.
- A fresh environment has **no effective Admin** until the first effective
  Admin is bootstrapped out of band via the service role / Supabase Admin API
  (Method B step 11 above); the protected `/api/advisors` provisioning paths
  are effective-Admin-only by design and cannot create the first Admin.
- Confirm the advisor row is **pre-bound**: `public.advisor.auth_user_id` must already equal the sign-in user's auth UUID. Binding is admin-only and one-time; it happens before first sign-in via the server-only provisioning module, never by email match or auto-linking.
- Confirm the advisor row has `is_active = true`.
- Confirm the complete migration chain through `20261009000001_scholarship_void_serialization.sql` was applied **before** any advisor was provisioned/pre-bound.
- Confirm the chain order: `20260318000001_advisor_self_activation_lockdown.sql`
  after `20260317000004_active_advisor_rls.sql`; then
  `20260929000001_advising_application_link.sql` … `20260930000004_advising_meeting_amendments.sql`;
  then the lifecycle/DELETE-lockdown migrations
  `20260930000005`–`20260930000007`; then the Admin/Advisor migrations
  `20261001000001`–`20261002000001`; then the role-change lease/fencing
  migrations `20261003000001`–`20261006000001`; then
  `20261007000001_atomic_advisor_role_change.sql`; then
  `20261008000001_historical_integrity_remediation.sql`; and finally
  `20261009000001_scholarship_void_serialization.sql` last.

### Connection failed

- Double-check the Supabase URL and anon key.
- Remove any extra spaces or quotes.
- Confirm the Supabase project is active.

## 📚 Learn More

- [Root project README](../README.md) — project overview and institutional handoff boundary
- [Supabase Setup Guide](../supabase/README.md)
- [Schema Reference](schema-reference.md)
- [Schema Design Decisions](schema-decisions.md) — rationale plus the deferred OCF event-date / award-cycle decisions
- [Schema Verification](schema-verification.md)
- [Supabase Docs](https://supabase.com/docs)

## 🎓 What You Have Now

1. **11 database tables** — 10 business tables (students, advisors,
   fellowships, applications, advising meetings, advising amendments,
   Thursday attendance, Thursday attendance corrections, scholarship history,
   scholarship amendments) plus the server-only role-change lock table.
2. **10 sidebar destinations** — 9 for active advisors (Dashboard, My Account,
   Students, Fellowships, Applications, Advising, Fellowship Thursday,
   Scholarship History, Reports) plus the admin-only **Advisor Management** page.
3. **Advisor-backed auth** with protected dashboard routes, password recovery,
   and exactly two operational roles: `Admin` and `Advisor`.
4. **Append-only history** across advising, Fellowship Thursday, and
   Scholarship History with amendment-based corrections (and scholarship
   `Void` for wrongly recorded awards), plus an archive/deactivate lifecycle
   instead of deletion.
5. **Type-safe Supabase access** with generated database types.
6. **Operational docs** covering schema, setup, and verification.

## 🔄 What Is Not Done Yet

| Feature | Status | Notes |
| --- | --- | --- |
| Hosted/production setup | Deferred | Running the app against a hosted project, real FGCU email backfill, and email delivery verification require a live Supabase environment; the production provenance freeze also blocks applying this chain to the hosted production database until a separate reconciliation is approved |
| Server-side pagination | Not started | All pagination is currently client-side |
| Bulk actions | Not started | Multi-select and bulk operations are planned |
| Institutional deployment/SSO/backups/monitoring | Excluded | Real production-data import, university deployment/networking/domains/secrets, university SSO, institutional backups, and institutional monitoring are out of scope and remain OCF/FGCU IT responsibilities after source-code handoff (see the [root README](../README.md)) |

Implemented and covered by the local suite: advisor provisioning (server-only,
admin API + UI), CSV export for students, the reports surface (system totals,
applications by stage, finalists & awarded by fellowship/cycle, students by
class standing, advising activity by advisor, advising sessions by student /
student-application / fellowship, no-show trend, advised-without-application,
and the Fellowship Thursday → application funnel), and add/edit/delete
operations on the mutable main tables (advising meetings, Fellowship Thursday,
and Scholarship History base rows plus their amendments are append-only
history; corrections are recorded as amendment rows, and scholarship `Void`
amendments exclude an award from operational counts).

## ✨ Recommended Next Steps

1. For local work, start the Docker-local Supabase instance and run
   `pnpm run test:contract` / `pnpm run test:e2e` against the full migration chain.
2. Provision advisor auth users in a real Supabase environment (fresh project
   only; never production) once FGCU emails are confirmed.
3. Verify profile updates and password recovery end to end.
4. Build server-side pagination and bulk actions.
5. Plan a `student_advisor` table only if OCF later wants formal caseload assignment.