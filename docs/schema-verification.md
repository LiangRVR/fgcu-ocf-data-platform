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
- [x] Append-only advising amendments migration (`supabase/migrations/20260930000004_advising_meeting_amendments.sql`) — adds `advising_meeting_amendment` (SELECT/INSERT-only corrections with database-authored creator/timestamp and trim-aware non-empty `reason`/`details` CHECKs)
- [x] Entity lifecycle archiving migration (`supabase/migrations/20260930000005_entity_lifecycle_archiving.sql`) — `student.archived_at` / `fellowship.archived_at`, admin-only `lifecycle_transition` RPC, `is_ocf_admin()`, direct-write guards; `advisor.is_active` stays the sole advisor lifecycle field
- [x] Core history DELETE lockdown migration (`supabase/migrations/20260930000006_core_history_delete_lockdown.sql`) — revokes authenticated DELETE on `advisor`/`student`/`fellowship`/`application` (grant + RLS); authenticated DELETE retained only on `fellowship_thursday`/`scholarship_history`
- [x] Lifecycle review remediation migration (`supabase/migrations/20260930000007_lifecycle_review_remediation.sql`) — lifecycle RPC requires a current ACTIVE bound advisor; archive-parent child boundary rejects new child records referencing archived students/fellowships
- [x] Explicit Admin/Advisor permissions migration (`supabase/migrations/20261001000001_explicit_admin_advisor_permissions.sql`) — normalizes `advisor.role` to exactly `Admin`/`Advisor`, hardens `is_ocf_admin()` to a strict JSON-boolean claim, adds `is_effective_admin()`, denies direct authenticated role writes
- [x] Advisor self-service role reconciliation migration (`supabase/migrations/20261002000001_advisor_self_service_role_reconciliation.sql`) — self-scoped `advisor_update_own_profile` UPDATE only, no authenticated advisor-row creation, display role reconciled to the Auth claim
- [x] Role-change lease migrations (`supabase/migrations/20261003000001_advisor_role_change_lock.sql`, `20261004000001_advisor_role_fenced_write.sql`, `20261005000001_advisor_role_fenced_read.sql`, `20261006000001_advisor_role_display_reconcile.sql`) — server-only per-advisor role-change lease + fenced write/read (legacy primitives retained)
- [x] Atomic role change migration (`supabase/migrations/20261007000001_atomic_advisor_role_change.sql`) — `set_advisor_role` RPC (service-role-only SECURITY DEFINER) updates the Auth claim and the display role in one transaction
- [x] Historical integrity remediation migration (`supabase/migrations/20261008000001_historical_integrity_remediation.sql`) — append-only `fellowship_thursday`/`scholarship_history` base rows + `fellowship_thursday_amendment`/`scholarship_history_amendment` tables, `effective_fellowship_thursday`/`effective_scholarship_history` views (terminal scholarship `Void`), the nine-stage application pipeline with stage/flag consistency and `application_year` bounds, and a required conducting `advisor_id` on new authenticated advising meetings
- [x] Scholarship terminal-Void serialization migration (`supabase/migrations/20261009000001_scholarship_void_serialization.sql`) — closes the terminal-`Void` race by taking an exclusive lock on the parent `scholarship_history` row before the `EXISTS` guard (concurrent amendments for one award serialize) and adds a partial unique index enforcing at most one `Void` per award; final migration of the chain
- [x] Schema documentation (`docs/schema-reference.md`, `supabase/SCHEMA.md`)
- [x] Auto-generated TypeScript types (`types/database.ts`)
- [x] Application-level types (`types/index.ts`)
- [x] Connection test utility (`scripts/test-connection.ts`)
- [x] Real advisor auth wiring (`lib/auth/session.ts`, protected dashboard layout, sign-in/sign-out)
- [x] Password recovery flow (`/forgot-password` → `/reset-password`)
- [x] Advisor account page (`/dashboard/account`)
- [x] All dashboard destinations query live Supabase data
- [x] Add / Edit operations implemented on mutable main tables (students, applications, fellowship thursday, scholarship history); advising meetings are append-only history and corrections are recorded as amendments
- [x] Archive/deactivate lifecycle flows for students, fellowships, and advisors (admin-only `lifecycle_transition` RPC)
- [x] Effective-Admin management surface (`/advisors`, `GET/POST /api/advisors`, `GET/PATCH /api/advisors/[id]`) with trusted server-side provisioning
- [x] Form validation: Zod + React Hook Form on login/recovery; manual field-level + consistency validation on account page and CRUD dialogs

