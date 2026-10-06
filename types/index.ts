/**
 * Shared domain types for the OCF Fellowship Management System.
 */
import type { ComponentType } from "react";

export interface NavItem {
  label: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
}

export type ApplicationStage =
  | "Started"
  | "Submitted"
  | "Under Review"
  | "Did Not Submit"
  | "Semi-Finalist"
  | "Finalist"
  | "Awarded"
  | "Rejected"
  | "Withdrawn";
