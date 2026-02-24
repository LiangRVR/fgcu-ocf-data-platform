# OCF Fellowship Management System

Internal admin platform for the **FGCU Office of Competitive Fellowships (OCF)**.
Built to track students, fellowship opportunities, applications, and advising sessions.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org) — App Router, Server Components |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS v4 |
| UI Components | shadcn/ui + Radix UI primitives |
| Icons | lucide-react |
| Forms | React Hook Form + Zod |
| Data Tables | TanStack Table v8 (wired up in next phase) |
| Backend / Auth | Supabase (JS client — ready, not yet wired) |
| Toasts | Sonner |
| Dates | date-fns |

---

## Project Structure

```
.
├── app/
│   ├── (auth)/
│   │   ├── layout.tsx            # Centered auth shell
│   │   └── login/page.tsx        # Login form (RHF + Zod)
│   ├── (dashboard)/
│   │   ├── layout.tsx            # Auth gate → DashboardShell
│   │   ├── dashboard/page.tsx
│   │   ├── students/page.tsx
│   │   ├── fellowships/page.tsx
│   │   ├── applications/page.tsx
│   │   ├── advising/page.tsx
│   │   └── reports/page.tsx
│   ├── api/
│   │   └── health/route.ts       # GET /api/health
│   ├── globals.css               # Tailwind + design tokens (CSS vars)
│   └── layout.tsx                # Root layout + Sonner Toaster
├── components/
│   ├── layout/
│   │   ├── dashboard-shell.tsx   # Client shell — mobile sidebar state
│   │   ├── page-header.tsx       # PageHeader + PageSkeleton
│   │   ├── sidebar.tsx           # Desktop fixed + mobile overlay drawer
│   │   └── top-bar.tsx           # Sticky header, mobile menu toggle
│   └── ui/                       # shadcn/ui primitives
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── input.tsx
│       ├── label.tsx
│       ├── separator.tsx
│       ├── skeleton.tsx
│       └── toaster.tsx
├── lib/
│   ├── auth/
│   │   └── mock.ts               # IS_AUTHED flag — replace with Supabase session
│   ├── config/
│   │   └── nav.ts                # Sidebar NAV_ITEMS config
│   ├── supabase/
│   │   ├── client.ts             # Browser Supabase client
│   │   └── server.ts             # Server Supabase client factory
│   ├── utils/
│   │   ├── cn.ts                 # clsx + tailwind-merge helper
│   │   └── format.ts             # formatDate, getInitials
│   └── validators/
│       └── auth.ts               # loginSchema (Zod)
├── types/
│   ├── database.ts               # Placeholder for supabase gen types
│   └── index.ts                  # NavItem, User, Student, Fellowship, Application
├── public/
├── .env.example                  # Required env vars
├── components.json               # shadcn/ui config
├── proxy.ts                      # Next.js 16 edge proxy stub (auth hook placeholder)
├── next.config.ts
├── tailwind.config (inline)      # Configured via globals.css @theme
└── tsconfig.json                 # strict: true
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your Supabase project credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

> **Note:** The app runs without real keys — missing vars trigger a `console.warn` but do not crash.

### 3. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — automatically redirects to `/dashboard`.

### 4. Other commands

```bash
npm run build   # Production build
npm run lint    # ESLint
```

---

## Current State (Phase 1 — Foundation)

### ✅ Done
- Next.js 16 App Router with TypeScript strict mode
- Tailwind CSS v4 with a consistent CSS variable design-token system (FGCU Blue primary)
- Dashboard shell: fixed desktop sidebar + responsive mobile drawer
- Active route highlighting in sidebar
- Top bar with mobile menu toggle
- Route stubs for all 6 sections (Dashboard, Students, Fellowships, Applications, Advising, Reports)
- Login page UI with React Hook Form + Zod validation, accessible error states
- Supabase client/server files configured and gracefully degraded when env vars are absent
- Domain types (`Student`, `Fellowship`, `Application`, `User`)
- shadcn/ui component primitives: `Button`, `Card`, `Input`, `Label`, `Badge`, `Skeleton`, `Separator`, `Toaster`
- `GET /api/health` endpoint
- Mock auth gate via `lib/auth/mock.ts` — single boolean toggle to simulate logged-in/out state
- Edge proxy stub (`proxy.ts`) ready for Supabase session middleware

### 🔜 Next Steps (Phase 2)
- [ ] Wire Supabase auth (email/password sign-in, session cookies via `@supabase/ssr`)
- [ ] Replace `IS_AUTHED` mock with real session check in `proxy.ts` and layouts
- [ ] Define database schema and run first Supabase migration
- [ ] Generate TypeScript types: `npx supabase gen types typescript ... > types/database.ts`
- [ ] Build Students data table with TanStack Table
- [ ] Build Fellowships CRUD
- [ ] Build Applications tracker
- [ ] Add role-based access control (admin / advisor / viewer)

---

## Auth Gate (Development)

The auth gate is controlled by a single flag in [lib/auth/mock.ts](lib/auth/mock.ts):

```ts
export const IS_AUTHED = true; // set to false to test redirect → /login
```

When Supabase auth is integrated, this file is deleted and replaced by a session check in `proxy.ts`.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes (for auth/DB) | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes (for auth/DB) | Your Supabase anon public key |

See [`.env.example`](.env.example) for the full template.

---

## License

[LICENSE](LICENSE)
