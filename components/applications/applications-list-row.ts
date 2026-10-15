import type { Database } from "@/types/database";

/**
 * Explicit list row from the read-only `application_list` view.
 *
 * This module is deliberately NOT a `"use client"` module: the server loader
 * imports and calls {@link isApplicationRow} during render, and a function
 * exported from a `"use client"` module becomes an RSC client reference that
 * cannot be invoked on the server. Keeping the type + guard in a neutral module
 * lets both the server page and the client table share one fail-closed source.
 */
export type ApplicationListRow = Database["public"]["Views"]["application_list"]["Row"];

/**
 * Domain-narrowed application row. The generated `application_list` view marks
 * every column nullable, but the identity, stage, and finalist columns derive
 * directly from non-null base `application` columns, so every usable row carries
 * them. {@link isApplicationRow} fails closed on a row that does not rather than
 * coercing a missing identity into a fabricated value. `student`/`fellowship`
 * are the resolved relationship labels (null when the view row did not prove a
 * name).
 */
export type Application = ApplicationListRow & {
  application_id: number;
  student_id: number;
  fellowship_id: number;
  stage_of_application: string;
  is_finalist: boolean;
  is_semi_finalist: boolean;
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
};

/**
 * Guard a generated `application_list` row into the identity/stage-complete
 * shape the table requires. A row missing any of these non-null-derived columns
 * fails closed (returns `false`) and is dropped by the caller.
 */
export function isApplicationRow(
  row: ApplicationListRow,
): row is ApplicationListRow & {
  application_id: number;
  student_id: number;
  fellowship_id: number;
  stage_of_application: string;
  is_finalist: boolean;
  is_semi_finalist: boolean;
} {
  return (
    row.application_id !== null &&
    row.student_id !== null &&
    row.fellowship_id !== null &&
    row.stage_of_application !== null &&
    row.is_finalist !== null &&
    row.is_semi_finalist !== null
  );
}
