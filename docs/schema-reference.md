# Schema Reference

**The canonical source of truth for the OCF Fellowship Management System database.**

All table names are **singular**. All primary keys are **integer sequences** (never UUIDs) except `advisor_role_lock`, whose primary key is the `advisor_id` foreign key (a server-only lock table). Every part of the application must follow this schema exactly.

> For a compact one-page overview see [`supabase/SCHEMA.md`](../supabase/SCHEMA.md).
> For open design decisions (email uniqueness, stage denormalization, etc.) see [`docs/schema-decisions.md`](./schema-decisions.md).
> The repository migration chain is **forward-only** and currently contains **twenty migrations** ending with `20261007000001_atomic_advisor_role_change.sql` (see `supabase/SCHEMA.md` for the ordered migration table).

---

## Tables

### `student`

Stores FGCU student profiles managed by the OCF.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `student_id` | integer | NO | nextval | **Primary key** |
| `archived_at` | timestamptz | YES | | **Lifecycle:** `NULL` = active, a database-authored timestamp = archived |
| `full_name` | varchar | NO | | |
| `email` | varchar | NO | | indexed (not unique — see schema-decisions.md §1) |
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

Indexed: `email`, `is_ch_student`, `class_standing`, `archived_at`.

**Lifecycle (migration `20260930000005`):** `archived_at` is the single
lifecycle representation — `NULL` = active, a database-authored timestamp =
archived. Existing rows were never backfilled (they remain `NULL`/active).
It is written only by the admin lifecycle RPC `public.lifecycle_transition`
(archive | restore); direct authenticated writes are rejected by a database
guard. Archive never deletes, nulls, or cascades the student's applications,
meetings, attendance, or award history (FKs stay `NO ACTION`).

**DELETE lockdown (migration `20260930000006`):** authenticated clients cannot
`DELETE` student rows (the `authenticated` DELETE table privilege is revoked
and no DELETE RLS policy remains). Archive via `lifecycle_transition` is the
only removal path.

---

### `advisor`

Staff profile and authorization anchor for OCF application users.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `advisor_id` | integer | NO | nextval | **Primary key** |
| `advisor_name` | varchar | NO | | UNIQUE |
| `email` | text | YES | | Unique when populated; backfill confirmed FGCU emails before enforcing `NOT NULL` on a populated database |
| `auth_user_id` | uuid | YES | | Unique Supabase Auth user link; **one-time bind**, never re-bound or cleared |
| `is_active` | boolean | NO | `true` | **Sole advisor lifecycle field** (no `archived_at`); inactive advisors are denied app access but preserved for history |
| `role` | text | NO | `'Advisor'` | Protected **display projection**: exactly `Admin` or `Advisor` (CHECK); reconciled to the Auth claim; **never** an authorization input |
| `created_at` | timestamptz | NO | `now()` | Advisor profile creation time |
| `last_login_at` | timestamptz | YES | | Last successful advisor sign-in link/update |

**Business rules:**

- `advisor_id` remains the business primary key and is referenced by
  `advising_meeting.advisor_id`, `advising_meeting.created_by_advisor_id`, and
  `advising_meeting_amendment.created_by_advisor_id`.
- Supabase Auth handles identity; `public.advisor` handles staff authorization.
- **Lifecycle:** `is_active` is the **sole** advisor lifecycle representation
  (there is no advisor `archived_at`). Deactivate/reactivate happen **only**
  through the admin lifecycle RPC `public.lifecycle_transition`; direct
  authenticated writes of `is_active` are rejected by a database guard.
  Advisors are marked inactive instead of deleted when they leave the office.
- **Roles and the effective-claim boundary (migrations `20261001000001` +
  `20261002000001`):** the handoff model has exactly two operational roles —
  `Admin` and `Advisor`. `advisor.role` is a protected display projection
  (CHECK `advisor_role_display_check`, default `'Advisor'`) that is
  **reconciled to the Auth claim**: a bound advisor displays `Admin` only when
  `auth.users.raw_app_meta_data.ocf_admin` is the JSON boolean `true`, and
  `Advisor` otherwise (the same strict-boolean rule as `public.is_ocf_admin()`).
  Direct authenticated writes to `role` — self or peer, including creating an
  `Admin` row — are rejected fail-closed (42501) by the invoker-security guard
  `trg_advisor_role_display`; only trusted `service_role`/DBA sessions (the
  server-only provisioning adapter) may set it. **Effective authority never
  comes from the display role.** An **effective Admin** is a current, active,
  pre-bound advisor (`advisor.auth_user_id = auth.uid()` AND `is_active =
  true`) carrying the Auth JSON-boolean claim `app_metadata.ocf_admin = true`
  — the database predicate is `public.is_effective_admin()`, mirrored in
  `lib/auth/session.ts`.
- **Write boundary (migration `20261002000001`):** authenticated advisor-row
  creation is **denied** (`advisor_insert_active_staff` is dropped), and an
  active, pre-bound advisor may UPDATE **only their own bound row** via the
  self-scoped policy `advisor_update_own_profile`. Peer rows are invisible for
  UPDATE. Advisor rows are created/managed only through the trusted
  `service_role`/DBA provisioning path and the protected management API.
