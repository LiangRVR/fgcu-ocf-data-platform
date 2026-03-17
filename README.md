# OCF Fellowship Management System

Internal admin platform for the **FGCU Office of Competitive Fellowships (OCF)**.
Manages students, fellowship opportunities, applications, and advising sessions.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and add your Supabase credentials (see [Quick Start Guide](docs/quickstart.md)).

### 3. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📚 Documentation

- **[Quick Start Guide](docs/quickstart.md)** - Get up and running with Supabase
- **[FGCU Design Style Guide](docs/DESIGN_GUIDE.md)** - Official design system and style guidelines
- **[UI/UX Refactor Summary](docs/UI_UX_REFACTOR.md)** - Complete UI/UX transformation documentation
- **[Schema Verification](docs/schema-verification.md)** - Database setup checklist
- **[Schema Reference](docs/schema-reference.md)** - Full schema with all constraints and business rules
- **[Schema Design Decisions](docs/schema-decisions.md)** - Rationale for key data-model choices
- **[Supabase Setup](supabase/README.md)** - Detailed database configuration
- **[Database Schema](supabase/SCHEMA.md)** - One-page reference: tables, PKs, FKs, business rules

---

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| **Framework** | Next.js 16 (App Router, Server Components) |
| **Language** | TypeScript (strict mode) |
| **Database** | Supabase (PostgreSQL) |
| **Auth** | Supabase Auth + `@supabase/ssr` |
| **Styling** | Tailwind CSS v4 |
| **Design System** | FGCU Brand Colors + Custom Palette |
| **UI Library** | shadcn/ui + Radix UI |
| **Typography** | Merriweather (headings) + Open Sans (body) |
| **Forms** | React Hook Form + Zod |
| **Icons** | lucide-react |
| **Toasts** | Sonner |

---

## 📁 Project Structure

```text
├── app/                    # Next.js App Router
│   ├── (auth)/            # Authentication pages
│   │   ├── login/         # Login page wired to Supabase Auth
│   │   ├── forgot-password/ # Password recovery request page
│   │   └── reset-password/ # Password reset completion page
│   ├── (dashboard)/       # Protected dashboard pages
│   │   ├── dashboard/     # Live overview: KPIs, distributions, recent activity
│   │   │   └── account/   # Advisor account page with profile, security, meetings, students
│   │   ├── students/      # Student list (CRUD, search, sort, filter, CSV export)
│   │   │   └── [id]/      # Student detail page (profile + related records)
│   │   ├── fellowships/   # Fellowship list with per-fellowship metrics
│   │   ├── applications/  # Application tracking with stage pipeline
│   │   ├── advising/      # Advising session records
│   │   ├── fellowship-thursday/ # Weekly meeting attendance
│   │   ├── scholarship-history/ # Past scholarship awards
│   │   └── reports/       # Placeholder (charts not yet built)
│   ├── api/               # API routes
│   │   ├── account/       # Advisor account update endpoints
│   │   ├── auth/          # Sign-out + password recovery endpoints
│   │   └── health/        # Health check endpoint
│   └── globals.css        # FGCU design system styles
├── components/
│   ├── advising/          # AdvisingTable (CRUD client component)
│   ├── applications/      # ApplicationsTable (CRUD client component)
│   ├── fellowship-thursday/ # FellowshipThursdayTable (CRUD client component)
│   ├── scholarship-history/ # ScholarshipHistoryTable (CRUD client component)
│   ├── students/          # StudentsTable (CRUD + sort + filter client component)
│   ├── layout/            # Shell, sidebar, top bar, page header
│   └── ui/                # shadcn/ui components (buttons, cards, badges, etc.)
├── lib/
│   ├── auth/              # Server-side session helpers + advisor authorization
│   ├── config/            # Navigation config (9 sidebar items)
│   ├── supabase/          # Supabase SSR clients + proxy session refresh helpers
│   ├── utils/             # cn, format (formatDate, getInitials, formatCurrency)
│   └── validators/        # Zod schemas (auth + account flows)
├── types/                 # TypeScript types (Database auto-generated, App-level)
├── supabase/
│   ├── migrations/        # Initial schema plus advisor auth and active-advisor RLS migrations
│   ├── SCHEMA.md          # Quick-reference schema table
│   └── README.md          # Supabase setup guide
├── docs/                  # Project documentation
│   ├── DESIGN_GUIDE.md    # FGCU design system
│   ├── UI_UX_REFACTOR.md  # UI transformation notes
│   ├── STUDENTS_DASHBOARD_UPGRADE.md # Students page upgrade details
│   ├── schema-reference.md # Canonical schema with all constraints
│   ├── quickstart.md      # Environment + Supabase setup
│   └── schema-verification.md # Database setup checklist
└── scripts/               # test-connection.ts
```

