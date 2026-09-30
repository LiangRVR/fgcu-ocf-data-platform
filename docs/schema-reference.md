# Schema Reference

**The canonical source of truth for the OCF Fellowship Management System database.**

All table names are **singular**. All primary keys are **integer sequences** (never UUIDs). Every part of the application must follow this schema exactly.

> For a compact one-page overview see [`supabase/SCHEMA.md`](../supabase/SCHEMA.md).
> For open design decisions (email uniqueness, stage denormalization, etc.) see [`docs/schema-decisions.md`](./schema-decisions.md).

---

## Tables

### `student`

Stores FGCU student profiles managed by the OCF.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `student_id` | integer | NO | nextval | **Primary key** |
| `full_name` | varchar | NO | | |
| `email` | varchar | NO | | |
| `is_ch_student` | boolean | NO | `false` | Honors College student |
| `us_citizen` | boolean | NO | | |
| `major` | varchar | YES | | |
| `minor` | varchar | YES | | |
| `gpa` | numeric | YES | | CHECK: `0.00 – 4.00` |
| `class_standing` | varchar | YES | | CHECK: `Freshman`, `Sophomore`, `Junior`, `Senior`, `Graduate`, `Doctoral` |
| `age` | integer | YES | | |
| `gender` | varchar | YES | | CHECK: `F`, `M`, `NB`, `NR` |
| `pronouns` | varchar | YES | | |
| `race_ethnicity` | varchar | YES | | |
| `languages` | varchar | YES | | |
| `first_gen` | boolean | NO | `false` | First-generation college student |
| `honors_college` | boolean | NO | `false` | |

---

### `advisor`

Staff profile and authorization anchor for OCF application users.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `advisor_id` | integer | NO | nextval | **Primary key** |
| `advisor_name` | varchar | NO | | UNIQUE |
| `email` | text | YES | | Unique when populated; backfill confirmed FGCU emails before enforcing `NOT NULL` on a populated database |
| `auth_user_id` | uuid | YES | | Unique Supabase Auth user link |
| `is_active` | boolean | NO | `true` | Inactive advisors are denied app access but preserved for history |
| `role` | text | NO | `'advisor'` | Reserved for future RBAC tiers |
| `created_at` | timestamptz | NO | `now()` | Advisor profile creation time |
| `last_login_at` | timestamptz | YES | | Last successful advisor sign-in link/update |

**Business rules:**

- `advisor_id` remains the business primary key and is referenced by `advising_meeting.advisor_id`.
- Supabase Auth handles identity; `public.advisor` handles staff authorization.
- Advisors should be marked inactive instead of deleted when they leave the office.

---

### `fellowship`

Fellowship programs that students can apply to or have won.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `fellowship_id` | integer | NO | nextval | **Primary key** |
| `fellowship_name` | varchar | NO | | UNIQUE |

---

### `application`

Tracks a student's application to one fellowship program.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `application_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `fellowship_id` | integer | NO | | FK → `fellowship.fellowship_id` |
| `application_year` | smallint | YES | | Application **cycle** (e.g. `2026`) — not a creation year and not a fellowship attribute; NULL for legacy rows whose cycle is unknown |
| `destination_country` | varchar | YES | | |
| `stage_of_application` | varchar | NO | | CHECK: `Started`, `Submitted`, `Under Review`, `Semi-Finalist`, `Finalist`, `Awarded`, `Rejected` |
| `is_semi_finalist` | boolean | NO | `false` | |
| `is_finalist` | boolean | NO | `false` | |

**Business rules:**

- `stage_of_application` drives the pipeline view; `is_semi_finalist` and `is_finalist` are denormalized flags for fast filtering.
- There is no unique constraint on `(student_id, fellowship_id)` — a student may have multiple application attempts to the same fellowship across years. There is also **no** `(student_id, fellowship_id, application_year)` uniqueness rule.
- `application_year` is the explicit application cycle. It stays `NULL` for legacy rows whose cycle is unknown — the system never infers or backfills a year. New/edited application records require an explicit four-digit year.
- `UNIQUE (application_id, student_id)` exists solely as the target for the `advising_meeting` composite FK; it adds no new application uniqueness rule.
- Application labels use `{fellowship_name} — {application_year}` (e.g. `Fulbright — 2027`). Unknown legacy years render as `{fellowship_name} — year unknown`, never as a guess.

---

### `advising_meeting`

