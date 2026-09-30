# Supabase Setup Guide

## Prerequisites

1. Create a Supabase account at [supabase.com](https://supabase.com)
2. Create a new project in Supabase
3. Note your project's:
   - Project URL (Settings → API → Project URL)
   - Anon/Public Key (Settings → API → Project API keys → anon public)
   - Project ID (Settings → General → Reference ID)

## Step 1: Configure Environment Variables

1. Update `.env.local` with your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

1. Restart your development server after updating environment variables.

## Step 2: Apply Database Schema

> ⚠️ **Production freeze (2026-09-25):** these steps describe a fresh-project
> setup. Do **not** apply the repository migrations to the hosted production
> database while provenance is unresolved — production is the physical-schema
> authority, its migration ledger records only
> `20260924065221_advisor_self_activation_lockdown`, and the deployed schema
> materially differs from this repository chain. See
> [SCHEMA.md — Migration deployment freeze](./SCHEMA.md#migration-deployment-freeze)
> and the approval-gated
> [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

### Advisor identity binding: admin pre-binding, not email self-link

Identity binding is **admin-only**. A person becomes an advisor through a
server-only provisioning path — never by signing in with an email that happens
to match `public.advisor.email`.

- An administrator provisions each advisor **before first sign-in** using the
  server-only provisioning module (`lib/provisioning/*`, executed server-side
  with `SUPABASE_SERVICE_ROLE_KEY`). That key is a secret: it must never be
  committed, placed in `.env.local`, sent to the browser, or logged.
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
  full chain through `20260930000003_advising_meeting_append_only.sql` first — the
  lockdown migration (`20260318000001_advisor_self_activation_lockdown.sql`)
  removes the remaining email self-link write path and installs the
  one-time-bind guard under which the trusted `service_role` bind is written.
  Never provision or pre-bind an advisor before the lockdown migration is
  applied.

### Option A: Using Supabase Dashboard (Recommended for first-time setup)

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
13. **Required final step (auth chain):** repeat steps 3–6 for `supabase/migrations/20260318000001_advisor_self_activation_lockdown.sql` — removes the email self-link escalation path, adds the one-time-bind guard and the active-staff-only update policy. It must run **after** `20260317000004_active_advisor_rls.sql`; the auth chain is not complete without it.
14. Repeat steps 3–6 for `supabase/migrations/20260929000001_advising_application_link.sql` — forward-only, additive: adds the nullable `application.application_year` cycle, the nullable `advising_meeting.application_id` advising↔application link (with direct and composite same-student FKs), the database-authored `created_at`/`created_by_advisor_id` creation metadata and hardened trigger, and advising indexes. Historic NULL values are preserved.
15. Repeat steps 3–6 for `supabase/migrations/20260930000002_advising_application_fk_indexes.sql` — adds the reverse composite-FK index on `(application_id, student_id)` and the creator index on `created_by_advisor_id`.
16. Repeat steps 3–6 for `supabase/migrations/20260930000003_advising_meeting_append_only.sql` — enforces database RLS append-only history: active advisors can `SELECT` and `INSERT` advising meetings, while `UPDATE` and `DELETE` are denied without an admin bypass.
17. **Only after the complete migration chain is applied (through step 16):** provision each advisor via the admin pre-binding path (see [Advisor identity binding](#advisor-identity-binding-admin-pre-binding-not-email-self-link) above) — never create auth users to "self-link" by email
18. Verify the first active advisor can sign in — the pre-bound `auth_user_id` resolves their advisor row, and `is_active` is `true`

Migrations `20260305000001_allow_anon_read.sql` and `20260305000002_allow_anon_write.sql` are temporary bootstrap steps. After the full chain ending with `20260930000002_advising_application_fk_indexes.sql`, bootstrap anon access is no longer the intended steady state. Operational access comes only from authenticated active advisors, and `advisor.auth_user_id` binding is admin-only (see the identity-binding subsection above).

### Option B: Using Supabase CLI (disposable local instances only)

The full chain ends with `20260930000003_advising_meeting_append_only.sql`.
That migration enforces append-only advising history through database RLS:
active advisors can SELECT and INSERT, while UPDATE and DELETE are denied with
no admin bypass.

```bash
# Link to your project (one time)
npx supabase link --project-ref <your-project-id>

# Push all migrations to your Supabase project
npx supabase db push
```

> ⚠️ `supabase link` + `supabase db push` must **not** be run against the
> hosted production project. The production migration ledger records only
> `20260924065221_advisor_self_activation_lockdown`, while this repository
> tracks nine migrations ending with `20260930000003_advising_meeting_append_only.sql` and the deployed schema differs materially. Generic
> `db push`, historical replay, and migration-history repair against production
> are prohibited until a separately approved reconciliation exists. See the
> [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

## Step 3: Generate TypeScript Types

> The repository migration chain now contains nine migrations and ends with
> `20260930000003_advising_meeting_append_only.sql`.

After applying the schema, generate TypeScript types for type-safe database access:

### Method 1: Using Project ID (Recommended)

```bash
pnpm run db:types
```

Or manually:

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```

### Method 2: Using Database URL

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
- Database tables are accessible

## Step 5: Add Sample Data (Optional)

To add sample data for testing:

1. Navigate to **Table Editor** in Supabase dashboard
2. Select a table (e.g., `student`)
3. Click **Insert row** → **Insert manually**
4. Fill in the required fields
5. Click **Save**

Or create a seed script for automated sample data insertion.

## Database Schema

See [SCHEMA.md](./SCHEMA.md) for detailed documentation about:

- Table structures
- Relationships
- Indexes
- Row Level Security policies
- Sample queries

## Troubleshooting

### Types generation fails

1. Ensure your project is deployed and schema is applied
2. Verify your project ID is correct: `npx supabase projects list`
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

## Next Steps

1. ✅ Configure environment variables
2. ✅ Apply database schema (`20260305000000_initial_schema.sql`)
3. ✅ Apply bootstrap anon-read policy (`20260305000001_allow_anon_read.sql`)
4. ✅ Apply bootstrap anon-write policy (`20260305000002_allow_anon_write.sql`)
5. ✅ Apply advisor auth migration (`20260317000003_advisor_auth.sql`)
6. ✅ Backfill confirmed advisor emails in `public.advisor.email`
7. ✅ Apply active-advisor RLS migration (`20260317000004_active_advisor_rls.sql`)
8. ✅ Apply advisor self-activation lockdown migration (`20260318000001_advisor_self_activation_lockdown.sql`)
9. ✅ Apply advising↔application link migration (`20260929000001_advising_application_link.sql`) — forward-only: adds the application cycle (`application.application_year`), the nullable advising↔application link with direct + composite same-student FKs, creation metadata and trigger, and advising indexes
10. ✅ Apply advising/application FK indexes (`20260930000002_advising_application_fk_indexes.sql`) — adds the reverse composite-FK index on `(application_id, student_id)` and creator index on `created_by_advisor_id`
11. ✅ Apply append-only advising history (`20260930000003_advising_meeting_append_only.sql`) — database RLS grants active advisors `SELECT` and `INSERT` only; `UPDATE` and `DELETE` are denied without an admin bypass, preserving historic records
12. ✅ Provision each advisor via the admin pre-binding path (invite/create the auth account and bind its UUID to the unbound `advisor` row **before first sign-in**; one-time bind, no email self-link) — done only after the full migration chain (items 2–11) is applied
13. ✅ Verify the first active advisor can sign in (pre-bound `auth_user_id` resolves the advisor row; `is_active = true`)
14. ✅ Generate TypeScript types
15. ✅ Verify connection

## Auth and Account Notes

- Dashboard access is gated by `requireAdvisor()` on the server.
- Advisor identity is resolved by `auth_user_id` only (never by an email match);
  the session never self-links, so an advisor row must be pre-bound before
  first sign-in.
- The account page lives at `/dashboard/account` and allows advisors to update `advisor_name`, request an email change, and change their password.
- Email updates should keep Supabase Auth and `public.advisor.email` synchronized.
- Password recovery uses `supabase.auth.resetPasswordForEmail(...)` and redirects back to `/reset-password`.

## Useful Commands

```bash
# Generate types
pnpm run db:types

# Test connection
pnpm run test:connection

# Start development server
pnpm dev

# Run Supabase locally (requires Docker)
npx supabase start

# View local Supabase logs
npx supabase logs
```

## Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/introduction)
- [Supabase SSR for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Database Migrations](https://supabase.com/docs/guides/cli/local-development#database-migrations)
