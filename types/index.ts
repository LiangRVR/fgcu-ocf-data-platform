/**
 * Shared domain types for the OCF Fellowship Management System.
 * Add more types here as features are built out.
 */
import type { ComponentType } from "react";

export interface NavItem {
  label: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface User {
  id: string;
  email: string;
  full_name?: string;
  role?: "admin" | "advisor" | "viewer";
  created_at?: string;
}

export interface Student {
  id: string;
  full_name: string;
  email: string;
  gpa?: number;
  major?: string;
  graduation_year?: number;
  created_at?: string;
}

export interface Fellowship {
  id: string;
  name: string;
  description?: string;
  deadline?: string;
  award_amount?: number;
  external_url?: string;
  is_active?: boolean;
  created_at?: string;
}

export type ApplicationStatus =
  | "draft"
  | "in_progress"
  | "submitted"
  | "under_review"
  | "awarded"
  | "rejected";

export interface Application {
  id: string;
  student_id: string;
  fellowship_id: string;
  status: ApplicationStatus;
  notes?: string;
  submitted_at?: string;
  created_at?: string;
}
