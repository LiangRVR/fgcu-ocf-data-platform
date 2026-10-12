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
one transaction; `set_advisor_role` is the **single role-changing writer**
(migration `20261013000001` decommissioned the legacy lease/fencing
direct-write display-role RPCs `fenced_write_advisor_role_display` and
`reconcile_advisor_role_display`, which wrote only the mutable display
projection with no human actor/reason).

**Operating rule:** keep `advisor_name` UNIQUE, keep `advisor_id` as the integer
business PK, and set `is_active = false` instead of deleting former staff.
Advisor-row creation, peer UPDATE, and DELETE are denied to authenticated
clients; advisor accounts are created and bound only through the trusted
server-only provisioning path — the service-role-only `public.provision_advisor`
RPC (migration `20261013000001`), which validates the initiating effective Admin
and writes the advisor row and its `created` audit event in one transaction.

**Email is read-only in ordinary profile editing (change
`advisor-admin-immutable-history`).** An advisor's login email is an Auth
identity field. Ordinary profile PATCH accepts `advisor_name` only; any supplied
`email` is rejected rather than updating one identity source in isolation, so
`advisor.email` and the Supabase Auth email cannot silently diverge. Changing a
login email requires a future explicit trusted account-management workflow that
updates Auth and the advisor projection together. No such self-service flow
exists in this handoff.

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

---

## 8. Fellowship Thursday & Scholarship History corrections are amendments, not edits

**Current state (historical-integrity remediation, change
`2026-10-06-historical-integrity-remediation`):** `fellowship_thursday` and
`scholarship_history` base rows become immutable for normal authenticated
sessions, matching the established `advising_meeting` pattern. Corrections are
recorded in two new append-only child tables — `fellowship_thursday_amendment`
and `scholarship_history_amendment` — with database-authored creator and
timestamp. `UPDATE`/`DELETE` grants and policies are removed; active advisors
get explicit `SELECT`/`INSERT` only.

- `fellowship_thursday_amendment` references one original `attendance_id`. It
  carries a required non-blank `reason`, optional `details`, a nullable
  `corrected_attended`, a `corrects_source_info` flag, and a nullable
  `corrected_source_info`. The flag is what lets an advisor explicitly correct
  `source_info` to NULL instead of leaving it unchanged. At least one field
  correction is required per amendment.
- `scholarship_history_amendment` references one original `history_id`. It
  carries a controlled `amendment_type` (`Correction` or `Void`), a required
  non-blank `reason`, optional `details`, and an optional
  `corrected_fellowship_id` for a factual award correction. A `Void` is
  terminal for normal operations: the original award remains in the audit
  history but is excluded from active/operational award counts.

**Why this design:** an attendance or award record is evidence of what
happened. Editing or deleting it would rewrite history. Recording corrections
as separate amendments preserves both the original record and the correction
trail.

**Enforcement:** both amendment tables are append-only (explicit active-advisor
`SELECT`/`INSERT` RLS policies; no UPDATE/DELETE grants or policies; sequence
privileges limited to the intended role). Their creation triggers resolve the
authenticated active advisor and the database timestamp, rejecting any
client-supplied creator or timestamp and any invalid amendment payload.
Effective Fellowship Thursday values are resolved deterministically from a
shared `security_invoker` view/query boundary (newest applicable amendment per
corrected field, ordered by `(created_at, amendment_id)` descending), so
correction rows are never counted as independent attendance or award rows in
reports.

---

## 9. Fellowship Thursday event date & Scholarship award cycle — deferred (OCF decision required)

**Current state:** `fellowship_thursday` records attendance
(`student_id`, `attended`, `source_info`) against the weekly Thursday meeting
but has **no event/meeting date column**. `scholarship_history` records awards
(`student_id`, `fellowship_id`) but has **no award cycle/year column**.

