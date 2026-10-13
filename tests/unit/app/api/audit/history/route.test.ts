/**
 * tests/unit/app/api/audit/history/route.test.ts
 *
 * Contract for the server-only paginated SAFE audit-history endpoint:
 *
 *   GET /api/audit/history?kind=...&<descriptor>&limit=&cursor=&watermark=
 *
 *   - unauthenticated callers get 401; malformed descriptors/cursors get 400;
 *   - a valid request returns ONLY safe `AuditActivity` fields — raw snapshot
 *     payload columns (`old_values`/`new_values`), unknown diff fields, and
 *     Auth-binding ids never appear in the JSON body (the browser can no longer
 *     read `audit_activity select('*')`);
 *   - the request is a single bounded query (no N+1) whose continuation uses
 *     the keyset cursor + high-watermark bounds, not an offset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUser } = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser }));

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient }));

import { GET } from "@/app/api/audit/history/route";
import type { AuditRow } from "@/lib/audit/presentation";

const SECRET_OLD = "secret-old@example.com";
const SECRET_NEW = "secret-new@example.com";
const SECRET_DIFF = "internal-secret-note";

function makeAuditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    action: "updated",
    actor_advisor_id: 12,
    actor_name_snapshot: "Jordan Lee",
    audit_id: 77,
    changes: { gpa: { old: 3.0, new: 3.4 }, internal_note: { old: SECRET_DIFF, new: SECRET_DIFF } },
    entity_id: 7,
    entity_type: "advisor",
    fellowship_name: null,
    new_values: { email: SECRET_NEW },
    occurred_at: "2026-10-12T14:30:00.000Z",
    old_values: { email: SECRET_OLD },
    origin: "api",
    reason: "Promoted",
    student_name: "Sam Student",
    subject_application_id: 5,
    subject_fellowship_id: null,
    subject_student_id: 3,
    ...overrides,
  };
}

interface QueryRecord {
  select: string | null;
  filters: Array<{ op: "eq" | "in"; column: string; value: unknown }>;
  ors: string[];
  orders: Array<{ column: string; ascending: boolean }>;
  range: [number, number] | null;
}

function makeSupabase(rows: AuditRow[]) {
  const calls: QueryRecord[] = [];
  const client = {
    from: vi.fn(() => {
      const record: QueryRecord = { select: null, filters: [], ors: [], orders: [], range: null };
      calls.push(record);
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (columns: string) => ((record.select = columns), builder),
        eq: (column: string, value: unknown) => (record.filters.push({ op: "eq", column, value }), builder),
        in: (column: string, value: unknown) => (record.filters.push({ op: "in", column, value }), builder),
        or: (expression: string) => (record.ors.push(expression), builder),
        order: (column: string, options: { ascending: boolean }) =>
          (record.orders.push({ column, ...options }), builder),
        range: (from: number, to: number) => {
          record.range = [from, to];
          return Promise.resolve({ data: rows, error: null });
        },
      });
      return builder;
    }),
  };
  createServerClient.mockReturnValue(client);
  return { client, calls };
}

function request(query: string): Request {
  return new Request(`http://localhost/api/audit/history${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue({ id: "user-1" });
});

describe("GET /api/audit/history authorization and validation", () => {
  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);
    makeSupabase([]);

    const response = await GET(request("?kind=entity&entityType=advisor&entityId=7"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("returns 400 for a malformed descriptor without querying", async () => {
    const { client } = makeSupabase([]);

    const response = await GET(request("?kind=everything"));
    expect(response.status).toBe(400);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed cursor without querying", async () => {
    const { client } = makeSupabase([]);

    const response = await GET(
      request("?kind=entity&entityType=advisor&entityId=7&cursor=not-a-cursor")
    );
    expect(response.status).toBe(400);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("returns 400 for an application query with no ids", async () => {
    const { client } = makeSupabase([]);
    const response = await GET(request("?kind=application&applicationIds=,,"));
    expect(response.status).toBe(400);
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe("GET /api/audit/history safe projection", () => {
  it("returns ONLY safe AuditActivity fields — no raw payload columns or secrets", async () => {
    makeSupabase([makeAuditRow()]);

    const response = await GET(request("?kind=entity&entityType=advisor&entityId=7"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "action",
      "actor",
      "changes",
      "entityLabel",
      "id",
      "occurredAt",
      "summary",
    ]);
    expect(body.items[0]).toMatchObject({
      id: "77",
      action: "updated",
      actor: "Jordan Lee",
      summary: "Promoted",
      changes: [{ field: "gpa", label: "GPA", oldValue: "3", newValue: "3.4" }],
    });

    const serialized = JSON.stringify(body);
    for (const secret of [
      SECRET_OLD,
      SECRET_NEW,
      SECRET_DIFF,
      "old_values",
      "new_values",
      "actor_advisor_id",
      "internal_note",
      "subject_application_id",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reads a single bounded query with the explicit safe columns", async () => {
    const { client, calls } = makeSupabase([makeAuditRow()]);

    await GET(request("?kind=entity&entityType=advisor&entityId=7&limit=5000"));

    expect(client.from).toHaveBeenCalledTimes(1);
    expect(calls[0].select).not.toContain("old_values");
    expect(calls[0].select).not.toContain("new_values");
    // Oversized limit is clamped to the hard ceiling.
    expect(calls[0].range).toEqual([0, 100]);
  });
});

describe("GET /api/audit/history keyset continuation", () => {
  it("applies the decoded cursor and high-watermark bounds (no offset)", async () => {
    const { calls } = makeSupabase([]);

    await GET(
      request(
        "?kind=student&studentId=42&limit=25&cursor=42.2026-10-12T14:30:00.000Z&watermark=99.2026-10-12T15:00:00.000Z"
      )
    );

    expect(calls[0].filters).toContainEqual({ op: "eq", column: "subject_student_id", value: 42 });
    expect(calls[0].ors).toEqual([
      'occurred_at.lt."2026-10-12T15:00:00.000Z",and(occurred_at.eq."2026-10-12T15:00:00.000Z",audit_id.lte.99)',
      'occurred_at.lt."2026-10-12T14:30:00.000Z",and(occurred_at.eq."2026-10-12T14:30:00.000Z",audit_id.lt.42)',
    ]);
    expect(calls[0].range).toEqual([0, 25]);
  });

  it("returns the page cursor/watermark metadata for the next load-more", async () => {
    makeSupabase([makeAuditRow({ audit_id: 77 }), makeAuditRow({ audit_id: 76 })]);

    const response = await GET(request("?kind=student&studentId=42&limit=1"));
    const body = (await response.json()) as {
      hasMore: boolean;
      nextCursor: unknown;
      highWatermark: unknown;
    };

    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toEqual({ occurredAt: "2026-10-12T14:30:00.000Z", auditId: 77 });
    expect(body.highWatermark).toEqual({ occurredAt: "2026-10-12T14:30:00.000Z", auditId: 77 });
  });
});
