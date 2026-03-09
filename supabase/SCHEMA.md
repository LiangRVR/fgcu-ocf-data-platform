# OCF Fellowship Management System - Database Schema

> **This file is a quick reference. For the full schema with all constraints and business rules, see [`docs/schema-reference.md`](../docs/schema-reference.md).**

## Overview

Seven tables. All primary keys are **integer sequences** (not UUIDs). All table names are **singular**.

| Table | Primary Key | Purpose |
| --- | --- | --- |
| `student` | `student_id` | Student profiles |
| `advisor` | `advisor_id` | Advisor names |
| `fellowship` | `fellowship_id` | Fellowship programs |
| `application` | `application_id` | Student fellowship applications |
| `advising_meeting` | `meeting_id` | Advising sessions |
| `fellowship_thursday` | `attendance_id` | Thursday meeting attendance |
| `scholarship_history` | `history_id` | Past scholarship awards |

## Foreign Keys

- `application.student_id` → `student.student_id`
- `application.fellowship_id` → `fellowship.fellowship_id`
- `advising_meeting.student_id` → `student.student_id`
- `advising_meeting.advisor_id` → `advisor.advisor_id`
- `fellowship_thursday.student_id` → `student.student_id`
- `scholarship_history.student_id` → `student.student_id`
- `scholarship_history.fellowship_id` → `fellowship.fellowship_id`

## Migrations

- `20260305000000_initial_schema.sql` — creates all tables
- `20260305000001_allow_anon_read.sql` — grants anon SELECT on all tables
