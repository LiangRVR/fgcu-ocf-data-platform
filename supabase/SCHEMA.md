# OCF Database Schema — One-Page Reference

> Canonical tables, keys, foreign keys, constraints, and business rules for the
> FGCU Office of Competitive Fellowships data platform.
>
> Active auth model: Supabase Auth identity + `public.advisor` authorization
>
> ⚠️ **Provenance notice (2026-09-25, updated 2026-10-01):** the hosted
> production database is the physical-schema authority. Its migration ledger
> records only `20260924065221_advisor_self_activation_lockdown`, while this
> repository tracks twenty-two migrations (`20260305000000` …
> `20261009000001_scholarship_void_serialization`), and the deployed schema
> materially differs from the repository chain. Do **not** run
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

All PKs are **integer sequences** (never UUIDs) except `advisor_role_lock`, whose primary key is the `advisor_id` foreign key (a server-only lock table, never exposed to clients). All table names are **singular**.

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

**Advisor write boundary (migration `20261002000001`):** authenticated
advisor-row creation is **denied** (`advisor_insert_active_staff` is dropped),
and an active, pre-bound advisor may UPDATE **only their own bound row** via
the self-scoped RLS policy `advisor_update_own_profile`
(`auth_user_id = auth.uid()` AND `is_active_advisor()`). Peer rows are
invisible for UPDATE and inactive/unbound sessions have no UPDATE path; the
column-scoped `role`/`is_active`/`auth_user_id` guards still protect those
fields on the self row. Advisor rows are created/managed only through the
trusted `service_role` / DBA provisioning path and the protected management
API.

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
- **ATOMIC role change (migration `20261007000001`)**: every NORMAL trusted
  role change is now a single service-role-only SECURITY DEFINER RPC
  (`set_advisor_role`) that atomically writes the Auth claim
  (`auth.users.raw_app_meta_data.ocf_admin` JSON boolean) AND the protected
  `public.advisor.role` display projection in ONE Postgres transaction — a
  claim/display mismatch is impossible (commit = both consistent; abort =
  neither changed). The trusted provisioning adapter calls this RPC; browser
  clients cannot (EXECUTE pinned to service_role). The earlier per-advisor
  lease/fencing/saga machinery (migrations `20261003000001`–`20261006000001`)
  is RETAINED but NOT relied on by the normal flow (legacy primitives only;
  `recoverAdvisorRoleChange` remains as an explicit recovery for historical
  drift). The lease is acquired
  before any read/mutation; a contending operation on another instance fails
  safely with `lock_busy` and mutates nothing; the lease is released reliably
  on success AND failure (a `finally`) and is holder-scoped; a crashed holder
  is recovered after the bounded lease (60s) expires
  (`acquire_advisor_role_lock` takes over expired leases). The protected
  display-role write is FENCED
  (`fenced_write_advisor_role_display`): the database only accepts it while
  the caller's holder still owns a NON-EXPIRED lease (atomically verified with
  a lease-row lock), so a lease that expires mid-operation can never leave a
  stale display write after another holder's takeover — the stale operation
  fails safely with `lock_lost` and performs no further mutation. An UNKNOWN
  fenced-write outcome (lost response) is reconciled by an EXACT fenced
  display-role read-back (`fenced_read_advisor_role_display`) while the same
  holder owns a non-expired lease, BEFORE any compensation: read-back ==
  desired role → safe reconciled success (matching Auth claim kept); read-back
  != desired role → compensate ONLY then; read-back NULL (lease lost) →
  `lock_lost`; read-back unavailable → `reconciliation_required` (no guessed
  rollback; a trusted OCF administrator reconciles the advisor). The lock
  table is server-only (RLS enabled with no policies, privileges revoked from
  anon/authenticated, granted to service_role), its FK stays the default
  `NO ACTION`, and its acquire/release/fenced-write/fenced-read/verify RPCs
  are SECURITY DEFINER with service_role-pinned EXECUTE.
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

