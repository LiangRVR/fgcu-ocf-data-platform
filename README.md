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
│   ├── migrations/         # Forward-only migration chain (22 migrations)
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

> **Architectural rule:** Historical records (advising meetings, Fellowship
> Thursday attendance, scholarship awards) are append-only. Existing base rows
> must not be directly edited or deleted through normal application workflows.
> Corrections are represented as separate amendment records (and `Void` for
> wrongly recorded awards), never as edits or deletes.

See [docs/schema-reference.md](docs/schema-reference.md) and
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

The repository ships no hosted/production configuration and must not be
deployed against the hosted production database while the
[production provenance freeze](supabase/SCHEMA.md#migration-deployment-freeze)
is in effect.

---

## 🤝 Contributing

This is an internal project for FGCU OCF. For questions or issues, contact the development team.

---

## 📄 License

See [LICENSE](LICENSE) for details.
