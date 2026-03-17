# OCF Database Schema — One-Page Reference

> Canonical tables, keys, foreign keys, constraints, and business rules for the
> FGCU Office of Competitive Fellowships data platform.
>
> Current migration chain ends with `20260317000004_active_advisor_rls.sql`
> Active auth model: Supabase Auth identity + `public.advisor` authorization
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
| `destination_country` | varchar | YES | — | Travel-fellowship destination |
| `stage_of_application` | varchar | NO | — | CHECK: see pipeline values below |
| `is_semi_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |
| `is_finalist` | boolean | NO | `false` | Denormalized flag for fast filtering |

**Pipeline stages (in order):**
`Started` → `Submitted` → `Under Review` → `Semi-Finalist` → `Finalist` → `Awarded` / `Rejected`

**Business rules:**

- No unique constraint on `(student_id, fellowship_id)` — multi-year repeat applications are allowed.
- `is_semi_finalist` and `is_finalist` duplicate `stage_of_application` for fast `WHERE` queries.
  Both must be set together when updating the stage. See schema-decisions.md §2.

Indexed: `student_id`, `fellowship_id`, `stage_of_application`.

---

## `advising_meeting`

**Purpose:** Records each advising session between an OCF advisor and a student.

| Column | Type | Null | Default | Constraint |
| --- | --- | --- | --- | --- |
| `meeting_id` | integer | NO | nextval | **PK** |
| `student_id` | integer | NO | — | **FK → `student.student_id`** |
| `advisor_id` | integer | YES | — | **FK → `advisor.advisor_id`** (nullable — session may be unassigned) |
| `meeting_date` | date | NO | — | |
| `meeting_mode` | varchar | NO | — | CHECK: `In-Person` `Virtual` |
| `no_show` | boolean | NO | `false` | `true` when student did not attend |
| `notes` | text | YES | — | |

Indexed: `student_id`, `meeting_date`.

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
                                                       │ advisor_id (nullable)
fellowship (1) ──────────────────────────────┐         │
       │                    fellowship_id     │         │
       │                                     ▼         ▼
       │          student (1) ────── advising_meeting (N)
       │              │
       │              ├──── application (N) ──── fellowship (1)
       │              │
       │              ├──── fellowship_thursday (N)
       │              │
       └──────────────└──── scholarship_history (N) ──── fellowship (1)
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

**All five migrations must be applied.** Migrations 2 and 3 are temporary bootstrap steps. Migration 5 establishes the intended steady state: authenticated active advisors only.

Apply via Supabase Dashboard (SQL Editor) or CLI:

```bash
npx supabase link --project-ref <your-project-id>
npx supabase db push
```

Regenerate TypeScript types after any schema change:

```bash
pnpm run db:types
```
