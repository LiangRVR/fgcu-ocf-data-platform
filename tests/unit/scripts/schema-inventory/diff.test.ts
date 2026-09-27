/**
 * tests/unit/scripts/schema-inventory/diff.test.ts
 *
 * Determinism and classification contract for the diff engine:
 * exactly `equivalent`, `remote-only intended`, `local-only missing`,
 * `conflict`, `unknown`, with fail-closed blocking for conflict/unknown.
 *
 * Review remediation: unmatched objects are `unknown` and block UNLESS a
 * reviewed disposition manifest explicitly authorizes `remote-only intended`
 * / `local-only missing`. The engine never auto-labels.
 */

import { describe, expect, it } from "vitest";
import {
  assertNoBlocking,
  diffInventories,
  SchemaDiffBlockedError,
  stableStringify,
} from "../../../../scripts/schema-inventory/diff";
import {
  INVENTORY_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSION,
  type CatalogRecord,
  type CatalogSection,
  type DispositionManifest,
  type SchemaInventory,
} from "../../../../scripts/schema-inventory/types";

function makeInventory(
  catalog: Partial<Record<CatalogSection, CatalogRecord[]>>,
  source: "remote" | "local" = "remote"
): SchemaInventory {
  const empty = {} as Record<CatalogSection, CatalogRecord[]>;
  for (const section of [
    "migrationLedger",
    "tables",
    "columns",
    "constraints",
    "foreignKeys",
    "indexes",
    "sequences",
    "views",
    "functions",
    "triggers",
    "rls",
    "policies",
    "grants",
    "schemaPrivileges",
    "defaultPrivileges",
    "extensions",
  ] as const) {
    empty[section] = catalog[section] ?? [];
  }
  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    source,
    capturedAt: "2026-09-25T00:00:00.000Z",
    catalog: empty,
  };
}

const advisorTable: CatalogRecord = {
  identity: "public.advisor",
  source: "pg_class: public.advisor",
  fields: { schema: "public", name: "advisor", kind: "table", persistence: "p" },
};

function manifest(entries: DispositionManifest["reviewed"]): DispositionManifest {
  return { formatVersion: MANIFEST_FORMAT_VERSION, reviewed: entries };
}

describe("stableStringify", () => {
  it("serializes with sorted keys for deterministic comparison", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: [3, 1, 2] })).toBe(`{"a":[3,1,2]}`);
  });
});

