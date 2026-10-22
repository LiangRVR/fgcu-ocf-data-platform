/**
 * tests/unit/lib/audit/presentation.test.ts
 *
 * Closed, positive-allowlisted audit presentation contract:
 *
 *   - `normalizeAuditRow` emits ONLY the safe display fields plus a TYPED,
 *     allowlisted `changes` list — raw JSON payloads, unexpected/sensitive diff
 *     fields, and Auth/account columns never reach the UI;
 *   - raw-diff extraction is keyed to an explicit `(entity_type, action)`
 *     allowlist with strict primitive typing; nested objects, arrays on a
 *     scalar field, wrong primitive types, and unknown fields are dropped;
 *   - relationship endpoint pairs, Fellowship Thursday per-field corrections,
 *     the exact Scholarship Void reason, and the immutable advising correction
 *     context are projected from the view's pre-derived scalars;
 *   - unknown entity/action values fail closed (never title-cased).
 */
import { describe, expect, it } from "vitest";
import type { AuditNormalizationInput } from "@/lib/audit/presentation";
import {
  auditActionLabel,
  auditEntityLabel,
  formatAuditDate,
  normalizeAuditRow,
  visibleAuditItems,
  type AuditActivity,
  type AuditChange,
} from "@/lib/audit/presentation";

const SECRET_OLD_VALUE = "secret-credential-old";
const SECRET_NEW_VALUE = "secret-credential-new";
const SECRET_DIFF_VALUE = "secret-diff-details";

/**
 * A generous trusted normalization input: the browser-safe view row plus the
 * server-only raw diff attached at the read boundary.
 */
function makeAuditRow(overrides: Partial<AuditNormalizationInput> = {}): AuditNormalizationInput {
  return {
    action: "updated",
    actor_advisor_id: 12,
    actor_name_snapshot: "Jordan Lee",
    audit_id: 77,
    changes: { gpa: { old: 3.8, new: 3.9 } },
    entity_id: 42,
    entity_type: "student",
    fellowship_name: null,
    occurred_at: "2026-10-12T14:30:00.000Z",
    origin: "api",
    reason: "Promotion approved",
    student_name: "Sam Student",
    subject_application_id: null,
    subject_fellowship_id: null,
    subject_student_id: 42,
    fellowship_subject_ids: [],
    student_subject_ids: [42],
    previous_student_name: null,
    current_student_name: null,
    previous_fellowship_name: null,
    current_fellowship_name: null,
    subject_application_name: null,
    previous_student_id: null,
    current_student_id: null,
    previous_fellowship_id: null,
    current_fellowship_id: null,
    fellowship_thursday_attended_before: null,
    fellowship_thursday_attended_after: null,
    fellowship_thursday_attended_amended: null,
    fellowship_thursday_source_before: null,
    fellowship_thursday_source_after: null,
    fellowship_thursday_source_amended: null,
    void_reason: null,
    advising_meeting_date: null,
    advising_application_id: null,
    advising_advisor_id: null,
    ...overrides,
  };
}