See the [full project structure details](docs/quickstart.md#project-structure) for more information.

---

## 🗄️ Database Setup

The application uses Supabase for the backend. To set up the database:

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
2. **Apply migration 1** — schema: run `supabase/migrations/20260305000000_initial_schema.sql`
3. **Apply migration 2** — bootstrap anon read: run `supabase/migrations/20260305000001_allow_anon_read.sql`
4. **Apply migration 3** — bootstrap anon write: run `supabase/migrations/20260305000002_allow_anon_write.sql`
5. **Apply migration 4** — advisor auth support: run `supabase/migrations/20260317000003_advisor_auth.sql`
6. **Backfill confirmed advisor emails** in `public.advisor.email` before enforcing a non-null requirement on non-empty databases
7. **Create Supabase Auth users** for your advisors with email addresses that exactly match `public.advisor.email`
8. **Apply migration 5** — active-advisor RLS: run `supabase/migrations/20260317000004_active_advisor_rls.sql` after verifying at least one advisor can sign in
9. **Generate types**: Run `pnpm run db:types`
10. **Test connection**: Run `pnpm run test:connection`

Migrations 2 and 3 are bootstrap steps for early setup. Migration 5 replaces that temporary anon access with authenticated active-advisor access as the intended steady state.

For detailed instructions, see the [Supabase Setup Guide](supabase/README.md).

---

## 🎯 Features

### Implemented

- ✅ **Live Dashboard** - 13 parallel Supabase queries: totals, finalists, semi-finalists, advising this month, no-shows, student flag distributions (CH / Honors / First-Gen), applications by stage, students by class standing, finalists by fellowship, recent meetings and applications
- ✅ **Students** - Full CRUD (add / edit / delete with confirmation dialog), client-side search + status + major filters, multi-column sort, click-through to student detail page, KPI cards, skeleton loading states
- ✅ **Student Detail Page** - Full profile view with applications, advising meetings, Fellowship Thursday attendance, and scholarship history all loaded in parallel
- ✅ **Applications** - Live queries with student + fellowship joins, full CRUD table, stage badges, finalist / semi-finalist flags
- ✅ **Advising** - Live queries with student + advisor joins, full CRUD table, no-show badge, meeting mode
- ✅ **Fellowship Thursday** - Live attendance records with student join, full CRUD table
- ✅ **Scholarship History** - Live records with student + fellowship joins, full CRUD table
- ✅ **Fellowships** - Live list with per-fellowship metrics (total applications, finalists, awarded) derived from the `application` table
- ✅ **Professional Dashboard UI** - Neutral slate sidebar, FGCU green accents, responsive layout
- ✅ **Semantic Status Badges** - Color-coded indicators throughout all tables
- ✅ **FGCU Design System** - Consistent colors, typography, and spacing (see `docs/DESIGN_GUIDE.md`)
- ✅ **Supabase SSR Auth Wiring** - Browser/server clients, proxy session refresh, protected dashboard layout, and real sign-in/sign-out flow
- ✅ **Advisor Account Center** - `/dashboard/account` with profile editing, password updates, advisor-scoped meeting history, and meeting-derived student roster
- ✅ **Password Recovery Flow** - Forgot-password request page plus reset-password completion page
- ✅ **Advisor Profile Sync** - Account email updates keep Supabase Auth and `public.advisor.email` aligned
- ✅ **Database Schema** - 7 core tables plus advisor-auth and active-advisor RLS migrations
- ✅ **TypeScript Type Safety** - Full type coverage, auto-generated Supabase types
- ✅ **Form Validation** - Zod schemas + React Hook Form on the login form; manual validation (field-level errors + consistency checks) on all CRUD dialogs throughout the dashboard
- ✅ **Toasts** - Sonner toast notifications on all mutations

### In Progress

- 🔄 **Advisor Provisioning** - Existing advisor rows still need confirmed FGCU email backfill before the auth migration can be finalized on populated databases
- 🔄 **Production Auth Verification** - Email-change confirmations and password-recovery delivery still need end-to-end verification against the real Supabase project
- 🔄 **Reports page** - Page exists with placeholder empty state; charts and export logic not yet built

### Planned

- 📋 Server-side pagination (currently client-side)
- 📋 CSV / PDF export (Students export button present; logic not yet implemented)
- 📋 Bulk actions (multi-select + bulk delete)
- 📋 Real-time updates via Supabase subscriptions
- 📋 Role-based access control beyond shared active-advisor access
- 📋 Formal student assignment model if OCF needs a true advisor caseload table

---

## 📜 Available Scripts

```bash
pnpm dev              # Start development server
pnpm build            # Build for production
pnpm start            # Start production server
pnpm lint             # Run ESLint
pnpm db:types         # Generate TypeScript types from Supabase
pnpm test:connection  # Test Supabase connection
```

---

## 🤝 Contributing

This is an internal project for FGCU OCF. For questions or issues, contact the development team.

---

## 📄 License

See [LICENSE](LICENSE) for details.
