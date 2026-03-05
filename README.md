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
| **Design System** | FGCU Brand Colors + Custom Palette |
| **UI Library** | shadcn/ui + Radix UI |
| **Typography** | Merriweather (headings) + Open Sans (body) |
| **Forms** | React Hook Form + Zod |
| **Icons** | lucide-react |
| **Toasts** | Sonner |

---

## 📁 Project Structure

```
├── app/                    # Next.js App Router
│   ├── (auth)/            # Authentication pages
│   │   └── login/         # Login page
│   ├── (dashboard)/       # Protected dashboard pages
│   │   ├── dashboard/     # Overview with statistics
│   │   ├── students/      # Student management
│   │   ├── fellowships/   # Fellowship opportunities
│   │   ├── applications/  # Application tracking
│   │   ├── advising/      # Advising sessions
│   │   └── reports/       # Analytics and reports
│   ├── api/               # API routes
│   └── globals.css        # FGCU design system styles
├── components/
│   ├── layout/            # Shell, sidebar, top bar, page header
│   └── ui/                # shadcn/ui components (buttons, cards, badges, etc.)
├── lib/
│   ├── auth/              # Authentication logic
│   ├── config/            # Navigation and app config
│   ├── supabase/          # Supabase clients (browser & server)
│   ├── utils/             # Utility functions (cn, format)
│   └── validators/        # Zod validation schemas
├── types/                 # TypeScript types (Database, App)
├── supabase/
│   ├── migrations/        # SQL migrations
│   ├── SCHEMA.md          # Database documentation
│   └── README.md          # Supabase setup guide
├── docs/                  # Project documentation
│   ├── DESIGN_GUIDE.md    # FGCU design system
│   ├── UI_UX_REFACTOR.md  # UI transformation docs
│   ├── quickstart.md      # Quick start guide
│   └── schema-verification.md
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
- ✅ **Professional Dashboard UI** - Modern, neutral design with FGCU green accents
- ✅ **Responsive Layout** - Adaptive sidebar and mobile-friendly tables
- ✅ **Statistics Cards** - Real-time metrics with colorful icons
- ✅ **Interactive Tables** - Hover states, search bars, action buttons
- ✅ **Enhanced Empty States** - Engaging onboarding with CTAs
- ✅ **Semantic Status Badges** - Color-coded indicators with borders
- ✅ **FGCU Design System** - Consistent colors, typography, and spacing
- ✅ **Database Schema** - Complete schema and migrations
- ✅ **TypeScript Type Safety** - Full type coverage
- ✅ **Form Validation** - Zod schemas for data validation

### In Progress
- 🔄 Supabase Auth integration
- 🔄 Student management CRUD operations
- 🔄 Fellowship opportunity management
- 🔄 Application tracking and review workflow
- 🔄 Advising session scheduling and calendar

### Planned
- 📋 Client-side search and filtering
- 📋 Table sorting functionality
- 📋 Real pagination with page size controls
- 📋 Add/Edit modals and forms
- 📋 Student profile pages
- 📋 Data export (CSV/PDF)
- 📋 Loading skeletons
- 📋 Bulk actions

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
