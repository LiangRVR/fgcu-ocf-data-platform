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
- [x] Role-change lease migrations (`supabase/migrations/20261003000001_advisor_role_change_lock.sql`, `20261004000001_advisor_role_fenced_write.sql`, `20261005000001_advisor_role_fenced_read.sql`, `20261006000001_advisor_role_display_reconcile.sql`) — server-only per-advisor role-change lease plus the read-only `verify_advisor_role_lock`/`fenced_read_advisor_role_display` primitives (retained infrastructure-only, write no advisor state); the legacy direct-write display-role RPCs `fenced_write_advisor_role_display`/`reconcile_advisor_role_display` were decommissioned (dropped) by `20261013000001`
- [x] Atomic role change migration (`supabase/migrations/20261007000001_atomic_advisor_role_change.sql`) — `set_advisor_role` RPC (service-role-only SECURITY DEFINER) updates the Auth claim and the display role in one transaction
- [x] Historical integrity remediation migration (`supabase/migrations/20261008000001_historical_integrity_remediation.sql`) — append-only `fellowship_thursday`/`scholarship_history` base rows + `fellowship_thursday_amendment`/`scholarship_history_amendment` tables, `effective_fellowship_thursday`/`effective_scholarship_history` views (terminal scholarship `Void`), the nine-stage application pipeline with stage/flag consistency and `application_year` bounds, and a required conducting `advisor_id` on new authenticated advising meetings
- [x] Scholarship terminal-Void serialization migration (`supabase/migrations/20261009000001_scholarship_void_serialization.sql`) — closes the terminal-`Void` race by taking an exclusive lock on the parent `scholarship_history` row before the `EXISTS` guard (concurrent amendments for one award serialize) and adds a partial unique index enforcing at most one `Void` per award
- [x] Read-only SECURITY INVOKER list views migration (`supabase/migrations/20261010000001_security_invoker_list_views.sql`) — one explicit-column, RLS-preserving view per operational list (`student_list`, `application_list`, `advising_meeting_list`, `fellowship_thursday_list`, `scholarship_history_list`, `fellowship_list`); no Auth binding fields, no row multiplication, `SELECT`-only to `authenticated`
- [x] Scholarship History operational summary migration (`supabase/migrations/20261011000001_scholarship_history_operational_summary.sql`) — RLS-preserving `SECURITY INVOKER` aggregate `scholarship_history_operational_summary(p_search, p_fellowship_id)` returning exact non-void award/student totals without shipping rows to the client; EXECUTE pinned to `authenticated`
- [x] Immutable audit trail migration (`supabase/migrations/20261012000001_immutable_audit.sql`) — database-authored `public.audit_event` (CHECK vocabularies for `entity_type`/`action`/`origin`, jsonb snapshots/diffs, no FKs), six `audit_id DESC` chronology indexes, RLS with `SELECT`-only active-advisor access and no product-role writer, and the internal `private.audit_current_state_change()` SECURITY DEFINER `AFTER INSERT/UPDATE` trigger on `student`/`fellowship`/`application`; no baseline rows
- [x] Advisor/admin immutable history migration (`supabase/migrations/20261013000001_advisor_admin_immutable_history.sql`) — advisor audit trigger helper `private.audit_advisor_change()` (`trg_audit_advisor_current_state` on `advisor`) with a strict positive allowlist (`advisor_name`/`email`/`role`/`is_active`; binding, claim, token, login-time, and role-lock data excluded; `last_login_at`-only changes write no event); trusted-actor validation `private.assert_durable_effective_admin` + transaction-local `private.set_audit_actor`; service-role-only audited `provision_advisor`; 4-arg `set_advisor_role`/`lifecycle_transition` with required non-blank reasons and atomic state+event; a shared transaction advisory lock enforcing the durable concurrency-safe last-active-bound-Admin invariant; `audit_current_state_change` re-created only to read `ocf.audit_reason`; decommissions the legacy direct-write display-role RPCs `fenced_write_advisor_role_display`/`reconcile_advisor_role_display` (leaving `set_advisor_role` as the single role-changing writer) while preserving the `advisor_role_lock` lease and its read-only `verify`/fenced-read primitives
- [x] Effective-Admin peer display-name RPC migration (`supabase/migrations/20261014000001_advisor_admin_profile_name.sql`) — authenticated-only `update_advisor_profile_name(p_advisor_id, p_advisor_name)` SECURITY DEFINER RPC (`SET search_path = ''`, fully qualified; EXECUTE revoked from `PUBLIC`/`anon`/`service_role`, granted to `authenticated`) closing the review gap: actor from `auth.uid()` only and validated with `public.is_effective_admin()`, peer-only (self row refused), writes ONLY `advisor_name` (no email parameter/list path; the existing invoker-security email guard is untouched), requires no reason (ordinary profile edit, R8), the existing advisor audit trigger emits exactly one attributed `updated` event (or none for a no-op), and role/lifecycle/binding/email controls, RLS, grants, and immutable audit are preserved; versioned in `20261015000001` (adds `p_expected_version`)
- [x] Protected current-state writers migration (`supabase/migrations/20261015000001_protected_current_state_writers.sql`) — `row_version`/`updated_at` on `student`/`fellowship`/`application`/`advisor` with the `private.set_current_state_row_version` semantic BEFORE UPDATE trigger (strict meaningful-field allowlist; exactly one version increment per semantic write; no-op/technical restatements preserve both; technical columns excluded from audit snapshots/diffs); narrow expected-version RPCs `update_student_profile`/`update_fellowship`/`update_application`/`update_my_advisor_profile`; versioned `lifecycle_transition`/`set_advisor_role`/`update_advisor_profile_name` (old signatures dropped) and `provision_advisor` returning version 1; stale versions raise fixed `PT409` before any change; the authenticated UPDATE grant and UPDATE policies are revoked on the four current-state tables
- [x] Historical audit + activity read model migration (`supabase/migrations/20261015000002_historical_audit_activity.sql`) — internal `private.audit_historical_record()` AFTER INSERT triggers on `advising_meeting`/`fellowship_thursday`/`scholarship_history` (`created`) and their `*_amendment` tables (`correction_added`; a Scholarship `Void` is `voided`) with structural-only snapshots (never notes/amendment reason/details/credentials), and the explicit-column `security_invoker` view `public.audit_activity` (audit-safe fields + correlated student/fellowship labels, `actor_name_snapshot`, no Auth-binding columns; SELECT only for `authenticated`; governed by the active-advisor audit RLS)
- [x] Insert metadata + positive expected-version migration (`supabase/migrations/20261016000001_insert_metadata_and_positive_version.sql`) — `private.set_current_state_row_version` extended with a BEFORE INSERT branch (forces `row_version = 1`/`updated_at = now()`, overriding any supplied value) and the four current-state triggers re-created as BEFORE INSERT OR UPDATE; new `private.assert_expected_version` raises `22023` unless `p_expected_version >= 1` and is called first by every protected existing-row writer; UPDATE semantics, authorization, locking, last-Admin, audit, and stale-`PT409` behavior unchanged
- [x] Advising-history TRUNCATE-revoke migration (`supabase/migrations/20261017000001_revoke_advising_meeting_truncate.sql`) — revokes `TRUNCATE` on `advising_meeting`/`advising_meeting_amendment` from `PUBLIC`/`anon`/`authenticated` (trusted `service_role` untouched), closing the destructive SQL bypass on the append-only advising history; no SELECT/INSERT behavior, RLS policy, audit trigger, business row, or audit row changes
- [x] Application re-link parent-locking migration (`supabase/migrations/20261018000001_lock_application_relink_parents.sql`) — `public.update_application` locks the prospective parent row `FOR UPDATE` and reads its `archived_at` under that lock before the ACTIVE-parent check (only when an actual parent re-link changes the reference), serializing the re-link against a concurrent `lifecycle_transition` archive so a re-link can never commit pointing at a parent archived at commit time; fixed, deadlock-free lock order; only the parent-validation block changes
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
- [x] Effective-Admin management surface (`/advisors`, `GET/POST /api/advisors`, `GET/PATCH /api/advisors/[id]`) with trusted server-side provisioning; `PATCH` also supports the authenticated peer display-name edit (`advisorName`, no reason) via `update_advisor_profile_name`
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
     tracks **thirty-two** forward-only migrations ending with
     `20261018000001_lock_application_relink_parents.sql`, and the deployed schema
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