- Authenticated clients **cannot `DELETE`** advisor rows (migration
  `20260930000006`); deactivation via `lifecycle_transition` is the only
  removal path.

---

### `fellowship`

Fellowship programs that students can apply to or have won.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `fellowship_id` | integer | NO | nextval | **Primary key** |
| `fellowship_name` | varchar | NO | | UNIQUE |
| `archived_at` | timestamptz | YES | | **Lifecycle:** `NULL` = active, a database-authored timestamp = archived |

Indexed: `archived_at`.

**Lifecycle (migration `20260930000005`):** `archived_at` is the single
lifecycle representation — `NULL` = active, a database-authored timestamp =
archived. It is written only by the admin lifecycle RPC
`public.lifecycle_transition` (archive | restore); direct authenticated writes
are rejected by a database guard. Archive never deletes, nulls, or cascades the
applications and award-history rows that reference the fellowship (FKs stay
`NO ACTION`).

**DELETE lockdown (migration `20260930000006`):** authenticated clients cannot
`DELETE` fellowship rows (privilege revoked at grant and RLS layers). Archive
via `lifecycle_transition` is the only removal path.

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
- Applications are **historical records** (migration `20260930000006`):
  authenticated clients cannot `DELETE` them, and the archive-parent child
  boundary (migration `20260930000007`) denies new `INSERT`s of an application
  referencing an archived `student` or `fellowship` (and UPDATE re-links to an
  archived parent). Historical reads of applications referencing archived
  parents are preserved.

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
- **Append-only history (migration `20260930000003`):** Database RLS permits
  active advisors to `SELECT` and `INSERT` advising meetings only. `UPDATE` and
  `DELETE` are denied, with **no application-admin bypass**. Historic meeting
  records are preserved, so a correction is recorded as a new
  `advising_meeting_amendment` rather than changing or removing one.
- **Archive-parent boundary (migration `20260930000007`):** `INSERT` of a
  meeting referencing an archived `student` (or an application of an archived
  student/fellowship) and `UPDATE` re-links to an archived parent are denied
  fail-closed (42501) for authenticated sessions; historical reads of meetings
  referencing archived parents are preserved, and re-linking a child **away**
  from an archived parent to an active one is always allowed.

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
- **No-auth technical INSERT** (service-role/seed, no JWT claims): clears any
  supplied creator attribution, writes `created_by_advisor_id = NULL`, and
  stamps the DB current timestamp.
- **UPDATE:** rejects any change to `created_at` or `created_by_advisor_id`
  fail-closed; the column-scoped trigger (`UPDATE OF created_at,
  created_by_advisor_id`) leaves ordinary meeting edits untouched.
- `advisor_id` is never modified by the trigger.

Indexes: `student_id`, `meeting_date`, `application_id` (single-column),
`(student_id, application_id)` (composite), `(application_id, student_id)`
(reverse composite-FK), and `created_by_advisor_id`.

---

### `advising_meeting_amendment`

Records a correction to an advising meeting **without mutating or deleting the
historic meeting row**. More than one amendment may reference the same meeting.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `amendment_id` | integer | NO | nextval | **Primary key** |
| `meeting_id` | integer | NO | | FK → `advising_meeting.meeting_id` |
| `created_by_advisor_id` | integer | NO | database trigger | FK → `advisor.advisor_id`; the authenticated active advisor who recorded the correction |
| `created_at` | timestamptz | NO | `now()` | Database-authored entry timestamp |
| `reason` | text | NO | | Short explanation of why the correction is needed; CHECK: non-empty after trimming whitespace |
| `details` | text | NO | | Correction details; does not overwrite the original meeting; CHECK: non-empty after trimming whitespace |

**Append-only correction design (migration `20260930000004`):**

- Database RLS allows active advisors to `SELECT` and `INSERT` amendment rows
  only. `UPDATE` and `DELETE` are denied.
- The creation trigger (`set_advising_meeting_amendment_created_metadata`)
  replaces any client-supplied creator or timestamp with the authenticated
  **active** advisor and the database timestamp; a session that cannot resolve
  an active advisor is rejected (42501). UPDATE of an amendment row is rejected
  fail-closed.
- A correction is represented by **another amendment row**, never an edit to
  the original meeting or an earlier amendment.
- `reason` and `details` are enforced non-empty at the database boundary by
  whitespace-trimming CHECK constraints
  (`btrim(column, ' \t\n\r\f\x0b') <> ''`), so a blank or whitespace-only
  correction is rejected even on a direct insert.

Indexed: `(meeting_id, created_at, amendment_id)` (per-meeting retrieval,
chronologically ordered), `created_by_advisor_id`.

---

### `fellowship_thursday`

Tracks student attendance at the weekly Thursday fellowship meeting.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `attendance_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `attended` | boolean | NO | | |
| `source_info` | varchar | YES | | CHECK (nullable): `OCF`, `HC`, `MM` |

`fellowship_thursday` rows are **operational attendance records**, not
historical entities — authenticated `DELETE` remains available (migration
`20260930000006` leaves this table untouched). The archive-parent boundary
(migration `20260930000007`) still denies `INSERT` of a row referencing an
archived student.

---

### `scholarship_history`

Records past scholarships/fellowships that a student has already received.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `history_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `fellowship_id` | integer | NO | | FK → `fellowship.fellowship_id` |

