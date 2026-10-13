# OCF Database Schema — One-Page Reference

> Canonical tables, keys, foreign keys, constraints, and business rules for the
> FGCU Office of Competitive Fellowships data platform.
>
> Active auth model: Supabase Auth identity + `public.advisor` authorization
>
> ⚠️ **Provenance notice (2026-09-25, updated 2026-10-15):** the hosted
> production database is the physical-schema authority. Its migration ledger
> records only `20260924065221_advisor_self_activation_lockdown`, while this
> repository tracks thirty-two migrations (`20260305000000` …
> `20261018000001_lock_application_relink_parents.sql`), and the deployed
> schema materially differs from the repository chain. Do **not** run
> `supabase db push`, replay migrations, or repair migration history against
> production. See [Migration deployment freeze](#migration-deployment-freeze).
>
> For open design decisions (email uniqueness, stage denormalization, etc.) see
> [`docs/schema-decisions.md`](../docs/schema-decisions.md).

---

## Table Overview

| Table | Purpose | PK |
| --- | --- | --- |
| `advisor` | OCF staff profile + auth anchor | `advisor_id` |
| `fellowship` | Fellowship / scholarship programs | `fellowship_id` |
| `student` | FGCU student profiles | `student_id` |
| `application` | One application attempt by one student | `application_id` |
| `advising_meeting` | Advising sessions (student ↔ advisor) | `meeting_id` |
| `advising_meeting_amendment` | Append-only corrections to advising meetings | `amendment_id` |
| `fellowship_thursday` | Weekly Thursday meeting attendance | `attendance_id` |
| `fellowship_thursday_amendment` | Append-only corrections to Fellowship Thursday attendance | `amendment_id` |
| `scholarship_history` | Confirmed past fellowship awards | `history_id` |
| `scholarship_history_amendment` | Append-only Correction / Void records for scholarship awards | `amendment_id` |
| `advisor_role_lock` | Server-only per-advisor role-change lease (migration `20261003000001`) | `advisor_id` (FK) |
| `audit_event` | Immutable, database-authored audit trail of every `student`/`fellowship`/`application`/`advisor` mutation plus historical base/amendment inserts (migrations `20261012000001` + `20261013000001` + `20261015000002`) | `audit_id` (bigint) |
| `audit_activity` (view) | Explicit-column, `security_invoker` read model over `audit_event` for entity histories and the global activity log (migration `20261015000002`); SELECT-only for `authenticated` | — |

All PKs are **integer sequences** (never UUIDs) except `advisor_role_lock`, whose primary key is the `advisor_id` foreign key (a server-only lock table, never exposed to clients); `audit_event.audit_id` is a `bigint` sequence, every other PK is `integer`. All table names are **singular**.

---

## Immutable History Invariant & Entity Categories

**Invariant (the release-hardening rule):** at the database boundary, no normal
application access may change business history without an atomic, immutable,
database-authored record. Every meaningful change to a current-state business
entity must run through that entity's expected-`row_version` database writer and
commit exactly one immutable `public.audit_event` in the same transaction (an
audit failure aborts the business write). `audit_event` history cannot be
directly changed, deleted, or truncated by any normal product role (staff or
Admin); corrections to historical records use append-only amendments.

Every table belongs to exactly one of three categories:

| Category | Tables | Rule |
| --- | --- | --- |
| **Current-state / audited** | `student`, `advisor`, `fellowship`, `application` | Mutable only through the expected-version database writer for that entity; each meaningful mutation writes exactly one `audit_event`; the `authenticated` `UPDATE` grant and direct `UPDATE` policies are revoked. |
| **Immutable base** | `advising_meeting`, `fellowship_thursday`, `scholarship_history` | Append-only history: normal roles may `SELECT`/`INSERT` only; rows are never updated or deleted; inserts are audited (`created`). |
| **Append-only amendment** | `advising_meeting_amendment`, `fellowship_thursday_amendment`, `scholarship_history_amendment` | Correction records appended (never edited); inserts are audited (`correction_added`; a scholarship `Void` is `voided`); effective-value views apply corrections without rewriting base facts. |

**Advising-history TRUNCATE closure (migration `20261017000001`).** The
append-only `advising_meeting` and `advising_meeting_amendment` tables revoke
`TRUNCATE` from `PUBLIC`, `anon`, and `authenticated` (the trusted
`service_role` grant is untouched), closing the destructive SQL path that the
local Supabase default privileges otherwise hand to `authenticated`/`anon` for
newly created objects. This matches the sibling historical tables already closed
in `20261008000001`; no `SELECT`/`INSERT` behavior, RLS policy, audit trigger,
business row, or audit row changes, and there is no down migration.

**Application re-link / parent-archive serialization (migration
`20261018000001`).** `public.update_application` validates an actual parent
re-link against the ACTIVE-parent boundary, and since this migration it locks the
prospective `student`/`fellowship` parent row `FOR UPDATE` and reads
`archived_at` under that lock **before** the check (only when the parent
reference actually changes). A concurrent `public.lifecycle_transition` archive
takes `FOR UPDATE` on the same parent row, so the two paths serialize: the
archive either commits first (and the re-link observes an archived parent and is
rejected with `42501`) or waits until the re-link commits (at which point the
parent was still active). The lock order is fixed — application row first, then
prospective student, then prospective fellowship — and no path locks a parent
before an application, so the added parent locks cannot deadlock. Only the
parent-validation block changes; authorization, the expected-version `PT409`
precondition, the missing-row `P0002` outcome, the permitted writable fields,
the return projection, and every ACL/RLS policy are unchanged.

**DBA / service-role trust boundary.** The product `Admin` is **not** a
PostgreSQL superuser: effective administration is the immutable Auth
`app_metadata.ocf_admin = true` claim plus an active, pre-bound advisor row
(`public.is_effective_admin()`), never the mutable `advisor.role` display column
and never a table privilege. A `service_role`/DBA session is a separate technical
trust boundary, used only for trusted provisioning, first-Admin bootstrap, and
synthetic fixtures — not a normal application path and never exposed to the
browser.

---

## `advisor`

**Purpose:** Staff profile table for OCF advisors and the app authorization anchor.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `advisor_id` | integer | NO | nextval | **PK** |
| `advisor_name` | varchar | NO | — | UNIQUE |
| `email` | text | YES | — | unique when populated |
| `auth_user_id` | uuid | YES | — | unique when populated |
| `is_active` | boolean | NO | `true` | Sole advisor lifecycle field |
| `role` | text | NO | `'Advisor'` | Protected display projection; CHECK: `Admin` or `Advisor` only |
| `created_at` | timestamptz | NO | `now()` | |
| `last_login_at` | timestamptz | YES | — | |
| `row_version` | integer | NO | `1` | Optimistic-concurrency version; DB-authored, increments once per meaningful UPDATE |
| `updated_at` | timestamptz | NO | `now()` | DB-authored timestamp of the last meaningful UPDATE; never in an audit snapshot/diff |

No foreign keys. Referenced by `advising_meeting.advisor_id`.

Used by the app for sign-in authorization, account profile display, password-recovery context, and the `/dashboard/account` page.

`is_active` is the **sole** advisor lifecycle representation (there is no advisor `archived_at`). Deactivate/reactivate happen **only** through the admin lifecycle RPC `public.lifecycle_transition` (migration `20260930000005`); direct authenticated writes of `is_active` are rejected by a database guard. See [Entity Lifecycle & Archive Model](#entity-lifecycle--archive-model-migration-20260930000005).

`role` is a **protected display projection** (migrations
`20261001000001` + `20261002000001`): the vocabulary is exactly `Admin` and
`Advisor` (CHECK `advisor_role_display_check`, default `'Advisor'`, existing
lowercase values normalized by the migration) and it is **reconciled to the
Auth claim** — a bound advisor displays `Admin` only when
`auth.users.raw_app_meta_data.ocf_admin` is the JSON boolean `true`, and
`Advisor` otherwise (the same strict boolean rule as `public.is_ocf_admin()`).
It is presentation / audit state and is **never** an RLS/RPC authorization
input. Direct authenticated writes to `role` — self or peer, including
creating an `Admin` row — are rejected fail-closed (42501) by the
invoker-security guard `trg_advisor_role_display` /
`guard_advisor_role_display`; only trusted `service_role` / DBA sessions (the
server-only provisioning adapter) may set it. Effective authority comes from
the Auth boolean claim + active bound advisor (`public.is_effective_admin()`),
never the display role.

**Advisor write boundary (migration `20261002000001`, superseded for direct
UPDATE by `20261015000001`):** authenticated
advisor-row creation is **denied** (`advisor_insert_active_staff` is dropped),
and an active, pre-bound advisor may UPDATE **only their own bound row** via
the self-scoped RLS policy `advisor_update_own_profile`
(`auth_user_id = auth.uid()` AND `is_active_advisor()`). Peer rows are
invisible for UPDATE and inactive/unbound sessions have no UPDATE path; the
column-scoped `role`/`is_active`/`auth_user_id` guards still protect those
fields on the self row. Advisor rows are created/managed only through the
trusted `service_role` / DBA provisioning path and the protected management
API. Since migration `20261015000001`, the `authenticated` UPDATE grant and the
`advisor_update_own_profile` policy are revoked and normal edits go through the
expected-version RPCs (`update_my_advisor_profile` for self,
`update_advisor_profile_name` for peers) — see
[Protected Expected-Version Writers](#protected-expected-version-writers-migration-20261015000001).

**Email is read-only in ordinary profile editing (change
`advisor-admin-immutable-history`, migration `20261013000001`):** an advisor's
login email is a Supabase Auth identity field. Ordinary profile PATCH accepts
`advisor_name` only; a supplied `email` is rejected rather than updating
`advisor.email` without the Auth email (which would silently diverge the two
identity sources). Changing a login email requires a future explicit trusted
account-management workflow that updates Auth and the advisor projection
together; no self-service email edit exists in this handoff.

**Trusted creation and atomic role change (migration `20261013000001`):**
advisor rows are created only by the service-role-only
`public.provision_advisor` RPC, which validates the initiating effective Admin,
writes the bound advisor row, and emits exactly one `created` audit event
attributed to that Admin in the same transaction. Role changes run through the
service-role-only `public.set_advisor_role(p_advisor_id, p_role, p_reason,
p_actor_id, p_expected_version)` RPC, which requires a non-blank reason,
revalidates the actor,
serializes membership-reducing changes under a fixed advisory lock, refuses to
remove the last active bound durable Admin, and atomically updates the Auth claim
and the display role with exactly one `role_changed` event. The old 2-arg and
legacy 4-arg signatures are dropped. See
[Advisor / Admin Immutable History](#advisor--admin-immutable-history-migration-20261013000001).

**Effective-Admin peer display-name update (migrations `20261014000001`
+ `20261015000001`):** the
authenticated-only SECURITY DEFINER RPC
`public.update_advisor_profile_name(p_advisor_id, p_advisor_name,
p_expected_version)` is the
production path for an effective Admin to change **another** advisor's permitted
profile display name. The actor is derived **only** from `auth.uid()` (there is
no actor parameter; a technical/service session with no `auth.uid()` is rejected
fail-closed 42501) and validated with the existing `public.is_effective_admin()`
boundary (Auth boolean `ocf_admin = true` claim AND a current ACTIVE pre-bound
advisor) — never the mutable display role. It writes **only** `advisor.advisor_name`;
`email`, `role`, `is_active`, and `auth_user_id` are unreachable (no email
parameter, and the invoker-security email guard still rejects any untrusted
email change). The caller's own row is refused so self-service name edits stay on
the profile path. The name must be non-blank, trimmed, ≤120 chars, and not
collide with another advisor's UNIQUE name. `p_expected_version` matches the
target's `row_version` (`PT409` on staleness). No reason is required or recorded
(ordinary profile edit, R8). Because the write is a single `UPDATE advisor_name`
inside the authenticated session, the existing advisor audit trigger emits
exactly one attributed `advisor/updated` event (no-op restatement writes none).
EXECUTE is revoked from `PUBLIC`/`anon`/`service_role` and granted to
`authenticated` only; all role/lifecycle/binding/email controls, RLS, grants, and
immutable audit are untouched.

Authenticated clients **cannot `DELETE`** advisor rows (migration
`20260930000006_core_history_delete_lockdown`): the `authenticated` DELETE
table privilege is revoked and the `advisor_delete_active_staff` RLS policy is
dropped. Deactivation via `lifecycle_transition` is the only removal path;
trusted `service_role` / DBA sessions retain their default grants.

---

## `fellowship`

**Purpose:** Reference list of fellowship and scholarship programs the OCF tracks.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `fellowship_id` | integer | NO | nextval | **PK** |
| `fellowship_name` | varchar | NO | — | UNIQUE |
| `archived_at` | timestamptz | YES | — | Lifecycle: NULL = active, DB-authored timestamp = archived |
| `row_version` | integer | NO | `1` | Optimistic-concurrency version; DB-authored, increments once per meaningful UPDATE |
| `updated_at` | timestamptz | NO | `now()` | DB-authored timestamp of the last meaningful UPDATE; never in an audit snapshot/diff |

Referenced by `application.fellowship_id` and `scholarship_history.fellowship_id`.

Indexed: `archived_at`.

`archived_at` is the single lifecycle representation for a fellowship: `NULL`
means **active** and a database-authored timestamp means **archived**. It is
written only by the admin lifecycle RPC `public.lifecycle_transition`
(migration `20260930000005`); direct authenticated writes are rejected by a
database guard. Archive never deletes, nulls, or cascades the applications and
award-history rows that reference the fellowship (FKs stay `NO ACTION`). See
[Entity Lifecycle & Archive Model](#entity-lifecycle--archive-model-migration-20260930000005).

Authenticated clients **cannot `DELETE`** fellowship rows (migration
`20260930000006_core_history_delete_lockdown`): the `authenticated` DELETE
table privilege is revoked and the FOR ALL active-advisor policy is replaced
with explicit SELECT / INSERT / UPDATE policies that carry no DELETE. Archive
via `lifecycle_transition` is the only removal path.

---

## `student`

**Purpose:** Core profile for every FGCU student tracked by the OCF.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `student_id` | integer | NO | nextval | **PK** |
| `archived_at` | timestamptz | YES | — | Lifecycle: NULL = active, DB-authored timestamp = archived |
| `full_name` | varchar | NO | — | |
| `email` | varchar | NO | — | indexed (not unique — see schema-decisions.md) |
| `is_ch_student` | boolean | NO | `false` | Coconut Club / CH Honors |
| `us_citizen` | boolean | NO | — | Required for fellowship eligibility checks |
| `major` | varchar | YES | — | |
| `minor` | varchar | YES | — | |
| `gpa` | numeric | YES | — | CHECK: 0.00 – 4.00 |
| `class_standing` | varchar | YES | — | CHECK: `Freshman` `Sophomore` `Junior` `Senior` `Graduate` `Doctoral` |
| `age` | integer | YES | — | |
| `gender` | varchar | YES | — | CHECK: `F` `M` `NB` `NR` |
| `pronouns` | varchar | YES | — | |
| `race_ethnicity` | varchar | YES | — | |
| `languages` | varchar | YES | — | |
| `first_gen` | boolean | NO | `false` | First-generation college student |
| `honors_college` | boolean | NO | `false` | |
| `row_version` | integer | NO | `1` | Optimistic-concurrency version; DB-authored, increments once per meaningful UPDATE |
| `updated_at` | timestamptz | NO | `now()` | DB-authored timestamp of the last meaningful UPDATE; never in an audit snapshot/diff |

Indexed: `email`, `is_ch_student`, `class_standing`, `archived_at`. Referenced by all five child tables below.

`archived_at` is the single lifecycle representation for a student: `NULL`
means **active** and a database-authored timestamp means **archived**. Existing
rows are untouched and remain `NULL` (active); nothing is ever backfilled. It
is written only by the admin lifecycle RPC `public.lifecycle_transition`
(migration `20260930000005`); direct authenticated writes are rejected by a
database guard. Archive never deletes, nulls, or cascades applications,
meetings, attendance, or award history (FKs stay `NO ACTION`). See
[Entity Lifecycle & Archive Model](#entity-lifecycle--archive-model-migration-20260930000005).

Authenticated clients **cannot `DELETE`** student rows (migration
`20260930000006_core_history_delete_lockdown`): the `authenticated` DELETE
table privilege is revoked and the FOR ALL active-advisor policy is replaced
with explicit SELECT / INSERT / UPDATE policies that carry no DELETE. Archive
via `lifecycle_transition` is the only removal path.

---

## `application`

**Purpose:** Tracks one fellowship application attempt by one student. A student may have multiple rows for the same fellowship across different years.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `application_id` | integer | NO | nextval | **PK** |
| `student_id` | integer | NO | — | **FK → `student.student_id`** |
| `fellowship_id` | integer | NO | — | **FK → `fellowship.fellowship_id`** |
| `application_year` | smallint | YES | — | Application **cycle** (e.g. `2026`), not a creation year and not a fellowship attribute; NULL for legacy rows whose cycle is unknown; CHECK: `NULL` or `2000–2100` |
| `destination_country` | varchar | YES | — | Travel-fellowship destination |
| `stage_of_application` | varchar | NO | — | CHECK: see pipeline values below |
| `is_semi_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |
| `is_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |
| `row_version` | integer | NO | `1` | Optimistic-concurrency version; DB-authored, increments once per meaningful UPDATE |
| `updated_at` | timestamptz | NO | `now()` | DB-authored timestamp of the last meaningful UPDATE; never in an audit snapshot/diff |

**Pipeline stages (in order — nine, database-enforced CHECK):**
`Started` → `Submitted` → `Under Review` → `Semi-Finalist` → `Finalist` → `Awarded` / `Rejected` / `Did Not Submit` / `Withdrawn`

`Did Not Submit` and `Withdrawn` are **non-finalist/non-awarded terminal
states** (their `is_semi_finalist` / `is_finalist` flags are `false`); they
carry no award and are excluded from awarded/finalist reporting. Stage/flag
consistency is enforced by database CHECK, not trusted to client validation.

**Business rules:**

- No unique constraint on `(student_id, fellowship_id)` — multi-year repeat applications are allowed. There is also **no** `(student_id, fellowship_id, application_year)` uniqueness rule.
- `application_year` is the explicit application cycle. It is nullable so legacy rows stay truthful when their cycle is unknown; the system never infers or backfills a year. The database bounds it to `NULL` or `2000–2100` (CHECK). Known cycles render as `{fellowship_name} — {application_year}` labels (see `advising_meeting`).
- `UNIQUE (application_id, student_id)` exists solely as the target for the `advising_meeting` composite FK (`application_id, student_id`); it adds no new application uniqueness rule.
- `is_semi_finalist` and `is_finalist` duplicate `stage_of_application` for fast `WHERE` queries.
  Both must be set together when updating the stage, and the nine-stage/value
  consistency is database-enforced (historical-integrity remediation). See
  schema-decisions.md §2.

Indexed: `student_id`, `fellowship_id`, `stage_of_application`, `(application_id, student_id)` (unique).

Authenticated clients **cannot `DELETE`** application rows (migration
`20260930000006_core_history_delete_lockdown`): the `authenticated` DELETE
table privilege is revoked and the FOR ALL active-advisor policy is replaced
with explicit SELECT / INSERT / UPDATE policies that carry no DELETE.
Applications are historical records — archival of their parent student or
fellowship preserves them, and they are never deleted in place.

---

## `advising_meeting`

**Purpose:** Records each advising session between an OCF advisor and a student.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `meeting_id` | integer | NO | nextval | **PK** |
| `student_id` | integer | NO | — | **FK → `student.student_id`** |
| `advisor_id` | integer | YES | — | **FK → `advisor.advisor_id`** (nullable — session may be unassigned) |
| `application_id` | integer | YES | — | **FK → `application.application_id`** + composite FK `(application_id, student_id)` → `application(application_id, student_id)`; NULL = General Advising |
| `meeting_date` | date | NO | — | Real session date — distinct from `created_at` |
| `meeting_mode` | varchar | NO | — | CHECK: `In-Person` `Virtual` |
| `no_show` | boolean | NO | `false` | `true` when student did not attend |
| `notes` | text | YES | — | |
| `created_at` | timestamptz | NO | `now()` | Database-authored **entry** timestamp; never a substitute for `meeting_date` |
| `created_by_advisor_id` | integer | YES | — | **FK → `advisor.advisor_id`**; the advisor who **entered** the record, distinct from `advisor_id` (who conducted the meeting) |

**Advising ↔ application link and creation metadata (migration `20260929000001`):**

- `application_id = NULL` is **General Advising**. A non-NULL value must reference
  an `application` that belongs to the meeting's own student — the composite FK
  `(application_id, student_id) → application(application_id, student_id)`
  enforces this at the database boundary, so a cross-student application is
  impossible even on a direct write. NULL columns pass both FKs.
- The fellowship shown for a meeting is **derived only** through
  `advising_meeting.application_id → application.fellowship_id → fellowship`.
  `advising_meeting` carries no `fellowship_id`, and `fellowship.fellowship_name`
  never encodes the cycle. Known-cycle labels render as
  `{fellowship_name} — {application_year}` (e.g. `Fulbright — 2027`); unknown
  legacy cycles render as `{fellowship_name} — year unknown`, never as a guess.
- `created_at` is when the record was **entered**, authored by the database —
  not the session date. `created_by_advisor_id` is the advisor who **entered**
  the record, distinct from `advisor_id` (who **conducted** the meeting).
- A hardened non-RPC trigger (`set_advising_meeting_created_metadata`,
  `trg_advising_meeting_created_metadata`) is authoritative for creation
  metadata: on authenticated browser INSERT it resolves the ACTIVE advisor
  whose `auth_user_id = auth.uid()` and overwrites any client-supplied creator
  and timestamp; no-auth technical inserts clear any supplied creator,
  writing `created_by_advisor_id = NULL`, and stamp the DB current timestamp.
  UPDATE changes to `created_at`/`created_by_advisor_id`
  are rejected fail-closed. RLS remains the authorization gate — a session
  that cannot resolve an active advisor is denied by the existing INSERT policy.
  `advisor_id` is never touched by the trigger.

Indexed: `student_id`, `meeting_date`, `application_id`,
`(student_id, application_id)`, `(application_id, student_id)` (reverse
composite-FK index), `created_by_advisor_id` (creator index).

This table is also the source for advisor-personalized views such as `My meetings` and the meeting-derived `My students` roster on `/dashboard/account`.

**Append-only history (migration `20260930000003`):** Database RLS allows an
active advisor to `SELECT` and `INSERT` advising meetings only. `UPDATE` and
`DELETE` are denied, with no application-admin policy or other admin bypass.
Meeting rows are historic records: corrections require a new record rather than
altering or removing the original.

**Conducting-advisor guard (historical-integrity remediation):** new
authenticated advising-meeting writes require a non-NULL conducting
`advisor_id` at both the UI and the database boundary. The form defaults to the
authenticated advisor, permits another active advisor, and offers no `None`
option; the recorder remains separately captured as
`created_by_advisor_id`. Legacy/imported rows with `advisor_id IS NULL` are
preserved and never backfilled, and trusted technical/service-role import
paths remain exempt.

---

## `advising_meeting_amendment`

**Purpose:** Records a correction to an advising meeting without mutating or
deleting the historic meeting row. More than one amendment may reference the
same meeting.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `amendment_id` | integer | NO | nextval | **PK** |
| `meeting_id` | integer | NO | — | **FK → `advising_meeting.meeting_id`** |
| `created_by_advisor_id` | integer | NO | database trigger | **FK → `advisor.advisor_id`**; authenticated active creator |
| `created_at` | timestamptz | NO | `now()` | Database-authored entry timestamp |
| `reason` | text | NO | — | Short explanation of why the correction is needed; CHECK: non-empty after trimming whitespace |
| `details` | text | NO | — | Correction details; does not overwrite the original meeting; CHECK: non-empty after trimming whitespace |

**Append-only correction history (migration `20260930000004`):** Database RLS
allows active advisors to `SELECT` and `INSERT` amendment rows only. The
creation trigger replaces any client-supplied creator or timestamp with the
authenticated active advisor and database timestamp. `UPDATE` and `DELETE` are
denied; a correction is represented by another amendment row, never an edit to
the original meeting or an earlier amendment. `reason` and `details` are
enforced non-empty at the database boundary by whitespace-trimming CHECK
constraints (`btrim(column, ' \t\n\r\f\x0b') <> ''` — space, tab, newline,
carriage return, form feed, vertical tab), so a blank or whitespace-only
correction is rejected even on a direct insert while a literal `v` is never
trimmed (PostgreSQL has no `\v` escape; vertical tab is `\x0b`).

Indexed: `(meeting_id, created_at, amendment_id)` (per-meeting retrieval,
chronologically ordered), `created_by_advisor_id`.

---

## `fellowship_thursday`

**Purpose:** Tracks student attendance at the weekly OCF Thursday meeting.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `attendance_id` | integer | NO | nextval | **PK** |
| `student_id` | integer | NO | — | **FK → `student.student_id`** |
| `attended` | boolean | NO | — | |
| `source_info` | varchar | YES | — | CHECK (nullable): `OCF` `HC` `MM` |

**`source_info` codes:** `OCF` = direct OCF referral · `HC` = Honors College · `MM` = McNair / Miami Mosaic

Indexed: `student_id`.

**Append-only base records (historical-integrity remediation):** base
attendance rows are immutable for normal authenticated sessions — `UPDATE` and
`DELETE` access is replaced with explicit active-advisor `SELECT`/`INSERT`
policies only. A correction is appended as a
`fellowship_thursday_amendment` row referencing the original `attendance_id`;
correction rows are **never** independent attendance records. Effective values
drive both the UI and attendance reports through one shared `security_invoker`
boundary: for each corrected field, the newest applicable amendment ordered by
`(created_at, amendment_id)` descending wins, so amendments can never inflate
attendance counts.

The table has **no event/meeting date column**. Whether Fellowship Thursday
needs an event date is a deferred OCF decision — see
[`docs/schema-decisions.md` §9](../docs/schema-decisions.md) — and the schema
is **not** changed until OCF decides; no date is inferred or backfilled.

The archive-parent boundary (migration `20260930000007`) still denies `INSERT`
of a row referencing an archived student.

---

## `fellowship_thursday_amendment`

**Purpose:** Records a correction to one Fellowship Thursday attendance record
without mutating or deleting the historic base row. More than one amendment may
reference the same attendance record.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `amendment_id` | integer | NO | nextval | **PK** |
| `attendance_id` | integer | NO | — | **FK → `fellowship_thursday.attendance_id`** |
| `created_by_advisor_id` | integer | NO | database trigger | **FK → `advisor.advisor_id`**; authenticated active creator |
| `created_at` | timestamptz | NO | `now()` | Database-authored entry timestamp |
| `reason` | text | NO | — | Why the correction is needed; CHECK: non-empty after trimming whitespace |
| `details` | text | YES | — | Correction details; does not overwrite the original record |
| `corrected_attended` | boolean | YES | — | Corrected attendance value; NULL = leave unchanged |
| `corrects_source_info` | boolean | NO | — | Explicit flag: `true` corrects `source_info` to the `corrected_source_info` value (including NULL); `false` leaves `source_info` unchanged |
| `corrected_source_info` | varchar | YES | — | CHECK (when non-NULL): `OCF` `HC` `MM`; only meaningful when `corrects_source_info = true` |

**Append-only correction model:** active advisors have explicit
`SELECT`/`INSERT` RLS policies only — no UPDATE/DELETE grants or policies, and
sequence privileges limited to the intended role. The creation trigger replaces
any client-supplied creator/timestamp with the authenticated **active** advisor
and the database timestamp, rejecting forged audit fields or invalid payloads.
At least one field correction is required
(`corrected_attended` non-NULL or `corrects_source_info = true`), and `reason`
is enforced non-empty by a whitespace-trimming CHECK. A further fix is another
amendment row, never an edit to the original or an earlier amendment.

---

## `scholarship_history`

**Purpose:** Confirmed past fellowship awards — distinct from `application`, which tracks
in-progress pipeline. Only stores fellowships the student has already received.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `history_id` | integer | NO | nextval | **PK** |
| `student_id` | integer | NO | — | **FK → `student.student_id`** |
| `fellowship_id` | integer | NO | — | **FK → `fellowship.fellowship_id`** |

Indexed: `student_id`, `fellowship_id`.

**Append-only base records (historical-integrity remediation):** base award
rows are immutable for normal authenticated sessions — `UPDATE` and `DELETE`
access is replaced with explicit active-advisor `SELECT`/`INSERT` policies
only. A correction or void is appended as a `scholarship_history_amendment`
row referencing the original `history_id`; **Correction** never mutates the
base row, and **Void** is terminal for normal operations (the original award
remains in the audit history but is excluded from active/operational award
counts).

The table has **no award cycle/year column**. Whether historical awards need
an award cycle is a deferred OCF decision — see
[`docs/schema-decisions.md` §9](../docs/schema-decisions.md) — and the schema
is **not** changed until OCF decides; no cycle is inferred or backfilled.

The archive-parent boundary (migration `20260930000007`) still denies `INSERT`
of a row referencing an archived student or fellowship.

---

## `scholarship_history_amendment`

**Purpose:** Records a correction or void of one Scholarship History award
without mutating or deleting the historic base row. More than one amendment may
reference the same award record.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `amendment_id` | integer | NO | nextval | **PK** |
| `history_id` | integer | NO | — | **FK → `scholarship_history.history_id`** |
| `amendment_type` | varchar | NO | — | CHECK: `Correction` or `Void` |
| `created_by_advisor_id` | integer | NO | database trigger | **FK → `advisor.advisor_id`**; authenticated active creator |
| `created_at` | timestamptz | NO | `now()` | Database-authored entry timestamp |
| `reason` | text | NO | — | Why the amendment is needed; CHECK: non-empty after trimming whitespace (every `Correction` and `Void` requires a reason) |
| `details` | text | YES | — | Amendment details; does not overwrite the original award |
| `corrected_fellowship_id` | integer | YES | — | **FK → `fellowship.fellowship_id`**; factual award correction (nullable — not every correction changes the fellowship) |

**Append-only correction/void model:** active advisors have explicit
`SELECT`/`INSERT` RLS policies only — no UPDATE/DELETE grants or policies, and
sequence privileges limited to the intended role. The creation trigger replaces
any client-supplied creator/timestamp with the authenticated **active** advisor
and the database timestamp, rejecting forged audit fields or invalid payloads.
A **Void** remains visible in audit history while excluded from active
operational counts; a **Correction** records a factual change (optionally the
`corrected_fellowship_id`) without touching the base row. A further change is
another amendment row, never an edit to the original award or an earlier
amendment.

---

## `audit_event` — Immutable Audit Trail (migrations `20261012000001` + `20261013000001` + `20261015000002`)

**Purpose:** Immutable, database-authored audit read model for the current-state
`student`, `fellowship`, and `application` rows, trusted `advisor`/
administrator operations (migration `20261013000001`), and historical
base/amendment inserts (migration `20261015000002`). Every INSERT and every
*meaningful* UPDATE of an audited table writes exactly one audit event, inside
the source mutation's own transaction, through an internal `SECURITY DEFINER`
trigger helper. An audit failure aborts the business write; no client code or RPC
can fabricate history.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `audit_id` | bigint | NO | nextval | **PK**; sequence-backed, never exposed to client roles |
| `entity_type` | text | NO | — | CHECK — exactly the ten reserved entity names (below) |
| `entity_id` | integer | NO | — | Immutable historical entity id at event time; **no FK** |
| `action` | text | NO | — | CHECK — exactly the ten reserved actions (below) |
| `actor_advisor_id` | integer | YES | — | Active advisor resolved from `auth.uid()`, or a verified server-supplied trusted actor for service operations; NULL for a technical/system origin |
| `actor_name_snapshot` | text | NO | — | Advisor display name copied at event time (`'System'` for technical writes); a later rename cannot rewrite a prior event |
| `occurred_at` | timestamptz | NO | `now()` | Transaction timestamp of the audited mutation |
| `old_values` | jsonb | YES | — | Whitelisted snapshot BEFORE a meaningful UPDATE; NULL for INSERT |
| `new_values` | jsonb | YES | — | Whitelisted snapshot AFTER the insertion/mutation |
| `changes` | jsonb | YES | — | Only whitelisted fields that differ under `IS DISTINCT FROM`, as `{field: {old, new}}`; NULL for INSERT |
| `reason` | text | YES | — | Human-supplied reason for trusted role/lifecycle actions (required by `set_advisor_role` and `lifecycle_transition`); NULL for ordinary profile/data edits |
| `subject_student_id` | integer | YES | — | Immutable subject student context; **no FK** |
| `subject_application_id` | integer | YES | — | Immutable subject application context; **no FK** |
| `subject_fellowship_id` | integer | YES | — | Immutable subject fellowship context; **no FK** |
| `origin` | text | NO | — | CHECK — exactly `user`, `system`, `migration` |

**CHECK vocabularies.**

- `audit_event_entity_type_check` — exactly `student`, `advisor`, `fellowship`,
  `application`, `advising_meeting`, `advising_meeting_amendment`,
  `fellowship_thursday`, `fellowship_thursday_amendment`, `scholarship_history`,
  `scholarship_history_amendment`.
- `audit_event_action_check` — exactly `created`, `updated`, `archived`,
  `restored`, `deactivated`, `reactivated`, `role_changed`,
  `correction_added`, `voided`, `baseline_captured`.
- `audit_event_origin_check` — exactly `user`, `system`, `migration`.

`student`, `fellowship`, `application`, and `advisor` are wired to triggers;
`created`, `updated`, `archived`, `restored`, `deactivated`, `reactivated`, and
`role_changed` have current-state writers. Since migration `20261015000002` the
historical base inserts (`advising_meeting`, `fellowship_thursday`,
`scholarship_history`) write `created`, and their amendment inserts write
`correction_added` (a Scholarship Void writes `voided`) through
`private.audit_historical_record()`. `baseline_captured` remains reserved
vocabulary with no writer.

**Event semantics.**

- **INSERT** → `old_values`/`changes` are NULL, `new_values` is the explicit
  whitelisted snapshot, `action = 'created'`.
- **UPDATE** → `old_values`/`new_values`/`changes` are populated. `changes`
  contains ONLY whitelisted business fields whose value differs under
  `IS DISTINCT FROM`; a no-op or technical-only update (no whitelisted field
  changed) records nothing.
- **Student/Fellowship lifecycle:** `NULL → non-NULL archived_at` is `archived`;
  `non-NULL → NULL` is `restored`; any other meaningful change is `updated`.
  Application updates are always `updated`.
- **Advisor classification (migration `20261013000001`):** an `is_active`
  transition is `deactivated`/`reactivated`; a role change is `role_changed`
  (written explicitly by the atomic role RPC, which suppresses the trigger for
  that one write); a permitted allowlisted profile edit is `updated`; a
  `last_login_at`-only change writes no event. Advisor snapshots/diffs contain
  ONLY `advisor_name`, `email`, `role`, and `is_active`.
- **Actor/origin:** a non-NULL `auth.uid()` MUST resolve to exactly one ACTIVE,
  pre-bound `public.advisor`; its current `advisor_name` is copied into
  `actor_name_snapshot` and `origin = 'user'`. An authenticated but unresolved
  actor raises `42501` and aborts the source mutation. A trusted service
  operation attributes the event to the server-supplied effective-Admin advisor
  id after revalidating it against durable Auth metadata (transaction-local
  context; no client-reachable actor parameter); `origin = 'user'`. A session
  with no request actor and no trusted context records `actor_advisor_id = NULL`,
  `actor_name_snapshot = 'System'`, `origin = 'system'`.
- Snapshots are EXPLICIT `jsonb_build_object` whitelists (never `to_jsonb(row)`):
  technical, binding, credential, and future columns never enter a snapshot or
  diff. JSON nulls are retained so a change to/from NULL is unambiguous.

**Privacy boundary.** Audit payloads contain only allowlisted business data.
Credentials, passwords, tokens/JWTs, raw Auth metadata or `auth_user_id`,
technical identifiers, the advisor role-lock state, and narrative free-text
(advising `notes`, amendment `reason`/`details`) are structurally excluded — not
redacted at read time — and no snapshot is built from a whole row. Read access is
least-privilege (active advisors only), so audit history exposes no sensitive or
technical field.

**RLS and immutability boundary.**

- RLS is **enabled**; ALL privileges are revoked from `PUBLIC`, `anon`, and
  `authenticated`; only `authenticated` receives `SELECT`. The sole policy
  `audit_event_select_active_advisor` (`FOR SELECT TO authenticated`) gates reads
  on the existing `public.is_active_advisor()` predicate.
- There is **no INSERT/UPDATE/DELETE/TRUNCATE grant or policy** for any product
  role, and sequence usage is revoked, so neither staff nor Admin can write audit
  rows. The only writer is the internal trigger helper.

**Triggers.** Three `private`-schema `SECURITY DEFINER` trigger helpers, each with
`SET search_path = ''` and every relation/function reference schema-qualified.
`PUBLIC`/`anon`/`authenticated` get no `USAGE` on `private` and no `EXECUTE` on
any helper, so none is a Data API RPC and none has a client writer
path.

- `private.audit_current_state_change()` is attached `AFTER INSERT OR UPDATE …
  FOR EACH ROW` on `public.student`, `public.fellowship`, and
  `public.application` (`trg_audit_student_current_state`,
  `trg_audit_fellowship_current_state`,
  `trg_audit_application_current_state`). It reads the transaction-local
  `ocf.audit_reason` setting (published by `lifecycle_transition`) into
  `reason`.
- `private.audit_advisor_change()` is attached `AFTER INSERT OR UPDATE … FOR EACH
  ROW` on `public.advisor` (`trg_audit_advisor_current_state`) with the strict
  advisor allowlist above.
- `private.audit_historical_record()` (migration `20261015000002`) is attached
  `AFTER INSERT … FOR EACH ROW` on `advising_meeting`, `fellowship_thursday`,
  `scholarship_history` (`created`) and their `*_amendment` tables
  (`correction_added`; a Scholarship `Void` is `voided`). Snapshots are explicit
  structural identifiers/context only — narrative `notes`, amendment
  `reason`/`details`, credentials, Auth claims, tokens, and passwords never
  enter a payload, and no historical row is backfilled.

`AFTER` timing follows the existing `BEFORE` lifecycle guards: a denied direct
archive write never reaches the trigger, while a lifecycle transition emits
exactly one canonical archive/restore event. The atomic role RPC suppresses the
advisor trigger for its own role write and emits its single explicit
`role_changed` event, so no duplicate is produced.

**Indexes.** Six chronological B-tree indexes, each ending in a stable
`audit_id DESC` tie-breaker; **no JSONB GIN index** is added by design.

| Index | Columns |
| --- | --- |
| `idx_audit_event_entity_chronology` | `(entity_type, entity_id, occurred_at DESC, audit_id DESC)` |
| `idx_audit_event_actor_chronology` | `(actor_advisor_id, occurred_at DESC, audit_id DESC)` |
| `idx_audit_event_subject_student_chronology` | `(subject_student_id, occurred_at DESC, audit_id DESC)` |
| `idx_audit_event_subject_application_chronology` | `(subject_application_id, occurred_at DESC, audit_id DESC)` |
| `idx_audit_event_subject_fellowship_chronology` | `(subject_fellowship_id, occurred_at DESC, audit_id DESC)` |
| `idx_audit_event_occurred_at_chronology` | `(occurred_at DESC, audit_id DESC)` |

**No-baseline boundary.** No event is created for pre-existing rows.
`baseline_captured` and the `migration` origin are reserved in the CHECK
vocabularies but have **no writer** in this rollout; a baseline may only be
captured by a future, explicitly authorized operation. Rollback is forward-only:
the audit surface is additive and unread by any write path, so application
rollback can simply stop reading it — there is no down migration and no data
reset.

---

## Advisor / Admin Immutable History (migration `20261013000001`)

Extends the immutable-audit core to advisor and administrator operations without
a second audit table or a second authorization system. `public.audit_event`
remains the single protected history surface.

**Advisor audit coverage.** A dedicated internal helper
(`private.audit_advisor_change`, trigger `trg_audit_advisor_current_state` on
`public.advisor`) writes exactly one event per advisor INSERT or meaningful
UPDATE. The snapshot/diff allowlist is exactly `advisor_name`, `email`, `role`,
and `is_active`; binding (`auth_user_id`), login-time (`last_login_at`),
timestamps, Auth claims, tokens, credentials, the legacy `advisor_role_lock`
infrastructure, and any future column are structurally excluded, and a
`last_login_at`-only change writes no event.

**Human attribution across trusted operations.** A service-role operation (the
browser session is lost) passes its already-authorized effective-Admin advisor id
to a service-only routine. `private.assert_durable_effective_admin` revalidates
the id as a current, ACTIVE, pre-bound advisor whose durable Auth metadata
(`auth.users.raw_app_meta_data.ocf_admin`) is the strict JSON boolean `true` —
the same durable authority the last-Admin invariant uses, never the mutable
display role and never a stale JWT. `private.set_audit_actor` stores the verified
id and frozen name in transaction-local context, which cannot leak across
requests and has no client EXECUTE grant. `public.provision_advisor`
(service-role only) INSERTs the advisor row and writes exactly one `created`
event attributed to that Admin in the same transaction, so normal provisioning
is not `System`. Ordinary profile/lifecycle writes still derive the actor from
`auth.uid()`.

**Atomic role change with required reason and expected version.**
`public.set_advisor_role(p_advisor_id, p_role, p_reason, p_actor_id,
p_expected_version)` replaces
the 2-arg form (old signatures dropped, including the legacy 4-arg arity). It requires a non-blank reason,
revalidates the actor, serializes membership-reducing transitions under a fixed
advisory lock, refuses to demote the last active bound durable Admin, and
atomically sets `auth.users.raw_app_meta_data.ocf_admin` and
`public.advisor.role` in one transaction with exactly one explicit
`role_changed` event (the advisor trigger is suppressed for that write). A stale
target `row_version` is rejected with `PT409` before any claim/display change. It never
rebinds and never touches `is_active`/history; EXECUTE is pinned to
`service_role`.

**Lifecycle transition with required reason and expected version.**
`public.lifecycle_transition(p_entity, p_action, p_entity_id, p_reason,
p_expected_version)` replaces
the 3-arg form (old signatures dropped, including the legacy 4-arg arity). The actor remains database-derived from
`auth.uid()` (never a parameter) and authorization stays claim +
active-bound-advisor. Student/fellowship `archive`/`restore` events receive the
reason through the current-state helper; advisor `deactivate`/`reactivate` is
classified by the advisor helper; advisor deactivation is serialized with role
demotion under the same advisory lock and the same last-Admin check, and the
self-deactivation guard is retained. A stale target `row_version` is rejected
with `PT409` before any state change.

**Durable, concurrency-safe last-active-bound-Admin invariant.** Role demotion
and advisor deactivation acquire the same fixed transaction-scoped advisory lock
(`hashtextextended('ocf.advisor_admin_membership', 0)`) before reading
membership, then count ACTIVE, bound advisors joined to
`auth.users.raw_app_meta_data.ocf_admin = true` (strict JSON boolean). A
transition that would take a nonzero membership to zero is rejected (`42501`);
competing final-Admin reductions serialize and cannot interleave. The check does
not repair a pre-existing zero-Admin state (break-glass/DBA recovery remains
outside normal product paths).

**Email read-only in ordinary profile editing.** An advisor's login email is an
Auth identity field. Ordinary profile PATCH accepts `advisor_name` only and
rejects a supplied `email`, so `advisor.email` cannot silently diverge from the
Auth email; a future explicit trusted account-management workflow must update
both together. See
[`docs/schema-decisions.md` §11](../docs/schema-decisions.md#11-advisoradmin-immutable-history-attribution-required-reasons-and-the-durable-last-admin-invariant).

**Authenticated peer display-name update (migrations `20261014000001` +
`20261015000001`).** The
review gap in this change — an effective Admin could previously change a peer's
permitted profile data only through a private SQL session — is closed by the
authenticated-only SECURITY DEFINER RPC
`public.update_advisor_profile_name(p_advisor_id, p_advisor_name,
p_expected_version)`
(`SET search_path = ''`, fully schema-qualified, EXECUTE pinned to
`authenticated`). The actor is `auth.uid()` only and is validated with
`public.is_effective_admin()`; the target must exist and be a **different**
advisor (self updates stay on the self-service profile path). Only
`advisor_name` is written — no email/role/is_active/binding column is reachable
— and the name must be non-blank, trimmed, ≤120 chars, and unique. It requires no
reason (ordinary profile edit, R8) and sets no audit reason context; it does
require the target's `p_expected_version` (stale writes raise `PT409`
unchanged). The
existing `private.audit_advisor_change` trigger therefore emits exactly one
`advisor/updated` event attributed to the acting Admin (`origin = 'user'`,
frozen name) inside the same transaction; a no-op restatement records nothing
via the existing no-op suppression. The consuming API is
`PATCH /api/advisors/[id]` with `{ "advisorName": "…" }`, which calls the RPC
through the admin's own cookie-backed session client (never a service-role
client) and forwards no actor or email. See
[`docs/schema-decisions.md` §12](../docs/schema-decisions.md#12-effective-admin-peer-display-name-update-is-an-authenticated-rpc).

**Preserved unchanged.** Supabase Auth, one-time `auth_user_id` binding, the
`app_metadata.ocf_admin` + active-bound-advisor effective-Admin model, the atomic
role-change boundary, direct lifecycle/role/binding write guards, all RLS
policies, all `audit_event` grants, all FKs (`NO ACTION`), and the legacy
`advisor_role_lock` infrastructure (still infrastructure-only and unaudited). No
down migration is provided.

---

## Protected Expected-Version Writers (migration `20261015000001`)

Database-enforced optimistic concurrency for the four mutable current-state
entities.

**Concurrency metadata.** `student`, `fellowship`, `application`, and `advisor`
each carry `row_version integer NOT NULL DEFAULT 1` and
`updated_at timestamptz NOT NULL DEFAULT now()`. A database-owned
BEFORE INSERT OR UPDATE trigger (`private.set_current_state_row_version`,
`SECURITY INVOKER`, empty `search_path`):
on **INSERT** (migration `20261016000001`) it forces `row_version := 1` and
`updated_at := now()`, overriding any supplied value so the version/timestamp
are always database-authored on creation; on **UPDATE** it compares a strict
per-entity allowlist of meaningful business/lifecycle fields — a semantic change
increments the OLD row version exactly once and stamps `updated_at := now()`,
while a no-op or technical-only restatement preserves both. The technical
columns are deliberately absent from every audit snapshot/diff allowlist, so
their maintenance never creates a visible `audit_event` change.

**Non-bypassable boundary.** The `authenticated` UPDATE table privilege is
revoked on all four tables and every direct authenticated UPDATE RLS policy is
dropped (`active_advisor_update_student`,
`active_advisor_update_fellowship`, `active_advisor_update_application`,
`advisor_update_own_profile`). SELECT and the intended INSERT surfaces retain
their existing RLS. Normal authenticated edits go through narrow, entity-specific
expected-version `SECURITY DEFINER` writers (all with `SET search_path = ''`,
fully qualified references, internal authorization, target row locking,
`p_expected_version` comparison BEFORE any change, and a fixed stale message
raised as `PT409`):

- `public.update_student_profile(p_student_id, p_expected_version, …editable
  student columns…)` — active-advisor student profile edit, returns the display-safe
  projection with its new version;
- `public.update_fellowship(p_fellowship_id, p_expected_version,
  p_fellowship_name)` — active-advisor rename;
- `public.update_application(p_application_id, p_expected_version,
  p_student_id, p_fellowship_id, p_application_year, p_destination_country,
  p_stage_of_application, p_is_semi_finalist, p_is_finalist)` — active-advisor edit;
  an actual parent re-link is validated against the ACTIVE-parent boundary
  (matching the existing invoker-security guard, which the definer path
  otherwise bypasses). Since migration `20261018000001`, that validation locks
  the prospective parent row `FOR UPDATE` and reads its `archived_at` under the
  lock **before** the check, so a concurrent `lifecycle_transition` parent
  archive serializes with the re-link and can never leave an application
  re-linked to a parent archived at commit time (lock order is fixed and
  deadlock-free);
- `public.update_my_advisor_profile(p_expected_version, p_advisor_name)` —
  authenticated self-service advisor display-name edit (actor from `auth.uid()`).

**Versioned extensions of the trusted writers (old signatures dropped).**

- `public.lifecycle_transition(p_entity, p_action, p_entity_id, p_reason,
  p_expected_version)` — every archive/restore/deactivate/reactivate now requires
  the target's expected version (PT409 on staleness, before any state change).
- `public.set_advisor_role(p_advisor_id, p_role, p_reason, p_actor_id,
  p_expected_version)` — service-role-only atomic role change validates the
  target version before the Auth-claim/display write.
- `public.update_advisor_profile_name(p_advisor_id, p_advisor_name,
  p_expected_version)` — effective-Admin peer display-name edit.
- `public.provision_advisor(...)` — stays insert-only (no expected version);
  the created row starts at version 1 and the RPC now returns it.

Malformed expected versions use `22023`; authorization (`42501`) and
missing-row (`P0002`) outcomes remain distinguishable from a conflict. A stale
rejection performs no mutation, no version increment, and no audit event; the
UI must refresh and review rather than retry.

**Positive expected-version validation (migration `20261016000001`).** The
internal `private.assert_expected_version(p_expected_version)` helper raises
`22023` unless the value is a positive integer (`>= 1`) and is called **first**
by every protected existing-row writer (the four entity writers, both
advisor-profile paths, the trusted role change, and the lifecycle transition).
NULL, `0`, and negative values are therefore malformed input (`22023`), distinct
from a genuine stale conflict (`PT409`). The seven public function bodies are
otherwise identical to migration `20261015000001`, so all authorization, lock,
last-Admin, audit, and stale-`PT409` behavior is unchanged.

## Historical Audit + Activity Read Model (migration `20261015000002`)

**Historical base/amendment audit.** The internal SECURITY DEFINER helper
`private.audit_historical_record()` (empty `search_path`, fully qualified, no
client EXECUTE) is attached AFTER INSERT to `advising_meeting`,
`fellowship_thursday`, `scholarship_history` (`created`) and their append-only
`*_amendment` tables (`correction_added`; a Scholarship `Void` is `voided`).
Snapshots are explicit structural identifiers/context only — narrative `notes`,
amendment `reason`/`details`, credentials, Auth claims, tokens, and passwords
are structurally excluded, and no historical row is backfilled. Actor
provenance uses the same trusted resolution as the current-state helpers
(unique active bound advisor from `auth.uid()`, verified transaction-local
trusted actor, or `System`).

**`public.audit_activity` (view).** An explicit-column `security_invoker` view
over `audit_event` exposing only audit-safe event fields (id, occurred_at,
entity type/id, action, actor id, frozen `actor_name_snapshot`, reason, origin,
whitelisted old/new/changes payloads, subject context ids) plus display-safe
student/fellowship labels resolved by correlated scalar subqueries (no row
multiplication, no current advisor join, no Auth-binding column). It is
`SELECT`-only, granted to `authenticated` after revoking `anon`, and remains
governed by the underlying active-advisor audit RLS. Existing chronology indexes
serve all documented access paths (no new index is added).

## Entity Lifecycle & Archive Model (migration `20260930000005`)

Non-destructive, reversible lifecycle behavior for advisors, students, and
fellowships. Normal operations **archive/deactivate** instead of deleting, and
every historical relationship is preserved.

**Single lifecycle representation per entity.**

- `student.archived_at` / `fellowship.archived_at` (timestamptz, nullable):
  `NULL` = **active**; a database-authored timestamp = **archived**. There is no
  redundant status column. Pre-existing rows were never backfilled — they remain
  `NULL` (active), and no historical lifecycle data is guessed.
- `advisor.is_active` (boolean) is retained as the **sole** advisor lifecycle
  representation; there is no advisor `archived_at`.

## Explicit Admin / Advisor Permissions (migrations `20261001000001` + `20261002000001`)

The handoff model has exactly two operational roles. Effective authority is the
conjunction of the trusted Auth claim and an active, pre-bound advisor record —
the protected `advisor.role` display column is never authorization.

- **Effective Admin** = the Auth boolean `app_metadata.ocf_admin = true` claim
  AND a current, active, pre-bound advisor (`advisor.auth_user_id =
  auth.uid()` AND `is_active = true`). `public.is_effective_admin()`
  (SECURITY DEFINER) is the database predicate; the server mirrors it in
  `lib/auth/session.ts` (`isEffectiveAdmin` / `getEffectiveAdmin`), which all
  protected API routes use.
- **`public.is_ocf_admin()`** compares a JSON **boolean** claim: a string
  `"true"` claim is never accepted (strict `auth.jwt() -> 'app_metadata' ->
  'ocf_admin' = 'true'::jsonb`).
- **`advisor.role`** is a protected display projection constrained to exactly
  `Admin` / `Advisor` (CHECK `advisor_role_display_check`, default
  `'Advisor'`). Migration `20261002000001` **reconciles** every advisor row to
  the claim: `Admin` only when their bound `auth.users.raw_app_meta_data`
  `ocf_admin` is the JSON boolean `true`, otherwise `Advisor`. Direct
  authenticated writes are rejected (42501) by the invoker-security guard
  `trg_advisor_role_display`; only trusted `service_role`/DBA sessions (the
  server-only provisioning adapter) may set it. It is never an RLS/RPC
  authorization input.
- **Self-scoped advisor write boundary (migration `20261002000001`):**
  authenticated advisor-row INSERT is denied (`advisor_insert_active_staff`
  dropped) and the UPDATE policy is `advisor_update_own_profile` — an ACTIVE,
  pre-bound advisor may update only their own bound row's allowed profile
  fields. Peer rows are invisible for UPDATE; the `role`/`is_active`/
  `auth_user_id` guards still protect those columns on the self row.
- **Trusted provisioning boundary**: the server-only adapter
  (`lib/provisioning`) is the only caller of the GoTrue Admin API. It
  create/invites the Auth identity with the matching `ocf_admin` boolean,
  binds an unbound advisor row once, and writes the matching display role;
  role changes update Auth metadata first and compensate (best-effort
  rollback to the KNOWN prior claim) if the display write fails — and abort
  with `claim_read_failed` if the prior claim cannot be read (never a guessed
  rollback). No service key ever reaches a client; no email self-link, public
  signup, self-binding, or rebinding exists.
- **ATOMIC role change (migrations `20261007000001` + `20261013000001` +
  `20261015000001`)**: every
  NORMAL trusted role change is a single service-role-only SECURITY DEFINER RPC
  (`set_advisor_role(p_advisor_id, p_role, p_reason, p_actor_id,
  p_expected_version)`) that
  atomically writes the Auth claim
  (`auth.users.raw_app_meta_data.ocf_admin` JSON boolean) AND the protected
  `public.advisor.role` display projection in ONE Postgres transaction — a
  claim/display mismatch is impossible (commit = both consistent; abort =
  neither changed). The migration `20261013000001` extension requires a
  non-blank reason, revalidates the server-supplied actor as a durable active
  bound effective Admin, serializes membership-reducing changes under a fixed
  advisory lock, refuses to demote the last active bound durable Admin, and
  emits exactly one `role_changed` event (the advisor trigger is suppressed for
  that write); migration `20261015000001` additionally requires the target's
  expected `row_version` (stale → `PT409`). The old 2-arg/legacy-4-arg
  signatures are dropped. The trusted provisioning
  adapter calls this RPC; browser clients cannot (EXECUTE pinned to
  service_role). The earlier per-advisor
  lease/fencing/saga machinery (migrations `20261003000001`–`20261006000001`)
  is RETAINED but NOT relied on by the normal flow. `set_advisor_role` is the
  single role-changing writer: the two legacy direct-write display-role RPCs
  (`fenced_write_advisor_role_display` and `reconcile_advisor_role_display`)
  were DECOMMISSIONED (EXECUTE revoked, then DROP) in migration
  `20261013000001`, and the legacy `recoverAdvisorRoleChange` adapter recovery
  path no longer exists. The retained `advisor_role_lock` infrastructure is
  lease/acquire/release/verify/fenced-read only and writes no advisor state:
  the server-only lease table (RLS enabled with no policies, privileges revoked
  from anon/authenticated, granted to service_role; FK stays the default
  `NO ACTION`) is granted by `acquire_advisor_role_lock` before any
  read/mutation; a contending operation on another instance fails safely with
  `lock_busy` and mutates nothing; the lease is released reliably on success
  AND failure (a `finally`) and is holder-scoped; a crashed holder is recovered
  after the bounded lease (60s) expires (`acquire_advisor_role_lock` takes over
  expired leases). The read-only primitives `verify_advisor_role_lock` (holder
  ownership check) and `fenced_read_advisor_role_display` (the current display
  role only while the caller's holder owns a non-expired lease) provide fenced
  reads without writing display state. The acquire/release/verify/fenced-read
  RPCs are SECURITY DEFINER with service_role-pinned EXECUTE.
- **Protected API**: `GET/POST /api/advisors` and
  `GET/PATCH /api/advisors/[id]` are effective-Admin-only. `PATCH` accepts
  `role` OR `isActive` — a combined payload is rejected with 400 before any
  state change. Role changes go through the trusted adapter; active-state
  changes go through the established `lifecycle_transition` RPC (via the
  admin's own session), preserving the self-deactivation guard.
  `auth_user_id` is never accepted by any route, so no API path can rebind a
  binding.
- **First effective Admin — trusted out-of-band bootstrap
  (historical-integrity remediation):** because the protected provisioning API
  is effective-Admin-only, a fresh environment **cannot create its own first
  effective Admin through the application**. The first effective Admin is
  bootstrapped out of band by a trusted FGCU IT operator using the service role
  / Supabase Admin API, **after** the full migration chain is applied:
  (1) create the Auth user for a confirmed FGCU email with
  `app_metadata.ocf_admin = true` and capture the returned `user.id`;
  (2) pre-bind that exact UUID to the **active** `public.advisor` row's
  `auth_user_id` (one-time bind) and set the `Admin` display role from the
  trusted session; (3) verify the first Admin can sign in — the pre-bound UUID
  resolves the active advisor row, and the strict-boolean `ocf_admin` claim
  grants effective admin. This is trusted-operator guidance only: **no public
  bootstrap endpoint is added**, and the service-role secret is never
  committed, logged, or sent to the browser. After the first effective Admin
  exists, every subsequent advisor is provisioned through the ordinary
  protected `/api/advisors` (effective-Admin-only) workflow.

**Admin authority is the Auth JWT plus an ACTIVE bound advisor identity.**

- Lifecycle authorization requires **both**:
  1. the immutable Auth `app_metadata` claim `ocf_admin = true`
     (`public.is_ocf_admin()`). Users cannot edit `app_metadata` through
     standard client APIs. The mutable `public.advisor.role` column is **never**
     authorization, because active advisors can mutate it; and
  2. a **current, active, pre-bound advisor identity**: an `advisor` row with
     `auth_user_id = auth.uid()` **and** `is_active = true` (migration
     `20260930000007`). A deactivated administrator (their bound advisor row is
     inactive) is denied **every** transition with 42501 — so a deactivated
     administrator can never reactivate their own advisor row and defeat
     deactivation. There is no email linking and no self binding: the identity
     binding is admin-only provisioning, and the RPC only reads it.

**The lifecycle RPC is the only normal transition path.**

- `public.lifecycle_transition(p_entity, p_action, p_entity_id, p_reason,
  p_expected_version)` (SECURITY DEFINER, migration-owned, empty `search_path`) is the only normal
  writer of lifecycle state; the earlier 3-arg/4-arg signatures are dropped. It:
  - requires a non-blank human `reason` (`22023` otherwise), stored once on the
    emitted `audit_event`;
  - derives the actor **exclusively** from `auth.uid()` — never from a
    parameter — and rejects technical (`service_role`/DBA) sessions that carry
    no JWT subject, so every transition is attributable to a specific
    authenticated administrator;
  - requires `public.is_ocf_admin()` = true **and** the session's bound advisor
    row to be currently ACTIVE (the deactivated-admin gate above);
  - enforces the durable last-active-bound-Admin invariant for advisor
    deactivation (shared fixed advisory lock with role demotion), rejecting a
    transition that would leave zero ACTIVE, bound, durable Auth-`ocf_admin`
    admins (`42501`), including under concurrency;
  - accepts only the whitelisted transitions `student`/`fellowship`
    `archive` | `restore` (stamps/clears `archived_at := now()`) and `advisor`
    `deactivate` | `reactivate` (sets `is_active`); anything else fails closed;
  - is **idempotent** — a transition that would leave the row in its current
    state is a no-op (`applied = false`) that returns the unchanged resulting
    state, and each target row is locked (`FOR UPDATE`) so concurrent
    transitions cannot race;
  - **expected version (migration `20261015000001`)**: the caller supplies the
    target's `row_version` as `p_expected_version`; a mismatch raises `PT409`
    before any state change (no mutation, no version bump, no audit event), and
    the returned state includes the row's new version;
  - **self-deactivation guard**: rejects deactivating the advisor row bound to
    the caller's own `auth_user_id` while it is active. That transition would
    immediately strand the acting administrator (their session is denied by
    `is_active_advisor()` / `requireAdvisor`), so a second administrator must
    deactivate an administrator's account. Reactivating your own row is only
    possible while you are yourself an ACTIVE bound advisor — never after
    deactivation (the active-bound gate above already rejects a deactivated
    administrator's session before any transition).

**Direct writes are guarded.**

- Column-scoped invoker-security triggers
  (`trg_student_archived_at_lifecycle`,
  `trg_fellowship_archived_at_lifecycle`,
  `trg_advisor_is_active_lifecycle`) reject direct authenticated `INSERT`/
  `UPDATE` of the lifecycle fields (`student.archived_at`,
  `fellowship.archived_at`, `advisor.is_active`) — including peer deactivation
  through the broad active-staff advisor UPDATE policy. Only the SECURITY
  DEFINER RPC (owned by the migration owner) or a trusted `service_role`/DBA
  session may write them. RLS remains the first gate; the triggers close the
  remaining lifecycle-field paths fail-closed. No-op restatements of the
  current value and ordinary non-lifecycle updates to other columns are
  unaffected.

**Archive-parent child boundary (migration `20260930000007`).**

- The database boundary — not just UI filters — rejects **new operational
  child records** that reference archived students/fellowships. Column-scoped
  invoker-security triggers on the four operational child tables
  (`application`, `advising_meeting`, `fellowship_thursday`,
  `scholarship_history`) deny, fail-closed with 42501 for every non-trusted
  session:
  - `INSERT` of a child referencing an archived `student` and/or `fellowship`;
  - `UPDATE` that **re-links** a child to an archived parent (the FK value
    actually changes to an archived target).
- Preserved behavior:
  - historical **reads** of children referencing archived parents are never
    touched (no RLS change);
  - `UPDATE`s that do not change the reference columns never fire the triggers,
    so historical records that point at an archived parent stay editable;
  - re-linking a child **away** from an archived parent to an ACTIVE parent is
    always allowed;
  - all non-archived workflows (children referencing active parents) are
    unaffected;
  - trusted `service_role` / DBA sessions are exempt (synthetic-fixture
    seeding, cleanup, and trusted data fixes) — the boundary targets
    browser/authenticated sessions.

**Active-workflow vs historical-view invariant.**

- Active operational lists and creation selectors **exclude** archived students
  and fellowships (`archived_at IS NULL`) and inactive advisors.
- Historical detail, application, student, report, and join views **retain**
  archived/inactive context: archived rows stay reachable and render an
  Archived/Inactive state. Archive state never hides established history, and
  an explicit archive filter allows restore without making archived records
  unreachable.

**Non-cascading FKs preserved.**

- No FK definition was changed. Every foreign key keeps the default
  **NO ACTION** semantics, and no archive/deactivate/restore action deletes,
  nulls, or cascades historical relationships (applications, advising meetings,
  amendments, Thursday attendance, scholarship/award history). Archive of a
  parent is not blocked by its children — it only marks state; the children and
  their links remain intact.

**Forward-only operational limitation.**

- The migration is additive and forward-only: no existing migration, table,
  column, row, FK, or RLS policy is edited, deleted, or reset, and there is no
  down migration. It is idempotent on re-apply. A defect is corrected with a
  follow-up migration/RPC revision that never deletes historical entities and
  never changes FKs to cascade.

**DELETE lockdown (follow-up `20260930000006`).**

- The follow-up migration `20260930000006_core_history_delete_lockdown` closes
  the remaining authenticated DELETE path for the four core historical
  entities at both the grant and RLS layers: it revokes the `DELETE` table
  privilege from `authenticated` on `advisor`, `student`, `fellowship`, and
  `application`; replaces the FOR ALL active-advisor policies on `student`,
  `fellowship`, and `application` with explicit SELECT / INSERT / UPDATE
  policies that carry no DELETE; and drops `advisor_delete_active_staff`.
  `service_role` / DBA grants are untouched, so trusted fixture
  seeding/cleanup and contract-test paths keep working. Authenticated `DELETE`
  intentionally remains only on the non-historical operational rows
  `fellowship_thursday` and `scholarship_history`. (The historical-integrity
  remediation subsequently makes those base rows append-only as well — see the
  `fellowship_thursday` / `scholarship_history` sections above.)

---

## Entity-Relationship Diagram

```text
advisor (1) ──────────────────────────────────────────┐
        │                                             │ advisor_id (nullable,
        │ created_by_advisor_id (nullable, creator)   │ who conducted)
        │                                             ▼
        │                             student (1) ─── advising_meeting (N)
fellowship (1) ────────────────┐            │                │
        │       fellowship_id   │            │                └── application_id (nullable;
        │                       ▼            │                    NULL = General Advising)
        │               application (N) ─────┘
        │                    │        ▲
        │                    │        └── composite FK (application_id, student_id)
        │                    │            → application UNIQUE (application_id, student_id)
        ├──── fellowship_thursday (N) ──── fellowship_thursday_amendment (N, append-only corrections)
        └──── scholarship_history (N) ──── fellowship (1)
              └──── scholarship_history_amendment (N, append-only Correction / Void)
```

---

## Migrations

| File | What it does |
| --- | --- |
| `20260305000000_initial_schema.sql` | Creates all 7 tables, 7 sequences, all indexes, enables RLS |
| `20260305000001_allow_anon_read.sql` | Temporary bootstrap anon-role `SELECT` on every table + `USAGE` on schema |
| `20260305000002_allow_anon_write.sql` | Temporary bootstrap anon-role `INSERT`, `UPDATE`, `DELETE` on every table + `USAGE`/`SELECT` on all sequences |
| `20260317000003_advisor_auth.sql` | Extends `advisor` for auth linkage, active status, role, timestamps, and helper logic |
| `20260317000004_active_advisor_rls.sql` | Removes anon access and enables authenticated active-advisor policies |
| `20260318000001_advisor_self_activation_lockdown.sql` | Removes the email self-link escalation path; adds the one-time-bind guard, active-staff-only update policy, and case-insensitive advisor-email uniqueness |
| `20260929000001_advising_application_link.sql` | Forward-only advising↔application link: adds nullable `application.application_year` (cycle), `UNIQUE (application_id, student_id)` as the composite-FK target, nullable `advising_meeting.application_id` with direct + composite FKs, `created_at` + nullable `created_by_advisor_id` with the hardened non-RPC creation-metadata trigger, and advising indexes |
| `20260930000002_advising_application_fk_indexes.sql` | Adds `advising_meeting(application_id, student_id)` to cover reverse composite-FK checks and `advising_meeting(created_by_advisor_id)` for creator-FK checks |
| `20260930000003_advising_meeting_append_only.sql` | Makes `advising_meeting` append-only under database RLS: active advisors can SELECT and INSERT; UPDATE and DELETE are denied without an admin bypass |
| `20260930000004_advising_meeting_amendments.sql` | Adds append-only, active-advisor-only amendment records linked to historic advising meetings; creator and timestamp are database-authored; trim-aware nonempty `reason`/`details` CHECK constraints; retrieval index on `(meeting_id, created_at, amendment_id)` |
| `20260930000005_entity_lifecycle_archiving.sql` | Non-destructive lifecycle model: nullable `student.archived_at` / `fellowship.archived_at` (+ indexes), trusted `is_ocf_admin()` Auth-`app_metadata` predicate, admin-only idempotent `lifecycle_transition` RPC (archive/restore student & fellowship, deactivate/reactivate advisor), and column-scoped direct-write guards on `archived_at`/`is_active`; all FKs stay `NO ACTION` |
| `20260930000006_core_history_delete_lockdown.sql` | Revokes the `authenticated` DELETE table privilege on `advisor`/`student`/`fellowship`/`application`; replaces the FOR ALL active-advisor policies on `student`/`fellowship`/`application` with explicit SELECT/INSERT/UPDATE policies (no DELETE) and drops `advisor_delete_active_staff`; leaves append-only meetings/amendments and the non-historical operational rows `fellowship_thursday`/`scholarship_history` (authenticated DELETE retained) untouched; `service_role`/DBA grants unchanged |
| `20260930000007_lifecycle_review_remediation.sql` | Review remediation: replaces `lifecycle_transition` so it requires a current ACTIVE bound advisor (`advisor.auth_user_id = auth.uid()` AND `is_active = true`) in addition to the `ocf_admin` JWT claim (a deactivated administrator cannot self-reactivate); adds invoker-security archive-parent guard triggers/functions on `application`/`advising_meeting`/`fellowship_thursday`/`scholarship_history` that reject (42501) INSERT of children referencing archived students/fellowships and UPDATE re-links to archived parents while preserving historical reads, non-reference updates, and trusted `service_role`/DBA sessions |
| `20261001000001_explicit_admin_advisor_permissions.sql` | Explicit Admin/Advisor model: normalizes `advisor.role` to exactly `Admin`/`Advisor` (+ CHECK + `'Advisor'` default), hardens `is_ocf_admin()` to a strict JSON-boolean claim, adds the effective-Admin predicate `is_effective_admin()` (claim + active bound advisor), and adds the invoker-security `trg_advisor_role_display` guard denying direct authenticated role writes (self/peer, and creating `Admin` rows); preserves lifecycle/immutable-history guards |
| `20261002000001_advisor_self_service_role_reconciliation.sql` | Review remediation: drops the broad authenticated `advisor_insert_active_staff` policy (no advisor-row creation via the client), replaces `advisor_update_active_staff_only` with the self-scoped `advisor_update_own_profile` UPDATE policy (an active, pre-bound advisor may update only their own bound row), and reconciles every `advisor.role` to the Auth claim (`Admin` only when `auth.users.raw_app_meta_data.ocf_admin` is the JSON boolean `true`, otherwise `Advisor`); preserves one-time binding, role/lifecycle guards, and immutable history |
| `20261003000001_advisor_role_change_lock.sql` | Review remediation: adds the server-only per-advisor role-change lease `advisor_role_lock` (RLS enabled, no policies; anon/authenticated revoked, service_role granted; FK stays NO ACTION) and the SECURITY DEFINER `acquire_advisor_role_lock` / `release_advisor_role_lock` RPCs — atomic lease grant with bounded stale-lock recovery (expired leases are taken over) and holder-scoped release — so concurrent trusted role changes are serialized cross-instance and a contender fails safely without mutation |
| `20261004000001_advisor_role_fenced_write.sql` | Superseded P1 remediation (legacy; its direct-write RPC was decommissioned by `20261013000001`): `fenced_write_advisor_role_display` was a lease-fenced writer of the `advisor.role` display projection — it atomically verified (with a lease-row lock) that the caller's holder still owned a NON-EXPIRED lease before writing. Because it wrote only the mutable display projection (never the durable Auth claim), carried no human actor/reason, and performed no last-Admin check, `20261013000001` decommissioned it (EXECUTE revoked, then DROP). The read-only `verify_advisor_role_lock` ownership check is retained (SECURITY DEFINER, service_role-pinned EXECUTE) as holder-aware compensation infrastructure |
| `20261005000001_advisor_role_fenced_read.sql` | Final P1 remediation: `fenced_read_advisor_role_display` returns the CURRENT `advisor.role` ONLY while the caller's holder owns a NON-EXPIRED lease (lease-row locked, atomic with the lock lifecycle). The trusted adapter reconciles an UNKNOWN/lost fenced-write outcome by exact read-back BEFORE any compensation: matching role = safe reconciled success (claim kept); non-matching = compensate only then; NULL (lease lost) = `lock_lost`; read-back unavailable = `reconciliation_required` (no guessed rollback). SECURITY DEFINER, service_role-pinned EXECUTE |
| `20261006000001_advisor_role_display_reconcile.sql` | Superseded P1 remediation (legacy; decommissioned by `20261013000001`): `reconcile_advisor_role_display` was a lease-fenced display-role alignment to the authoritative Auth claim, but it wrote only the mutable display projection with no human actor/reason and no last-Admin check, so `20261013000001` decommissioned it (EXECUTE revoked, then DROP) |
| `20261007000001_atomic_advisor_role_change.sql` | FUNDAMENTAL FINAL P1 remediation: `set_advisor_role(advisor_id, role)` is a NARROW service-role-only SECURITY DEFINER RPC that validates the role (Admin/Advisor), locks the target advisor row, verifies it exists and is BOUND, then in ONE Postgres transaction sets `auth.users.raw_app_meta_data.ocf_admin` to the matching JSON boolean AND `public.advisor.role` to the display projection — a claim/display mismatch is IMPOSSIBLE (commit = both consistent; abort = neither changed). This is the ONLY normal role-change path; the trusted adapter calls it and clients cannot. Never rebinds, never touches `is_active`/history |
| `20261008000001_historical_integrity_remediation.sql` | Historical integrity remediation: adds the append-only `fellowship_thursday_amendment` / `scholarship_history_amendment` tables (database-authored creator/timestamp; a scholarship `Void` is terminal and stays auditable); locks `fellowship_thursday` and `scholarship_history` base rows down to active-advisor SELECT/INSERT only; adds the `effective_fellowship_thursday` / `effective_scholarship_history` SECURITY INVOKER views; expands `stage_of_application` to nine named stages with an exact stage/`is_semi_finalist`/`is_finalist` consistency CHECK and bounds `application_year` to `NULL` or `2000–2100`; and requires a conducting `advisor_id` on new authenticated `advising_meeting` inserts while preserving legacy `NULL` rows |
| `20261009000001_scholarship_void_serialization.sql` | Scholarship terminal-`Void` serialization (review finding 3 of `2026-10-06-historical-integrity-remediation`): the first action of `set_scholarship_history_amendment_metadata()` on INSERT is now an exclusive `SELECT … FOR UPDATE` lock on the parent `public.scholarship_history` row, so concurrent amendments for the same award serialize on that lock and a loser re-evaluates the terminal-`Void` `EXISTS` guard against the committed state and is rejected (two concurrent Voids, or a Void racing a Correction, can no longer both commit); adds the partial unique index `uidx_scholarship_history_amendment_single_void` (at most one `Void` per award) as a declarative backstop that cannot be bypassed by trigger ordering, failing loudly if history is already inconsistent rather than normalizing; preserves the append-only SELECT/INSERT model, the SECURITY DEFINER trigger with empty `search_path`, service_role-only EXECUTE, RLS, and the effective-value views |
| `20261010000001_security_invoker_list_views.sql` | Read-only `SECURITY INVOKER` list views (`student_list`, `application_list`, `advising_meeting_list`, `fellowship_thursday_list`, `scholarship_history_list`, `fellowship_list`): explicit columns only (no Auth binding fields), correlated scalar subqueries/EXISTS (never row-multiplying joins), corrected/void-aware by reading the `effective_*` views, and `SELECT`-only granted to `authenticated` |
| `20261011000001_scholarship_history_operational_summary.sql` | RLS-preserving `SECURITY INVOKER` aggregate `scholarship_history_operational_summary(p_search, p_fellowship_id)` returning the exact non-void award and distinct-student totals over the same filters as the paginated list, without shipping rows to the client; EXECUTE pinned to `authenticated` |
| `20261012000001_immutable_audit.sql` | Immutable audit trail: `public.audit_event` (CHECK-vocabulary entity/action/origin, explicit jsonb snapshots/diffs, context columns with no FKs), six `audit_id DESC` chronology indexes, RLS with `SELECT`-only active-advisor access and no product-role writer, the `private.audit_current_state_change()` SECURITY DEFINER helper (`SET search_path = ''`, fully qualified), and `AFTER INSERT/UPDATE` triggers on `student`/`fellowship`/`application`; `baseline_captured`/`migration` are reserved with no writer |
| `20261013000001_advisor_admin_immutable_history.sql` | Advisor/admin immutable audit extension: adds the `private.audit_advisor_change()` trigger + `trg_audit_advisor_current_state` on `advisor` with a strict positive allowlist (`advisor_name`/`email`/`role`/`is_active`; binding/claim/token/login-time/role-lock excluded; `last_login_at`-only writes none); trusted-actor validation `private.assert_durable_effective_admin` + transaction-local `private.set_audit_actor`; service-role-only `provision_advisor` (audited `created` attributed to the initiating Admin); replaces `set_advisor_role` (4-arg, required non-blank reason, verified actor, atomic Auth-claim + display write, one explicit `role_changed`) and `lifecycle_transition` (4-arg, required non-blank reason, reason propagated to lifecycle events); and a shared transaction advisory lock enforcing the durable concurrency-safe last-active-bound-Admin invariant for role demotion and advisor deactivation; `audit_current_state_change` re-created only to read `ocf.audit_reason`; decommissions the two legacy direct-write display-role RPCs `fenced_write_advisor_role_display`/`reconcile_advisor_role_display` (EXECUTE revoked, then DROP), leaving `set_advisor_role` as the **single role-changing writer** while the `advisor_role_lock` lease and its read-only `verify`/fenced-read primitives are preserved |
| `20261014000001_advisor_admin_profile_name.sql` | Closes the review gap in the advisor/admin immutable-history change by adding the authenticated-only SECURITY DEFINER RPC `public.update_advisor_profile_name(p_advisor_id, p_advisor_name)` (`SET search_path = ''`, fully qualified, EXECUTE revoked from `PUBLIC`/`anon`/`service_role` and granted to `authenticated`): an effective Admin (`public.is_effective_admin()`; actor derived from `auth.uid()` only, never a parameter, so a service/technical session is rejected 42501) updates **another** advisor's permitted profile display name. Writes ONLY `advisor.advisor_name` (no email/role/is_active/binding parameter; the existing invoker-security email guard is untouched), requires no reason (ordinary profile edit, R8), refuses the caller's own row, and validates target existence, non-blank trimmed ≤120-char name, and unique name. The single `UPDATE` lets the existing `private.audit_advisor_change` trigger emit exactly one `advisor/updated` event attributed to the acting Admin in the same transaction (a no-op writes none). Additive only; no prior migration, policy, grant, trigger, or audit row is weakened, and no down migration is provided |
| `20261015000001_protected_current_state_writers.sql` | Protected expected-version writers: adds `row_version`/`updated_at` to `student`/`fellowship`/`application`/`advisor` with the `private.set_current_state_row_version` semantic BEFORE UPDATE trigger (strict meaningful-field allowlist; exactly one version increment per semantic write; no-op/technical restatements preserve both values; technical columns excluded from audit snapshots/diffs). Adds narrow expected-version RPCs (`update_student_profile`, `update_fellowship`, `update_application`, `update_my_advisor_profile`) and versioned replacements of `lifecycle_transition` (5-arg), `set_advisor_role` (5-arg), and `update_advisor_profile_name` (3-arg) — old signatures dropped — plus `provision_advisor` returning version 1. Stale expected versions raise fixed `PT409` before any change (no mutation/version bump/audit event); 22023 for malformed versions. Revokes the authenticated UPDATE table privilege on the four current-state tables and drops their UPDATE policies, making the precondition non-bypassable for authenticated sessions |
| `20261015000002_historical_audit_activity.sql` | Historical audit + activity read model: `private.audit_historical_record()` (SECURITY DEFINER, empty `search_path`) attached AFTER INSERT to `advising_meeting`/`fellowship_thursday`/`scholarship_history` (`created`) and their `*_amendment` tables (`correction_added`; a Scholarship `Void` is `voided`) with explicit structural-only snapshots (never notes/amendment reason/details/credentials). Adds the explicit-column `security_invoker` view `public.audit_activity` (audit-safe fields + correlated student/fellowship labels, `actor_name_snapshot`, no Auth-binding columns) with SELECT granted to `authenticated` only; underlying active-advisor audit RLS governs. No vocabulary/CHECK/index change was required — existing chronology indexes serve the documented access paths |
| `20261016000001_insert_metadata_and_positive_version.sql` | Closes two review findings: (1) `private.set_current_state_row_version` gains an INSERT branch forcing `row_version := 1`/`updated_at := now()` (overriding any supplied value) and the four current-state triggers are re-created as BEFORE INSERT OR UPDATE; (2) `private.assert_expected_version(integer)` raises `22023` unless `p_expected_version >= 1` and is called first by every protected existing-row writer (four entity writers, both advisor-profile paths, `set_advisor_role`, and `lifecycle_transition`). The seven public bodies are otherwise byte-for-byte identical to `20261015000001`, so all UPDATE semantics, authorization, locking, last-Admin, audit, and stale-`PT409` behavior is preserved. Additive/replacement definitions only; nothing is edited, deleted, or reset, and there is no down migration |
| `20261017000001_revoke_advising_meeting_truncate.sql` | Forward-only, privilege-only closure of the normal-role `TRUNCATE` bypass on the advising history surfaced by `tests/contract/historical-audit-activity.test.ts`: `REVOKE TRUNCATE ON public.advising_meeting, public.advising_meeting_amendment FROM PUBLIC, anon, authenticated`. TRUNCATE is a destructive SQL path the local Supabase default privileges grant to `authenticated`/`anon` for newly created objects, so a normal PostgREST-role session could have wiped the entire advising history even though row-level UPDATE/DELETE were denied. This applies the same closure the sibling historical tables received in `20261008000001`. The trusted `service_role` grant is left untouched; no append-only SELECT/INSERT behavior, RLS policy, audit trigger, business row, or audit row is changed. Forward-only; no down migration |
| `20261018000001_lock_application_relink_parents.sql` | **Final migration.** Forward-only, additive/replacement migration closing a concurrency (TOCTOU) finding on `historical-audit-timeline`: `public.update_application` (the expected-version writer from `20261015000001`, carried forward by `20261016000001`) now locks the prospective parent row `FOR UPDATE` and reads its `archived_at` under that lock **before** the ACTIVE-parent check, but only when an actual parent re-link changes the reference. Because a concurrent `public.lifecycle_transition` archive takes `FOR UPDATE` on the same parent row, an archive and a re-link now serialize — the archive either commits first (the re-link observes an archived parent and is rejected `42501`) or waits until the re-link commits (the parent was still active). Lock order is fixed (application, then prospective student, then prospective fellowship) and no path locks a parent before an application, so the added parent locks cannot deadlock. Only the parent-validation block changes; authorization (`is_active_advisor`, `42501`), the expected-version precondition (`assert_expected_version`, `22023`), the stale `PT409`, the missing-row `P0002`, the permitted fields, the return projection, the revoked direct authenticated UPDATE boundary, and every ACL/RLS policy are identical to `20261016000001`. The REVOKE/GRANT pair is restated for self-documentation. No existing business row, policy, grant, or audit row is edited, deleted, or reset. Forward-only; no down migration |

Migrations 2 and 3 are temporary bootstrap steps. The chain must be applied in
order and ends with `20261018000001_lock_application_relink_parents.sql`.
`20260318000001_advisor_self_activation_lockdown.sql` is required and must
follow `20260317000004_active_advisor_rls.sql`; the forward-only
`20260929000001_advising_application_link.sql` extends the model afterwards,
`20260930000002_advising_application_fk_indexes.sql` adds its supporting
indexes, `20260930000005_entity_lifecycle_archiving.sql` adds the
non-destructive lifecycle model,
`20260930000006_core_history_delete_lockdown.sql` revokes authenticated
DELETE on the core historical entities,
`20260930000007_lifecycle_review_remediation.sql` hardens the lifecycle RPC
with the active-bound-advisor requirement and adds the archive-parent child
boundary, `20261001000001_explicit_admin_advisor_permissions.sql` adds the
explicit Admin/Advisor display-role model with the strict-boolean effective-Admin
predicate and trusted provisioning boundary, and
`20261002000001_advisor_self_service_role_reconciliation.sql` closes the broad
authenticated advisor INSERT/peer UPDATE paths (self-scoped own-profile UPDATE
only) and reconciles the display role to the Auth claim, and
`20261003000001_advisor_role_change_lock.sql` serializes concurrent trusted role
changes with a durable per-advisor database lease, and
`20261004000001_advisor_role_fenced_write.sql` fences the protected display-role
write to the current non-expired lease holder, and
`20261005000001_advisor_role_fenced_read.sql` adds a fenced read-back so an
unknown/lost write outcome is reconciled by exact display-role read-back (never
a guessed Auth rollback), and `20261006000001_advisor_role_display_reconcile.sql` adds a durable
lease-fenced reconciliation (retained as a legacy primitive), and
`20261007000001_atomic_advisor_role_change.sql` makes every normal role change a
single atomic service-role RPC that sets the Auth claim and the display
projection in one transaction — no lease/network timing can leave a
claim/display mismatch, and
`20261008000001_historical_integrity_remediation.sql` makes Fellowship Thursday
and Scholarship History base rows append-only (corrections/voids are appended
via their amendment tables, with a terminal `Void` excluded from the effective
views), hardens the application stage/flag/year invariants, and requires a
conducting `advisor_id` on new authenticated advising meetings, and
`20261009000001_scholarship_void_serialization.sql` closes the terminal-`Void`
race by locking the parent `scholarship_history` row in the amendment trigger
before the guard (concurrent amendments for one award serialize) and adding a
partial unique index that allows at most one `Void` per award, and
`20261010000001_security_invoker_list_views.sql` adds one read-only,
explicit-column, `SECURITY INVOKER` list view per operational list (RLS
preserved, no Auth binding fields, no row multiplication), and
`20261011000001_scholarship_history_operational_summary.sql` adds the
`SECURITY INVOKER` aggregate that returns the operational Scholarship History
totals without shipping rows to the client, and
`20261012000001_immutable_audit.sql` adds the immutable, database-authored
`public.audit_event` read model plus the internal `SECURITY DEFINER` trigger on
`student`/`fellowship`/`application` (SELECT-only for active advisors; no client
writer; no baseline rows), and
`20261013000001_advisor_admin_immutable_history.sql` extends the same
`audit_event` model to `advisor`/administrator operations with a strict positive
allowlist, trusted human attribution, required role/lifecycle reasons, audited
`provision_advisor` creation, and the durable concurrency-safe
last-active-bound-Admin invariant, and
`20261014000001_advisor_admin_profile_name.sql` closes the review gap by adding
the authenticated-only effective-Admin `update_advisor_profile_name` RPC for a
peer's permitted profile display name (actor derived from `auth.uid()`, no email,
no reason, one attributed `updated` event); none of these alters the auth steady
state. `20261015000001_protected_current_state_writers.sql` adds the
`row_version`/`updated_at` concurrency metadata and replaces every normal
authenticated current-state write with an expected-version RPC (revoking the
direct authenticated UPDATE grant/policies), and
`20261015000002_historical_audit_activity.sql` extends the immutable audit to
historical base/amendment inserts and adds the explicit-column
`security_invoker` `audit_activity` read view, and
`20261016000001_insert_metadata_and_positive_version.sql` forces
`row_version`/`updated_at` to be database-authored on every INSERT and requires
every expected version to be a positive integer, and
`20261017000001_revoke_advising_meeting_truncate.sql` closes the normal-role
`TRUNCATE` bypass on the append-only `advising_meeting`/
`advising_meeting_amendment` history (matching the sibling historical tables
closed in `20261008000001`) with no SELECT/INSERT, RLS, trigger, or data change, and
`20261018000001_lock_application_relink_parents.sql` serializes an
`update_application` parent re-link against a concurrent
`lifecycle_transition` parent archive by locking the prospective parent row
`FOR UPDATE` before the ACTIVE-parent check (only when the reference actually
changes), so a re-link can never commit pointing at a parent archived at commit
time; the lock order is fixed and deadlock-free, and only the parent-validation
block changes.

**Migration/history limits for `20260929000001`:** the migration is additive
and forward-only — no existing migration, table, column, row, or RLS policy is
edited, deleted, or reset, and there is no down migration. When applied it
preserves every historic NULL: existing `application` rows keep
`application_year = NULL` (the cycle is never inferred), and existing
`advising_meeting` rows keep `application_id = NULL` and
`created_by_advisor_id = NULL` while receiving the migration-time timestamp
in `created_at` — documented migration-time metadata, never a fabricated
original entry time. `meeting_date` is unchanged. Historic creator identity is
never backfilled.

Steady state after the full chain: authenticated active advisors only, with
admin-only `advisor.auth_user_id` binding. Lifecycle state is written only
through the admin-only `lifecycle_transition` RPC, authorized by the immutable
Auth `app_metadata.ocf_admin = true` claim **plus** a current ACTIVE bound
advisor identity — never by the mutable `advisor.role` column or direct client
writes, and never by a deactivated administrator (no self-reactivation).
The persisted display role is exactly `Admin` or `Advisor` (protected by a
database CHECK + direct-write guard), is reconciled to the Auth claim, and is
never authorization. Authenticated advisor-row creation is denied and an
active, pre-bound advisor may UPDATE only their own bound row (self-scoped
`advisor_update_own_profile`); ordinary profile editing accepts `advisor_name`
only (login email is read-only pending a future trusted workflow; an effective
Admin may additionally update a peer advisor's permitted name through the
authenticated `update_advisor_profile_name` RPC of migration `20261014000001`),
and advisor rows are created through the trusted server-only
`provision_advisor` RPC. Since migration `20261015000001` ordinary profile
edits and all current-state edits carry an expected version and go through the
narrow RPC writers (`update_my_advisor_profile` for self,
`update_advisor_profile_name(..., p_expected_version)` for peers,
`update_student_profile`/`update_fellowship`/`update_application` for the
operational rows, versioned `lifecycle_transition`/`set_advisor_role` for
lifecycle/role): the authenticated UPDATE grant and UPDATE policies on those
tables are revoked, `row_version`/`updated_at` are database-authored on INSERT
(`row_version = 1`) and bumped only on a meaningful write (never audited), every
expected version must be a positive integer, and a stale version is rejected
with `PT409` before any change.
Trusted server-only provisioning (`lib/provisioning`) create/invites and binds
Auth identities with a matching boolean claim and display role; protected
`/api/advisors` routes are effective-Admin-only, never accept `auth_user_id`,
and `PATCH` accepts exactly one of `role`/`isActive`/`advisorName` per request — a
required non-blank reason only for the role and active-state mutations, while an
`advisorName` edit is an ordinary profile edit (no reason) that calls the
authenticated `update_advisor_profile_name` RPC from the admin's own session
(no email is ever accepted). Role changes go through the atomic service-role-only
`set_advisor_role(..., p_reason, p_actor_id, p_expected_version)` RPC and lifecycle changes through
`lifecycle_transition(..., p_reason, p_expected_version)`; both revalidate authority and refuse to
remove the last active bound durable Admin.
Authenticated clients cannot
`DELETE` `advisor`, `student`, `fellowship`, or `application` (grant and RLS
layers); destructive removal of those historical entities is
archive/deactivate via the RPC only. After the historical-integrity
remediation the same holds for `fellowship_thursday` and
`scholarship_history`: their base rows are append-only (explicit active-advisor
`SELECT`/`INSERT` only), and corrections/voids are recorded in
`fellowship_thursday_amendment` / `scholarship_history_amendment`. New
operational child records
(`application`, `advising_meeting`, `fellowship_thursday`,
`scholarship_history`) can never reference an archived student/fellowship at
the database boundary (INSERT and re-linking UPDATE are denied; historical
reads are preserved). An `application` parent re-link is additionally
serialized against a concurrent parent archive by locking the prospective
parent row `FOR UPDATE` before the boundary check (migration `20261018000001`),
so a re-link cannot commit against a parent that is archived at commit time.
Every INSERT and meaningful UPDATE of `student`,
`fellowship`, `application`, and `advisor` additionally writes exactly one
immutable, database-authored `public.audit_event` inside the source transaction;
advisor/admin events use a strict allowlist and are attributed to the verified
human actor (the service-role `provision_advisor`/role RPCs revalidate the
server-supplied effective Admin). Since migrations `20261015000001`/`
20261015000002`/`20261016000001`, every normal authenticated edit of the four
current-state tables is an expected-version writer RPC (direct authenticated
UPDATE is revoked), each row carries database-authored `row_version`/`updated_at`
that are `1`/`now()` on creation and change only on a meaningful write (technical
columns never appear in an audit snapshot/diff), a stale expected version is
rejected with `PT409` before any change, and historical base/amendment inserts
write their own classified events. The audit read model is readable only by
active advisors, is writable by no product role (including Admin), mints no
baseline rows, and fails the source transaction closed if an audit event cannot
be written. The chain is **not proven equivalent** to the deployed production
schema.

### Migration deployment freeze

As of 2026-09-25 the production migration ledger contains only
`20260924065221_advisor_self_activation_lockdown` while the repository tracks
thirty-two migrations (`20260305000000` …
`20261018000001_lock_application_relink_parents.sql`), and the live production
schema materially differs from the repository chain.
Production is the physical-schema authority. Until a reviewed reconciliation is
approved:

- **Do not** run `supabase db push`, `supabase db reset`, or `supabase config push` against production.
- **Do not** replay historical migrations or mark them applied on the production ledger.
- **Do not** run SQL Editor scripts derived from these migration files against production.
- Any future production metadata write requires separate explicit approval.

Approval-gated future-operation guidance:
[`aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md`](../aidlc-docs/changes/2026-09-25-schema-provenance-reconciliation/runbook.md)

### Applying migrations locally

For a fresh, disposable local Supabase instance only, the chain can be applied
via the standard Docker-local workflow (`pnpm exec supabase start` then
`pnpm exec supabase db reset --no-seed`, which applies every file in
`supabase/migrations/` in order, ending with
`20261018000001_lock_application_relink_parents.sql`) or via the isolated local
harness (`node scripts/schema-inventory/run-local.mjs --out <path>`); both are
safe and the latter is how the reconciliation baseline is produced. Applying
the chain to a hosted project remains prohibited while provenance is
unresolved.

Regenerate TypeScript types after any schema change (against the running local
instance):

```bash
pnpm run db:types
```