describe("normalizeAuditRow — labels and subjects", () => {
  it("derives a friendly entity label from the entity type and subject name", () => {
    expect(normalizeAuditRow(makeAuditRow({ entity_type: "advisor", student_name: "Sam Student" })).entityLabel).toBe(
      "advisor: Sam Student"
    );
  });

  it("replaces underscore/dash separators in the entity type before display", () => {
    const row = makeAuditRow({ entity_type: "advising_meeting_amendment", student_name: "Sam" });
    expect(normalizeAuditRow(row).entityLabel).toBe("advising meeting amendment: Sam");
  });

  it("prefers the event-time CURRENT subject over the aggregate endpoint snapshot", () => {
    const row = makeAuditRow({
      entity_type: "application",
      student_name: "Maria Torres | John Chen",
      current_student_name: "John Chen",
    });
    expect(normalizeAuditRow(row).entityLabel).toBe("application: John Chen");
  });

  it("falls back to the aggregate label when the relationship scalar is unproven (NULL)", () => {
    expect(
      normalizeAuditRow(makeAuditRow({ current_student_name: null, student_name: "Legacy Student" })).entityLabel
    ).toBe("student: Legacy Student");
  });

  it("keeps null subjects/nullable display values as-is (no fabricated labels)", () => {
    const normalized = normalizeAuditRow(
      makeAuditRow({ student_name: null, fellowship_name: null, actor_name_snapshot: "System", reason: null })
    );
    expect(normalized.entityLabel).toBe("student");
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

describe("normalizeChanges — closed allowlist + typed rendering", () => {
  function changesOf(overrides: Partial<AuditNormalizationInput> = {}): AuditChange[] | undefined {
    return normalizeAuditRow(makeAuditRow(overrides)).changes;
  }

  it("maps allowlisted fields to friendly labels", () => {
    const changes = changesOf({
      changes: { gpa: { old: 3.4, new: 3.9 }, is_ch_student: { old: false, new: true } },
    });
    expect(changes).toEqual([
      { field: "gpa", label: "GPA", oldValue: "3.4", newValue: "3.9" },
      { field: "is_ch_student", label: "CH student", oldValue: "No", newValue: "Yes" },
    ]);
  });

  it("admits Student email only (Student entity) and projects languages as a scalar string", () => {
    const changes = changesOf({
      entity_type: "student",
      action: "updated",
      changes: {
        email: { old: "a@example.edu", new: "b@example.edu" },
        languages: { old: null, new: "English, Spanish" },
      },
    });
    expect(changes).toEqual([
      { field: "email", label: "Email", oldValue: "a@example.edu", newValue: "b@example.edu" },
      { field: "languages", label: "Languages", oldValue: "Not set", newValue: "English, Spanish" },
    ]);
  });

  it("drops a non-scalar languages value (strict typing is retained)", () => {
    const changes = changesOf({
      entity_type: "student",
      action: "updated",
      changes: { languages: { old: [], new: ["English", "Spanish"] } },
    });
    expect(changes).toEqual([]);
  });

  it("renders null/empty as 'Not set' and archived_at as friendly 'Archived'", () => {
    const changes = changesOf({
      changes: { major: { old: null, new: "" }, archived_at: { old: null, new: "2026-10-12T00:00:00.000Z" } },
    });
    expect(changes).toEqual([
      { field: "major", label: "Major", oldValue: "Not set", newValue: "Not set" },
      { field: "archived_at", label: "Archive status", oldValue: "Not set", newValue: "Archived" },
    ]);
  });

  it("dropping is fail-closed: nested objects, scalar arrays, and wrong primitives are dropped", () => {
    const changes = changesOf({
      changes: {
        gpa: { old: "not-a-number", new: 3.9 },
        major: { old: { nested: true }, new: "Music" },
        minor: { old: ["Music"], new: "Music" },
        is_ch_student: { old: "yes", new: true },
        us_citizen: { old: false, new: true },
      },
    });
    expect(changes).toEqual([{ field: "us_citizen", label: "U.S. Citizen", oldValue: "No", newValue: "Yes" }]);
  });

  it("DROPS unknown/sensitive diff fields and never serializes them", () => {
    const changes = changesOf({
      changes: {
        password_hash: { old: "hash-old", new: "hash-new" },
        auth_user_id: { old: "u-1", new: "u-2" },
        internal_note: { old: SECRET_OLD_VALUE, new: SECRET_NEW_VALUE },
        gpa: { old: 3.0, new: 3.2 },
      },
    });
    expect(changes).toEqual([{ field: "gpa", label: "GPA", oldValue: "3", newValue: "3.2" }]);
    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain(SECRET_OLD_VALUE);
    expect(serialized).not.toContain(SECRET_NEW_VALUE);
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("auth_user_id");
  });

  it("NEVER exposes advisor email/Auth fields (not in the advisor allowlist)", () => {
    const changes = changesOf({
      entity_type: "advisor",
      action: "role_changed",
      changes: {
        role: { old: "Advisor", new: "Admin" },
        email: { old: SECRET_OLD_VALUE, new: SECRET_NEW_VALUE },
        auth_user_id: { old: "u-1", new: "u-2" },
      },
    });
    expect(changes).toEqual([{ field: "role", label: "Advisor role", oldValue: "Advisor", newValue: "Admin" }]);
    expect(JSON.stringify(changes)).not.toContain(SECRET_NEW_VALUE);
  });

  it("fails closed on a missing/malformed old-or-new diff pair", () => {
    const changes = changesOf({
      changes: {
        gpa: { old: 3.1 }, // missing `new`
        major: { new: "Music" }, // missing `old`
        minor: {}, // both missing
        us_citizen: { old: false, new: true }, // well-formed
      },
    });
    expect(changes).toEqual([
      { field: "us_citizen", label: "U.S. Citizen", oldValue: "No", newValue: "Yes" },
    ]);
  });

  it("treats malformed/null changes as an empty typed list", () => {
    for (const raw of [null, undefined, "not-an-object", 42, ["array"], {}]) {
      expect(changesOf({ changes: raw as never })).toEqual([]);
    }
  });

  it("returns no diff changes for a non-allowlisted (entity, action) pair", () => {
    // `scholarship_history_amendment` is not in the diff allowlist.
    const changes = changesOf({
      entity_type: "scholarship_history_amendment",
      action: "correction_added",
      changes: { fellowship_id: { old: 1, new: 2 } },
    });
    expect(changes).toEqual([]);
  });

  it("never serializes raw payload/Auth/provenance fields", () => {
    const normalized = normalizeAuditRow(
      makeAuditRow({
        changes: { gpa: { old: 3.0, new: 3.4 }, internal_note: { old: SECRET_DIFF_VALUE, new: SECRET_DIFF_VALUE } },
      })
    );
    const serialized = JSON.stringify(normalized);
    expect(Object.keys(normalized).sort()).toEqual([
      "action",
      "actor",
      "changes",
      "entityLabel",
      "id",
      "occurredAt",
      "summary",
    ]);
    expect(serialized).not.toContain(SECRET_OLD_VALUE);
    expect(serialized).not.toContain(SECRET_NEW_VALUE);
    expect(serialized).not.toContain(SECRET_DIFF_VALUE);
    expect(serialized).not.toContain("internal_note");
    expect(serialized).not.toContain("old_values");
    expect(serialized).not.toContain("new_values");
    expect(serialized).not.toContain("actor_advisor_id");
  });
});

describe("relationship + correction + void + advising projection", () => {
  it("renders an application re-link as immutable before→after endpoint labels", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "updated",
      changes: { student_id: { old: 1, new: 2 }, fellowship_id: { old: 5, new: 6 } },
      previous_student_name: "Maria Torres",
      current_student_name: "John Chen",
      previous_student_id: 1,
      current_student_id: 2,
      previous_fellowship_name: "Goldwater",
      current_fellowship_name: "Fulbright",
      previous_fellowship_id: 5,
      current_fellowship_id: 6,
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "student_id", label: "Student", oldValue: "Maria Torres", newValue: "John Chen" },
      { field: "fellowship_id", label: "Fellowship", oldValue: "Goldwater", newValue: "Fulbright" },
    ]);
  });

  it("falls back to the paired frozen ID fallback when a label is absent", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "updated",
      changes: { student_id: { old: 1, new: 2 } },
      previous_student_name: null,
      current_student_name: null,
      previous_student_id: 1,
      current_student_id: 2,
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "student_id", label: "Student", oldValue: "Student #1", newValue: "Student #2" },
    ]);
  });

  it("fails closed on a malformed application relationship diff pair", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "updated",
      changes: {
        student_id: { old: 1 }, // malformed: missing `new`
        fellowship_id: { old: "x", new: 6 }, // malformed: non-id endpoint
      },
      previous_student_name: "Maria Torres",
      current_student_name: "John Chen",
      previous_fellowship_name: "Goldwater",
      current_fellowship_name: "Fulbright",
    });
    expect(normalizeAuditRow(row).changes).toEqual([]);
  });

  it("ignores an application relationship diff for a non-allowlisted action", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "voided",
      changes: { student_id: { old: 1, new: 2 } },
      previous_student_name: "Maria Torres",
      current_student_name: "John Chen",
    });
    expect(normalizeAuditRow(row).changes).toEqual([]);
  });

  it("drops an unprovable relationship pair (no frozen name or id on either side)", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "updated",
      changes: { student_id: { old: 1, new: 2 } },
    });
    expect(normalizeAuditRow(row).changes).toEqual([]);
  });

  it("does not render a non-transitioning (identical) relationship pair", () => {
    const row = makeAuditRow({
      entity_type: "application",
      action: "updated",
      changes: { student_id: { old: 1, new: 1 } },
      previous_student_name: "Maria Torres",
      current_student_name: "Maria Torres",
      previous_student_id: 1,
      current_student_id: 1,
    });
    expect(normalizeAuditRow(row).changes).toEqual([]);
  });

  it("renders a Fellowship Thursday correction as per-field before→corrected pairs", () => {
    const row = makeAuditRow({
      entity_type: "fellowship_thursday_amendment",
      action: "correction_added",
      changes: null,
      fellowship_thursday_attended_amended: true,
      fellowship_thursday_attended_before: true,
      fellowship_thursday_attended_after: false,
      fellowship_thursday_source_amended: true,
      fellowship_thursday_source_before: "OCF",
      fellowship_thursday_source_after: null,
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "attended", label: "Attended", oldValue: "Yes", newValue: "No" },
      { field: "source_info", label: "Source", oldValue: "OCF", newValue: "Not set" },
    ]);
  });

  it("renders a Scholarship correction as prior→corrected frozen fellowship", () => {
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "correction_added",
      changes: null,
      previous_fellowship_id: 5,
      previous_fellowship_name: "Goldwater",
      current_fellowship_id: 6,
      current_fellowship_name: "Fulbright",
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "fellowship_id", label: "Fellowship", oldValue: "Goldwater", newValue: "Fulbright" },
    ]);
  });

  it("shows a Scholarship Void's exact reason and its retained frozen fellowship", () => {
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "voided",
      changes: null,
      reason: null,
      void_reason: "Award entered in error",
      previous_fellowship_id: null,
      previous_fellowship_name: null,
      current_fellowship_id: 6,
      current_fellowship_name: "Fulbright",
    });
    const normalized = normalizeAuditRow(row);
    expect(normalized.summary).toBe("Award entered in error");
    expect(normalized.entityLabel).toBe("scholarship history amendment: Fulbright");
    // R6: a Void retains the immediately-prior effective frozen fellowship as
    // its context; the retained fellowship stays visible alongside the reason.
    expect(normalized.changes).toEqual([
      { field: "fellowship_id", label: "Fellowship", oldValue: "Not set", newValue: "Fulbright" },
    ]);
  });

  it("keeps a Scholarship Void's frozen fellowship visible even when a current student subject is present", () => {
    // In practice a Void event carries a `current` student subject, which the
    // entity label prefers; the fellowship context must still surface as a
    // typed change rather than disappear from the item.
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "voided",
      changes: { corrected_fellowship_id: { old: 5, new: null } },
      reason: "must never display",
      void_reason: "Voided in error",
      current_student_name: "Maria Torres",
      current_fellowship_id: 6,
      current_fellowship_name: "Fulbright",
    });
    const normalized = normalizeAuditRow(row);
    expect(normalized.entityLabel).toBe("scholarship history amendment: Maria Torres");
    expect(normalized.summary).toBe("Voided in error");
    expect(normalized.changes).toEqual([
      { field: "fellowship_id", label: "Fellowship", oldValue: "Not set", newValue: "Fulbright" },
    ]);
  });

  it("falls back to the frozen Fellowship #id when a Void's label is unproven and never renders raw ids", () => {
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "voided",
      changes: null,
      void_reason: "reason",
      current_fellowship_id: 6,
      current_fellowship_name: null,
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "fellowship_id", label: "Fellowship", oldValue: "Not set", newValue: "Fellowship #6" },
    ]);
  });

  it("drops a non-transitioning scholarship relationship pair", () => {
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "correction_added",
      changes: null,
      previous_fellowship_id: 6,
      current_fellowship_id: 6,
      previous_fellowship_name: "Fulbright",
      current_fellowship_name: "Fulbright",
    });
    expect(normalizeAuditRow(row).changes).toEqual([]);
  });

  it("projects Fellowship Thursday / advising context only for a correction_added action", () => {
    const ft = makeAuditRow({
      entity_type: "fellowship_thursday_amendment",
      action: "updated",
      changes: null,
      fellowship_thursday_attended_amended: true,
      fellowship_thursday_attended_before: true,
      fellowship_thursday_attended_after: false,
    });
    expect(normalizeAuditRow(ft).changes).toEqual([]);

    const advising = makeAuditRow({
      entity_type: "advising_meeting_amendment",
      action: "updated",
      changes: null,
      advising_meeting_date: "2026-09-21",
      advising_application_id: 8,
      advising_advisor_id: 12,
    });
    expect(normalizeAuditRow(advising).changes).toEqual([]);
  });

  it("does not forward a generic amendment reason for a non-approved pair", () => {
    const row = makeAuditRow({
      entity_type: "scholarship_history_amendment",
      action: "correction_added",
      changes: null,
      reason: "must never display",
      void_reason: null,
    });
    expect(normalizeAuditRow(row).summary).toBeNull();
  });

  it("projects safe advising correction context only (never details/reason)", () => {
    const row = makeAuditRow({
      entity_type: "advising_meeting_amendment",
      action: "correction_added",
      changes: null,
      reason: "must never display",
      advising_meeting_date: "2026-09-21",
      advising_application_id: 8,
      advising_advisor_id: 12,
      subject_application_name: "Fulbright — 2026",
      current_fellowship_name: "Fulbright",
    });
    const normalized = normalizeAuditRow(row);
    expect(normalized.summary).toBeNull();
    expect(normalized.changes).toEqual([
      { field: "meeting_date", label: "Meeting date", oldValue: "—", newValue: "2026-09-21" },
      { field: "application_id", label: "Application", oldValue: "—", newValue: "Fulbright — 2026" },
      { field: "advisor_id", label: "Conducting advisor", oldValue: "—", newValue: "Advisor #12" },
    ]);
  });

  it("uses a neutral Application #id fallback when the parent label is unproven", () => {
    const row = makeAuditRow({
      entity_type: "advising_meeting_amendment",
      action: "correction_added",
      changes: null,
      advising_application_id: 8,
      subject_application_name: null,
      advising_advisor_id: null,
      advising_meeting_date: null,
    });
    expect(normalizeAuditRow(row).changes).toEqual([
      { field: "application_id", label: "Application", oldValue: "—", newValue: "Application #8" },
    ]);
  });
});

