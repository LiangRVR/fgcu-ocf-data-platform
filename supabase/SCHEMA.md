# OCF Database Schema — One-Page Reference

> Canonical tables, keys, foreign keys, constraints, and business rules for the
> FGCU Office of Competitive Fellowships data platform.
>
> Active auth model: Supabase Auth identity + `public.advisor` authorization
>
> ⚠️ **Provenance notice (2026-09-25, updated 2026-09-29):** the hosted
> production database is the physical-schema authority. Its migration ledger
> records only `20260924065221_advisor_self_activation_lockdown`, while this
> repository tracks seven migrations (`20260305000000` …
> `20260929000001_advising_application_link`), and the deployed schema
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
| `is_active` | boolean | NO | `true` | |
| `role` | text | NO | `'advisor'` | |
| `created_at` | timestamptz | NO | `now()` | |
| `last_login_at` | timestamptz | YES | — | |

No foreign keys. Referenced by `advising_meeting.advisor_id`.

Used by the app for sign-in authorization, account profile display, password-recovery context, and the `/dashboard/account` page.

---

## `fellowship`

**Purpose:** Reference list of fellowship and scholarship programs the OCF tracks.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `fellowship_id` | integer | NO | nextval | **PK** |
| `fellowship_name` | varchar | NO | — | UNIQUE |

Referenced by `application.fellowship_id` and `scholarship_history.fellowship_id`.

---

## `student`

**Purpose:** Core profile for every FGCU student tracked by the OCF.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `student_id` | integer | NO | nextval | **PK** |
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

Indexed: `email`, `is_ch_student`, `class_standing`. Referenced by all five child tables below.

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
  and timestamp; no-auth technical inserts retain a NULL creator and the DB
  current timestamp. UPDATE changes to `created_at`/`created_by_advisor_id`
  are rejected fail-closed. RLS remains the authorization gate — a session
  that cannot resolve an active advisor is denied by the existing INSERT policy.
  `advisor_id` is never touched by the trigger.

Indexed: `student_id`, `meeting_date`, `application_id`,
`(student_id, application_id)`.

This table is also the source for advisor-personalized views such as `My meetings` and the meeting-derived `My students` roster on `/dashboard/account`.

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

Migrations 2 and 3 are temporary bootstrap steps. The chain must be applied in
order and ends with `20260929000001_advising_application_link.sql`.
`20260318000001_advisor_self_activation_lockdown.sql` is required and must
follow `20260317000004_active_advisor_rls.sql`; the forward-only
`20260929000001_advising_application_link.sql` extends the model afterwards
and does not alter the auth steady state.

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
admin-only `advisor.auth_user_id` binding. The chain is **not proven
equivalent** to the deployed production schema.

### Migration deployment freeze

As of 2026-09-25 the production migration ledger contains only
`20260924065221_advisor_self_activation_lockdown` while the repository tracks
seven migrations (`20260305000000` … `20260929000001_advising_application_link`),
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