- `public.lifecycle_transition(entity, action, entity_id)` (SECURITY DEFINER,
  migration-owned, empty `search_path`) is the only normal writer of lifecycle
  state. It:
  - derives the actor **exclusively** from `auth.uid()` — never from a
    parameter — and rejects technical (`service_role`/DBA) sessions that carry
    no JWT subject, so every transition is attributable to a specific
    authenticated administrator;
  - requires `public.is_ocf_admin()` = true **and** the session's bound advisor
    row to be currently ACTIVE (the deactivated-admin gate above);
  - accepts only the whitelisted transitions `student`/`fellowship`
    `archive` | `restore` (stamps/clears `archived_at := now()`) and `advisor`
    `deactivate` | `reactivate` (sets `is_active`); anything else fails closed;
  - is **idempotent** — a transition that would leave the row in its current
    state is a no-op (`applied = false`) that returns the unchanged resulting
    state, and each target row is locked (`FOR UPDATE`) so concurrent
    transitions cannot race;
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
| `20261004000001_advisor_role_fenced_write.sql` | Final P1 remediation: `fenced_write_advisor_role_display` is the ONLY writer of `advisor.role` for the role-change flow — it atomically verifies (with a lease-row lock) that the caller's holder still owns a NON-EXPIRED lease before writing, so a lease that expires mid-operation cannot leave a stale display write after another holder's takeover; `verify_advisor_role_lock` gates holder-aware compensation (a stale holder never rolls back a new holder's claim). Both are SECURITY DEFINER with service_role-pinned EXECUTE |
| `20261005000001_advisor_role_fenced_read.sql` | Final P1 remediation: `fenced_read_advisor_role_display` returns the CURRENT `advisor.role` ONLY while the caller's holder owns a NON-EXPIRED lease (lease-row locked, atomic with the lock lifecycle). The trusted adapter reconciles an UNKNOWN/lost fenced-write outcome by exact read-back BEFORE any compensation: matching role = safe reconciled success (claim kept); non-matching = compensate only then; NULL (lease lost) = `lock_lost`; read-back unavailable = `reconciliation_required` (no guessed rollback). SECURITY DEFINER, service_role-pinned EXECUTE |
| `20261006000001_advisor_role_display_reconcile.sql` | Prior P1 remediation (retained as a harmless legacy primitive, no longer relied on by the normal flow): `reconcile_advisor_role_display` is a lease-fenced display-role alignment to the authoritative Auth claim |
| `20261007000001_atomic_advisor_role_change.sql` | FUNDAMENTAL FINAL P1 remediation: `set_advisor_role(advisor_id, role)` is a NARROW service-role-only SECURITY DEFINER RPC that validates the role (Admin/Advisor), locks the target advisor row, verifies it exists and is BOUND, then in ONE Postgres transaction sets `auth.users.raw_app_meta_data.ocf_admin` to the matching JSON boolean AND `public.advisor.role` to the display projection — a claim/display mismatch is IMPOSSIBLE (commit = both consistent; abort = neither changed). This is the ONLY normal role-change path; the trusted adapter calls it and clients cannot. Never rebinds, never touches `is_active`/history |
| `20261008000001_historical_integrity_remediation.sql` | Historical integrity remediation: adds the append-only `fellowship_thursday_amendment` / `scholarship_history_amendment` tables (database-authored creator/timestamp; a scholarship `Void` is terminal and stays auditable); locks `fellowship_thursday` and `scholarship_history` base rows down to active-advisor SELECT/INSERT only; adds the `effective_fellowship_thursday` / `effective_scholarship_history` SECURITY INVOKER views; expands `stage_of_application` to nine named stages with an exact stage/`is_semi_finalist`/`is_finalist` consistency CHECK and bounds `application_year` to `NULL` or `2000–2100`; and requires a conducting `advisor_id` on new authenticated `advising_meeting` inserts while preserving legacy `NULL` rows |
| `20261009000001_scholarship_void_serialization.sql` | Scholarship terminal-`Void` serialization (review finding 3 of `2026-10-06-historical-integrity-remediation`): the first action of `set_scholarship_history_amendment_metadata()` on INSERT is now an exclusive `SELECT … FOR UPDATE` lock on the parent `public.scholarship_history` row, so concurrent amendments for the same award serialize on that lock and a loser re-evaluates the terminal-`Void` `EXISTS` guard against the committed state and is rejected (two concurrent Voids, or a Void racing a Correction, can no longer both commit); adds the partial unique index `uidx_scholarship_history_amendment_single_void` (at most one `Void` per award) as a declarative backstop that cannot be bypassed by trigger ordering, failing loudly if history is already inconsistent rather than normalizing; preserves the append-only SELECT/INSERT model, the SECURITY DEFINER trigger with empty `search_path`, service_role-only EXECUTE, RLS, and the effective-value views |

Migrations 2 and 3 are temporary bootstrap steps. The chain must be applied in
order and ends with `20261009000001_scholarship_void_serialization.sql`.
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
partial unique index that allows at most one `Void` per award; none of these
alters the auth steady state.

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
`advisor_update_own_profile`); advisor rows are managed through the trusted
server-only provisioning path. Trusted
server-only provisioning (`lib/provisioning`) create/invites and binds Auth
identities with a matching boolean claim and display role; protected
`/api/advisors` routes are effective-Admin-only, never accept `auth_user_id`,
and `PATCH` accepts exactly one of `role`/`isActive` per request.
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
reads are preserved). The chain is **not proven equivalent** to the deployed
production schema.

### Migration deployment freeze

As of 2026-09-25 the production migration ledger contains only
`20260924065221_advisor_self_activation_lockdown` while the repository tracks
twenty-two migrations (`20260305000000` … `20261009000001_scholarship_void_serialization`),
and the live production schema materially differs from the repository chain.
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
`20261009000001_scholarship_void_serialization.sql`) or via the isolated local
harness (`node scripts/schema-inventory/run-local.mjs --out <path>`); both are
safe and the latter is how the reconciliation baseline is produced. Applying
the chain to a hosted project remains prohibited while provenance is
unresolved.

Regenerate TypeScript types after any schema change (against the running local
instance):

```bash
pnpm run db:types
```
