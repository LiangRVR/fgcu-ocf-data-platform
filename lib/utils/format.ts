import { format, parseISO } from "date-fns";

/**
 * Format a date string or Date object to a readable format.
 */
export function formatDate(
  date: string | Date,
  pattern = "MMM d, yyyy"
): string {
  const d = typeof date === "string" ? parseISO(date) : date;
  return format(d, pattern);
}

/**
 * Return initials from a full name (up to 2 characters).
 */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Format a number as US currency.
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
