import type { Database } from "@/types/database";

/**
 * Explicit list row from the read-only `student_list` view.
 *
 * This module is deliberately NOT a `"use client"` module: the server roster
 * loader imports and calls {@link isListedStudent} during render, and a function
 * exported from a `"use client"` module becomes an RSC client reference that
 * cannot be invoked on the server. Keeping the type + guard in a neutral module
 * lets both the server page and the client table share one fail-closed source.
 */
export type StudentListRow = Database["public"]["Views"]["student_list"]["Row"];

/**
 * Domain-narrowed roster row. The generated `student_list` view marks every
 * column nullable, but these identity/display columns derive directly from
 * non-null base `student` columns, so every usable roster row carries them.
 * {@link isListedStudent} fails closed on a row that does not, rather than
 * coercing a missing identity into a fabricated value.
 */
export type Student = StudentListRow & {
  student_id: number;
  full_name: string;
  email: string;
  is_ch_student: boolean;
  first_gen: boolean;
  honors_college: boolean;
  us_citizen: boolean;
};

/** Guard a generated `student_list` row into a usable {@link Student}. */
export function isListedStudent(row: StudentListRow): row is Student {
  return (
    row.student_id !== null &&
    row.full_name !== null &&
    row.email !== null &&
    row.is_ch_student !== null &&
    row.first_gen !== null &&
    row.honors_college !== null &&
    row.us_citizen !== null
  );
}
