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
authorization anchor for Supabase Auth.

**Why this design:** The OCF workflow is shared across staff. Advisors need full
shared access to students, applications, fellowships, and advising history.
Creating a separate `users` table would add extra joins without solving a real
problem at the current project size.

**Implementation shape:**

```sql
ALTER TABLE public.advisor
  ADD COLUMN email text,
  ADD COLUMN auth_user_id uuid,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN role text NOT NULL DEFAULT 'advisor',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_login_at timestamptz;
```

**Operating rule:** keep `advisor_name` UNIQUE, keep `advisor_id` as the integer
business PK, and set `is_active = false` instead of deleting former staff.

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
