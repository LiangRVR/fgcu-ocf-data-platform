# Schema Reference

**The canonical source of truth for the OCF Fellowship Management System database.**

All table names are **singular**. All primary keys are **integer sequences** (never UUIDs). Every part of the application must follow this schema exactly.

---

## Tables

### `student`

Stores FGCU student profiles managed by the OCF.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `student_id` | integer | NO | nextval | **Primary key** |
| `full_name` | varchar | NO | | |
| `email` | varchar | NO | | |
| `is_ch_student` | boolean | NO | `false` | Honors College student |
| `us_citizen` | boolean | NO | | |
| `major` | varchar | YES | | |
| `minor` | varchar | YES | | |
| `gpa` | numeric | YES | | CHECK: `0.00 – 4.00` |
| `class_standing` | varchar | YES | | CHECK: `Freshman`, `Sophomore`, `Junior`, `Senior`, `Graduate`, `Doctoral` |
| `age` | integer | YES | | |
| `gender` | varchar | YES | | CHECK: `F`, `M`, `NB`, `NR` |
| `pronouns` | varchar | YES | | |
| `race_ethnicity` | varchar | YES | | |
| `languages` | varchar | YES | | |
| `first_gen` | boolean | NO | `false` | First-generation college student |
| `honors_college` | boolean | NO | `false` | |

---

### `advisor`

Advisor names referenced by advising meetings.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `advisor_id` | integer | NO | nextval | **Primary key** |
| `advisor_name` | varchar | NO | | UNIQUE |

---

### `fellowship`

Fellowship programs that students can apply to or have won.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `fellowship_id` | integer | NO | nextval | **Primary key** |
| `fellowship_name` | varchar | NO | | UNIQUE |

---

### `application`

Tracks a student's application to one fellowship program.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `application_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `fellowship_id` | integer | NO | | FK → `fellowship.fellowship_id` |
| `destination_country` | varchar | YES | | |
| `stage_of_application` | varchar | NO | | CHECK: `Started`, `Submitted`, `Under Review`, `Semi-Finalist`, `Finalist`, `Awarded`, `Rejected` |
| `is_semi_finalist` | boolean | NO | `false` | |
| `is_finalist` | boolean | NO | `false` | |

**Business rules:**

- `stage_of_application` drives the pipeline view; `is_semi_finalist` and `is_finalist` are denormalized flags for fast filtering.
- There is no unique constraint on `(student_id, fellowship_id)` — a student may have multiple application attempts to the same fellowship across years.

---

### `advising_meeting`

Records each advising session between an advisor and a student.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `meeting_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `advisor_id` | integer | YES | | FK → `advisor.advisor_id` |
| `meeting_date` | date | NO | | |
| `meeting_mode` | varchar | NO | | CHECK: `In-Person`, `Virtual` |
| `no_show` | boolean | NO | `false` | Student did not attend |
| `notes` | text | YES | | |

---

### `fellowship_thursday`

Tracks student attendance at the weekly Thursday fellowship meeting.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `attendance_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `attended` | boolean | NO | | |
| `source_info` | varchar | YES | | CHECK (nullable): `OCF`, `HC`, `MM` |

---

### `scholarship_history`

Records past scholarships/fellowships that a student has already received.

| Column | Type | Nullable | Default | Notes |
| --- | --- | --- | --- | --- |
| `history_id` | integer | NO | nextval | **Primary key** |
| `student_id` | integer | NO | | FK → `student.student_id` |
| `fellowship_id` | integer | NO | | FK → `fellowship.fellowship_id` |

---

## Relationship Diagram

```text
student (1) ──────────────────────── (N) application (N) ─── (1) fellowship
   │                                                                │
   │                                                                │
   ├── (N) advising_meeting (N) ─── (1) advisor              (N) scholarship_history
   │
   ├── (N) fellowship_thursday
   │
   └── (N) scholarship_history
```

---

## Naming Rules

| Rule | Correct | Wrong |
| --- | --- | --- |
| Table names | `student` | `students` |
| Primary keys | `student_id` | `id` |
| Key types | `integer` (sequence) | `uuid` |
| App stage field | `stage_of_application` | `status` |
| Fellowship name field | `fellowship_name` | `name` |
| Advisor name field | `advisor_name` | `name` |

---

## TypeScript Type Locations

| File | Purpose |
| --- | --- |
| `types/database.ts` | Auto-generated Supabase types — use for all DB queries |
| `types/index.ts` | Application-level domain types — must mirror this schema |

Regenerate `types/database.ts` after any schema change:

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
```
