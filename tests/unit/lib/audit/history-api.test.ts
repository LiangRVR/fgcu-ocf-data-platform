/**
 * tests/unit/lib/audit/history-api.test.ts
 *
 * Client-safe audit-history transport contract:
 *
 *   - cursor tokens round-trip exactly (timestamp preserved verbatim for
 *     microsecond-precision keyset tie-breaks) and reject anything malformed or
 *     containing PostgREST filter delimiters, so a crafted cursor can never
 *     inject an `.or(...)` expression;
 *   - history descriptors (entity/student/application) serialize and parse
 *     round-trip, and the parser is strict: unknown kinds, bad/oversized ids,
 *     empty application id lists, and non-snake entity types are all rejected.
 */
import { describe, expect, it } from "vitest";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  parseEntityHistoryQuery,
  serializeEntityHistoryQuery,
  type EntityHistoryQuery,
} from "@/lib/audit/history-api";

describe("audit cursor encode/decode", () => {
  it("round-trips a cursor, preserving the exact timestamp", () => {
    const cursor = { occurredAt: "2026-10-12T14:30:00.123456+00:00", auditId: 42 };
    const token = encodeAuditCursor(cursor);
    expect(token).toBe("42.2026-10-12T14:30:00.123456+00:00");
    expect(decodeAuditCursor(token)).toEqual(cursor);
  });

  it("returns null for an absent cursor", () => {
    expect(encodeAuditCursor(null)).toBeNull();
    expect(encodeAuditCursor(undefined)).toBeNull();
    expect(decodeAuditCursor(null)).toBeNull();
    expect(decodeAuditCursor("")).toBeNull();
  });

  it("rejects malformed audit ids and timestamps", () => {
    expect(encodeAuditCursor({ occurredAt: "2026-10-12T14:30:00.000Z", auditId: 0 })).toBeNull();
    expect(encodeAuditCursor({ occurredAt: "2026-10-12T14:30:00.000Z", auditId: -3 })).toBeNull();
    expect(encodeAuditCursor({ occurredAt: "not-a-date", auditId: 1 })).toBeNull();
    expect(decodeAuditCursor("abc")).toBeNull();
    expect(decodeAuditCursor("1.not-a-date")).toBeNull();
    expect(decodeAuditCursor("0.2026-10-12T14:30:00.000Z")).toBeNull();
  });

  it("rejects tokens carrying PostgREST filter delimiters (no .or injection)", () => {
    for (const hostile of [
      '1.2026-10-12T14:30:00.000Z"',
      '1.2026-10-12T14:30:00.000Z,audit_id.gt.0',
      "1.2026-10-12T14:30:00.000Z)",
      "1.2026-10-12T14:30:00.000Z(",
      "1.2026-10-12T14:30:00Z%2C",
    ]) {
      expect(decodeAuditCursor(hostile)).toBeNull();
    }
  });
});

describe("history descriptor serialize/parse", () => {
  it("round-trips every descriptor kind", () => {
    const descriptors: EntityHistoryQuery[] = [
      { kind: "entity", entityType: "advising_meeting_amendment", entityId: 9 },
      { kind: "student", studentId: 42 },
      { kind: "application", applicationIds: [4, 7] },
    ];
    for (const descriptor of descriptors) {
      expect(parseEntityHistoryQuery(serializeEntityHistoryQuery(descriptor))).toEqual(descriptor);
    }
  });

  it("deduplicates application ids and preserves positive ones", () => {
    const params = new URLSearchParams("kind=application&applicationIds=4,4,7");
    expect(parseEntityHistoryQuery(params)).toEqual({
      kind: "application",
      applicationIds: [4, 7],
    });
  });

  it("rejects unknown kinds and malformed descriptors", () => {
    expect(parseEntityHistoryQuery(new URLSearchParams("kind=everything"))).toBeNull();
    expect(parseEntityHistoryQuery(new URLSearchParams(""))).toBeNull();
    expect(parseEntityHistoryQuery(new URLSearchParams("kind=entity&entityId=3"))).toBeNull();
    expect(
      parseEntityHistoryQuery(new URLSearchParams("kind=entity&entityType=Student&entityId=3"))
    ).toBeNull();
    expect(
      parseEntityHistoryQuery(new URLSearchParams("kind=entity&entityType=student&entityId=0"))
    ).toBeNull();
    expect(parseEntityHistoryQuery(new URLSearchParams("kind=student"))).toBeNull();
    expect(parseEntityHistoryQuery(new URLSearchParams("kind=application"))).toBeNull();
    expect(
      parseEntityHistoryQuery(new URLSearchParams("kind=application&applicationIds=,,"))
    ).toBeNull();
  });

  it("bounds the number of application ids", () => {
    const many = Array.from({ length: 101 }, (_, index) => index + 1).join(",");
    expect(
      parseEntityHistoryQuery(new URLSearchParams(`kind=application&applicationIds=${many}`))
    ).toBeNull();
  });
});
