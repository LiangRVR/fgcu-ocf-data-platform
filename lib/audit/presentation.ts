/**
 * Safe, human-facing audit presentation.
 *
 * This module is the SINGLE place the raw audit diff (`changes`) is parsed. It
 * is a closed, positive-allowlisted `(entity_type, action)` schema:
 *
 *   - Only the ten reserved entity types and ten reserved actions are admitted;
 *     anything else fails closed (no title-casing of unknown technical values).
 *   - A raw diff field is projected only when its `(entity_type, action)` pair
 *     is allowlisted AND both sides validate to the field's strict primitive
 *     type. Nested objects, arrays on a scalar field, wrong primitive types,
 *     and unexpected keys are dropped rather than coerced.
 *   - Per-field corrections (Fellowship Thursday), relationship endpoint pairs
 *     (application re-link, Scholarship correction), the retained frozen
 *     Fellowship context and exact approved Void reason (Scholarship Void), and
 *     the immutable advising correction context are projected from the view's
 *     pre-derived safe scalars — never from a mutable lookup.
 *
 * `normalizeAuditRow` returns ONLY the typed `AuditActivity` surface: raw
 * `old_values`/`new_values`/`changes` JSON, Auth bindings, and unexpected
 * fields never leave the server. The client bundle imports only the pure
 * label/format helpers and the `AuditActivity`/`AuditChange` contracts.
 */
export interface AuditActivity {
  id: string;
  action: string;
  entityLabel: string;
  actor?: string | null;
  occurredAt?: string | null;
  summary?: string | null;
  changes?: AuditChange[];
}

export interface AuditChange {
  field: string;
  label: string;
  oldValue: string;
  newValue: string;
}

/** The generated browser-safe `audit_activity` view row (every column nullable). */
export type AuditActivityViewRow =
  import("@/types/database").Database["public"]["Views"]["audit_activity"]["Row"];

/**
 * The identity-complete audit row the presentation layer requires.
 *
 * The generated view marks every column nullable, but an event without its
 * immutable identity (`audit_id`, `occurred_at`, `entity_type`, `action`) can be
 * neither keyed, paginated, nor normalized safely. {@link isAuditRow} narrows a
 * generated view row to this shape and fails such a row closed instead of
 * coercing missing identity into a presentable value.
 */
export type AuditRow = Omit<
  AuditActivityViewRow,
  "audit_id" | "occurred_at" | "entity_type" | "action"
> & {
  audit_id: number;
  occurred_at: string;
  entity_type: string;
  action: string;
};

/**
 * Guard a generated view row into the identity-complete {@link AuditRow}. A row
 * missing any immutable identity column fails closed (returns `false`) and is
 * dropped by the caller rather than being rendered under a fabricated identity.
 */
export function isAuditRow(row: AuditActivityViewRow): row is AuditRow {
  return (
    row.audit_id !== null &&
    row.occurred_at !== null &&
    row.entity_type !== null &&
    row.action !== null
  );
}

/**
 * Server-only normalization input: a browser-safe `audit_activity` view row plus
 * the raw audit diff (`changes`) attached at the read boundary from the
 * RLS-governed `audit_event` base table. The `audit_activity` projection does NOT
 * expose the raw payload columns, so a raw diff is only ever present on this
 * server-side shape and is parsed here.
 */
export interface AuditNormalizationInput extends AuditRow {
  changes?: unknown;
}

