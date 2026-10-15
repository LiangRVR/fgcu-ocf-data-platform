# OCF Fellowship Management System

Internal admin platform for the **FGCU Office of Competitive Fellowships (OCF)**.
Manages students, fellowship opportunities, applications, and advising sessions.

---

## 🚀 Quick Start (local development)

The supported local workflow runs against a **Docker-local Supabase instance** —
no hosted project is required. The repository migration chain is forward-only
and is applied in full to a fresh, disposable local instance.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up environment

```bash
cp .env.example .env.local
```

`.env.local` requires five keys:

| Key | Purpose | Visibility |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Browser-safe |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key | Browser-safe |
| `APP_URL` | Server-side absolute app URL (auth redirects / recovery links) | Server-only |
| `SUPABASE_URL` | Server-only Supabase URL for trusted advisor provisioning | Server-only |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service-role secret for trusted advisor provisioning | Server-only — **secret** |

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` must **never** be prefixed with
> `NEXT_PUBLIC_`, committed, or exposed to the browser/client-side code. Keep
> it only in `.env.local` or your secret store. For local development, map the
> outputs of `pnpm exec supabase status -o env` into `.env.local` by hand —
> copy values, never print or commit them:
>
> | `supabase status -o env` output | App variable |
> | --- | --- |
> | `API_URL` | `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL` |
> | `ANON_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
> | `SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |

### 3. Start the local Supabase stack and apply the schema

```bash
pnpm exec supabase start          # start the local stack (first run pulls Docker images)
pnpm exec supabase db reset --no-seed   # apply the full migration chain to a fresh local database
pnpm exec supabase status -o env  # capture local runtime URLs/keys
```

Stop it later with `pnpm exec supabase stop --no-backup`. See the
[Quick Start Guide](docs/quickstart.md) for details.

### 4. Generate TypeScript types

```bash
pnpm run db:types   # runs `supabase gen types --local > types/database.ts`
```

### 5. Run the development server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📚 Documentation

- **[Quick Start Guide](docs/quickstart.md)** — local Docker Supabase workflow, environment setup, type generation, verification, and what is / is not done
- **[Schema Reference](docs/schema-reference.md)** — canonical schema with all constraints and business rules
- **[Supabase Setup](supabase/README.md)** — detailed database configuration and migration guidance
- **[Database Schema](supabase/SCHEMA.md)** — one-page reference: tables, keys, business rules, and the ordered migration table
- **[Schema Design Decisions](docs/schema-decisions.md)** — rationale for key data-model choices
- **[Schema Verification](docs/schema-verification.md)** — database setup checklist
- **[FGCU/OCF IT Handoff](docs/it-handoff.md)** — owner boundaries, the trusted legacy-baseline import pattern, and the resolved OCF identifier requirements
- **[Testing & Verification](aidlc-docs/project/testing.md)** — command semantics and prerequisites for the test suites

---

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| **Framework** | Next.js 16 (App Router, Server Components) |
| **Language** | TypeScript (strict mode) |
| **Database** | Supabase (PostgreSQL) |
| **Auth** | Supabase Auth + `@supabase/ssr` |
| **Styling** | Tailwind CSS v4 |
| **Design System** | Neutral SaaS admin surfaces with FGCU brand accents |
| **UI Library** | shadcn/ui + Radix UI |
| **Typography** | Merriweather (headings) + Open Sans (body) |
| **Forms** | React Hook Form + Zod |
| **Icons** | lucide-react |
| **Toasts** | Sonner |

---

## 📁 Project Structure

```text
├── app/                    # Next.js App Router (auth pages, dashboard, API routes)
├── components/             # Feature tables, dashboard shell, shadcn/ui primitives
├── lib/                    # Server-side auth/session helpers, config, Supabase clients
├── types/                  # TypeScript types (auto-generated database + app-level)
├── supabase/
│   ├── migrations/         # Forward-only migration chain (38 migrations, through 20261024000001)
│   ├── SCHEMA.md           # One-page schema reference
│   └── README.md           # Supabase setup guide
├── docs/                   # Project documentation
└── scripts/                # Connection test, contract/E2E runners, test support
```

For current navigation destinations (sidebar pages and the admin-only Advisor
Management page) and the reports surface, see the
[Quick Start Guide](docs/quickstart.md).

---

## 🔐 Roles & History

- **Roles** — exactly two operational roles: `Admin` and `Advisor`. Effective
  administration is the immutable Auth claim plus an active, pre-bound advisor
  identity; the mutable `advisor.role` display column is never authorization.
  Advisor accounts are provisioned through a server-only admin pre-binding path
  (never email self-link); the first effective Admin is bootstrapped out of
  band via the service role / Supabase Admin API — no public bootstrap
  endpoint, no exposed secrets — after which normal protected provisioning
  applies. See [supabase/README.md](supabase/README.md).
- **Archive instead of delete** — students/fellowships archive
  (`student.archived_at` / `fellowship.archived_at`) and advisors
  deactivate/reactivate via the admin-only `lifecycle_transition` RPC;
  historical relationships are preserved, and core tables have an
  authenticated DELETE lockdown.
- **Append-only history** — advising meetings, Fellowship Thursday attendance,
  and Scholarship History awards are append-only base records; corrections are
  recorded as `advising_meeting_amendment`, `fellowship_thursday_amendment`,
  and `scholarship_history_amendment` rows, never as edits or deletes.
  Scholarship `Void` amendments keep the original award in the audit trail
  while excluding it from operational counts.
- **Required identifiers on new records** — every new Fellowship Thursday
  attendance record must carry its weekly event calendar date (`event_date`) and
  every new Scholarship History award must carry its four-digit award year
  (`award_year`, 1000–9999). The requirement is enforced at the authoritative
  database write boundary (an authenticated insert missing the identifier is
  rejected), not only in the UI. The columns are additive and nullable:
  genuinely unknown legacy rows keep a truthful `NULL`, and no date or year is
  ever inferred or backfilled. Both are immutable base facts — corrections
  cannot add or change them.
- **Activity** — `/activity` is an authenticated, server-paginated read of the
  `public.audit_activity` view over the immutable `audit_event` trail, with
  filters for record type, change, actor, student, fellowship, and date range.
  `audit_activity` is a `security_invoker`, browser-safe projection: it exposes
  frozen relationship labels (from `audit_event_subject`) and never exposes the
  raw audit JSON snapshots (`old_values`/`new_values`/`changes`), which are
  unreadable to every client role and fetched only by server-only service-role code.

### Immutable history invariant

> **At the database boundary, current-state business entities may change, but
> no meaningful prior state may be lost.** Every business mutation commits
> atomically with an immutable, database-authored history record identifying
> the actor, timestamp, previous state, new state, and actual changed fields.
> Historical/event records are never directly modified or deleted; corrections
> are represented through append-only amendment records. No normal application
> role, including Admin, may alter audit history. Current-state business
> entities (`student`, `advisor`, `fellowship`, `application`) must use their
> database-owned versioned writer; audit failure aborts the business write.

The schema classifies entities into exactly three categories:

| Category | Entities | Rule |
| --- | --- | --- |
| **Current-state / audited** | `student`, `advisor`, `fellowship`, `application` | Mutable only through the expected-`row_version` database writer for that entity; each meaningful mutation writes exactly one immutable `audit_event`. Direct authenticated `UPDATE` is revoked. |
| **Immutable base** | `advising_meeting`, `fellowship_thursday`, `scholarship_history` | Append-only history: normal roles may `SELECT`/`INSERT` only; rows are never updated or deleted. Inserts are audited (`created`). |
| **Append-only amendment** | `advising_meeting_amendment`, `fellowship_thursday_amendment`, `scholarship_history_amendment` | Correction records appended (never edited); `scholarship_history_amendment` also carries a terminal `Void`. Inserts are audited (`correction_added`; a `Void` is `voided`). |

Corrections are represented as separate amendment records (and `Void` for
wrongly recorded awards), never as edits or deletes. Effective-value views
(`effective_fellowship_thursday`, `effective_scholarship_history`) apply the
newest amendment without rewriting the base facts.

Every audit event also receives immutable, normalized subject associations in
`audit_event_subject` (`subject` / `previous` / `current` links, with an
event-time name snapshot), so a re-link or correction stays discoverable from
both endpoints. Those associations and their frozen labels are derived only from
immutable event payloads; existing events were backfilled once, idempotently,
without joining any mutable table and without fabricating an event. No row of
history is created for pre-existing business data by any normal path:
`baseline_captured` / `origin = migration` has exactly one writer — the trusted,
transaction-local `service_role`/DBA-only import helper used by FGCU IT (see
[the IT handoff](docs/it-handoff.md)) — and ordinary later writes remain
`created` / `origin = user`.

> **Advising-history privilege closure.** The append-only `advising_meeting`
> and `advising_meeting_amendment` tables also revoke the destructive
> `TRUNCATE` privilege from `PUBLIC`, `anon`, and `authenticated` (migration
> `20261017000001_revoke_advising_meeting_truncate.sql`), matching the sibling
> historical tables already closed in `20261008000001`. A normal product role
> therefore cannot wipe the entire advising history through the `TRUNCATE`
> path even though row-level `UPDATE`/`DELETE` were already denied; the trusted
> `service_role` grant is untouched.

> **DBA / service-role trust boundary.** OCF product `Admin` is **not** a
> PostgreSQL superuser and has no special table privileges: the Admin privilege
> is the immutable Auth `app_metadata.ocf_admin = true` claim plus an active,
> pre-bound advisor row. A PostgreSQL `service_role`/DBA session is a separate
> technical trust boundary used only for trusted provisioning, first-Admin
> bootstrap, and synthetic test fixtures — it is not a normal application path
> and must never be exposed to the browser.

See [docs/schema-reference.md](docs/schema-reference.md),
[docs/schema-decisions.md](docs/schema-decisions.md), and
[supabase/SCHEMA.md](supabase/SCHEMA.md) for the full model.

---

## 📜 Available Scripts

```bash
pnpm dev              # Start development server
pnpm build            # Build for production
pnpm start            # Start production server
pnpm lint             # Run ESLint
pnpm db:types         # Generate TypeScript types from the local Supabase instance
pnpm test:connection  # Test Supabase connection
```

### Testing

There is deliberately **no bare `pnpm test`**. The test layers are explicit:

```bash
pnpm run test:unit            # Fast unit tests (no coverage)
pnpm run test:unit:coverage   # Unit tests + threshold-enforced V8 coverage of lib/** and app/api/**
pnpm run test:contract        # Contract/RLS tests (Docker-local Supabase, requires Docker)
pnpm run test:e2e             # Playwright Chromium E2E (requires Docker + built app)
pnpm run test:all             # Full aggregate: unit + contract + e2e
```

The contract and E2E suites automatically run the full migration chain against
a throwaway isolated Docker-local instance. See the
[Quick Start Guide](docs/quickstart.md) and
[Testing & Verification](aidlc-docs/project/testing.md) for details.

---

## 🚧 Handoff Boundary

This repository is a **source-code handoff for the local platform**. The
following institutional responsibilities are **excluded** and remain with OCF /
FGCU IT after handoff:

- **Real data import** — importing real production data into the system
- **University deployment** — production hosting, networking, domains, and
  secret/credential management
- **SSO** — university single sign-on integration
- **Backups** — institutional backup and recovery procedures
- **Monitoring** — production monitoring and alerting

See [FGCU/OCF IT Handoff](docs/it-handoff.md) for the concise owner boundary and
the approved trusted legacy-baseline import procedure. The repository ships no
hosted/production configuration, no credentials, and no production runbook, and
must not be deployed against the hosted production database while the
[production provenance freeze](supabase/SCHEMA.md#migration-deployment-freeze)
is in effect.

---

## 🤝 Contributing

This is an internal project for FGCU OCF. For questions or issues, contact the development team.

---

## 📄 License

See [LICENSE](LICENSE) for details.
