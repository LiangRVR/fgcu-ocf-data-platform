# 🚀 Quick Start: Supabase Connection

## What Has Been Set Up

### ✅ Environment Configuration

- Created `.env.local` for Supabase credentials
- Configured Supabase clients for browser and server in `lib/supabase/`
- Added proxy-based session refresh for authenticated dashboard routes

### ✅ Database Schema

- 7-table schema with advisor-backed auth applied via five SQL migrations
  - `supabase/migrations/20260305000000_initial_schema.sql` — creates all tables
  - `supabase/migrations/20260305000001_allow_anon_read.sql` — temporary bootstrap anon read access
  - `supabase/migrations/20260305000002_allow_anon_write.sql` — temporary bootstrap anon write access
  - `supabase/migrations/20260317000003_advisor_auth.sql` — extends `public.advisor` for auth linkage and active status
  - `supabase/migrations/20260317000004_active_advisor_rls.sql` — removes anon access and enables active-advisor RLS
- Documented in `docs/schema-reference.md` and `supabase/SCHEMA.md`

### ✅ Live Data and Auth Features

- Dashboard overview with KPI and recent-activity queries
- Advisor account page with profile editing, password updates, advisor-scoped meetings, and a meeting-derived student roster
- Students, applications, advising, fellowship Thursday, scholarship history, and fellowships all query live Supabase data
- Login, sign-out, forgot-password, and reset-password flows are wired to Supabase Auth

### ✅ UI, Validation, and Tooling

- FGCU design system and responsive dashboard shell
- Zod validation for login, recovery, and account flows
- Type-safe database access via `types/database.ts`
- Connection test and type-generation scripts via `pnpm`

## ⚠️ Still Required From You

### 1. Get Supabase Credentials

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

### 3. Apply Database Schema and Auth Migrations

#### Method A: Supabase Dashboard

1. Open **SQL Editor** in your Supabase project.
2. Run `supabase/migrations/20260305000000_initial_schema.sql`.
3. Run `supabase/migrations/20260305000001_allow_anon_read.sql`.
4. Run `supabase/migrations/20260305000002_allow_anon_write.sql`.
5. Run `supabase/migrations/20260317000003_advisor_auth.sql`.
6. Backfill the real FGCU advisor emails into `public.advisor.email`.
7. Create Supabase Auth users whose emails exactly match `public.advisor.email`.
8. Run `supabase/migrations/20260317000004_active_advisor_rls.sql`.

#### Method B: Supabase CLI

```bash
# Link to your project once
npx supabase link --project-ref YOUR_PROJECT_REF_ID

# Push all migrations
npx supabase db push
```

Migrations 2 and 3 are only bootstrap steps. After migration 5, authenticated active advisors are the intended steady state.

### 4. Generate TypeScript Types

The package script already supports `SUPABASE_PROJECT_ID`:

```bash
export SUPABASE_PROJECT_ID=your-project-ref-id
pnpm run db:types
```

### 5. Test Connection

```bash
pnpm run test:connection
```

Expected result:

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
- Re-run the migration sequence in Step 3.

### Permission denied or RLS errors

- After the final RLS migration, this is expected for unauthenticated users or inactive advisors.
- Confirm the signed-in email exactly matches `public.advisor.email`.
- Confirm the advisor row has `is_active = true`.
- Confirm `20260317000004_active_advisor_rls.sql` was applied only after an advisor account was validated.

### Connection failed

- Double-check the Supabase URL and anon key.
- Remove any extra spaces or quotes.
- Confirm the Supabase project is active.

## 📚 Learn More

- [Supabase Setup Guide](../supabase/README.md)
- [Schema Reference](schema-reference.md)
- [Schema Verification](schema-verification.md)
- [Supabase Docs](https://supabase.com/docs)

## 🎓 What You Have Now

1. **7 database tables** for students, advisors, fellowships, applications, advising meetings, Thursday attendance, and scholarship history.
2. **9 dashboard destinations** including the personalized account page.
3. **Advisor-backed auth** with protected dashboard routes and password recovery.
4. **Type-safe Supabase access** with generated database types.
5. **Operational docs** covering schema, setup, and verification.

## 🔄 What Is Not Done Yet

| Feature | Status | Notes |
| --- | --- | --- |
| Advisor provisioning | In progress | Real environments still need confirmed FGCU emails and matching Supabase Auth users |
| Email delivery verification | In progress | Forgot-password and secure email-change confirmation need end-to-end testing |
| Reports page | Placeholder | Empty state exists; charts and export logic are not built |
| Server-side pagination | Not started | All pagination is currently client-side |
| CSV export | UI only | Buttons exist, but export logic is not implemented |
| Bulk actions | Not started | Multi-select and bulk operations are planned |

## ✨ Recommended Next Steps

1. Provision advisor auth users in the real Supabase environment.
2. Verify profile updates and password recovery end to end.
3. Build reports, exports, and pagination.
4. Plan a `student_advisor` table only if OCF later wants formal caseload assignment.