Records each advising session between an advisor and a student.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `meeting_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `advisor_id` | integer | YES | | FK → `advisor.advisor_id` (the advisor who **conducted** the meeting; nullable) |
| `application_id` | integer | YES | | FK → `application.application_id` + composite FK `(application_id, student_id)` → `application(application_id, student_id)`; NULL = General Advising |
| `meeting_date` | date | NO | | Real session date — distinct from `created_at` |
| `meeting_mode` | varchar | NO | | CHECK: `In-Person`, `Virtual` |
| `no_show` | boolean | NO | `false` | Student did not attend |
| `notes` | text | YES | | |
| `created_at` | timestamptz | NO | `now()` | Database-authored **entry** timestamp; never a substitute for `meeting_date` |
| `created_by_advisor_id` | integer | YES | | FK → `advisor.advisor_id`; the advisor who **entered** the record, distinct from `advisor_id` |

**Business rules:**

- **General Advising:** `application_id = NULL` means the session was General
  Advising (the explicit first option in the advising form). A non-NULL value
  must reference an `application` that belongs to the meeting's own student —
  the composite FK `(application_id, student_id) → application(application_id,
  student_id)` enforces this at the database boundary, so a cross-student
  application is impossible even on a direct write. NULL columns pass both FKs.
- **Derivation:** the fellowship shown for a meeting is derived only through
  `advising_meeting.application_id → application.fellowship_id → fellowship`.
  `advising_meeting` carries no `fellowship_id`, and
  `fellowship.fellowship_name` never encodes the cycle.
- **Labels:** known-cycle contexts render as `{fellowship_name} — {application_year}`
  (e.g. `Fulbright — 2027`); unknown legacy cycles render as
  `{fellowship_name} — year unknown`.
- **`advisor_id` vs `created_by_advisor_id`:** `advisor_id` is the advisor who
  conducted the meeting; `created_by_advisor_id` is the advisor who entered the
  record. They are independent and can differ (e.g. notes entered the next day).
- **`meeting_date` vs `created_at`:** `meeting_date` is the real session date;
  `created_at` is the database-authored timestamp of when the record was entered.
- Advisor-personalized meeting history is derived from `advising_meeting.advisor_id`.
- The first version of `My students` is also derived from this table by grouping the current advisor's meetings by `student_id`.
- This schema does **not** currently encode a formal advisor assignment or caseload model.

**Creation-metadata trigger (migration `20260929000001`):**

`set_advising_meeting_created_metadata()` (trigger `trg_advising_meeting_created_metadata`)
is a non-RPC `SECURITY DEFINER` function with `SET search_path = ''` and
`EXECUTE` revoked from `PUBLIC`, `anon`, and `authenticated`. It is the only
path that writes creator attribution:

- **Authenticated browser INSERT:** resolves the ACTIVE advisor whose
  `auth_user_id = auth.uid()` and overwrites any client-supplied
  `created_by_advisor_id` and `created_at`; a session that cannot resolve an
  active advisor is rejected by the existing RLS INSERT policy (RLS remains the
  authorization gate).
- **No-auth technical INSERT** (service-role/seed, no JWT claims): retains the
  nullable creator as supplied and stamps the DB current timestamp.
- **UPDATE:** rejects any change to `created_at` or `created_by_advisor_id`
  fail-closed; the column-scoped trigger (`UPDATE OF created_at,
  created_by_advisor_id`) leaves ordinary meeting edits untouched.
- `advisor_id` is never modified by the trigger.

Indexes: `student_id`, `meeting_date`, `application_id` (single-column) and
`(student_id, application_id)` (composite).

---

### `fellowship_thursday`

Tracks student attendance at the weekly Thursday fellowship meeting.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `attendance_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `attended` | boolean | NO | | |
| `source_info` | varchar | YES | | CHECK (nullable): `OCF`, `HC`, `MM` |

---

### `scholarship_history`

Records past scholarships/fellowships that a student has already received.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `history_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `fellowship_id` | integer | NO | | FK → `fellowship.fellowship_id` |

---

## Relationship Diagram

```text
student (1) ──────────────────────── (N) application (N) ─── (1) fellowship
   │                                        │                          │
   │                                        │                          │
   │                                        └── UNIQUE (application_id,│
   │                                            student_id)            │
   ├── (N) advising_meeting (N) ─── (1) advisor          (N) scholarship_history
   │        │
   │        └── (N) application — via nullable application_id:
   │              NULL = General Advising; composite FK
   │              (application_id, student_id) forces the application
   │              to belong to the meeting's student
   ├── (N) fellowship_thursday
   │
   └── (N) scholarship_history

advisor (1) ─── created_by_advisor_id (nullable, the record creator) ─── (N) advising_meeting
```

---

## Naming Rules

| Rule | Correct | Wrong |
| --- | --- | --- |
| Table names | `student` | `students` |
| Primary keys | `student_id` | `id` |
| Key types | `integer` (sequence) | `uuid` |
| App stage field | `stage_of_application` | `status` |
| Application cycle field | `application_year` | `year` / encoding the year in `fellowship_name` |
| Fellowship name field | `fellowship_name` | `name` |
| Advisor name field | `advisor_name` | `name` |

## Label Format

- Application contexts render as `{fellowship_name} — {application_year}` (e.g. `Fulbright — 2027`).
- Unknown legacy cycles render as `{fellowship_name} — year unknown` — never a guessed year.
- Advising records with `application_id = NULL` render as **General Advising**.

---

## TypeScript Type Locations

| File | Purpose |
| --- | --- |
| `types/database.ts` | Auto-generated Supabase types — use for all DB queries |
| `types/index.ts` | Application-level domain types — must mirror this schema |

Regenerate `types/database.ts` after any schema change:

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```
