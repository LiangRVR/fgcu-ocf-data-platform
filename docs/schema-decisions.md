# Schema Design Decisions

Open design questions settled before adding create/edit forms.
These choices are intentional — not oversights.

---

## 1. `student.email` — Not Unique (current decision: defer)

**Current state:** `email` is indexed (`idx_student_email`) but has **no UNIQUE constraint**.

**Why deferred:** The data imported from existing OCF spreadsheets may contain
duplicate email addresses (e.g., the same student was entered under two advisors,
or a student changed their email). Adding a UNIQUE constraint before a data-cleaning
pass would block the initial import.

**Recommendation:** Add the constraint once the student table has been audited:

```sql
ALTER TABLE public.student
  ADD CONSTRAINT student_email_unique UNIQUE (email);
```

Until then, the app should treat email as a fast-lookup field, not an identity key.
Use `student_id` everywhere as the authoritative record identifier.

---

## 2. `stage_of_application` vs. `is_finalist` / `is_semi_finalist` — Keep Both

**Current state:** Both exist simultaneously:

| Field | Purpose |
| --- | --- |
| `stage_of_application` | Authoritative string enum — drives the pipeline view |
| `is_semi_finalist` | Boolean — allows `WHERE is_semi_finalist = true` |
| `is_finalist` | Boolean — allows `WHERE is_finalist = true` |

**Potential inconsistency:** A row could have `stage_of_application = 'Finalist'`
but `is_finalist = false`, or vice versa.

**Decision: keep both, enforce at the application layer.**
The booleans are deliberate denormalization for fast dashboard counts
(avoid a string comparison on every row). They must always be set together
with the stage field.

**Enforced in the current codebase:** All add/edit form handlers set all three
fields atomically. The rule is:

| `stage_of_application` | `is_semi_finalist` | `is_finalist` |
| --- | --- | --- |
| `Semi-Finalist` | `true` | `false` |
| `Finalist` | `true` | `true` |
| `Awarded` | `true` | `true` |
| anything else | `false` | `false` |

> **Note:** A Finalist is by definition also a Semi-Finalist. The app enforces `is_semi_finalist = true` whenever `is_finalist = true` — both via the stage→flag auto-sync and the submit-time consistency check.

**Optional future enforcement via trigger** (not yet applied):

```sql
CREATE OR REPLACE FUNCTION sync_finalist_flags()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_semi_finalist := NEW.stage_of_application IN ('Semi-Finalist', 'Finalist', 'Awarded');
  NEW.is_finalist       := NEW.stage_of_application IN ('Finalist', 'Awarded');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_finalist_flags
  BEFORE INSERT OR UPDATE ON public.application
  FOR EACH ROW EXECUTE FUNCTION sync_finalist_flags();
```

---

## 3. `advisor` as the app user table

**Current state:** `advisor` now serves both as the staff profile table and the
authorization anchor for Supabase Auth. It carries the one-time Supabase Auth
bind (`auth_user_id`), the **sole** lifecycle field (`is_active`), and a
protected `role` display projection (`Admin` / `Advisor`).

**Why this design:** The OCF workflow is shared across staff. Advisors need full
shared access to students, applications, fellowships, and advising history.
Creating a separate `users` table would add extra joins without solving a real
problem at the current project size.

**Historical implementation shape** (the migration `20260317000003` shape that
later migrations extended):

```sql
ALTER TABLE public.advisor
  ADD COLUMN email text,
  ADD COLUMN auth_user_id uuid,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN role text NOT NULL DEFAULT 'advisor',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_login_at timestamptz;
```

**Current role semantics (migrations `20261001000001`–`20261007000001`):**
the `role` column is now constrained to exactly `Admin` / `Advisor` (CHECK,
default `'Advisor'`) and is a **protected display projection reconciled to the
Auth claim** — a bound advisor displays `Admin` only when
`auth.users.raw_app_meta_data.ocf_admin` is the JSON boolean `true`, and
`Advisor` otherwise. It is **never** an authorization input: effective
administration is the immutable Auth claim **plus** an active, pre-bound
advisor (`public.is_effective_admin()`), and direct authenticated role writes
are rejected (42501). Role changes run through the atomic `set_advisor_role`
RPC (migration `20261007000001`), which updates the claim and the display in
one transaction.

