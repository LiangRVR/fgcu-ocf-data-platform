# Documentation

This folder contains detailed documentation for the OCF Fellowship Management System.

## 📑 Available Documentation

### Getting Started

- **[Quick Start Guide](quickstart.md)** - Environment setup and Supabase connection

### Design & UI

- **[FGCU Design Style Guide](DESIGN_GUIDE.md)** - Official design system, colors, typography, and component guidelines
- **[UI/UX Refactor Summary](UI_UX_REFACTOR.md)** - Dashboard transformation details and file changelog
- **[Students Dashboard Upgrade](STUDENTS_DASHBOARD_UPGRADE.md)** - Students page CRUD, sort, filter, and pagination details

### Database

- **[Schema Reference](schema-reference.md)** — **Canonical schema** with all constraints, business rules, and TypeScript type locations
- **[Schema Verification](schema-verification.md)** - Checklist for setting up and verifying the database
- **[Supabase Setup](../supabase/README.md)** - Guide for creating a Supabase project and applying migrations
- **[Schema Quick Reference](../supabase/SCHEMA.md)** - Table list and foreign key map

### Project Information
- **[Main README](../README.md)** - Project overview, tech stack, features, and project structure
- **[License](../LICENSE)** - License information

---

## 🚀 Quick Links

### For New Developers

1. Read the [Main README](../README.md) for project overview and feature status
2. Follow the [Quick Start Guide](quickstart.md) to configure Supabase
3. Review the [Schema Reference](schema-reference.md) to understand the data model
4. Review the [FGCU Design Style Guide](DESIGN_GUIDE.md) for UI/UX guidelines

### For Database Setup

1. Follow the [Supabase Setup Guide](../supabase/README.md)
2. Use the [Schema Verification Checklist](schema-verification.md) to confirm everything is working

---

## 🎨 Design System

The application follows the official FGCU design system:

- **Colors:** FGCU Green (`#006747`), FGCU Blue (`#003B5C`), FGCU Gold (`#C99700`)
- **Sidebar:** Neutral `bg-slate-900` — FGCU green used only for active nav items
- **Accents:** FGCU green on primary buttons and active states
- **Components:** shadcn/ui + Radix UI with custom FGCU theme

See the [Design Style Guide](DESIGN_GUIDE.md) for complete details.

---

## 📝 Need Help?

1. Check the [Supabase Setup Guide](../supabase/README.md) for connection troubleshooting
2. Review the [Schema Verification](schema-verification.md) checklist
3. Run `pnpm run test:connection` to verify your Supabase connection
4. Run `pnpm run db:types` after any schema change to regenerate TypeScript types