describe("diffInventories classification", () => {
  it("classifies identical objects as equivalent", () => {
    const remote = makeInventory({ tables: [advisorTable] });
    const local = makeInventory({ tables: [advisorTable] }, "local");
    const register = diffInventories(remote, local);
    expect(register.blocked).toBe(false);
    expect(register.summary.equivalent).toBe(1);
    expect(register.entries[0]).toMatchObject({
      section: "tables",
      identity: "public.advisor",
      disposition: "equivalent",
    });
  });

  it("classifies remote-only objects WITHOUT manifest authorization as unknown (blocks)", () => {
    const remote = makeInventory({ tables: [advisorTable] });
    const local = makeInventory({}, "local");
    const register = diffInventories(remote, local);
    expect(register.blocked).toBe(true);
    expect(register.summary.unknown).toBe(1);
    expect(register.summary["remote-only intended"]).toBe(0);
    expect(register.entries[0].disposition).toBe("unknown");
    expect(register.entries[0].reason).toContain("not covered by a reviewed disposition manifest");
  });

  it("classifies remote-only objects as remote-only intended ONLY with manifest authorization", () => {
    const remote = makeInventory({ tables: [advisorTable] });
    const local = makeInventory({}, "local");
    const register = diffInventories(remote, local, manifest([
      { section: "tables", identity: "public.advisor", disposition: "remote-only intended" },
    ]));
    expect(register.blocked).toBe(false);
    expect(register.entries[0].disposition).toBe("remote-only intended");
  });

  it("classifies local-only objects WITHOUT manifest authorization as unknown (blocks)", () => {
    const remote = makeInventory({}, "remote");
    const local = makeInventory({ tables: [advisorTable] }, "local");
    const register = diffInventories(remote, local);
    expect(register.blocked).toBe(true);
    expect(register.summary.unknown).toBe(1);
    expect(register.summary["local-only missing"]).toBe(0);
    expect(register.entries[0].disposition).toBe("unknown");
  });

  it("classifies local-only objects as local-only missing ONLY with manifest authorization", () => {
    const remote = makeInventory({}, "remote");
    const local = makeInventory({ tables: [advisorTable] }, "local");
    const register = diffInventories(remote, local, manifest([
      { section: "tables", identity: "public.advisor", disposition: "local-only missing" },
    ]));
    expect(register.blocked).toBe(false);
    expect(register.entries[0].disposition).toBe("local-only missing");
  });

  it("does not honor a manifest entry with the WRONG direction for the object side", () => {
    // Remote-only object but manifest authorizes "local-only missing":
    // direction mismatch => still unknown.
    const remote = makeInventory({ tables: [advisorTable] });
    const local = makeInventory({}, "local");
    const register = diffInventories(remote, local, manifest([
      { section: "tables", identity: "public.advisor", disposition: "local-only missing" },
    ]));
    expect(register.blocked).toBe(true);
    expect(register.entries[0].disposition).toBe("unknown");
  });

  it("classifies differing objects as conflict and blocks", () => {
    const remote = makeInventory({
      tables: [{ ...advisorTable, fields: { ...advisorTable.fields, persistence: "p" } }],
    });
    const local = makeInventory(
      {
        tables: [{ ...advisorTable, fields: { ...advisorTable.fields, persistence: "u" } }],
      },
      "local"
    );
    const register = diffInventories(remote, local);
    expect(register.blocked).toBe(true);
    expect(register.summary.conflict).toBe(1);
    expect(register.entries[0]).toMatchObject({
      disposition: "conflict",
      reason: expect.stringContaining("differ"),
    });
  });

  it("classifies duplicate identities as unknown and blocks", () => {
    const remote = makeInventory({
      tables: [advisorTable, { ...advisorTable, source: "second" }],
    });
    const local = makeInventory({}, "local");
    const register = diffInventories(remote, local);
    expect(register.blocked).toBe(true);
    expect(register.summary.unknown).toBe(1);
    expect(register.entries[0].disposition).toBe("unknown");
  });

  it("orders entries by section then identity for determinism", () => {
    const remote = makeInventory({
      tables: [advisorTable],
      functions: [
        {
          identity: "public.is_active_advisor()",
          source: "pg_proc: public.is_active_advisor()",
          fields: { schema: "public", name: "is_active_advisor", signature: "" },
        },
      ],
    });
    const local = makeInventory({}, "local");
    const register = diffInventories(remote, local, manifest([
      { section: "tables", identity: "public.advisor", disposition: "remote-only intended" },
      { section: "functions", identity: "public.is_active_advisor()", disposition: "remote-only intended" },
    ]));
    expect(register.entries.map((e) => e.section)).toEqual(["functions", "tables"]);
  });

  it("is deterministic: identical inputs produce identical registers", () => {
    const remote = makeInventory({
      tables: [advisorTable],
      columns: [
        {
          identity: "public.advisor.advisor_id",
          source: "pg_attribute: public.advisor.advisor_id",
          fields: { schema: "public", table: "advisor", name: "advisor_id", ordinal: 1 },
        },
      ],
    });
    const local = makeInventory(
      {
        tables: [{ ...advisorTable, fields: { ...advisorTable.fields, kind: "partitioned" } }],
      },
      "local"
    );
    const m = manifest([
      { section: "columns", identity: "public.advisor.advisor_id", disposition: "remote-only intended" },
    ]);
    const a = diffInventories(remote, local, m);
    const b = diffInventories(remote, local, m);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe("assertNoBlocking (fail closed)", () => {
  it("returns the register when nothing blocks", () => {
    const register = diffInventories(
      makeInventory({ tables: [advisorTable] }),
      makeInventory({ tables: [advisorTable] }, "local")
    );
    expect(assertNoBlocking(register)).toBe(register);
  });

  it("throws SchemaDiffBlockedError for conflict", () => {
    const register = diffInventories(
      makeInventory({ tables: [advisorTable] }),
      makeInventory(
        { tables: [{ ...advisorTable, fields: { ...advisorTable.fields, kind: "partitioned" } }] },
        "local"
      )
    );
    expect(() => assertNoBlocking(register)).toThrow(SchemaDiffBlockedError);
  });

  it("throws SchemaDiffBlockedError for an unmatched object without manifest authorization", () => {
    const register = diffInventories(
      makeInventory({ tables: [advisorTable, { ...advisorTable, source: "dup" }] }),
      makeInventory({}, "local")
    );
    expect(() => assertNoBlocking(register)).toThrow(SchemaDiffBlockedError);
  });
});