**Operating rule:** keep `advisor_name` UNIQUE, keep `advisor_id` as the integer
business PK, and set `is_active = false` instead of deleting former staff.
Advisor-row creation, peer UPDATE, and DELETE are denied to authenticated
clients; advisor accounts are created and bound only through the trusted
server-only provisioning path.

---

## 4. `fellowship` — Name Only (current decision: defer extra attributes)

**Current state:** `fellowship` stores only `fellowship_id` and `fellowship_name`.

**Attributes under consideration for future migrations:**

| Column | Type | Rationale |
| --- | --- | --- |
| `award_amount` | numeric | Show monetary value on the Fellowships page |
| `application_deadline` | date | Surface upcoming deadlines in the dashboard |
| `description` | text | Brief program description for advisors |
| `is_travel_fellowship` | boolean | Control whether `destination_country` is shown in application forms |
| `host_organization` | varchar | External body that grants the award (Rhodes Trust, etc.) |

**Decision:** Add these columns only when the UI needs to display or filter by them.
The current phase focuses on tracking applications, not managing program metadata.
`fellowship_name` remains UNIQUE regardless of what is added later.

---

## 5. Advisor-specific student roster — Derive from meeting history first

**Current state:** `public.advising_meeting` links each advising record to both
`student_id` and `advisor_id`, but `public.student` does not include an advisor
foreign key and there is no `student_advisor` bridge table.

**Decision:** The first version of `My students` on the advisor account page is a
derived convenience view, not a formal assignment model. It means
`students this advisor has met with`, computed from advising history.

**Why this design:** OCF advising continuity can involve multiple staff members
working with the same student over time. Adding `student.primary_advisor_id`
immediately would force a one-student-to-one-advisor shape that may be too rigid.

**Future direction:** If OCF later needs official caseload assignment, prefer a
new `student_advisor` table over adding a single `primary_advisor_id` column.
That bridge table can support primary and secondary relationships, active and
inactive assignments, and assignment start/end dates without rewriting advising
history.

---

## 6. Lifecycle: archive / deactivate instead of delete

**Current state:** `student` and `fellowship` carry a nullable `archived_at`
(`NULL` = active, a database-authored timestamp = archived) and `advisor` uses
`is_active` as its **sole** lifecycle field (there is no advisor
`archived_at`). Archive/deactivate is the only normal removal path; every FK
keeps the default `NO ACTION` semantics, so no historical relationship is ever
deleted, nulled, or cascaded.

**Why this design:** Students, applications, advising meetings, and award
history are durable records. Hard-deleting a student or fellowship would
silently destroy the historical context that reports, advising continuity, and
accountability depend on.

**Enforcement:** the admin-only RPC `public.lifecycle_transition` is the only
normal writer of lifecycle state; direct authenticated writes of
`archived_at`/`is_active` are rejected by column-scoped database guards; and
authenticated `DELETE` of `advisor`, `student`, `fellowship`, or `application`
is revoked at the grant and RLS layers. New operational child rows
(`application`, `advising_meeting`, `fellowship_thursday`,
`scholarship_history`) can never reference an archived student/fellowship at
the database boundary, while historical reads of rows referencing archived
parents are preserved.

---

## 7. Advising corrections are amendments, not edits

**Current state:** `advising_meeting` is database-enforced append-only history
(active advisors can `SELECT` and `INSERT` only). Corrections are recorded in
`advising_meeting_amendment`, an append-only child record with a database
-authored creator and timestamp and trim-aware non-empty `reason`/`details`
CHECKs.

**Why this design:** A meeting record is evidence of what happened. Editing or
deleting it would rewrite history. Recording the correction as a separate
amendment preserves both the original record and the correction trail, and more
than one amendment may reference the same meeting.

**Enforcement:** RLS grants `SELECT`/`INSERT` on `advising_meeting_amendment`
only; `UPDATE`/`DELETE` are denied; the creation trigger resolves the
authenticated active advisor and the database timestamp, rejecting any
client-supplied creator.