`scholarship_history` rows are **operational award records**, not historical
entities — authenticated `DELETE` remains available (migration
`20260930000006` leaves this table untouched). The archive-parent boundary
(migration `20260930000007`) still denies `INSERT` of a row referencing an
archived student or fellowship.

---

### `advisor_role_lock` (server-only, never exposed to clients)

Per-advisor role-change lease table added by migration `20261003000001`. It is
**server-only**: RLS is enabled with no policies, privileges are revoked from
`anon`/`authenticated`, and only `service_role` has access. Its primary key is
the `advisor_id` foreign key. It exists to serialize trusted role changes; the
normal role-change flow now uses the atomic `set_advisor_role` RPC (migration
`20261007000001`), and the lease primitives are retained as legacy machinery.

---

## Lifecycle & Archive Model (migration `20260930000005`)

Non-destructive, reversible lifecycle behavior for advisors, students, and
fellowships. Normal operations **archive/deactivate** instead of deleting, and
every historical relationship is preserved.

- `student.archived_at` / `fellowship.archived_at` (timestamptz, nullable):
  `NULL` = **active**; a database-authored timestamp = **archived**. There is
  no redundant status column, and pre-existing rows were never backfilled.
- `advisor.is_active` (boolean) is the **sole** advisor lifecycle
  representation; there is no advisor `archived_at`.
- **Only normal transition path:** `public.lifecycle_transition(entity,
  action, entity_id)` (SECURITY DEFINER) — admin-only, actor derived from
  `auth.uid()`, whitelisted to `student`/`fellowship` `archive` | `restore` and
  `advisor` `deactivate` | `reactivate`, idempotent, and guarded against
  self-deactivation.
- **Authorization requires both:** the immutable Auth claim
  `app_metadata.ocf_admin = true` (`public.is_ocf_admin()`) **and** a current,
  active, pre-bound advisor identity (`auth_user_id = auth.uid()` AND
  `is_active = true`). The mutable `advisor.role` display column is **never**
  authorization.
- **Direct writes are guarded:** column-scoped invoker-security triggers reject
  direct authenticated `INSERT`/`UPDATE` of `student.archived_at`,
  `fellowship.archived_at`, and `advisor.is_active`.
- **Archive-parent child boundary (migration `20260930000007`):** the database
  boundary denies new operational child records (`application`,
  `advising_meeting`, `fellowship_thursday`, `scholarship_history`) that
  reference archived students/fellowships — `INSERT` of a child referencing an
  archived parent and `UPDATE` re-links to an archived parent fail closed
  (42501) for non-trusted sessions. Historical reads are preserved, re-linking
  away from an archived parent is always allowed, and trusted
  `service_role`/DBA sessions are exempt.
- **Non-cascading FKs preserved:** every foreign key keeps the default
  `NO ACTION` semantics. No archive/deactivate/restore action deletes, nulls,
  or cascades applications, meetings, amendments, attendance, or award history.
- **DELETE lockdown (migration `20260930000006`):** authenticated clients
  cannot `DELETE` the core historical entities `advisor`, `student`,
  `fellowship`, or `application` (grant and RLS layers). Authenticated `DELETE`
  intentionally remains only on the non-historical operational rows
  `fellowship_thursday` and `scholarship_history`.

## Relationship Diagram

```text
student (1) ──────────────────────── (N) application (N) ─── (1) fellowship
   │                                        │                          │
   │                                        │                          │
   │                                        └── UNIQUE (application_id,│
   │                                            student_id)            │
   ├── (N) advising_meeting (N) ─── (1) advisor          (N) scholarship_history
   │        │
   │        ├── (N) advising_meeting_amendment (append-only corrections)
   │        └── (N) application — via nullable application_id:
   │              NULL = General Advising; composite FK
   │              (application_id, student_id) forces the application
   │              to belong to the meeting's student
   ├── (N) fellowship_thursday
   │
   └── (N) scholarship_history

advisor (1) ─── created_by_advisor_id (nullable, the record creator) ─── (N) advising_meeting
advisor (1) ─── created_by_advisor_id (authenticated active creator) ─── (N) advising_meeting_amendment
advisor (1) ─── advisor_id (FK, server-only lock) ─── (1) advisor_role_lock

archive/deactivate lifecycle: student.archived_at, fellowship.archived_at,
advisor.is_active — all FKs stay NO ACTION; archived parents reject new
operational child INSERTs and UPDATE re-links (database boundary).
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
| Advisor role vocabulary | `Admin` / `Advisor` | `admin` / `advisor` / other free-form values |

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

Regenerate `types/database.ts` after any schema change against a running local
Supabase instance:

```bash
pnpm run db:types    # runs `supabase gen types --local > types/database.ts`
```

(For a hosted project the equivalent is
`npx supabase gen types typescript --project-id <your-project-id> > types/database.ts`.)