describe("closed entity/action fail-closed behavior", () => {
  it("omits changes and reason for an unknown entity type", () => {
    const normalized = normalizeAuditRow(
      makeAuditRow({ entity_type: "mystery", action: "updated", changes: { gpa: { old: 1, new: 2 } }, reason: "x" })
    );
    expect(normalized.entityLabel).toBe("Unknown record");
    expect(normalized.changes).toEqual([]);
    expect(normalized.summary).toBeNull();
  });

  it("omits changes and reason for an unknown action", () => {
    const normalized = normalizeAuditRow(
      makeAuditRow({ entity_type: "student", action: "mystery", changes: { gpa: { old: 1, new: 2 } }, reason: "x" })
    );
    expect(normalized.changes).toEqual([]);
    expect(normalized.summary).toBeNull();
  });
});

describe("auditActionLabel / auditEntityLabel", () => {
  it("maps known lifecycle actions to friendly labels", () => {
    expect(auditActionLabel("created")).toBe("Created");
    expect(auditActionLabel("updated")).toBe("Updated");
    expect(auditActionLabel("archived")).toBe("Archived");
    expect(auditActionLabel("restored")).toBe("Restored");
    expect(auditActionLabel("deactivated")).toBe("Advisor Deactivated");
    expect(auditActionLabel("reactivated")).toBe("Advisor Reactivated");
    expect(auditActionLabel("role_changed")).toBe("Role Changed");
    expect(auditActionLabel("correction_added")).toBe("Correction Added");
    expect(auditActionLabel("voided")).toBe("Voided");
    expect(auditActionLabel("baseline_captured")).toBe("Legacy State Captured");
  });

  it("is case-insensitive for known actions and fails closed for unknown verbs", () => {
    expect(auditActionLabel("INSERT")).toBe("Created");
    expect(auditActionLabel("Archived")).toBe("Archived");
    expect(auditActionLabel("some_new_verb")).toBe("Change");
  });

  it("labels known entity types and fails closed for unknown ones", () => {
    expect(auditEntityLabel("student")).toBe("Student");
    expect(auditEntityLabel("advising_meeting_amendment")).toBe("Advising Meeting Amendment");
    expect(auditEntityLabel("mystery")).toBe("Unknown record");
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
  function change(field: string, oldValue = "No", newValue = "Yes"): AuditChange {
    return { field, label: field, oldValue, newValue };
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

  it("strips the redundant finalist flags ONLY when a consistent stage change exists", () => {
    const items = [
      item({
        id: "stage-flow",
        changes: [
          change("stage_of_application", "Submitted", "Finalist"),
          change("is_finalist", "No", "Yes"),
          change("is_semi_finalist", "No", "Yes"),
          change("major"),
        ],
      }),
    ];
    const [visible] = visibleAuditItems(items);
    expect(visible.changes?.map((c) => c.field)).toEqual(["stage_of_application", "major"]);
  });

  it("keeps an explicitly recognized inconsistent-state diagnostic", () => {
    const items = [
      item({
        id: "diagnostic",
        changes: [
          change("stage_of_application", "Submitted", "Finalist"),
          change("is_finalist", "No", "No"),
          change("is_semi_finalist", "No", "Yes"),
        ],
      }),
    ];
    const [visible] = visibleAuditItems(items);
    expect(visible.changes?.map((c) => c.field)).toEqual([
      "stage_of_application",
      "is_finalist",
      "is_semi_finalist",
    ]);
  });

  it("keeps finalist flags when there is NO stage_of_application change", () => {
    const items = [
      item({ id: "direct-flag", changes: [change("is_finalist"), change("is_semi_finalist")] }),
      item({ id: "entry-ascent", action: "stage_changed", changes: [] }),
    ];
    expect(visibleAuditItems(items)).toEqual(items);
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