The **thirty-two-migration** repository chain ends with
`20261018000001_lock_application_relink_parents.sql`. The full chain enforces, at
the database boundary: append-only advising meetings and amendments; archive /
deactivate lifecycle for students, fellowships, and advisors; a DELETE lockdown
on the core historical entities; an explicit `Admin`/`Advisor` role model
backed by the immutable Auth claim; a trusted, server-only provisioning
path; read-only `SECURITY INVOKER` list views plus the operational aggregate;
an immutable, database-authored audit trail over the current-state
`student`/`fellowship`/`application`/`advisor` rows and the historical
base/amendment inserts; database-enforced optimistic concurrency whose
expected-version writers replace direct authenticated UPDATE (with
`row_version`/`updated_at` database-authored on insert and a positive expected
version required since `20261016000001`); and a serialized application parent
re-link that locks the prospective parent `FOR UPDATE` before the active-parent
check so it cannot race a concurrent `lifecycle_transition` archive
(`20261018000001`).

The durable invariant is: **no normal application access may change business
history without an atomic, immutable audit record.** Entities fall into three
categories — **current-state / audited** (`student`, `advisor`, `fellowship`,
`application`), **immutable base** (`advising_meeting`, `fellowship_thursday`,
`scholarship_history`), and **append-only amendment**
(`advising_meeting_amendment`, `fellowship_thursday_amendment`,
`scholarship_history_amendment`). The product `Admin` role is not a PostgreSQL
superuser; the `service_role`/DBA session is a separate technical trust
boundary, not a normal application path.

