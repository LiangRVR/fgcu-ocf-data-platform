/** Safe, human-facing audit presentation. Deliberately ignores payloads and secrets. */
export interface AuditActivity {
  id: string;
  action: string;
  entityLabel: string;
  actor?: string | null;
  occurredAt?: string | null;
  summary?: string | null;
  changes?: AuditChange[];
}

export interface AuditChange { field: string; label: string; oldValue: string; newValue: string }

export type AuditRow = import("@/types/database").Database["public"]["Views"]["audit_activity"]["Row"];

const fieldLabels: Record<string, string> = {
  full_name: "Full Name", is_ch_student: "CH student", major: "Major", minor: "Minor",
  gpa: "GPA", class_standing: "Class Standing", us_citizen: "U.S. Citizen",
  age: "Age", gender: "Gender", pronouns: "Pronouns", race_ethnicity: "Race & ethnicity",
  languages: "Languages", first_gen: "First-generation", honors_college: "Honors College",
  archived_at: "Archive status", fellowship_name: "Fellowship name", application_year: "Application Year",
  destination_country: "Destination Country", stage_of_application: "Application Stage",
  is_semi_finalist: "Semi-finalist", is_finalist: "Finalist", role: "Advisor role",
};

function friendlyValue(value: unknown, field: string): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (field === "archived_at") return "Archived";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(String).join(", ") || "None";
  return String(value);
}

/** Parse only explicitly approved fields from the change payload. */
function normalizeChanges(raw: unknown): AuditChange[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([field, pair]) => {
    const label = fieldLabels[field];
    if (!label || !pair || typeof pair !== "object" || Array.isArray(pair)) return [];
    const values = pair as Record<string, unknown>;
    return [{ field, label, oldValue: friendlyValue(values.old, field), newValue: friendlyValue(values.new, field) }];
  });
}

/** Normalize a trusted audit row; raw snapshots are never returned to UI. */
export function normalizeAuditRow(row: AuditRow): AuditActivity {
  const entity = row.entity_type.replace(/[_-]+/g, " ");
  const subject = row.student_name ?? row.fellowship_name;
  return {
    id: String(row.audit_id), action: row.action,
    entityLabel: subject ? `${entity}: ${subject}` : entity,
    actor: row.actor_name_snapshot, occurredAt: row.occurred_at,
    summary: row.reason,
    changes: normalizeChanges(row.changes),
  };
}

const labels: Record<string, string> = {
  insert: "Created", create: "Created", update: "Updated", delete: "Removed",
  archive: "Archived", restore: "Restored", stage_change: "Stage changed",
};

export function auditActionLabel(action: string): string {
  return labels[action.toLowerCase()] ?? action.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatAuditDate(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** Stage is already presented by the application workflow; suppress duplicate audit stage changes. */
export function visibleAuditItems(items: AuditActivity[]): AuditActivity[] {
  return items.map((item) => {
    const changes = item.changes ?? [];
    if (!changes.some((change) => change.field === "stage_of_application")) return item;
    return { ...item, changes: changes.filter((change) => change.field !== "is_finalist" && change.field !== "is_semi_finalist") };
  });
}