**Why deferred (recorded in the 2026-10-06 historical-integrity
remediation):** OCF must decide whether weekly Fellowship Thursday needs an
event date and whether historical awards need an award cycle **before either
schema is changed**. These values cannot be inferred safely from the existing
data, and any backfill would fabricate history.

**Decision required from OCF (product owner):**

1. Does Fellowship Thursday need an event/meeting date on each attendance
   record? If so, at what granularity (e.g. the date of the weekly meeting)?
2. Does Scholarship History need an award cycle/year? If so, how is an unknown
   legacy cycle represented?

Until OCF decides, neither field is added, no historical value is inferred or
backfilled, and displays render unknown context as "date unknown" / "year
unknown" rather than a guess. Once OCF decides, the field would be added in a
future forward-only migration together with a matching amendment model — never
by mutating existing rows.

---

## 10. Immutable audit trail is database-authored, append-only, and never backfilled

**Current state (migrations `20261012000001` + `20261013000001`):** the database
maintains an immutable audit trail in `public.audit_event`. The core writer
covers the three current-state business tables (`student`, `fellowship`,
`application`); the extension covers `advisor`. Every INSERT and every
meaningful UPDATE writes exactly one database-authored event inside the source
mutation's own transaction, through an internal `SECURITY DEFINER` trigger
helper in the unexposed `private` schema.

**Why this design:** the audit trail must be trustworthy evidence. If client
code (or an RPC reachable by a client) could write audit rows, history could be
forged or shaped by the very actors it is meant to hold accountable. If the
event were written outside the business transaction, a committed mutation could
silently lack its audit record. If the actor's display name were looked up at
read time, a later rename would rewrite the meaning of a past event.

**Enforcement:**

- **Database-authored only.** No product role has
  INSERT/UPDATE/DELETE/TRUNCATE on `audit_event` or USAGE on its sequence, and
  there is no INSERT/UPDATE policy — so neither staff nor Admin can write or
  alter an audit row. The only writer is the internal trigger, invoked by the
  source mutation itself.
- **Transaction-atomic.** The `AFTER INSERT/UPDATE` trigger writes the event in
  the same transaction; an audit failure aborts the business write (fail
  closed), so a committed mutation always has its audit record.
- **Frozen snapshots.** `actor_name_snapshot` copies the advisor's name at event
  time, and `old_values`/`new_values`/`changes` are explicit whitelisted
  snapshots/diffs, so a later rename or schema change cannot rewrite a prior
  event. The `entity_id` and `subject_*_id` context columns are stored without
  foreign keys precisely so history is never cascaded or nulled.
- **Least-privilege reads.** Active authenticated advisors get `SELECT` only,
  gated by `public.is_active_advisor()`; the helper function and the `private`
  schema are not reachable by any client role.
- **No fabricated baseline.** `baseline_captured` and the `migration` origin are
  reserved in the CHECK vocabularies but have **no writer** in this rollout; no
  event is created for pre-existing rows. A baseline may only be captured by a
  future, explicitly authorized operation.

**Operating rule:** never add a client-callable writer for `audit_event`, never
look up actor identity or values at read time, and never backfill history by
guessing. If the audited entity/action vocabulary must grow, extend the CHECK
constraint in a new forward-only migration and update the snapshot/diff
whitelist — do not normalize or rewrite existing events.

---

## 11. Advisor/admin immutable history, attribution, required reasons, and the durable last-Admin invariant

**Current state (change `advisor-admin-immutable-history`, migration
`20261013000001`):** the immutable-audit core is extended to advisor and
administrator operations without a second audit table or a second authorization
system. `public.audit_event` remains the single protected history surface.