Our database schema aligns with the application needs:

### Students Management

- **Table**: `student`
- **Application Pages**: `/students`
- **Primary Key**: `student_id` (integer)
- **Key Fields**: full_name, email, major, gpa, class_standing, is_ch_student, us_citizen, archived_at (lifecycle), row_version, updated_at (concurrency metadata)
- **Notes**: archive instead of delete (`lifecycle_transition`); authenticated DELETE denied; edits via the expected-version `update_student_profile` RPC (authenticated UPDATE revoked)

### Fellowship Management

- **Table**: `fellowship`
- **Application Pages**: `/fellowships`
- **Primary Key**: `fellowship_id` (integer)
- **Key Fields**: fellowship_name, archived_at (lifecycle), row_version, updated_at (concurrency metadata)
- **Notes**: archive instead of delete; archived fellowships cannot be selected for new applications but remain readable in history; renames via the expected-version `update_fellowship` RPC (authenticated UPDATE revoked)

### Application Tracking

- **Table**: `application`
- **Application Pages**: `/applications`
- **Primary Key**: `application_id` (integer)
- **Key Fields**: student_id, fellowship_id, application_year (application cycle — nullable for legacy rows, never inferred), stage_of_application, is_semi_finalist, is_finalist, destination_country, row_version, updated_at (concurrency metadata)
- **Relationships**: Links `student` to `fellowship`
- **Notes**: historical record — authenticated DELETE denied; new rows cannot reference archived students/fellowships; edits via the expected-version `update_application` RPC (authenticated UPDATE revoked)

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
- **Key Fields**: advisor_name, email, auth_user_id (one-time bind), is_active (sole lifecycle field), role (`Admin`/`Advisor` display projection), last_login_at, row_version, updated_at (concurrency metadata)
- **Notes**: Serves as both the staff profile table and the app authorization anchor. Effective authority is the Auth `ocf_admin` claim + active bound advisor, never the display role. Authenticated advisor-row creation, peer UPDATE, and DELETE are denied; deactivation is RPC-only; profile/role/lifecycle writes are expected-version RPCs (`update_my_advisor_profile`, `update_advisor_profile_name(..., p_expected_version)`, `set_advisor_role(..., p_expected_version)`, `lifecycle_transition(..., p_expected_version)`).

### Fellowship Thursday Attendance

