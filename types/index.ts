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

// ---------------------------------------------------------------------------
// Application-level domain types — mirror the canonical DB schema exactly.
// For raw query results, prefer Database["public"]["Tables"][table]["Row"]
// from @/types/database instead.
// ---------------------------------------------------------------------------

export interface Student {
  student_id: number;
  full_name: string;
  email: string;
  is_ch_student: boolean;
  us_citizen: boolean;
  major?: string | null;
  minor?: string | null;
  gpa?: number | null;
  class_standing?: "Freshman" | "Sophomore" | "Junior" | "Senior" | "Graduate" | "Doctoral" | null;
  age?: number | null;
  gender?: "F" | "M" | "NB" | "NR" | null;
  pronouns?: string | null;
  race_ethnicity?: string | null;
  languages?: string | null;
  first_gen: boolean;
  honors_college: boolean;
}

export interface Fellowship {
  fellowship_id: number;
  fellowship_name: string;
}

export type ApplicationStage =
  | "Started"
  | "Submitted"
  | "Under Review"
  | "Semi-Finalist"
  | "Finalist"
  | "Awarded"
  | "Rejected";

export interface Application {
  application_id: number;
  student_id: number;
  fellowship_id: number;
  destination_country?: string | null;
  stage_of_application: ApplicationStage;
  is_semi_finalist: boolean;
  is_finalist: boolean;
}
