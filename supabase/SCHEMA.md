# OCF Database Schema — One-Page Reference

> Canonical tables, keys, foreign keys, constraints, and business rules for the
> FGCU Office of Competitive Fellowships data platform.
>
> Active auth model: Supabase Auth identity + `public.advisor` authorization
>
> ⚠️ **Provenance notice (2026-09-25, updated 2026-10-01):** the hosted
> production database is the physical-schema authority. Its migration ledger
> records only `20260924065221_advisor_self_activation_lockdown`, while this
> repository tracks twelve migrations (`20260305000000` …
> `20260930000006_core_history_delete_lockdown`), and the deployed schema
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
| `scholarship_history` | Confirmed past fellowship awards | `history_id` |

All PKs are **integer sequences** (never UUIDs). All table names are **singular**.

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
| `role` | text | NO | `'advisor'` | |
| `created_at` | timestamptz | NO | `now()` | |
| `last_login_at` | timestamptz | YES | — | |

No foreign keys. Referenced by `advising_meeting.advisor_id`.

Used by the app for sign-in authorization, account profile display, password-recovery context, and the `/dashboard/account` page.

`is_active` is the **sole** advisor lifecycle representation (there is no advisor `archived_at`). Deactivate/reactivate happen **only** through the admin lifecycle RPC `public.lifecycle_transition` (migration `20260930000005`); direct authenticated writes of `is_active` are rejected by a database guard. See [Entity Lifecycle & Archive Model](#entity-lifecycle--archive-model-migration-20260930000005).

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
| `application_year` | smallint | YES | — | Application **cycle** (e.g. `2026`), not a creation year and not a fellowship attribute; NULL for legacy rows whose cycle is unknown |
| `destination_country` | varchar | YES | — | Travel-fellowship destination |
| `stage_of_application` | varchar | NO | — | CHECK: see pipeline values below |
| `is_semi_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |
| `is_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |

**Pipeline stages (in order):**
`Started` → `Submitted` → `Under Review` → `Semi-Finalist` → `Finalist` → `Awarded` / `Rejected`

**Business rules:**

- No unique constraint on `(student_id, fellowship_id)` — multi-year repeat applications are allowed. There is also **no** `(student_id, fellowship_id, application_year)` uniqueness rule.
- `application_year` is the explicit application cycle. It is nullable so legacy rows stay truthful when their cycle is unknown; the system never infers or backfills a year. Known cycles render as `{fellowship_name} — {application_year}` labels (see `advising_meeting`).
- `UNIQUE (application_id, student_id)` exists solely as the target for the `advising_meeting` composite FK (`application_id, student_id`); it adds no new application uniqueness rule.
- `is_semi_finalist` and `is_finalist` duplicate `stage_of_application` for fast `WHERE` queries.
  Both must be set together when updating the stage. See schema-decisions.md §2.

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

`fellowship_thursday` rows are **operational attendance records**, not
historical entities. Migration `20260930000006_core_history_delete_lockdown`
intentionally leaves this table untouched, so authenticated `DELETE` remains
available.

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

`scholarship_history` rows are **operational award records**, not historical
entities. Migration `20260930000006_core_history_delete_lockdown`
intentionally leaves this table untouched, so authenticated `DELETE` remains
available.

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

**Admin authority is the Auth JWT, not the advisor row.**

- Lifecycle authorization reads **only** the immutable Auth `app_metadata`
  claim `ocf_admin = true` (`public.is_ocf_admin()`). Users cannot edit
  `app_metadata` through standard client APIs. The mutable `public.advisor.role`
  column is **never** authorization, because active advisors can mutate it.

**The lifecycle RPC is the only normal transition path.**

- `public.lifecycle_transition(entity, action, entity_id)` (SECURITY DEFINER,
  migration-owned, empty `search_path`) is the only normal writer of lifecycle
  state. It:
  - derives the actor **exclusively** from `auth.uid()` — never from a
    parameter — and rejects technical (`service_role`/DBA) sessions that carry
    no JWT subject, so every transition is attributable to a specific
    authenticated administrator;
  - requires `public.is_ocf_admin()` = true;
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
    `is_active_advisor()` / `requireAdvisor` and there is no self-reactivation
    path), so a second administrator must deactivate an administrator's
    account. Reactivating your own row and idempotent no-ops remain allowed.

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
  `fellowship_thursday` and `scholarship_history`.

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
        ├──── fellowship_thursday (N)
        └──── scholarship_history (N) ──── fellowship (1)
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

Migrations 2 and 3 are temporary bootstrap steps. The chain must be applied in
order and ends with `20260930000006_core_history_delete_lockdown.sql`.
`20260318000001_advisor_self_activation_lockdown.sql` is required and must
follow `20260317000004_active_advisor_rls.sql`; the forward-only
`20260929000001_advising_application_link.sql` extends the model afterwards,
`20260930000002_advising_application_fk_indexes.sql` adds its supporting
indexes, `20260930000005_entity_lifecycle_archiving.sql` adds the
non-destructive lifecycle model, and
`20260930000006_core_history_delete_lockdown.sql` revokes authenticated
DELETE on the core historical entities; none alters the auth steady state.

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
Auth `app_metadata.ocf_admin = true` claim — never by the mutable
`advisor.role` column or direct client writes. Authenticated clients cannot
`DELETE` `advisor`, `student`, `fellowship`, or `application` (grant and RLS
layers); destructive removal of those historical entities is
archive/deactivate via the RPC only, while `DELETE` on the non-historical
operational rows `fellowship_thursday` / `scholarship_history` is
intentionally retained. The chain is **not proven equivalent** to the deployed
production schema.

### Migration deployment freeze

As of 2026-09-25 the production migration ledger contains only
`20260924065221_advisor_self_activation_lockdown` while the repository tracks
twelve migrations (`20260305000000` … `20260930000006_core_history_delete_lockdown`),
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
via the isolated local harness; this is safe and is how the reconciliation
baseline is produced. Applying the chain to a hosted project remains prohibited
while provenance is unresolved.

Regenerate TypeScript types after any schema change:

```bash
pnpm run db:types
```
