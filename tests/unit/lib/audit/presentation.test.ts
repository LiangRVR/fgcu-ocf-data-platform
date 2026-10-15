/**
 * tests/unit/lib/audit/presentation.test.ts
 *
 * Safe, human-facing audit presentation contract (R7):
 *
 *   - `normalizeAuditRow` emits ONLY the safe display fields plus a TYPED,
 *     allowlisted `changes` list (field/label/oldValue/newValue) — raw JSON
 *     `old_values` / `new_values` payload columns, unknown/sensitive diff
 *     fields, and Auth bindings never reach the UI (no raw JSON output);
 *   - `normalizeChanges` renders friendly text for null, boolean, numeric,
 *     array, and archive values while dropping unrecognized fields;
 *   - `auditActionLabel` maps event actions to friendly labels and safely
 *     title-cases unknown verbs;
 *   - `formatAuditDate` formats valid timestamps and degrades gracefully;
 *   - `visibleAuditItems` strips the redundant derived `is_finalist` /
 *     `is_semi_finalist` flags ONLY from items that carry an actual
 *     `stage_of_application` change (the application workflow already presents
 *     the stage); items without a stage change keep every change.
 */
import { describe, expect, it } from "vitest";
import type { AuditRow } from "@/lib/audit/presentation";
import {
  auditActionLabel,
  formatAuditDate,
  normalizeAuditRow,
  visibleAuditItems,
  type AuditActivity,
  type AuditChange,
} from "@/lib/audit/presentation";

const SECRET_OLD_VALUE = "secret-credential-old";
const SECRET_NEW_VALUE = "secret-credential-new";
const SECRET_DIFF_VALUE = "secret-diff-details";

/** A generous trusted view row: every safe field plus raw JSON payloads. */
function makeAuditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    action: "updated",
    actor_advisor_id: 12,
    actor_name_snapshot: "Jordan Lee",
    audit_id: 77,
    changes: { gpa: { old: 3.8, new: 3.9 } },
    entity_id: 42,
    entity_type: "advisor",
    fellowship_name: null,
    new_values: { email: SECRET_NEW_VALUE, is_active: true },
    occurred_at: "2026-10-12T14:30:00.000Z",
    old_values: { email: SECRET_OLD_VALUE, is_active: false },
    origin: "api",
    reason: "Promotion approved",
    student_name: null,
    subject_application_id: null,
    subject_fellowship_id: null,
    subject_student_id: null,
    fellowship_subject_ids: [],
    student_subject_ids: [],
    previous_student_name: null,
    current_student_name: null,
    previous_fellowship_name: null,
    current_fellowship_name: null,
    subject_application_name: null,
    ...overrides,
  };
}

describe("normalizeAuditRow", () => {
  it("derives a friendly entity label from the entity type and subject name", () => {
    const row = makeAuditRow({
      entity_type: "advisor",
      student_name: "Sam Student",
      fellowship_name: null,
    });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Sam Student");
  });

  it("replaces underscore/dash separators in the entity type before display", () => {
    const row = makeAuditRow({ entity_type: "advising_meeting_amendment", student_name: "Sam" });
    expect(normalizeAuditRow(row).entityLabel).toBe("advising meeting amendment: Sam");
  });

  it("prefers the student subject when both student and fellowship names exist", () => {
    const row = makeAuditRow({
      student_name: "Sam Student",
      fellowship_name: "Freshman Scholars",
    });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Sam Student");
  });

  it("falls back to the fellowship subject when there is no student name", () => {
    const row = makeAuditRow({ student_name: null, fellowship_name: "Freshman Scholars" });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Freshman Scholars");
  });

  it("prefers the event-time CURRENT subject over the aggregate endpoint snapshot", () => {
    // A re-link aggregates both endpoints in `student_name`; the relationship
    // scalar exposes only the current endpoint.
    const row = makeAuditRow({
      entity_type: "application",
      student_name: "Maria Torres | John Chen",
      current_student_name: "John Chen",
    });
    expect(normalizeAuditRow(row).entityLabel).toBe("application: John Chen");
  });

  it("prefers the current fellowship label when no student context is proven", () => {
    const row = makeAuditRow({
      student_name: null,
      fellowship_name: "Goldwater | Fulbright",
      current_fellowship_name: "Fulbright",
    });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Fulbright");
  });

  it("falls back to the aggregate label when the relationship scalar is unproven (NULL)", () => {
    const row = makeAuditRow({ current_student_name: null, student_name: "Legacy Student" });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Legacy Student");
  });

  it("uses the frozen previous side only when no current/aggregate label exists", () => {
    const row = makeAuditRow({ previous_student_name: "Maria Torres" });
    expect(normalizeAuditRow(row).entityLabel).toBe("advisor: Maria Torres");
  });

  it("keeps null subjects/nullable display values as-is (no fabricated labels)", () => {
    const row = makeAuditRow({
      student_name: null,
      fellowship_name: null,
      actor_name_snapshot: "System",
      reason: null,
    });
    const normalized = normalizeAuditRow(row);
    expect(normalized.entityLabel).toBe("advisor");
    expect(normalized.actor).toBe("System");
    expect(normalized.summary).toBeNull();
    expect(normalized.occurredAt).toBe("2026-10-12T14:30:00.000Z");
  });

  it("passes through the recorded actor snapshot, timestamp, and reason verbatim", () => {
    const row = makeAuditRow({ actor_name_snapshot: "Ada Lovelace", reason: "Approved", action: "archived" });
    expect(normalizeAuditRow(row)).toMatchObject({
      id: "77",
      action: "archived",
      actor: "Ada Lovelace",
      occurredAt: "2026-10-12T14:30:00.000Z",
      summary: "Approved",
    });
  });

  it("coerces the numeric audit id to a string key for React", () => {
    expect(normalizeAuditRow(makeAuditRow({ audit_id: 999 })).id).toBe("999");
  });
});

