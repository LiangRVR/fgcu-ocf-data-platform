# Schema Implementation Verification

## Current Status

### ✅ Completed (Code)

- [x] Supabase client configuration (`lib/supabase/client.ts` and `lib/supabase/server.ts`)
- [x] Environment variable setup (`.env.local`)
- [x] Initial schema migration (`supabase/migrations/20260305000000_initial_schema.sql`)
- [x] Bootstrap anon read policy migration (`supabase/migrations/20260305000001_allow_anon_read.sql`)
- [x] Bootstrap anon write policy migration (`supabase/migrations/20260305000002_allow_anon_write.sql`)
- [x] Advisor auth migration (`supabase/migrations/20260317000003_advisor_auth.sql`)
- [x] Active-advisor RLS migration (`supabase/migrations/20260317000004_active_advisor_rls.sql`)
- [x] Advisor self-activation lockdown migration (`supabase/migrations/20260318000001_advisor_self_activation_lockdown.sql`)
- [x] Advising↔application link migration (`supabase/migrations/20260929000001_advising_application_link.sql`) — forward-only: nullable `application.application_year` (cycle), nullable `advising_meeting.application_id` with direct + composite same-student FKs, database-authored `created_at`/`created_by_advisor_id` creation metadata and hardened trigger, advising indexes
- [x] Advising/application FK indexes migration (`supabase/migrations/20260930000002_advising_application_fk_indexes.sql`) — adds the reverse composite-FK index on `(application_id, student_id)` and creator index on `created_by_advisor_id`
- [x] Append-only advising history migration (`supabase/migrations/20260930000003_advising_meeting_append_only.sql`) — database RLS permits active advisors to SELECT and INSERT advising meetings only; UPDATE and DELETE are denied without an admin bypass, preserving historic data
- [x] Schema documentation (`docs/schema-reference.md`, `supabase/SCHEMA.md`)
- [x] Auto-generated TypeScript types (`types/database.ts`)
- [x] Application-level types (`types/index.ts`)
- [x] Connection test utility (`scripts/test-connection.ts`)
- [x] Real advisor auth wiring (`lib/auth/session.ts`, protected dashboard layout, sign-in/sign-out)
- [x] Password recovery flow (`/forgot-password` → `/reset-password`)
- [x] Advisor account page (`/dashboard/account`)
- [x] All 9 dashboard destinations query live Supabase data
- [x] Add / Edit / Delete operations implemented on mutable main tables (students, applications, fellowship thursday, scholarship history); advising meetings are append-only history
- [x] Form validation: Zod + React Hook Form on login/recovery; manual field-level + consistency validation on account page and CRUD dialogs

### ⚠️ Required From You Before First Use

1. **Add Supabase Credentials to `.env.local`**
   - Get your Project URL from: Supabase Dashboard → Settings → API
   - Get your Anon Key from: Supabase Dashboard → Settings → API
   - Update the `.env.local` file with real values

