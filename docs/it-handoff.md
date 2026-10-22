# FGCU / OCF IT Handoff

This repository is a **source-code handoff for the local platform**. It ships the
application, the forward-only database migration chain (38 migrations, ending
with `20261024000001_dated_attendance_award_year.sql`), tests, and
documentation. It ships **no hosted/production configuration and no
credentials**, and it does not instruct a production operation.

This page records the ownership boundary and the one approved pattern for
loading real institutional data. It is not a production runbook and contains no
secrets, connection strings, or deployment steps.

---

## 1. What the repository provides

- **Application source** — Next.js app, Supabase clients, server-side auth, and
  the operational UI.
- **Database definition** — the complete forward-only migration chain under
  `supabase/migrations/` and the schema references
  ([`docs/schema-reference.md`](./schema-reference.md),
  [`supabase/SCHEMA.md`](../supabase/SCHEMA.md)).
- **Local verification** — unit, contract/RLS, and Chromium E2E suites that run
  against an isolated Docker-local Supabase instance with synthetic fixtures
  (see [`docs/quickstart.md`](./quickstart.md) and
  [`aidlc-docs/project/testing.md`](../aidlc-docs/project/testing.md)).
- **The immutable-history contract** — the durable rule that no normal product
  access may change business history without an atomic, immutable,
  database-authored `audit_event` (see
  [`docs/schema-decisions.md`](./schema-decisions.md) §10).

## 2. Responsibilities that remain with FGCU / OCF IT

The following are **excluded** from this handoff and remain institutional
responsibilities. The repository intentionally contains no implementation or
credentials for any of them:

| Responsibility | Owner | Notes |
| --- | --- | --- |
| **Real data migration** | FGCU/OCF IT | Importing existing OCF/FGCU records into the platform (see §3). |
| **Environment & secrets** | FGCU/OCF IT | Hosting the database and app, and provisioning all keys/secrets in an institutional secret store. The repository holds no production credentials. |
| **University SSO** | FGCU IT | Any single sign-on integration; the shipped auth model is Supabase Auth plus the internal `advisor` authorization table. |
| **Domains & networking** | FGCU IT | DNS, TLS, and network placement. |
| **Backups & recovery** | FGCU/OCF IT | Institutional backup schedule, retention, and restore procedures. |
| **Monitoring & alerting** | OCF/FGCU IT | Runtime monitoring, log retention, and alert routing. |

The application's `Admin` role is **not** a PostgreSQL superuser. Effective
administration is the immutable Auth claim `app_metadata.ocf_admin = true`
**plus** a current, active, pre-bound `public.advisor` row
(`public.is_effective_admin()`); the mutable `advisor.role` display column is
never authorization. A PostgreSQL `service_role`/DBA session is a separate
technical trust boundary used only for trusted provisioning, first-Admin
bootstrap, and synthetic fixtures — it is never a normal application path and
must never be exposed to the browser.

## 3. Trusted legacy-baseline import pattern (real data)

Real institutional data is loaded **once**, by FGCU/OCF IT, inside a **trusted
`service_role`/DBA session**. The platform deliberately has no client-writable
way to fabricate history: there is no public bootstrap endpoint and no
client-callable audit writer, and a normal application path cannot create a
`baseline_captured` event.

The approved pattern is **transaction-local**:

```sql
-- Trusted service_role / DBA session only (never a browser or product JWT).
BEGIN;

  -- Enable baseline provenance for THIS transaction only.
  SELECT public.begin_legacy_baseline_import();

  -- Insert the legacy baseline rows in the SAME transaction.
  -- Each imported audited row is captured as:
  --   action = 'baseline_captured', origin = 'migration',
  --   actor_advisor_id = NULL, actor_name_snapshot = 'System'
  -- with the known imported state and its known subject associations.
  INSERT INTO public.student (...) VALUES (...);
  INSERT INTO public.fellowship (...) VALUES (...);
  INSERT INTO public.application (...) VALUES (...);
  -- ... other baseline rows ...

COMMIT;
```

Rules for this pattern:

- **Same transaction only.** `begin_legacy_baseline_import()` enables the
  context transaction-locally (`set_config(..., true)`); the inserts must run in
  that same transaction. Outside it, imports are ordinary `created` events.
- **Trusted session only.** The helper and the BEFORE normalizer both revalidate
  the trusted technical session, so a product session cannot forge
  `baseline_captured`/`origin = migration` by setting a flag.
- **No fabricated history.** Do not invent a historic creator, an original
  timestamp, or an event/cycle value that the source data does not prove. Do not
  backfill an unknown value by guessing.
- **No repository credentials.** Do not commit, log, or paste service-role keys,
  connection strings, or production data into the repository, tests, or
  documentation.
- **After the import, normal application writes resume** as `created` /
  `origin = user`, attributed to the authenticated actor.

Operational rollback is forward-only: the audit surface is additive and no write
path reads it, so application rollback can simply stop reading it. There is no
down migration and no data reset.

## 4. What the application does not and will not do

To protect the immutable-history guarantee, the following are permanent product
boundaries — not configuration options:

- A product role (including `Admin`) cannot `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`
  `audit_event`, `audit_event_subject`, or any historical base/amendment row.
- The raw audit JSON snapshots (`old_values`/`new_values`/`changes`) are
  unreadable to **every** client role and are fetched only by server-only
  service-role code; the browser-safe `audit_activity` view never exposes them.
- Archived students/fellowships are read-only current state; restore first, edit
  through the versioned writer, then optionally archive again.
- Current-state edits carry an expected `row_version`; a stale version is
  rejected with `PT409` before any change.

## 5. Resolved OCF identifier requirements (event date and award year)

The two OCF product-owner questions about identifying operational history are now
**settled and implemented** (change `dated-attendance-award-year`, migration
`20261024000001_dated_attendance_award_year.sql`). The schema never infers or
backfills a value for historic data, so these requirements apply to **new
operational records only**:

1. **Fellowship Thursday event date** — each new Fellowship Thursday attendance
   record must identify the calendar date of its weekly event (`event_date`,
   a `date` — not a timestamp, time zone, or recurrence model).
2. **Scholarship History award year** — each new Scholarship History award must
   identify its four-digit award year (`award_year`, 1000–9999).

Rules for these identifiers:

- **Enforced at the database boundary.** A normal product insert carries a request
  identity (`auth.uid()`); one that omits the identifier is rejected
  fail-closed, so the requirement holds regardless of any UI path.
- **Legacy values stay NULL.** Both columns are nullable and additive; every
  pre-existing row keeps a truthful `NULL`, and no date or year is ever inferred,
  guessed, or backfilled.
- **Trusted import compatibility.** A trusted, no-JWT `service_role`/DBA
  import/seed insert may retain `NULL` under the existing technical trust
  boundary; no browser/product route uses it.
- **Immutable base facts.** Corrections are amendments and cannot add or change
  either identifier; a future correction model for an erroneously entered
  identifier would be a separate change.

See [`docs/schema-decisions.md`](./schema-decisions.md) §9 for the design
rationale and §18/§19 for the interaction with trusted baseline imports (which
must never invent an event date or award year the source data does not prove).