describe("normalizeChanges — typed friendly diff rendering", () => {
  function changesOf(overrides: Partial<AuditRow> = {}): AuditChange[] | undefined {
    return normalizeAuditRow(makeAuditRow(overrides)).changes;
  }

  it("maps allowlisted fields to friendly labels", () => {
    const changes = changesOf({
      changes: {
        gpa: { old: 3.4, new: 3.9 },
        is_ch_student: { old: false, new: true },
      },
    });
    expect(changes).toEqual([
      { field: "gpa", label: "GPA", oldValue: "3.4", newValue: "3.9" },
      { field: "is_ch_student", label: "CH student", oldValue: "No", newValue: "Yes" },
    ]);
  });

  it("renders null/undefined/empty values as the neutral 'Not set' text", () => {
    const changes = changesOf({
      changes: { major: { old: null, new: "" }, minor: { old: undefined, new: "Music" } },
    });
    expect(changes).toEqual([
      { field: "major", label: "Major", oldValue: "Not set", newValue: "Not set" },
      { field: "minor", label: "Minor", oldValue: "Not set", newValue: "Music" },
    ]);
  });

  it("renders booleans as Yes/No and numerics as plain text", () => {
    const changes = changesOf({
      changes: {
        us_citizen: { old: false, new: true },
        is_finalist: { old: null, new: true },
        gpa: { old: 3.85, new: 3.925 },
        application_year: { old: 2025, new: 2026 },
      },
    });
    expect(changes).toEqual([
      { field: "us_citizen", label: "U.S. Citizen", oldValue: "No", newValue: "Yes" },
      { field: "is_finalist", label: "Finalist", oldValue: "Not set", newValue: "Yes" },
      { field: "gpa", label: "GPA", oldValue: "3.85", newValue: "3.925" },
      { field: "application_year", label: "Application Year", oldValue: "2025", newValue: "2026" },
    ]);
  });

  it("renders arrays as joined text and empty arrays as 'None'", () => {
    const changes = changesOf({
      changes: { languages: { old: [], new: ["English", "Spanish"] } },
    });
    expect(changes).toEqual([
      { field: "languages", label: "Languages", oldValue: "None", newValue: "English, Spanish" },
    ]);
  });

  it("renders the archived_at status flag as friendly 'Archived' text", () => {
    const changes = changesOf({
      changes: { archived_at: { old: null, new: "2026-10-12T00:00:00.000Z" } },
    });
    expect(changes).toEqual([
      { field: "archived_at", label: "Archive status", oldValue: "Not set", newValue: "Archived" },
    ]);
  });

  it("DROPS unknown/unlabeled diff fields (no raw or sensitive keys in the UI)", () => {
    const changes = changesOf({
      changes: {
        email: { old: SECRET_OLD_VALUE, new: SECRET_NEW_VALUE },
        password_hash: { old: "hash-old", new: "hash-new" },
        auth_user_id: { old: "u-1", new: "u-2" },
        gpa: { old: 3.0, new: 3.2 },
      },
    });
    expect(changes).toEqual([
      { field: "gpa", label: "GPA", oldValue: "3", newValue: "3.2" },
    ]);
    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain(SECRET_OLD_VALUE);
    expect(serialized).not.toContain(SECRET_NEW_VALUE);
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("auth_user_id");
  });

  it("treats malformed/null changes as an empty typed list (no crash, no raw output)", () => {
    for (const raw of [null, undefined, "not-an-object", 42, ["array"], {}]) {
      expect(changesOf({ changes: raw as never })).toEqual([]);
    }
  });

  it("drops changes whose value pair is not a plain object", () => {
    const changes = changesOf({
      changes: { gpa: "3.5", major: [1, 2], minor: null, stage_of_application: { old: "applied", new: "reviewed" } },
    });
    expect(changes).toEqual([
      { field: "stage_of_application", label: "Application Stage", oldValue: "applied", newValue: "reviewed" },
    ]);
  });

  it("NEVER exposes raw JSON payload columns, secrets, or Auth bindings (no raw output)", () => {
    const normalized = normalizeAuditRow(
      makeAuditRow({
        changes: {
          gpa: { old: 3.0, new: 3.4 },
          // Secrets embedded in the diff in an unknown field must not leak.
          internal_note: { old: SECRET_DIFF_VALUE, new: SECRET_DIFF_VALUE },
        },
      })
    );
    const serialized = JSON.stringify(normalized);

    // The safe display surface survives; the typed changes list is explicit.
    expect(Object.keys(normalized).sort()).toEqual([
      "action",
      "actor",
      "changes",
      "entityLabel",
      "id",
      "occurredAt",
      "summary",
    ]);
    expect(normalized.changes).toEqual([
      { field: "gpa", label: "GPA", oldValue: "3", newValue: "3.4" },
    ]);

    // Raw payload columns, unknown diff secrets, and Auth/provenance ids never
    // serialize into the UI-facing object.
    expect(serialized).not.toContain(SECRET_OLD_VALUE);
    expect(serialized).not.toContain(SECRET_NEW_VALUE);
    expect(serialized).not.toContain(SECRET_DIFF_VALUE);
    expect(serialized).not.toContain("internal_note");
    expect(serialized).not.toContain("old_values");
    expect(serialized).not.toContain("new_values");
    expect(serialized).not.toContain("actor_advisor_id");
    expect(serialized).not.toContain("subject_application_id");
  });
});

