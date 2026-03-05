# Supabase Setup Guide

## Prerequisites

1. Create a Supabase account at [supabase.com](https://supabase.com)
2. Create a new project in Supabase
3. Note your project's:
   - Project URL (Settings → API → Project URL)
   - Anon/Public Key (Settings → API → Project API keys → anon public)
   - Project ID (Settings → General → Reference ID)

## Step 1: Configure Environment Variables

1. Update `.env.local` with your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

2. Restart your development server after updating environment variables.

## Step 2: Apply Database Schema

### Option A: Using Supabase Dashboard (Recommended for first-time setup)

1. Log in to your Supabase project dashboard
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `supabase/migrations/20260305000000_initial_schema.sql`
5. Paste into the SQL Editor
6. Click **Run** to execute the migration
7. Verify tables are created in **Table Editor**

### Option B: Using Supabase CLI

```bash
# Link to your project (one time)
npx supabase link --project-ref <your-project-id>

# Push the migration to your Supabase project
npx supabase db push
```

## Step 3: Generate TypeScript Types

After applying the schema, generate TypeScript types for type-safe database access:

### Method 1: Using Project ID (Recommended)

```bash
pnpm run db:types
```

Or manually:
```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```

### Method 2: Using Database URL

If you prefer to use a direct database connection:

```bash
npx supabase gen types typescript --db-url "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" > types/database.ts
```

Find your database URL in: Settings → Database → Connection string (URI)

## Step 4: Verify Connection

Run the connection test:

```bash
pnpm run test:connection
```

This will verify:
- Environment variables are set correctly
- Connection to Supabase is successful
- Database tables are accessible

## Step 5: Add Sample Data (Optional)

To add sample data for testing:

1. Navigate to **Table Editor** in Supabase dashboard
2. Select a table (e.g., `students`)
3. Click **Insert row** → **Insert manually**
4. Fill in the required fields
5. Click **Save**

Or create a seed script for automated sample data insertion.

## Database Schema

See [SCHEMA.md](./SCHEMA.md) for detailed documentation about:
- Table structures
- Relationships
- Indexes
- Row Level Security policies
- Sample queries

## Troubleshooting

### Types generation fails

1. Ensure your project is deployed and schema is applied
2. Verify your project ID is correct: `npx supabase projects list`
3. Make sure you're logged in: `npx supabase login`

### Connection issues

1. Double-check environment variables in `.env.local`
2. Ensure there are no extra spaces or quotes around values
3. Restart the development server: `pnpm dev`
4. Check Supabase project status in the dashboard

### RLS Policies blocking access

If you're getting permission errors:
1. Review RLS policies in the SQL schema
2. Temporarily disable RLS for testing (not recommended for production):
   ```sql
   ALTER TABLE table_name DISABLE ROW LEVEL SECURITY;
   ```
3. Implement proper authentication with Supabase Auth
4. Update RLS policies to match your authentication setup

## Next Steps

1. ✅ Configure environment variables
2. ✅ Apply database schema
3. ✅ Generate TypeScript types
4. ✅ Verify connection
5. 🔄 Implement authentication (see [Auth Setup Guide](../docs/AUTH_SETUP.md))
6. 🔄 Customize RLS policies for your security requirements
7. 🔄 Add seed data for development
8. 🔄 Deploy to production

## Useful Commands

```bash
# Generate types
pnpm run db:types

# Test connection
pnpm run test:connection

# Start development server
pnpm dev

# Run Supabase locally (requires Docker)
npx supabase start

# View local Supabase logs
npx supabase logs
```

## Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/introduction)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Database Migrations](https://supabase.com/docs/guides/cli/local-development#database-migrations)