- **Table**: `fellowship_thursday`
- **Primary Key**: `attendance_id` (integer)
- **Key Fields**: student_id, attended, source_info
- **Notes**: immutable base record (historical-integrity remediation) — authenticated UPDATE/DELETE denied, SELECT/INSERT only; new rows cannot reference archived students; corrections are appended as `fellowship_thursday_amendment` rows

### Scholarship History

- **Table**: `scholarship_history`
- **Primary Key**: `history_id` (integer)
- **Key Fields**: student_id, fellowship_id
- **Notes**: immutable base record (historical-integrity remediation) — authenticated UPDATE/DELETE denied, SELECT/INSERT only; new rows cannot reference archived students/fellowships; corrections/voids are appended as `scholarship_history_amendment` rows (a `Void` is terminal for operational counts)

### Server-only Role-Change Lock

- **Table**: `advisor_role_lock` (migration `20261003000001`)
- **Primary Key**: `advisor_id` (FK)
- **Notes**: server-only lease table; RLS enabled with no policies, anon/authenticated revoked, service_role granted. Never exposed to clients. Infrastructure-only: `set_advisor_role` is the single role-changing writer; the legacy direct-write display-role RPCs were dropped by `20261013000001`, while the lease `acquire`/`release` and read-only `verify`/fenced-read primitives are retained.

### Immutable Audit Trail