**Advisor audit coverage and sensitive-field exclusion.** A dedicated internal
trigger helper (`private.audit_advisor_change`, trigger
`trg_audit_advisor_current_state` on `public.advisor`) writes exactly one event
per advisor INSERT or meaningful UPDATE. Its snapshot/diff allowlist is exactly
`advisor_name`, `email`, `role`, and `is_active`. Binding, authentication,
credential, token, claim, service-role, login-time, and role-lock data
(`auth_user_id`, `last_login_at`, timestamps, the legacy `advisor_role_lock`
infrastructure, and any future column) can never be audited. A change limited to
a non-allowlisted/technical field such as `last_login_at` writes no event.
Classification: INSERT → `created`; an allowlisted profile edit → `updated`; an
`is_active` transition → `deactivated`/`reactivated`; a role change →
`role_changed`.

**Human attribution across trusted operations.** Service-role operations lose
the browser session, so the server passes its already-authorized effective-Admin
advisor id to a service-only routine. The database revalidates that id as a
current, ACTIVE, pre-bound advisor whose durable Auth metadata
(`auth.users.raw_app_meta_data.ocf_admin`) is the strict JSON boolean `true` —
the same durable authority the last-Admin invariant uses, never the mutable
display role and never a possibly-stale JWT. The verified id and frozen name are
stored in transaction-local context (`private.set_audit_actor`), which cannot
leak across requests and is not client-addressable (no client EXECUTE grant).
`public.provision_advisor` (service-role only) writes the advisor row and its
single `created` event attributed to the initiating Admin in the same
transaction, so normal provisioning is never attributed to `System`. Ordinary
authenticated profile/lifecycle writes continue to derive the actor from
`auth.uid()`.

**Required reasons for role and lifecycle actions.** `set_advisor_role` now
takes `(p_advisor_id, p_role, p_reason, p_actor_id)` and
`lifecycle_transition` takes `(p_entity, p_action, p_entity_id, p_reason)`; both
reject a NULL or blank reason (`22023`). The prior 2-arg and 3-arg signatures
are explicitly dropped so the reason cannot be bypassed through the legacy
arity. The one `role_changed` event carries the reason, the role diff, the
verified actor, and the frozen name; student/fellowship lifecycle events receive
the reason through the existing current-state helper without expanding their
allowlist.

**Atomic audit + state.** Every state change and its audit event commit in one
transaction; an audit or validation failure rolls back both, so a committed
meaningful mutation always has exactly one event. The atomic role change sets
`auth.users.raw_app_meta_data.ocf_admin` and `public.advisor.role` in the same
transaction as its single explicit `role_changed` event, and suppresses the
generic advisor trigger for that one write so no duplicate event is produced.

**Durable, concurrency-safe last-active-bound-Admin invariant.** Role demotion
and advisor deactivation acquire the same fixed transaction-scoped advisory lock
(`hashtextextended('ocf.advisor_admin_membership', 0)`) before reading
membership, then count ACTIVE, bound advisors joined to
`auth.users.raw_app_meta_data.ocf_admin = true` (strict JSON boolean; the display
role is never the authority). A transition that would take a nonzero membership
to zero is rejected (`42501`); competing final-Admin reductions serialize on the
lock and cannot interleave. The check deliberately does not repair a
pre-existing zero-Admin state — break-glass/DBA recovery stays outside normal
product paths.

**Legacy display-role writers decommissioned (migration `20261013000001`).**
The earlier per-advisor lease/fencing display-role RPCs
`fenced_write_advisor_role_display` and `reconcile_advisor_role_display` are
dropped: each wrote only the mutable `advisor.role` display projection (never
the durable Auth claim), carried no human actor or reason, and performed no
last-active-Admin check, so a service-role caller could land a claim/display
mismatch or remove the last effective Admin without a human-attributed audit
event. `set_advisor_role` is therefore the **single role-changing writer**. The
`advisor_role_lock` lease (`acquire_advisor_role_lock` /
`release_advisor_role_lock`) and the read-only `verify_advisor_role_lock` /
`fenced_read_advisor_role_display` primitives are retained as
infrastructure-only, unaudited primitives that write no advisor state; the
legacy `recoverAdvisorRoleChange` adapter recovery path no longer exists.

**Email is read-only in ordinary profile editing** — see §3.