/** The reserved entity vocabulary; a single shared source for labels/filters. */
export const AUDIT_ENTITY_TYPES = [
  "student",
  "advisor",
  "fellowship",
  "application",
  "advising_meeting",
  "advising_meeting_amendment",
  "fellowship_thursday",
  "fellowship_thursday_amendment",
  "scholarship_history",
  "scholarship_history_amendment",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** The reserved action vocabulary; a single shared source for labels/filters. */
export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "archived",
  "restored",
  "deactivated",
  "reactivated",
  "role_changed",
  "correction_added",
  "voided",
  "baseline_captured",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ENTITY_TYPE_SET = new Set<string>(AUDIT_ENTITY_TYPES);
const ACTION_SET = new Set<string>(AUDIT_ACTIONS);

// ---------------------------------------------------------------------------
// Field specifications (strict primitive typing per allowlisted field)
// ---------------------------------------------------------------------------

type FieldType = "string" | "number" | "boolean" | "archived_at";
interface FieldSpec {
  label: string;
  type: FieldType;
}

/**
 * Per-entity allowlisted diff fields. Student email is admitted ONLY here (the
 * Student entity); advisor email/Auth/account columns are never listed, so they
 * can never be projected.
 */
const ENTITY_FIELD_SPECS: Partial<Record<AuditEntityType, Record<string, FieldSpec>>> = {
  student: {
    full_name: { label: "Full Name", type: "string" },
    email: { label: "Email", type: "string" },
    is_ch_student: { label: "CH student", type: "boolean" },
    major: { label: "Major", type: "string" },
    minor: { label: "Minor", type: "string" },
    gpa: { label: "GPA", type: "number" },
    class_standing: { label: "Class Standing", type: "string" },
    us_citizen: { label: "U.S. Citizen", type: "boolean" },
    age: { label: "Age", type: "number" },
    gender: { label: "Gender", type: "string" },
    pronouns: { label: "Pronouns", type: "string" },
    race_ethnicity: { label: "Race & ethnicity", type: "string" },
    languages: { label: "Languages", type: "string" },
    first_gen: { label: "First-generation", type: "boolean" },
    honors_college: { label: "Honors College", type: "boolean" },
    archived_at: { label: "Archive status", type: "archived_at" },
  },
  advisor: {
    advisor_name: { label: "Advisor name", type: "string" },
    role: { label: "Advisor role", type: "string" },
    is_active: { label: "Active", type: "boolean" },
  },
  fellowship: {
    fellowship_name: { label: "Fellowship name", type: "string" },
    archived_at: { label: "Archive status", type: "archived_at" },
  },
  application: {
    // student_id/fellowship_id are resolved to relationship labels, not raw ids.
    student_id: { label: "Student", type: "string" },
    fellowship_id: { label: "Fellowship", type: "string" },
    application_year: { label: "Application Year", type: "number" },
    destination_country: { label: "Destination Country", type: "string" },
    stage_of_application: { label: "Application Stage", type: "string" },
    is_semi_finalist: { label: "Semi-finalist", type: "boolean" },
    is_finalist: { label: "Finalist", type: "boolean" },
  },
};

/**
 * Explicit `(entity_type, action)` allowlist for raw-diff extraction. A pair
 * not listed here contributes no diff-derived change even if `changes` carries
 * data. Amendment/void/correction context is built from the view's pre-derived
 * scalars, never from the raw diff.
 */
const ALLOWED_DIFF_ACTIONS: Partial<Record<AuditEntityType, readonly string[]>> = {
  student: ["created", "updated", "archived", "restored", "baseline_captured"],
  advisor: ["created", "updated", "deactivated", "reactivated", "role_changed", "baseline_captured"],
  fellowship: ["created", "updated", "archived", "restored", "baseline_captured"],
  application: ["created", "updated", "baseline_captured"],
};

/** `(entity_type, action)` pairs whose event `reason` is approved for display. */
const REASON_ALLOWED_PAIRS = new Set<string>([
  "student:archived",
  "student:restored",
  "fellowship:archived",
  "fellowship:restored",
  "advisor:deactivated",
  "advisor:reactivated",
  "advisor:role_changed",
]);

// ---------------------------------------------------------------------------
// Strict primitive validation + rendering
// ---------------------------------------------------------------------------

function isValidFieldValue(type: FieldType, value: unknown): boolean {
  // A JSON null (or absent) is a legitimate "before/after" side of a change.
  if (value === null || value === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "archived_at":
      return typeof value === "string";
  }
}

function renderValue(type: FieldType, value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (type === "archived_at") return "Archived";
  if (type === "boolean") return value === true ? "Yes" : "No";
  return String(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** A raw diff payload object, or null when it is missing/not a plain object. */
function asDiffObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * A well-formed `{ old, new }` diff pair. BOTH sides must be present (an own
 * `old` AND an own `new` key); a missing/malformed half fails closed and is
 * dropped instead of being coerced into a fabricated "Not set" → "Not set"
 * change.
 */
function asPair(pair: unknown): Record<string, unknown> | null {
  if (!pair || typeof pair !== "object" || Array.isArray(pair)) return null;
  const values = pair as Record<string, unknown>;
  if (!hasOwn(values, "old") || !hasOwn(values, "new")) return null;
  return values;
}

/** A well-formed relationship endpoint id pair (each side a finite number or null). */
function asIdPair(pair: unknown): { old: number | null; new: number | null } | null {
  const values = asPair(pair);
  if (!values) return null;
  const isId = (value: unknown): value is number | null =>
    value === null || (typeof value === "number" && Number.isFinite(value));
  if (!isId(values.old) || !isId(values.new)) return null;
  return { old: values.old, new: values.new };
}

/** True when `(entity_type, action)` is in the explicit raw-diff allowlist. */
function isDiffActionAllowed(entity: AuditEntityType, action: string): boolean {
  return ALLOWED_DIFF_ACTIONS[entity]?.includes(action) ?? false;
}

/** Parse only the allowlisted fields from the change payload with strict typing. */
function normalizeChanges(row: AuditNormalizationInput): AuditChange[] {
  const entity = row.entity_type as AuditEntityType;
  if (!ENTITY_TYPE_SET.has(entity)) return [];
  if (!isDiffActionAllowed(entity, row.action)) return [];
  const specs = ENTITY_FIELD_SPECS[entity];
  const raw = asDiffObject(row.changes);
  if (!specs || !raw) return [];

  const out: AuditChange[] = [];
  for (const [field, pair] of Object.entries(raw)) {
    const spec = specs[field];
    if (!spec) continue;
    // Raw id diffs on an application are rendered as relationship label pairs.
    if (entity === "application" && (field === "student_id" || field === "fellowship_id")) continue;
    // Fail closed: the entry MUST be a well-formed pair with both sides present.
    const values = asPair(pair);
    if (!values) continue;
    if (!isValidFieldValue(spec.type, values.old) || !isValidFieldValue(spec.type, values.new)) continue;
    out.push({
      field,
      label: spec.label,
      oldValue: renderValue(spec.type, values.old),
      newValue: renderValue(spec.type, values.new),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relationship, correction, void, and advising context projection
// ---------------------------------------------------------------------------

/** `Student #id` style fallback that never fabricates a mutable name. */
function endpointLabel(name: string | null, id: number | null, kind: "Student" | "Fellowship" | "Application"): string {
  if (name) return name;
  if (id !== null && id !== undefined) return `${kind} #${id}`;
  return "Not set";
}

/** Push a relationship change only when at least one endpoint is provable. */
function pushEndpointChange(out: AuditChange[], change: AuditChange): void {
  if (change.oldValue === "Not set" && change.newValue === "Not set") return;
  out.push(change);
}

/**
 * Application re-link: immutable before→after endpoint label pairs.
 *
 * Fails closed: the event must be an allowlisted application diff action and the
 * `student_id`/`fellowship_id` diff entries must be well-formed id pairs
 * (`{ old, new }` with both sides a finite number or null) whose endpoints
 * actually differ. A malformed pair, an unexpected action, or an unprovable
 * pair contributes no relationship change.
 */
function relationshipChanges(row: AuditNormalizationInput): AuditChange[] {
  if (row.entity_type !== "application") return [];
  if (!isDiffActionAllowed("application", row.action)) return [];
  const diff = asDiffObject(row.changes);
  if (!diff) return [];
  const out: AuditChange[] = [];

  const student = asIdPair(diff.student_id);
  if (student && student.old !== student.new) {
    pushEndpointChange(out, {
      field: "student_id",
      label: "Student",
      oldValue: endpointLabel(row.previous_student_name, row.previous_student_id, "Student"),
      newValue: endpointLabel(row.current_student_name, row.current_student_id, "Student"),
    });
  }
  const fellowship = asIdPair(diff.fellowship_id);
  if (fellowship && fellowship.old !== fellowship.new) {
    pushEndpointChange(out, {
      field: "fellowship_id",
      label: "Fellowship",
      oldValue: endpointLabel(row.previous_fellowship_name, row.previous_fellowship_id, "Fellowship"),
      newValue: endpointLabel(row.current_fellowship_name, row.current_fellowship_id, "Fellowship"),
    });
  }
  return out;
}

/**
 * Scholarship amendment fellowship context.
 *
 * A Correction renders its immediately-prior effective frozen fellowship
 * (previous) → the corrected frozen fellowship (current). A Void does not
 * transition the award: it retains the immediately-prior effective frozen
 * fellowship as the event's `current` context and creates no new fellowship, so
 * it surfaces that retained fellowship the same way (an absent prior side renders
 * as the neutral "Not set"). Both sides come only from the view's pre-derived
 * frozen `previous_fellowship_*`/`current_fellowship_*` scalars — never a raw
 * diff or a mutable lookup.
 */
function scholarshipChanges(row: AuditNormalizationInput): AuditChange[] {
  if (row.entity_type !== "scholarship_history_amendment") return [];
  if (row.action !== "correction_added" && row.action !== "voided") return [];
  const previous = row.previous_fellowship_id ?? null;
  const current = row.current_fellowship_id ?? null;
  // Fail closed: an unproven (both NULL) or non-transitioning (identical
  // endpoint) pair is not a relationship change.
  if (previous === null && current === null) return [];
  if (previous !== null && previous === current) return [];
  return [
    {
      field: "fellowship_id",
      label: "Fellowship",
      oldValue: endpointLabel(row.previous_fellowship_name, previous, "Fellowship"),
      newValue: endpointLabel(row.current_fellowship_name, current, "Fellowship"),
    },
  ];
}

/** Fellowship Thursday per-field correction: effective-before → corrected. */
function fellowshipThursdayChanges(row: AuditNormalizationInput): AuditChange[] {
  if (row.entity_type !== "fellowship_thursday_amendment") return [];
  if (row.action !== "correction_added") return [];
  const out: AuditChange[] = [];
  if (row.fellowship_thursday_attended_amended) {
    out.push({
      field: "attended",
      label: "Attended",
      oldValue: renderValue("boolean", row.fellowship_thursday_attended_before),
      newValue: renderValue("boolean", row.fellowship_thursday_attended_after),
    });
  }
  if (row.fellowship_thursday_source_amended) {
    out.push({
      field: "source_info",
      label: "Source",
      oldValue: renderValue("string", row.fellowship_thursday_source_before),
      newValue: renderValue("string", row.fellowship_thursday_source_after),
    });
  }
  return out;
}

function contextChange(field: string, label: string, value: string | null): AuditChange | null {
  if (!value) return null;
  return { field, label, oldValue: "—", newValue: value };
}

/**
 * Safe advising correction context. Only the immutable parent-meeting
 * structural scalars (meeting date, application, conducting advisor) are
 * exposed; amendment details/notes/reason are never read. The conducting
 * advisor is the neutral `Advisor #id` derived from the immutable parent
 * `advisor_id` (a mutable advisor-name join is never performed).
 */
function advisingChanges(row: AuditNormalizationInput): AuditChange[] {
  if (row.entity_type !== "advising_meeting_amendment") return [];
  if (row.action !== "correction_added") return [];
  const out: AuditChange[] = [];
  const date = contextChange("meeting_date", "Meeting date", row.advising_meeting_date ?? null);
  if (date) out.push(date);
  const applicationLabel = row.subject_application_name ?? (row.advising_application_id ? `Application #${row.advising_application_id}` : null);
  const application = contextChange("application_id", "Application", applicationLabel);
  if (application) out.push(application);
  const advisor = contextChange(
    "advisor_id",
    "Conducting advisor",
    row.advising_advisor_id ? `Advisor #${row.advising_advisor_id}` : null
  );
  if (advisor) out.push(advisor);
  return out;
}

// ---------------------------------------------------------------------------
// Labels + reasons
// ---------------------------------------------------------------------------

const ENTITY_LABELS: Record<string, string> = {
  student: "Student",
  advisor: "Advisor",
  fellowship: "Fellowship",
  application: "Application",
  advising_meeting: "Advising Meeting",
  advising_meeting_amendment: "Advising Meeting Amendment",
  fellowship_thursday: "Fellowship Thursday",
  fellowship_thursday_amendment: "Fellowship Thursday Amendment",
  scholarship_history: "Scholarship History",
  scholarship_history_amendment: "Scholarship History Amendment",
};

/** Friendly, business-facing entity label; unknown entities fail closed. */
export function auditEntityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? "Unknown record";
}

const ACTION_LABELS: Record<string, string> = {
  insert: "Created",
  create: "Created",
  created: "Created",
  update: "Updated",
  updated: "Updated",
  delete: "Removed",
  archive: "Archived",
  archived: "Archived",
  restore: "Restored",
  restored: "Restored",
  stage_change: "Stage changed",
  deactivated: "Advisor Deactivated",
  reactivated: "Advisor Reactivated",
  role_changed: "Role Changed",
  correction_added: "Correction Added",
  voided: "Voided",
  baseline_captured: "Legacy State Captured",
};

/** Friendly action label; an unrecognized verb fails closed (never title-cased). */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action.toLowerCase()] ?? "Change";
}

/**
 * Approved event reason policy: lifecycle (archive/restore), advisor lifecycle
 * (deactivate/reactivate), advisor role change, and the exact Scholarship Void
 * reason. All other amendment/advising narrative is excluded.
 */
function displayReason(row: AuditRow): string | null {
  if (row.entity_type === "scholarship_history_amendment" && row.action === "voided") {
    return row.void_reason ?? null;
  }
  if (REASON_ALLOWED_PAIRS.has(`${row.entity_type}:${row.action}`)) {
    return row.reason ?? null;
  }
  return null;
}

/**
 * Resolve the label for an event's subject. The event-time CURRENT subject is
 * preferred; when the immutable event could not prove a relationship label
 * (NULL scalars) it degrades to the aggregate labels and finally the frozen
 * previous side, never fabricating a present-day name.
 */
function subjectLabel(row: AuditRow): string | null {
  return (
    row.current_student_name ??
    row.current_fellowship_name ??
    row.student_name ??
    row.fellowship_name ??
    row.subject_application_name ??
    row.previous_student_name ??
    row.previous_fellowship_name
  );
}

/** Normalize a trusted audit row; raw snapshots are never returned to UI. */
export function normalizeAuditRow(row: AuditNormalizationInput): AuditActivity {
  const known = ENTITY_TYPE_SET.has(row.entity_type) && ACTION_SET.has(row.action);
  const entity = row.entity_type.replace(/[_-]+/g, " ");
  const subject = known ? subjectLabel(row) : null;
  const changes = known
    ? [
        ...relationshipChanges(row),
        ...scholarshipChanges(row),
        ...fellowshipThursdayChanges(row),
        ...normalizeChanges(row),
        ...advisingChanges(row),
      ]
    : [];
  return {
    id: String(row.audit_id),
    action: row.action,
    entityLabel: known
      ? subject
        ? `${entity}: ${subject}`
        : entity
      : auditEntityLabel(row.entity_type),
    actor: row.actor_name_snapshot,
    occurredAt: row.occurred_at,
    summary: known ? displayReason(row) : null,
    changes,
  };
}

export function formatAuditDate(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** The four pipeline stages whose denormalized flags are exactly (ff, ff). */
const STAGE_FLAG_MAP: Record<string, [boolean, boolean]> = {
  Started: [false, false],
  Submitted: [false, false],
  "Under Review": [false, false],
  "Did Not Submit": [false, false],
  Rejected: [false, false],
  Withdrawn: [false, false],
  "Semi-Finalist": [true, false],
  Finalist: [true, true],
  Awarded: [true, true],
};

/**
 * True when an explicitly recognized stage change carries finalist flags that
 * contradict the new stage (the recognized inconsistent-state diagnostic). Such
 * a case keeps the flags visible instead of suppressing them.
 */
function isInconsistentStageDiagnostic(changes: AuditChange[]): boolean {
  const stage = changes.find((change) => change.field === "stage_of_application");
  if (!stage) return false;
  const expected = STAGE_FLAG_MAP[stage.newValue];
  if (!expected) return false;
  const [expectedSemi, expectedFinal] = expected;
  const semi = changes.find((change) => change.field === "is_semi_finalist");
  const final = changes.find((change) => change.field === "is_finalist");
  if (semi && (semi.newValue === "Yes") !== expectedSemi) return true;
  if (final && (final.newValue === "Yes") !== expectedFinal) return true;
  return false;
}

/** Stage is already presented by the application workflow; suppress duplicate audit stage changes. */
export function visibleAuditItems(items: AuditActivity[]): AuditActivity[] {
  return items.map((item) => {
    const changes = item.changes ?? [];
    if (!changes.some((change) => change.field === "stage_of_application")) return item;
    if (isInconsistentStageDiagnostic(changes)) return item;
    return { ...item, changes: changes.filter((change) => change.field !== "is_finalist" && change.field !== "is_semi_finalist") };
  });
}