- **Table**: `audit_event` (migrations `20261012000001` + `20261013000001` + `20261015000002`), `audit_activity` (view, migration `20261015000002`)
- **Primary Key**: `audit_id` (`bigint` sequence)
- **Key Fields**: entity_type / entity_id, action, actor_advisor_id, actor_name_snapshot, occurred_at, old_values / new_values / changes (jsonb), reason, subject_student_id / subject_application_id / subject_fellowship_id (no FKs), origin
- **Vocabulary**: `entity_type` and `action` each admit exactly ten reserved values; `origin` admits exactly `user`, `system`, `migration`
- **Notes**: immutable, database-authored read model. Written only by the internal `SECURITY DEFINER` triggers on `student`/`fellowship`/`application`, on `advisor`, and (migration `20261015000002`) on the historical base/amendment tables inside the source transaction; advisor/admin events use a strict positive allowlist and verified human attribution; historical events carry structural-only payloads (never notes/amendment reason/details/credentials); `audit_activity` is an explicit-column `security_invoker` view for entity histories and the global activity log; readable by active advisors (`SELECT`-only); no INSERT/UPDATE/DELETE/TRUNCATE grant or policy for any product role; `baseline_captured`/`migration` are reserved with no writer. An audit failure aborts the business write.

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
- [ ] Scholarship terminal-Void serialization migration applied (`20261009000001_scholarship_void_serialization.sql`)
- [ ] Read-only SECURITY INVOKER list views migration applied (`20261010000001_security_invoker_list_views.sql`)
- [ ] Scholarship History operational summary migration applied (`20261011000001_scholarship_history_operational_summary.sql`)
- [ ] Immutable audit trail migration applied (`20261012000001_immutable_audit.sql`)
- [ ] Advisor/admin immutable history migration applied (`20261013000001_advisor_admin_immutable_history.sql`)
- [ ] Effective-Admin peer display-name RPC migration applied (`20261014000001_advisor_admin_profile_name.sql`)
- [ ] Protected current-state writers migration applied (`20261015000001_protected_current_state_writers.sql`)
- [ ] Historical audit + activity read model migration applied (`20261015000002_historical_audit_activity.sql`)
- [ ] Insert metadata + positive expected-version migration applied (`20261016000001_insert_metadata_and_positive_version.sql`)
- [ ] Advising-history TRUNCATE-revoke migration applied (`20261017000001_revoke_advising_meeting_truncate.sql`) — the destructive `TRUNCATE` privilege on `advising_meeting`/`advising_meeting_amendment` is revoked from `PUBLIC`/`anon`/`authenticated` (trusted `service_role` retained)
- [ ] Application re-link parent-locking migration applied (`20261018000001_lock_application_relink_parents.sql`) — an `update_application` parent re-link locks the prospective parent row `FOR UPDATE` before the ACTIVE-parent check, so a concurrent `lifecycle_transition` archive serializes with the re-link and a re-link to a parent archived at commit time is impossible (lock order fixed and deadlock-free)
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
- [ ] Active advisor receives a database permission denial for TRUNCATE attempts on `advising_meeting`/`advising_meeting_amendment` (privilege revoked from `PUBLIC`/`anon`/`authenticated`; the trusted `service_role` grant is retained)
- [ ] Active advisor can INSERT an amendment and receives a denial for amendment UPDATE and DELETE attempts
- [ ] Archive/restore of a student or fellowship and deactivate/reactivate of an advisor succeed for an effective admin only, and each requires a non-blank reason (a blank/NULL reason is rejected)
- [ ] A new child record (application/meeting/attendance/history) referencing an archived student or fellowship is denied at the database boundary
- [ ] Authenticated DELETE of `advisor`/`student`/`fellowship`/`application` is denied; `fellowship_thursday`/`scholarship_history` base rows are also append-only (no authenticated UPDATE/DELETE), with corrections/voids recorded via amendments
- [ ] Fellowship Thursday and Scholarship History base rows cannot be updated or deleted by an active advisor; an appended amendment (attendance correction; scholarship `Correction`/`Void`) succeeds, is rejected with forged creator/timestamp, and a `Void` is excluded from operational counts while staying in the audit history
- [ ] Application stages include `Did Not Submit` and `Withdrawn` (non-finalist/non-awarded terminal states) and `application_year` is rejected outside `NULL` or `2000–2100` at the database boundary
- [ ] A new authenticated advising meeting without a conducting `advisor_id` is rejected at the database boundary; legacy `advisor_id IS NULL` rows remain readable
- [ ] An INSERT/UPDATE of `student`/`fellowship`/`application` writes exactly one `audit_event` with the correct `action` (`created`/`updated`/`archived`/`restored`), actor snapshot, and whitelisted `changes`; a no-op or technical-only update writes none
- [ ] An authenticated active advisor can `SELECT` `audit_event`; anon/non-advisor sessions cannot; every INSERT/UPDATE/DELETE/TRUNCATE attempt on `audit_event` by a product role (including an Admin) is denied
- [ ] `audit_event` rows are never fabricated for pre-existing rows (`baseline_captured`/`migration` origin have no writer), and no client path can write an audit row
- [ ] An advisor INSERT or meaningful UPDATE writes exactly one `advisor` audit event through the internal trigger with only `advisor_name`/`email`/`role`/`is_active` in snapshots/diffs; a `last_login_at`-only change writes none, and `auth_user_id`/claim/token/login-time/role-lock data never appears
- [ ] Provisioning an advisor through the service-role `provision_advisor` path writes one `advisor/created` event attributed to the initiating effective Admin (not System); a service-role `set_advisor_role` call writes exactly one `advisor/role_changed` event with the reason, role diff, verified actor, and frozen name, and no duplicate `updated` event
- [ ] Role and lifecycle RPCs reject a NULL/blank reason, and the legacy `set_advisor_role` (2-arg/4-arg) and `lifecycle_transition` (3-arg/4-arg) signatures no longer exist
- [ ] The legacy direct-write display-role RPCs `fenced_write_advisor_role_display`/`reconcile_advisor_role_display` are absent (dropped by `20261013000001`); `set_advisor_role` is the only role-changing writer, and the `advisor_role_lock` lease/verify/fenced-read primitives remain
- [ ] Lifecycle events (`student`/`fellowship` archive/restore; `advisor` deactivate/reactivate) carry the supplied reason; role demotion and advisor deactivation cannot remove the last active, bound, durable (`ocf_admin = true`) Admin, including competing concurrent attempts
- [ ] Ordinary profile updates accept `advisor_name` only; a supplied `email` is rejected so `advisor.email` cannot silently diverge from the Supabase Auth email
- [ ] `update_advisor_profile_name(p_advisor_id, p_advisor_name, p_expected_version)` exists as an authenticated-only SECURITY DEFINER RPC with empty `search_path` and fully qualified references; EXECUTE is revoked from `PUBLIC`/`anon`/`service_role` and granted to `authenticated` only, so a technical/service session (no `auth.uid()`) is rejected fail-closed, the legacy 2-arg signature no longer exists, and a stale `p_expected_version` raises `PT409`
- [ ] An effective Admin updating another advisor's name through `update_advisor_profile_name` writes exactly ONE `advisor/updated` event attributed to the acting Admin (`origin = 'user'`, frozen `actor_name_snapshot`) with only `advisor_name` in the diff; a no-op restatement writes no event, and the caller's own row is refused (self-service profile path remains the only self-write route for one's own row)
- [ ] The peer name RPC accepts no email, no actor, and no reason: it cannot change `email`/`role`/`is_active`/`auth_user_id`, records no reason, and never sets `ocf.audit_reason`; a duplicate-name value is rejected (`23505`) and target/name/length/blank validation fail closed
- [ ] `PATCH /api/advisors/[id]` accepts a sole `advisorName` field without a reason (R8) through the authenticated session, still rejects `email`/`auth_user_id` and any combined mutation payload (`role`/`isActive`/`advisorName`) before any state change, and forwards no actor parameter
- [ ] Every `student`/`fellowship`/`application`/`advisor` row has a non-null `row_version` (starting at 1) and a non-null database-authored `updated_at`; a semantic write increments `row_version` exactly once and updates `updated_at`, and a no-op/technical restatement does neither
- [ ] `row_version`/`updated_at` never appear in an `audit_event` snapshot/diff; the semantic version trigger (not the audit trigger) owns those columns
- [ ] The `authenticated` UPDATE grant and the direct UPDATE policies (`active_advisor_update_student`, `active_advisor_update_fellowship`, `active_advisor_update_application`, `advisor_update_own_profile`) no longer exist on the four current-state tables; normal edits call the expected-version writer RPCs
- [ ] Two independently authenticated editor sessions: the second writer's stale expected version is rejected with `PT409` before any change (no row mutation, no version bump, no audit event); malformed expected versions use `22023`
- [ ] The legacy un-versioned signatures `lifecycle_transition(text,text,integer,text)`, `set_advisor_role(integer,text,text,integer)`, and `update_advisor_profile_name(integer,text)` no longer exist; `provision_advisor` still creates rows at version 1
- [ ] A client INSERT that supplies `row_version`/`updated_at` is overridden: every created `student`/`fellowship`/`application`/`advisor` row starts at `row_version = 1` with a database-authored `updated_at` (migration `20261016000001`)
- [ ] Every expected-version writer rejects a NULL/`0`/negative `p_expected_version` with `22023` (malformed input), distinct from a stale `PT409` conflict
- [ ] `private.assert_expected_version` is not callable by `PUBLIC`/`anon`/`authenticated`; `private.set_current_state_row_version` remains SECURITY INVOKER with client EXECUTE revoked
- [ ] Historical inserts: a new advising meeting, Fellowship Thursday attendance, or scholarship award writes exactly one audited `created` event, and a new `*_amendment` row writes exactly one `correction_added` event (a Scholarship `Void` writes `voided`) with structural-only payloads — no notes, amendment reason/details, credentials, or Auth data
- [ ] An active advisor can `SELECT` `audit_activity`; the view is `security_invoker`, explicit-column, exposes no Auth-binding/private field, and its rows remain governed by the active-advisor audit RLS; anon can neither select the underlying `audit_event` nor the view

### Auth Flow Smoke Test

- [ ] Sign in with a Supabase Auth user whose UUID is pre-bound to an advisor row (`advisor.auth_user_id`)
- [ ] Confirm the pre-bound advisor row resolves by `auth_user_id` (no sign-in auto-linking; an unbound, email-matched account gets no advisor row)
- [ ] Confirm inactive advisors are redirected out of protected routes
- [ ] Confirm an `Admin`-displaying advisor is one whose bound Auth user carries the boolean `app_metadata.ocf_admin = true` claim, and that direct `role` writes are denied
- [ ] Confirm profile updates save successfully from `/dashboard/account`, and the email field is read-only (a supplied email change is rejected, never a partial identity update)
- [ ] Confirm password updates succeed for an active session

### What Works Without Real Data

All pages gracefully handle empty tables — empty states are shown instead of errors. You do **not** need seed data to verify the connection.