describe("auditActionLabel", () => {
  it("maps known lifecycle actions to friendly labels", () => {
    expect(auditActionLabel("insert")).toBe("Created");
    expect(auditActionLabel("create")).toBe("Created");
    expect(auditActionLabel("update")).toBe("Updated");
    expect(auditActionLabel("delete")).toBe("Removed");
    expect(auditActionLabel("archive")).toBe("Archived");
    expect(auditActionLabel("restore")).toBe("Restored");
    expect(auditActionLabel("stage_change")).toBe("Stage changed");
  });

  it("is case-insensitive for known actions", () => {
    expect(auditActionLabel("INSERT")).toBe("Created");
    expect(auditActionLabel("Archived")).toBe("Archived");
  });

  it("title-cases an unknown action and makes separators friendly", () => {
    expect(auditActionLabel("role_changed")).toBe("Role Changed");
    expect(auditActionLabel("correction_added")).toBe("Correction Added");
    expect(auditActionLabel("voided")).toBe("Voided");
    expect(auditActionLabel("baseline_captured")).toBe("Legacy State Captured");
  });
});

describe("formatAuditDate", () => {
  it("formats a valid ISO timestamp for display", () => {
    const formatted = formatAuditDate("2026-10-12T14:30:00.000Z");
    expect(formatted).toContain("2026");
    expect(formatted).not.toBe("Date unavailable");
  });

  it("degrades gracefully for null, empty, and unparseable values", () => {
    expect(formatAuditDate(null)).toBe("Date unavailable");
    expect(formatAuditDate(undefined)).toBe("Date unavailable");
    expect(formatAuditDate("")).toBe("Date unavailable");
    expect(formatAuditDate("not-a-date")).toBe("Date unavailable");
  });
});

describe("visibleAuditItems (stage-flag suppression gated on stage change)", () => {
  function change(field: string): AuditChange {
    return { field, label: field, oldValue: "No", newValue: "Yes" };
  }

  function item(overrides: Partial<AuditActivity> = {}): AuditActivity {
    return {
      id: "1",
      action: "updated",
      entityLabel: "application: 5",
      actor: "Jordan Lee",
      occurredAt: "2026-10-12T14:30:00.000Z",
      summary: null,
      ...overrides,
    };
  }

  it("strips the redundant finalist flags ONLY when a stage_of_application change exists", () => {
    const items = [
      item({
        id: "stage-flow",
        changes: [
          change("stage_of_application"),
          change("is_finalist"),
          change("is_semi_finalist"),
          change("major"),
        ],
      }),
    ];
    const [visible] = visibleAuditItems(items);
    expect(visible.changes?.map((c) => c.field)).toEqual(["stage_of_application", "major"]);
  });

  it("keeps finalist flags when there is NO stage_of_application change", () => {
    const items = [
      item({ id: "direct-flag", changes: [change("is_finalist"), change("is_semi_finalist")] }),
      item({ id: "entry-ascent", action: "stage_changed", changes: [] }),
    ];
    expect(visibleAuditItems(items)).toEqual(items);
    expect(visibleAuditItems(items)[0].changes?.map((c) => c.field)).toEqual([
      "is_finalist",
      "is_semi_finalist",
    ]);
  });

  it("preserves items without any changes (no action-based filtering)", () => {
    const items = [
      item({ id: "1", action: "updated" }),
      item({ id: "2", action: "archived" }),
      item({ id: "3", action: "voided", changes: undefined }),
    ];
    expect(visibleAuditItems(items).map((entry) => entry.id)).toEqual(["1", "2", "3"]);
    expect(visibleAuditItems(items)[2].changes).toBeUndefined();
  });

  it("returns a mapped (same-length) list and an empty list for no items", () => {
    const items = [item({ id: "only", changes: [change("stage_of_application")] })];
    expect(visibleAuditItems(items)).toHaveLength(1);
    expect(visibleAuditItems([])).toEqual([]);
  });
});
