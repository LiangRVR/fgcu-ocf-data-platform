# Supabase Setup Guide

## Prerequisites

1. Create a Supabase account at [supabase.com](https://supabase.com)
2. Create a new project in Supabase (only needed to run the hosted app)
3. Note your project's:
   - Project URL (Settings → API → Project URL)
   - Anon/Public Key (Settings → API → Project API keys → anon public)
   - Project ID (Settings → General → Reference ID)

> Local development and the full test suite use a **Docker-local Supabase
> instance** (see [Local workflow](#local-workflow-docker-recommended)) and
> need no hosted project.

## Step 1: Configure Environment Variables

1. Update `.env.local` with your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

1. For **trusted advisor provisioning** (the admin pre-binding path below),
   `.env.local` also needs two **server-only** variables:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is the service-role secret. It must **never**
> be prefixed with `NEXT_PUBLIC_`, committed, or exposed to the browser or
> client-side code. It is consumed only by server code
> (`lib/provisioning/*`, via `createProvisioningClient`) and is never logged.
> Missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` makes provisioning fail
> fast server-side with a configuration error.

#### Local mapping from `pnpm exec supabase status -o env`

For the Docker-local workflow (recommended), the runtime values come from the
local stack. After `pnpm exec supabase start` and
`pnpm exec supabase db reset --no-seed`, run `pnpm exec supabase status -o env`
and copy the values into `.env.local` **by hand — never print, paste, or commit
them**:

| `supabase status -o env` output | App variable |
| --- | --- |
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL` |
| `ANON_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |

`APP_URL=http://localhost:3000` (server-side, for auth redirects/recovery
links) is also required and does not come from `supabase status -o env`.

1. Restart your development server after updating environment variables.

## Step 2: Apply Database Schema

> ⚠️ **Production freeze (2026-09-25):** these steps describe a
> fresh/disposable setup only. Do **not** apply the repository migrations to
> the hosted **production** database while provenance is unresolved —
> production is the physical-schema authority, its migration ledger records
> only `20260924065221_advisor_self_activation_lockdown`, and the deployed
> schema materially differs from this repository chain (which tracks **twenty-two**
> forward-only migrations ending with
> `20261009000001_scholarship_void_serialization.sql`). See
> [SCHEMA.md — Migration deployment freeze](./SCHEMA.md#migration-deployment-freeze)
> and the approval-gated
> [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

### Advisor identity binding: admin pre-binding, not email self-link

Identity binding is **admin-only**. A person becomes an advisor through a
server-only provisioning path — never by signing in with an email that happens
to match `public.advisor.email`.

- An administrator provisions each advisor **before first sign-in** using the
  server-only provisioning module (`lib/provisioning/*`, executed server-side
  with `SUPABASE_SERVICE_ROLE_KEY`). That key is a secret: for local
  development it may exist only in an uncommitted, server-side `.env.local`;
  it must never be committed, logged, prefixed with `NEXT_PUBLIC_`, or sent to
  the browser. Hosted environments keep it in a server-side secret store, never
  in client or shared configuration.
- The module creates/invites the auth account via the Supabase Admin API
  (`inviteUserByEmail` or `createUser`), captures the returned `data.user.id`,
  and conditionally binds that exact UUID to the chosen `public.advisor` row
  **only while the row is still unbound** (`auth_user_id IS NULL`), so a
  duplicate or retry can never re-bind an already-bound row.
- `advisor.auth_user_id` is **one-time bind**: a non-NULL value may be created
  (INSERT) or set (UPDATE NULL → non-NULL) only by a trusted
  `service_role`/DBA session, and it can never be replaced, re-bound, or
  cleared afterwards. There is no `link_current_advisor` RPC, no email
  self-link, and no self-service fallback — an unbound, email-matched account
  reads zero advisor rows by design.
- Provisioning is sequenced **after** the complete migration chain: apply the
  full chain through `20261009000001_scholarship_void_serialization.sql` first —
  the lockdown migration (`20260318000001_advisor_self_activation_lockdown.sql`)
  removes the remaining email self-link write path and installs the
  one-time-bind guard under which the trusted `service_role` bind is written.
  Never provision or pre-bind an advisor before the lockdown migration is
  applied.

### Bootstrap the first effective Admin (trusted operator, out of band)

There is **no public bootstrap endpoint** and **no self-service path** to
create the first effective Admin: the protected provisioning API (`/api/advisors`)
is effective-Admin-only, so a fresh project has no way to create its own first
Admin through the application. The first effective Admin is bootstrapped **out
of band** by a trusted FGCU IT operator using the **service role / Supabase
Admin API** — never a public endpoint, and never with service credentials
exposed, committed, or logged.

Steps (after the complete migration chain through
`20261009000001_scholarship_void_serialization.sql` is applied):

1. Confirm the confirmed FGCU advisor email is present on an **active**
   `public.advisor` row (`is_active = true`).
2. Via the Supabase Admin API (service-role client), create the Auth user for
   that email with `app_metadata: { ocf_admin: true }` and capture the returned
   `user.id`. (`app_metadata.ocf_admin` is the authoritative, immutable
   effective-Admin claim; `public.is_ocf_admin()` requires a JSON **boolean**
   `true`.)
3. From the trusted `service_role`/DBA session, **pre-bind** that exact UUID to
   the advisor row's `auth_user_id` (one-time bind — the row must be unbound
   `auth_user_id IS NULL` — and never rebound, replaced, or cleared) and set
   the matching `Admin` display role.
4. Verify the first Admin can sign in: the pre-bound UUID resolves the active
   advisor row, `is_active` is `true`, and the strict-boolean `ocf_admin`
   claim grants effective admin (`public.is_effective_admin()`).

After the first effective Admin exists, **regular protected provisioning
applies**: create/invite and bind every subsequent advisor through the
server-only provisioning module and the effective-Admin-only `/api/advisors`
endpoints. Bootstrap credentials are a one-time trusted-operator operation and
are never a part of the running application.

### Local workflow (Docker) — recommended

This is the supported local development/testing workflow. It applies the full
**twenty-two-migration** chain to a disposable Docker-local instance and requires
no hosted project:

```bash
# Start the local stack (first run pulls Docker images)
pnpm exec supabase start

# Apply the full migration chain to a fresh local database (no seed)
pnpm exec supabase db reset --no-seed

# Capture the local runtime URLs/keys (used by tests and db:types)
pnpm exec supabase status -o env

# Stop the stack when finished
pnpm exec supabase stop --no-backup
```

`supabase db reset` applies every file in `supabase/migrations/` in order,
ending with `20261009000001_scholarship_void_serialization.sql`. The contract and
E2E suites run the same chain automatically against a throwaway isolated
instance (`scripts/test-support/supabase-isolation.mjs`) and never touch the
repository's own `supabase/` project.

### Option A: Using Supabase Dashboard (fresh, disposable hosted project only)

> ⛔ These steps target a **fresh hosted project**, never production. Run the
> SQL in order and respect the auth-chain ordering.

1. Log in to your Supabase project dashboard
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `supabase/migrations/20260305000000_initial_schema.sql`
5. Paste into the SQL Editor
6. Click **Run** to execute the migration
7. Verify tables are created in **Table Editor**
8. Repeat steps 3–6 for `supabase/migrations/20260305000001_allow_anon_read.sql` — temporary bootstrap read access for local development
9. Repeat steps 3–6 for `supabase/migrations/20260305000002_allow_anon_write.sql` — temporary bootstrap write access for local development
10. Repeat steps 3–6 for `supabase/migrations/20260317000003_advisor_auth.sql` — adds advisor auth columns and helper function
11. Backfill confirmed FGCU emails into `public.advisor.email` for any existing advisor rows before finalizing advisor auth on a populated database
12. Repeat steps 3–6 for `supabase/migrations/20260317000004_active_advisor_rls.sql` — removes anon access and enables authenticated active-advisor policies
13. **Required auth-chain step:** repeat steps 3–6 for `supabase/migrations/20260318000001_advisor_self_activation_lockdown.sql` — removes the email self-link escalation path, adds the one-time-bind guard and the active-staff-only update policy. It must run **after** `20260317000004_active_advisor_rls.sql`; the auth chain is not complete without it.
14. Repeat steps 3–6 for `supabase/migrations/20260929000001_advising_application_link.sql` — forward-only, additive: adds the nullable `application.application_year` cycle, the nullable `advising_meeting.application_id` advising↔application link (with direct and composite same-student FKs), the database-authored `created_at`/`created_by_advisor_id` creation metadata and hardened trigger, and advising indexes. Historic NULL values are preserved.
15. Repeat steps 3–6 for `supabase/migrations/20260930000002_advising_application_fk_indexes.sql` — adds the reverse composite-FK index on `(application_id, student_id)` and the creator index on `created_by_advisor_id`.
16. Repeat steps 3–6 for `supabase/migrations/20260930000003_advising_meeting_append_only.sql` — enforces database RLS append-only history: active advisors can `SELECT` and `INSERT` advising meetings, while `UPDATE` and `DELETE` are denied without an admin bypass.
17. Repeat steps 3–6 for `supabase/migrations/20260930000004_advising_meeting_amendments.sql` — append-only correction records for advising meetings (SELECT/INSERT only, database-authored creator/timestamp, trim-aware non-empty `reason`/`details` CHECKs).
18. Repeat steps 3–6 for `supabase/migrations/20260930000005_entity_lifecycle_archiving.sql` — non-destructive lifecycle: `student.archived_at` / `fellowship.archived_at`, admin-only `lifecycle_transition` RPC, `is_ocf_admin()`, direct-write guards; `advisor.is_active` stays the sole advisor lifecycle field.
19. Repeat steps 3–6 for `supabase/migrations/20260930000006_core_history_delete_lockdown.sql` — revokes authenticated DELETE on `advisor`/`student`/`fellowship`/`application` (grant + RLS); authenticated DELETE retained only on `fellowship_thursday`/`scholarship_history`.
20. Repeat steps 3–6 for `supabase/migrations/20260930000007_lifecycle_review_remediation.sql` — lifecycle RPC requires a current ACTIVE bound advisor; archive-parent child boundary rejects new child records referencing archived students/fellowships.
21. Repeat steps 3–6 for `supabase/migrations/20261001000001_explicit_admin_advisor_permissions.sql` — normalizes `advisor.role` to exactly `Admin`/`Advisor`, hardens `is_ocf_admin()` to a strict JSON-boolean claim, adds `is_effective_admin()`, denies direct authenticated role writes.
22. Repeat steps 3–6 for `supabase/migrations/20261002000001_advisor_self_service_role_reconciliation.sql` — self-scoped `advisor_update_own_profile` UPDATE only, no authenticated advisor-row creation, display role reconciled to the Auth claim.
23. Repeat steps 3–6 for `supabase/migrations/20261003000001_advisor_role_change_lock.sql`, `20261004000001_advisor_role_fenced_write.sql`, `20261005000001_advisor_role_fenced_read.sql`, and `20261006000001_advisor_role_display_reconcile.sql` — server-only per-advisor role-change lease + fenced write/read (legacy primitives retained).
24. Repeat steps 3–6 for `supabase/migrations/20261007000001_atomic_advisor_role_change.sql` — `set_advisor_role` (service-role-only SECURITY DEFINER RPC) updates the Auth claim and the display role in one transaction.
25. Repeat steps 3–6 for `supabase/migrations/20261008000001_historical_integrity_remediation.sql` — makes `fellowship_thursday`/`scholarship_history` append-only base records plus their amendment tables and effective views, expands the application pipeline to nine database-enforced stages with the stage/flag and `application_year` checks, and requires a conducting `advisor_id` on new authenticated advising meetings while preserving legacy `NULL` rows.
26. Repeat steps 3–6 for `supabase/migrations/20261009000001_scholarship_void_serialization.sql` — **final migration**: serializes concurrent scholarship amendments for one award by taking an exclusive lock on the parent `scholarship_history` row before the terminal-`Void` `EXISTS` guard (the loser re-evaluates against the committed state and is rejected) and adds a partial unique index enforcing at most one `Void` per award; the append-only tables, trigger grants, RLS, and effective views are otherwise unchanged.
27. **Only after the complete migration chain is applied (through step 26):** provision each advisor via the admin pre-binding path (see [Advisor identity binding](#advisor-identity-binding-admin-pre-binding-not-email-self-link) above) — never create auth users to "self-link" by email. Use the protected `/api/advisors` endpoints (effective-Admin only). Because those endpoints require an existing effective Admin, **first** bootstrap the first effective Admin out of band (see [Bootstrap the first effective Admin](#bootstrap-the-first-effective-admin-trusted-operator-out-of-band)), then provision every other advisor normally.
28. Verify the first active advisor (the bootstrapped Admin) can sign in — the pre-bound `auth_user_id` resolves their advisor row, `is_active` is `true`, and the strict-boolean `ocf_admin` claim grants effective admin.

Migrations `20260305000001_allow_anon_read.sql` and
`20260305000002_allow_anon_write.sql` are temporary bootstrap steps. After the
full chain ending with `20261009000001_scholarship_void_serialization.sql`,
bootstrap anon access is no longer the intended steady state. Operational
access comes only from authenticated active advisors, `advisor.auth_user_id`
binding is admin-only, and advising history is append-only (meetings and
amendments are SELECT/INSERT-only).

### Option B: Supabase CLI against a hosted project (fresh/disposable only)

> ⛔ `supabase link` + `supabase db push` must **not** be run against the
> hosted **production** project. The production migration ledger records only
> `20260924065221_advisor_self_activation_lockdown`, while this repository
> tracks twenty-two migrations ending with
> `20261009000001_scholarship_void_serialization.sql`, and the deployed schema
> differs materially. Generic `db push`, historical replay, and
> migration-history repair against production are prohibited until a separately
> approved reconciliation exists. See the
> [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

For a fresh, disposable hosted project only, the CLI can apply the chain:

```bash
# Link to your fresh project (one time)
npx supabase link --project-ref <your-project-id>

# Push all migrations to the fresh project
npx supabase db push
```

The local Docker workflow above (`supabase start` + `supabase db reset`) is the
preferred path for development and testing; the CLI push path exists for
provisioning a fresh hosted project.

## Step 3: Generate TypeScript Types

> The repository migration chain now contains **twenty-two** migrations and ends
> with `20261009000001_scholarship_void_serialization.sql`.

After applying the schema, generate TypeScript types for type-safe database access:

### Method 1: Local instance (Recommended)

With the Docker-local instance running:

```bash
pnpm run db:types
```

This runs `supabase gen types --local > types/database.ts` and needs no project
ID.

### Method 2: Hosted project (project ID)

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```

### Method 3: Using Database URL

If you prefer to use a direct database connection:

```bash
npx supabase gen types typescript --db-url "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" > types/database.ts
```

Find your database URL in: Settings → Database → Connection string (URI)

## Step 4: Verify Connection

Run the connection test:

```bash
pnpm run test:connection
```

This will verify:

- Environment variables are set correctly
- Connection to Supabase is successful
- Core database tables are accessible

## Step 5: Add Sample Data (Optional)

To add sample data for testing:

1. Navigate to **Table Editor** in Supabase dashboard (or use the Docker-local instance)
2. Select a table (e.g., `student`)
3. Click **Insert row** → **Insert manually**
4. Fill in the required fields
5. Click **Save**

Or create a seed script for automated sample data insertion. (The repository
intentionally ships no `seed.sql`; contract/E2E lanes create their own
synthetic fixtures.)

## Database Schema

See [SCHEMA.md](./SCHEMA.md) for detailed documentation about:

- Table structures
- Relationships
- Indexes
- Row Level Security policies
- Sample queries

## Troubleshooting

### Types generation fails

1. For `pnpm run db:types`, ensure the Docker-local instance is running
   (`pnpm exec supabase start`) and the schema is applied
2. For a hosted project, verify your project ID is correct: `npx supabase projects list`
3. Make sure you're logged in: `npx supabase login`

### Connection issues

1. Double-check environment variables in `.env.local`
2. Ensure there are no extra spaces or quotes around values
3. Restart the development server: `pnpm dev`
4. Check Supabase project status in the dashboard

### RLS Policies blocking access

If you're getting permission errors:

1. Review the RLS policies in the schema (`supabase/SCHEMA.md`). Keep RLS
   **enabled** on every table — never run
   `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, even for local testing, as it
   would expose student PII.
2. Confirm the advisor row is **pre-bound**: `public.advisor.auth_user_id`
   must already equal the sign-in user's auth UUID. Binding is admin-only and
   one-time; it happens **before** first sign-in via the server-only
   provisioning module, and is never "linked" automatically on sign-in.
3. Confirm the advisor row has `is_active = true`
4. Confirm the signed-in account is resolved by its pre-bound UUID, not by an
   email match — an unbound, email-matched account receives zero advisor rows
   by design
5. For a new advisor, complete the admin pre-binding/invite path (see the
   identity-binding subsection above) before asking them to sign in
6. Confirm the complete chain through
   `20261009000001_scholarship_void_serialization.sql` was applied before any
   advisor was provisioned
7. A fresh project has **no effective Admin** until the first effective Admin
   is bootstrapped out of band via the service role / Supabase Admin API (see
   [Bootstrap the first effective Admin](#bootstrap-the-first-effective-admin-trusted-operator-out-of-band));
   the protected `/api/advisors` provisioning paths are effective-Admin-only by
   design and cannot create the first Admin

## Next Steps

1. ✅ Configure environment variables
2. ✅ Apply database schema (`20260305000000_initial_schema.sql`)
3. ✅ Apply bootstrap anon-read policy (`20260305000001_allow_anon_read.sql`)
4. ✅ Apply bootstrap anon-write policy (`20260305000002_allow_anon_write.sql`)
5. ✅ Apply advisor auth migration (`20260317000003_advisor_auth.sql`)
6. ✅ Backfill confirmed advisor emails in `public.advisor.email`
7. ✅ Apply active-advisor RLS migration (`20260317000004_active_advisor_rls.sql`)
8. ✅ Apply advisor self-activation lockdown migration (`20260318000001_advisor_self_activation_lockdown.sql`)
9. ✅ Apply advising↔application link migration (`20260929000001_advising_application_link.sql`)
10. ✅ Apply advising/application FK indexes (`20260930000002_advising_application_fk_indexes.sql`)
11. ✅ Apply append-only advising history (`20260930000003_advising_meeting_append_only.sql`)
12. ✅ Apply append-only advising amendments (`20260930000004_advising_meeting_amendments.sql`)
13. ✅ Apply entity lifecycle archiving (`20260930000005_entity_lifecycle_archiving.sql`)
14. ✅ Apply core history DELETE lockdown (`20260930000006_core_history_delete_lockdown.sql`)
15. ✅ Apply lifecycle review remediation (`20260930000007_lifecycle_review_remediation.sql`)
16. ✅ Apply explicit Admin/Advisor permissions (`20261001000001_explicit_admin_advisor_permissions.sql`)
17. ✅ Apply advisor self-service role reconciliation (`20261002000001_advisor_self_service_role_reconciliation.sql`)
18. ✅ Apply role-change lease/fencing migrations (`20261003000001`–`20261006000001`)
19. ✅ Apply atomic role change migration (`20261007000001_atomic_advisor_role_change.sql`)
20. ✅ Apply historical integrity remediation migration (`20261008000001_historical_integrity_remediation.sql`)
21. ✅ Apply scholarship terminal-Void serialization migration (`20261009000001_scholarship_void_serialization.sql`) — final migration
22. ✅ Provision each advisor via the admin pre-binding path (invite/create the auth account and bind its UUID to the unbound `advisor` row **before first sign-in**; one-time bind, no email self-link) — done only after the full migration chain (items 2–21) is applied
23. ✅ Verify the first active advisor can sign in (pre-bound `auth_user_id` resolves the advisor row; `is_active = true`)
24. ✅ Generate TypeScript types
25. ✅ Verify connection

## Auth and Account Notes

- Dashboard access is gated by `requireAdvisor()` on the server.
- Advisor identity is resolved by `auth_user_id` only (never by an email match);
  the session never self-links, so an advisor row must be pre-bound before
  first sign-in.
- Effective administration is the immutable Auth claim
  `app_metadata.ocf_admin = true` plus an active, pre-bound advisor
  (`public.is_effective_admin()`), mirrored in `lib/auth/session.ts`; the
  mutable `advisor.role` display column is never authorization.
- The **first effective Admin** is bootstrapped out of band by a trusted
  operator via the service role / Supabase Admin API (`app_metadata.ocf_admin
  = true` + a pre-bound active advisor row); there is **no public bootstrap
  endpoint**, and the service-role key is never exposed, committed, or logged.
  After the first Admin exists, all subsequent advisors are provisioned
  through the protected `/api/advisors` (effective-Admin-only) workflow.
- The account page lives at `/dashboard/account` and allows advisors to update `advisor_name`, request an email change, and change their password.
- Email updates should keep Supabase Auth and `public.advisor.email` synchronized.
- Password recovery uses `supabase.auth.resetPasswordForEmail(...)` and redirects back to `/reset-password`.

## Useful Commands

```bash
# Generate types (local instance must be running)
pnpm run db:types

# Test connection
pnpm run test:connection

# Start development server
pnpm dev

# Run Supabase locally (requires Docker)
pnpm exec supabase start

# Apply the full migration chain to a fresh local database
pnpm exec supabase db reset --no-seed

# Capture local runtime env (URLs/keys)
pnpm exec supabase status -o env

# View local Supabase logs
pnpm exec supabase logs

# Stop local Supabase
pnpm exec supabase stop --no-backup
```

## Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/introduction)
- [Supabase SSR for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Database Migrations](https://supabase.com/docs/guides/cli/local-development#database-migrations)