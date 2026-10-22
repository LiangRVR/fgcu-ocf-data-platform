import type { Database } from "@/types/database";

/**
 * Explicit list row from the read-only `fellowship_list` view.
 *
 * This module is deliberately NOT a `"use client"` module: the server loader
 * imports and calls {@link isFellowshipListRow} during render, and a function
 * exported from a `"use client"` module becomes an RSC client reference that
 * cannot be invoked on the server. Keeping the type + guard in a neutral module
 * lets both the server page and the client table share one fail-closed source.
 */
export type FellowshipListRow = Database["public"]["Views"]["fellowship_list"]["Row"];

/**
 * Domain-narrowed fellowship list row. The generated `fellowship_list` view marks
 * every column nullable, but the identity columns are derived from non-null base
 * `fellowship` columns. {@link isFellowshipListRow} fails a row that does not
 * carry them closed rather than coercing a missing identity into a fabricated
 * value.
 */
export type Fellowship = FellowshipListRow & {
  fellowship_id: number;
  fellowship_name: string;
};

/** Guard a generated `fellowship_list` row into a usable {@link Fellowship}. */
export function isFellowshipListRow(row: FellowshipListRow): row is Fellowship {
  return row.fellowship_id !== null && row.fellowship_name !== null;
}
