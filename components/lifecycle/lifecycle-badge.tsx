import { Archive, ShieldOff } from "lucide-react";
import { MetricBadge } from "@/components/ui/metric-badge";
import { cn } from "@/lib/utils/cn";

/**
 * LifecycleBadge
 *
 * The single, consistent surface for the lifecycle state of a student,
 * fellowship, or advisor. Renders nothing when the entity is in its active
 * state (so the active baseline never advertises itself), and renders a
 * pinned, color-stable badge for archived/inactive records.
 *
 * - Student / Fellowship → "Archived" with a database-authored timestamp.
 * - Advisor              → "Inactive" (advisor lifecycle uses `is_active`).
 *
 * Tone is locked: amber for archive (visible but not destructive), red for
 * inactive advisor (because advisor deactivation has a real auth effect and
 * must stand out from the muted amber of an archived student/fellowship).
 *
 * The component is a server-friendly presentational surface. The interactive
 * lifecycle controls live in `./lifecycle-actions`.
 */
export type LifecycleKind = "student" | "fellowship" | "advisor";

interface LifecycleBadgeProps {
  kind: LifecycleKind;
  archivedAt?: string | null;
  isActive?: boolean;
  className?: string;
  /** Render an inline timestamp suffix (`since <date>`). Default true. */
  showTimestamp?: boolean;
}

function formatArchivedDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function LifecycleBadge({
  kind,
  archivedAt,
  isActive,
  className,
  showTimestamp = true,
}: LifecycleBadgeProps) {
  // Active baseline: no badge. Active rows must read as the default state.
  if (kind !== "advisor" && archivedAt == null) return null;
  if (kind === "advisor" && isActive !== false) return null;

  if (kind === "advisor") {
    return (
      <MetricBadge
        tone="red"
        className={cn("gap-1", className)}
        aria-label="Advisor inactive"
      >
        <ShieldOff className="h-3 w-3" aria-hidden="true" />
        Advisor Inactive
      </MetricBadge>
    );
  }

  const date = formatArchivedDate(archivedAt);
  return (
    <MetricBadge
      tone="amber"
      className={cn("gap-1", className)}
      aria-label={date ? `Archived since ${date}` : "Archived"}
    >
      <Archive className="h-3 w-3" aria-hidden="true" />
      {kind === "student" ? "Student Archived" : "Fellowship Archived"}{showTimestamp && date ? ` since ${date}` : ""}
    </MetricBadge>
  );
}