2. **Apply Database Schema**
   - For a fresh/disposable project only: `npx supabase db push` (after linking)
   - ⚠️ Do **not** run these migrations against the hosted production database.
     Production is the physical-schema authority; its migration ledger records
     only `20260924065221_advisor_self_activation_lockdown` while the repository
     tracks eight migrations ending with `20260930000002_advising_application_fk_indexes.sql`, and the deployed schema differs materially. See
     [`supabase/SCHEMA.md`](../supabase/SCHEMA.md#migration-deployment-freeze)
     and the approval-gated
     [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

3. **Generate TypeScript Types** (only needed if schema changes)

   - The repository now tracks **nine** migrations ending with
     `20260930000003_advising_meeting_append_only.sql`; use that ninth migration
     when applying or verifying the complete local chain.
   - Run: `pnpm run db:types`

4. **Test Connection**
   - Run: `pnpm run test:connection`

## Schema Mapping

The nine-migration repository chain ends with
`20260930000003_advising_meeting_append_only.sql`, which enforces
database-RLS append-only advising history: active advisors can SELECT and
INSERT only; UPDATE and DELETE are denied without an admin bypass.

Our database schema aligns with the application needs:

### Students Management

- **Table**: `student`
- **Application Pages**: `/students`
- **Primary Key**: `student_id` (integer)
- **Key Fields**: full_name, email, major, gpa, class_standing, is_ch_student, us_citizen

### Fellowship Management

- **Table**: `fellowship`
- **Application Pages**: `/fellowships`
- **Primary Key**: `fellowship_id` (integer)
- **Key Fields**: fellowship_name

### Application Tracking

- **Table**: `application`
- **Application Pages**: `/applications`
- **Primary Key**: `application_id` (integer)
- **Key Fields**: student_id, fellowship_id, application_year (application cycle — nullable for legacy rows, never inferred), stage_of_application, is_semi_finalist, is_finalist, destination_country
- **Relationships**: Links `student` to `fellowship`

### Advising Meetings

- **Table**: `advising_meeting`
- **Application Pages**: `/advising`
- **Primary Key**: `meeting_id` (integer)
- **Key Fields**: student_id, advisor_id (who conducted), application_id (nullable — NULL = General Advising; composite FK keeps the application on the meeting's student), meeting_date, meeting_mode, no_show, notes, created_at (entry timestamp), created_by_advisor_id (who entered)
- **Relationships**: Links `student` to `advisor` and, optionally, to one of that student's `application` rows

### Advisors

- **Table**: `advisor`
- **Primary Key**: `advisor_id` (integer)
- **Key Fields**: advisor_name, email, auth_user_id, is_active, role, last_login_at
- **Notes**: Serves as both the staff profile table and the app authorization anchor

### Fellowship Thursday Attendance

- **Table**: `fellowship_thursday`
- **Primary Key**: `attendance_id` (integer)
- **Key Fields**: student_id, attended, source_info

### Scholarship History

- **Table**: `scholarship_history`
- **Primary Key**: `history_id` (integer)
- **Key Fields**: student_id, fellowship_id

> **Canonical reference**: See `docs/schema-reference.md` for the full schema with all constraints and business rules.

## Type Alignment

1. `types/database.ts` — auto-generated from Supabase; use for all database operations
2. `types/index.ts` — application-level types; must mirror the DB schema exactly
3. All table names are **singular** (`student` not `students`), all PKs are **integer sequences** (not UUIDs)

## Verification Checklist

Before using the application with real data:

- [ ] Supabase project created and credentials added to `.env.local`
- [ ] Schema migration applied (`20260305000000_initial_schema.sql`)
- [ ] Bootstrap anon-read policy applied (`20260305000001_allow_anon_read.sql`)
- [ ] Bootstrap anon-write policy applied (`20260305000002_allow_anon_write.sql`)
- [ ] Advisor auth migration applied (`20260317000003_advisor_auth.sql`)
- [ ] Confirmed advisor emails backfilled in `public.advisor.email`
- [ ] Active-advisor RLS migration applied (`20260317000004_active_advisor_rls.sql`)
- [ ] Advisor self-activation lockdown migration applied (`20260318000001_advisor_self_activation_lockdown.sql`) — removes any email self-link and adds the one-time-bind guard
- [ ] Advising↔application link migration applied (`20260929000001_advising_application_link.sql`) — forward-only: adds the nullable application cycle (`application.application_year`), the nullable advising↔application link with direct + composite same-student FKs, creation metadata and trigger, and advising indexes
- [ ] Advising/application FK indexes migration applied (`20260930000002_advising_application_fk_indexes.sql`) — adds the reverse composite-FK index on `(application_id, student_id)` and creator index on `created_by_advisor_id`
- [ ] Append-only advising history migration applied (`20260930000003_advising_meeting_append_only.sql`) — database RLS permits active advisors to SELECT and INSERT only; UPDATE and DELETE have no admin bypass
- [ ] Advisors provisioned via the admin pre-binding path: each auth account's exact UUID bound to its `advisor.auth_user_id` while unbound, before first sign-in (no email self-link, no sign-in auto-linking)
- [ ] TypeScript types regenerated if schema was modified: `pnpm run db:types`
- [ ] Connection test passes: `pnpm run test:connection`
- [ ] Dev server starts: `pnpm dev`
- [ ] Advisor can sign in and reach `/dashboard`
- [ ] Advisor can open `/dashboard/account`
- [ ] Forgot-password email flow reaches `/reset-password`
- [ ] Dashboard loads with live (or empty) data
- [ ] Active advisor can SELECT and INSERT an advising meeting
- [ ] Active advisor receives a database permission denial for advising-meeting UPDATE and DELETE attempts

### Auth Flow Smoke Test

- [ ] Sign in with a Supabase Auth user whose UUID is pre-bound to an advisor row (`advisor.auth_user_id`)
- [ ] Confirm the pre-bound advisor row resolves by `auth_user_id` (no sign-in auto-linking; an unbound, email-matched account gets no advisor row)
- [ ] Confirm inactive advisors are redirected out of protected routes
- [ ] Confirm profile updates save successfully from `/dashboard/account`
- [ ] Confirm password updates succeed for an active session

### What Works Without Real Data

All pages gracefully handle empty tables — empty states are shown instead of errors. You do **not** need seed data to verify the connection.