### ⚠️ Required From You Before First Use

1. **Add Supabase Credentials to `.env.local`** (only to run the hosted app)
   - Get your Project URL from: Supabase Dashboard → Settings → API
   - Get your Anon Key from: Supabase Dashboard → Settings → API
   - Update the `.env.local` file with real values

2. **Apply Database Schema**
   - For local development/testing (recommended): start Docker-local Supabase and
     apply the full chain — `pnpm exec supabase start` then
     `pnpm exec supabase db reset --no-seed`.
   - ⚠️ Do **not** run these migrations against the hosted production database.
     Production is the physical-schema authority; its migration ledger records
     only `20260924065221_advisor_self_activation_lockdown` while the repository
     tracks **twenty-two** forward-only migrations ending with
     `20261009000001_scholarship_void_serialization.sql`, and the deployed schema
     differs materially. See
     [`supabase/SCHEMA.md`](../supabase/SCHEMA.md#migration-deployment-freeze)
     and the approval-gated
     [reconciliation runbook](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md).

3. **Generate TypeScript Types** (only needed if schema changes)

   - With a local instance running: `pnpm run db:types`
     (runs `supabase gen types --local > types/database.ts`; no project ID needed).

4. **Test Connection**
   - Run: `pnpm run test:connection`

## Schema Mapping

The **twenty-two-migration** repository chain ends with
`20261009000001_scholarship_void_serialization.sql`. The full chain enforces, at
the database boundary: append-only advising meetings and amendments; archive /
deactivate lifecycle for students, fellowships, and advisors; a DELETE lockdown
on the core historical entities; an explicit `Admin`/`Advisor` role model
backed by the immutable Auth claim; and a trusted, server-only provisioning
path.

Our database schema aligns with the application needs:

### Students Management

- **Table**: `student`
- **Application Pages**: `/students`
- **Primary Key**: `student_id` (integer)
- **Key Fields**: full_name, email, major, gpa, class_standing, is_ch_student, us_citizen, archived_at (lifecycle)
- **Notes**: archive instead of delete (`lifecycle_transition`); authenticated DELETE denied

### Fellowship Management

- **Table**: `fellowship`
- **Application Pages**: `/fellowships`
- **Primary Key**: `fellowship_id` (integer)
- **Key Fields**: fellowship_name, archived_at (lifecycle)
- **Notes**: archive instead of delete; archived fellowships cannot be selected for new applications but remain readable in history

### Application Tracking

- **Table**: `application`
- **Application Pages**: `/applications`
- **Primary Key**: `application_id` (integer)
- **Key Fields**: student_id, fellowship_id, application_year (application cycle — nullable for legacy rows, never inferred), stage_of_application, is_semi_finalist, is_finalist, destination_country
- **Relationships**: Links `student` to `fellowship`
- **Notes**: historical record — authenticated DELETE denied; new rows cannot reference archived students/fellowships

### Advising Meetings

- **Table**: `advising_meeting`
- **Application Pages**: `/advising`
- **Primary Key**: `meeting_id` (integer)
- **Key Fields**: student_id, advisor_id (who conducted), application_id (nullable — NULL = General Advising; composite FK keeps the application on the meeting's student), meeting_date, meeting_mode, no_show, notes, created_at (entry timestamp), created_by_advisor_id (who entered)
- **Relationships**: Links `student` to `advisor` and, optionally, to one of that student's `application` rows
- **Notes**: append-only — SELECT and INSERT only for active advisors; corrections go to `advising_meeting_amendment`

### Advising Meeting Amendments

- **Table**: `advising_meeting_amendment`
- **Application Pages**: `/advising` (shown in the meeting's amendment history)
- **Primary Key**: `amendment_id` (integer)
- **Key Fields**: meeting_id, created_by_advisor_id (database-resolved active creator), created_at (database timestamp), reason, details
- **Notes**: append-only corrections — SELECT and INSERT only; `reason`/`details` must be non-empty after trimming whitespace

### Advisors

- **Table**: `advisor`
- **Primary Key**: `advisor_id` (integer)
- **Key Fields**: advisor_name, email, auth_user_id (one-time bind), is_active (sole lifecycle field), role (`Admin`/`Advisor` display projection), last_login_at
- **Notes**: Serves as both the staff profile table and the app authorization anchor. Effective authority is the Auth `ocf_admin` claim + active bound advisor, never the display role. Authenticated advisor-row creation, peer UPDATE, and DELETE are denied; deactivation is RPC-only.

### Fellowship Thursday Attendance

- **Table**: `fellowship_thursday`
- **Primary Key**: `attendance_id` (integer)
- **Key Fields**: student_id, attended, source_info
- **Notes**: operational record — authenticated DELETE retained; new rows cannot reference archived students

### Scholarship History

- **Table**: `scholarship_history`
- **Primary Key**: `history_id` (integer)
- **Key Fields**: student_id, fellowship_id
- **Notes**: operational record — authenticated DELETE retained; new rows cannot reference archived students/fellowships

### Server-only Role-Change Lock

- **Table**: `advisor_role_lock` (migration `20261003000001`)
- **Primary Key**: `advisor_id` (FK)
- **Notes**: server-only lease table; RLS enabled with no policies, anon/authenticated revoked, service_role granted. Never exposed to clients.

> **Canonical reference**: See `docs/schema-reference.md` for the full schema with all constraints and business rules.

## Type Alignment

1. `types/database.ts` — auto-generated from Supabase; use for all database operations
2. `types/index.ts` — application-level types; must mirror the DB schema exactly
3. All table names are **singular** (`student` not `students`), all PKs are **integer sequences** (not UUIDs, except the FK-keyed `advisor_role_lock`)

## Verification Checklist

Before using the application with real data:

- [ ] Supabase project created and credentials added to `.env.local` (hosted app only; local testing uses Docker-local Supabase)
- [ ] Local instance started: `pnpm exec supabase start`
- [ ] Schema migration applied (`20260305000000_initial_schema.sql`)
- [ ] Bootstrap anon-read policy applied (`20260305000001_allow_anon_read.sql`)
- [ ] Bootstrap anon-write policy applied (`20260305000002_allow_anon_write.sql`)
- [ ] Advisor auth migration applied (`20260317000003_advisor_auth.sql`)
- [ ] Confirmed advisor emails backfilled in `public.advisor.email`
- [ ] Active-advisor RLS migration applied (`20260317000004_active_advisor_rls.sql`)
- [ ] Advisor self-activation lockdown migration applied (`20260318000001_advisor_self_activation_lockdown.sql`) — removes any email self-link and adds the one-time-bind guard
- [ ] Advising↔application link migration applied (`20260929000001_advising_application_link.sql`)
- [ ] Advising/application FK indexes migration applied (`20260930000002_advising_application_fk_indexes.sql`)
- [ ] Append-only advising history migration applied (`20260930000003_advising_meeting_append_only.sql`)
- [ ] Append-only advising amendments migration applied (`20260930000004_advising_meeting_amendments.sql`)
- [ ] Entity lifecycle archiving migration applied (`20260930000005_entity_lifecycle_archiving.sql`)
- [ ] Core history DELETE lockdown migration applied (`20260930000006_core_history_delete_lockdown.sql`)
- [ ] Lifecycle review remediation migration applied (`20260930000007_lifecycle_review_remediation.sql`)
- [ ] Explicit Admin/Advisor permissions migration applied (`20261001000001_explicit_admin_advisor_permissions.sql`)
- [ ] Advisor self-service role reconciliation migration applied (`20261002000001_advisor_self_service_role_reconciliation.sql`)
- [ ] Role-change lease/fencing migrations applied (`20261003000001`–`20261006000001`)
- [ ] Atomic role change migration applied (`20261007000001_atomic_advisor_role_change.sql`)
- [ ] Historical integrity remediation migration applied (`20261008000001_historical_integrity_remediation.sql`)
- [ ] Scholarship terminal-Void serialization migration applied last (`20261009000001_scholarship_void_serialization.sql`)
- [ ] Advisors provisioned via the admin pre-binding path: each auth account's exact UUID bound to its `advisor.auth_user_id` while unbound, before first sign-in (no email self-link, no sign-in auto-linking)
- [ ] First effective Admin bootstrapped out of band via the service role / Supabase Admin API (`app_metadata.ocf_admin = true` + a pre-bound active advisor row); no public bootstrap endpoint exists and service credentials are never exposed
- [ ] After the first Admin exists, provisioning a new advisor through the protected `/api/advisors` (effective-Admin-only) path succeeds
- [ ] TypeScript types regenerated if schema was modified: `pnpm run db:types`
- [ ] Connection test passes: `pnpm run test:connection`
- [ ] Dev server starts: `pnpm dev`
- [ ] Advisor can sign in and reach `/dashboard`
- [ ] Advisor can open `/dashboard/account`
- [ ] Forgot-password email flow reaches `/reset-password`
- [ ] Dashboard loads with live (or empty) data
- [ ] Active advisor can SELECT and INSERT an advising meeting
- [ ] Active advisor receives a database permission denial for advising-meeting UPDATE and DELETE attempts
- [ ] Active advisor can INSERT an amendment and receives a denial for amendment UPDATE and DELETE attempts
- [ ] Archive/restore of a student or fellowship and deactivate/reactivate of an advisor succeed for an effective admin only
- [ ] A new child record (application/meeting/attendance/history) referencing an archived student or fellowship is denied at the database boundary
- [ ] Authenticated DELETE of `advisor`/`student`/`fellowship`/`application` is denied; `fellowship_thursday`/`scholarship_history` base rows are also append-only (no authenticated UPDATE/DELETE), with corrections/voids recorded via amendments
- [ ] Fellowship Thursday and Scholarship History base rows cannot be updated or deleted by an active advisor; an appended amendment (attendance correction; scholarship `Correction`/`Void`) succeeds, is rejected with forged creator/timestamp, and a `Void` is excluded from operational counts while staying in the audit history
- [ ] Application stages include `Did Not Submit` and `Withdrawn` (non-finalist/non-awarded terminal states) and `application_year` is rejected outside `NULL` or `2000–2100` at the database boundary
- [ ] A new authenticated advising meeting without a conducting `advisor_id` is rejected at the database boundary; legacy `advisor_id IS NULL` rows remain readable

### Auth Flow Smoke Test

- [ ] Sign in with a Supabase Auth user whose UUID is pre-bound to an advisor row (`advisor.auth_user_id`)
- [ ] Confirm the pre-bound advisor row resolves by `auth_user_id` (no sign-in auto-linking; an unbound, email-matched account gets no advisor row)
- [ ] Confirm inactive advisors are redirected out of protected routes
- [ ] Confirm an `Admin`-displaying advisor is one whose bound Auth user carries the boolean `app_metadata.ocf_admin = true` claim, and that direct `role` writes are denied
- [ ] Confirm profile updates save successfully from `/dashboard/account`
- [ ] Confirm password updates succeed for an active session

### What Works Without Real Data

All pages gracefully handle empty tables — empty states are shown instead of errors. You do **not** need seed data to verify the connection.