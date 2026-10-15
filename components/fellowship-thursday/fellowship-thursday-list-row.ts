import type { Database } from "@/types/database";

/**
 * Explicit list row from the read-only `fellowship_thursday_list` view.
 *
 * This module is deliberately NOT a `"use client"` module: the server loader
 * imports and calls {@link isFellowshipThursdayListRow} during render, and a
 * function exported from a `"use client"` module becomes an RSC client reference
 * that cannot be invoked on the server. Keeping the type + guard in a neutral
 * module lets both the server page and the client table share one fail-closed
 * source.
 */
export type FellowshipThursdayListRow =
  Database["public"]["Views"]["fellowship_thursday_list"]["Row"];

/**
 * Domain-narrowed attendance row. The generated `fellowship_thursday_list` view
 * marks every column nullable, but the attendance identity/state columns derive
 * directly from non-null base `fellowship_thursday` columns. {@link
 * isFellowshipThursdayListRow} fails a row that does not carry them closed rather
 * than coercing a missing identity into a fabricated value. `student` is the
 * resolved display name (null when the view row did not prove one).
 */
export type FellowshipThursday = FellowshipThursdayListRow & {
  attendance_id: number;
  student_id: number;
  attended: boolean;
  student: { full_name: string } | null;
};

/** Guard a generated `fellowship_thursday_list` row into a usable shape. */
export function isFellowshipThursdayListRow(
  row: FellowshipThursdayListRow,
): row is FellowshipThursdayListRow & {
  attendance_id: number;
  student_id: number;
  attended: boolean;
} {
  return row.attendance_id !== null && row.student_id !== null && row.attended !== null;
}
