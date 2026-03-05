# OCF Fellowship Management System - Database Schema

This document describes the database schema for the FGCU OCF Fellowship Management System.

## Overview

The system manages fellowship opportunities, student applications, and advising sessions. The schema is designed to support:

- Student profile management
- Fellowship opportunity creation and management
- Application tracking and review
- Advising session scheduling and notes
- Multi-reviewer evaluation system
- User/staff management

## Tables

### 1. `students`
Stores information about fellowship-eligible students.

**Key Fields:**
- `id` (UUID): Primary key
- `fgcu_id` (VARCHAR): Unique FGCU student identifier
- `email` (VARCHAR): Student email (unique)
- `first_name`, `last_name`: Student name
- `major`, `gpa`, `expected_graduation`: Academic info
- `academic_standing`, `enrollment_status`: Current status

### 2. `fellowships`
Stores fellowship opportunities available to students.

**Key Fields:**
- `id` (UUID): Primary key
- `title`, `description`: Fellowship details
- `funding_amount`, `duration_months`: Financial info
- `application_deadline`, `start_date`, `end_date`: Timeline
- `max_recipients`: Number of available positions
- `status`: 'Draft' | 'Open' | 'Closed' | 'Awarded'

### 3. `applications`
Tracks student applications to fellowships.

**Key Fields:**
- `id` (UUID): Primary key
- `student_id` (UUID): References `students(id)`
- `fellowship_id` (UUID): References `fellowships(id)`
- `status`: 'Draft' | 'Submitted' | 'Under Review' | 'Interviewed' | 'Accepted' | 'Rejected' | 'Withdrawn'
- `essay`, `cv_url`, `recommendation_letters`: Application materials
- `score`: Aggregate review score
- `notes`: Internal notes

**Unique Constraint:** (student_id, fellowship_id) - One application per student per fellowship

### 4. `advising_sessions`
Records advising appointments and interactions with students.

**Key Fields:**
- `id` (UUID): Primary key
- `student_id` (UUID): References `students(id)`
- `advisor_id` (UUID): References `users(id)`
- `session_date` (TIMESTAMPTZ): Scheduled time
- `duration_minutes`: Session length
- `session_type`: 'General' | 'Fellowship' | 'Academic' | 'Career'
- `status`: 'Scheduled' | 'Completed' | 'Cancelled' | 'No-Show'
- `notes`, `follow_up_notes`: Session documentation

### 5. `application_reviews`
Individual reviews from multiple reviewers for applications.

**Key Fields:**
- `id` (UUID): Primary key
- `application_id` (UUID): References `applications(id)`
- `reviewer_id` (UUID): References `users(id)`
- `score`: Individual reviewer score
- `comments`: Review comments
- `criteria_scores` (JSONB): Detailed criterion-by-criterion scores

### 6. `users`
System users including advisors, reviewers, and administrators.

**Key Fields:**
- `id` (UUID): Primary key
- `email` (VARCHAR): User email (unique)
- `first_name`, `last_name`: User name
- `role`: 'Admin' | 'Advisor' | 'Reviewer' | 'Staff'
- `department`: User department
- `is_active`: Account status

## Relationships

```
students (1) ──── (N) applications (N) ──── (1) fellowships
    │                       │
    │                       │
    │                       └──── (N) application_reviews (N) ──── (1) users
    │
    └──── (N) advising_sessions (N) ──── (1) users (advisor)
```

## Indexes

Performance indexes are created on:
- Foreign key columns
- Email and ID lookups
- Status fields for filtering
- Date fields for scheduling and deadlines

## Features

### Automatic Timestamps
All tables include `created_at` and `updated_at` fields with automatic updates via triggers.

### Row Level Security (RLS)
RLS is enabled on all tables with example policies:
- Students can view their own records
- Authenticated users can view fellowships
- Students can view their own applications
- Customize policies based on your authentication requirements

### Data Integrity
- Foreign key constraints ensure referential integrity
- CHECK constraints validate enum-like fields
- UNIQUE constraints prevent duplicate data
- CASCADE deletes maintain data consistency

## Migration

To apply this schema to your Supabase project:

1. Copy the SQL from `migrations/20260305000000_initial_schema.sql`
2. Run it in the Supabase SQL Editor
3. Or use the Supabase CLI: `npx supabase db push`

## Type Generation

After applying the migration, generate TypeScript types:

```bash
# Using project reference
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts

# Or using direct database connection
npx supabase gen types typescript --db-url <your-db-url> > types/database.ts
```

## Security Considerations

1. **Authentication**: Implement proper authentication using Supabase Auth
2. **RLS Policies**: Review and customize RLS policies for your use case
3. **API Keys**: Use service role key only in secure server environments
4. **Data Validation**: Implement additional validation in application code
5. **Sensitive Data**: Consider encryption for sensitive fields

## Sample Queries

### Get all open fellowships
```sql
SELECT * FROM fellowships WHERE status = 'Open' AND application_deadline > NOW();
```

### Get student applications with fellowship details
```sql
SELECT a.*, f.title, f.funding_amount, s.first_name, s.last_name
FROM applications a
JOIN fellowships f ON a.fellowship_id = f.id
JOIN students s ON a.student_id = s.id
WHERE a.status = 'Submitted';
```

### Get upcoming advising sessions
```sql
SELECT ads.*, s.first_name, s.last_name, u.first_name as advisor_first_name
FROM advising_sessions ads
JOIN students s ON ads.student_id = s.id
JOIN users u ON ads.advisor_id = u.id
WHERE ads.status = 'Scheduled' AND ads.session_date > NOW()
ORDER BY ads.session_date;
```
