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
- **[Schema Verification](docs/schema-verification.md)** - Database setup checklist
- **[Supabase Setup](supabase/README.md)** - Detailed database configuration
- **[Database Schema](supabase/SCHEMA.md)** - Complete schema documentation

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, Server Components) |
| **Language** | TypeScript (strict mode) |
| **Database** | Supabase (PostgreSQL) |
| **Auth** | Supabase Auth (setup in progress) |
| **Styling** | Tailwind CSS v4 |
| **UI Library** | shadcn/ui + Radix UI |
| **Forms** | React Hook Form + Zod |
| **Icons** | lucide-react |
| **Toasts** | Sonner |

---

## 📁 Project Structure

```
├── app/                    # Next.js App Router
│   ├── (auth)/            # Authentication pages
│   ├── (dashboard)/       # Protected dashboard pages
│   └── api/               # API routes
├── components/
│   ├── layout/            # Shell, sidebar, top bar
│   └── ui/                # shadcn/ui components
├── lib/
│   ├── auth/              # Authentication logic
│   ├── supabase/          # Supabase clients
│   ├── utils/             # Utility functions
│   └── validators/        # Zod schemas
├── types/                 # TypeScript types
├── supabase/
│   └── migrations/        # Database migrations
├── docs/                  # Documentation
└── scripts/               # Utility scripts
```

See the [full project structure details](docs/quickstart.md#project-structure) for more information.

---

## 🗄️ Database Setup

The application uses Supabase for the backend. To set up the database:

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
2. **Apply the schema**: Copy `supabase/migrations/20260305000000_initial_schema.sql` to Supabase SQL Editor
3. **Generate types**: Run `pnpm run db:types`
4. **Test connection**: Run `pnpm run test:connection`

For detailed instructions, see the [Supabase Setup Guide](supabase/README.md).

---

## 🎯 Features

### Current
- ✅ Dashboard layout with responsive sidebar
- ✅ Authentication UI (mock auth, Supabase integration pending)
- ✅ Empty state pages for all modules
- ✅ Database schema and migrations
- ✅ TypeScript type safety
- ✅ Form validation with Zod

### Planned
- 🔄 Supabase Auth integration
- 🔄 Student management CRUD
- 🔄 Fellowship opportunity management
- 🔄 Application tracking and review workflow
- 🔄 Advising session scheduling
- 🔄 Data tables with sorting/filtering

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
