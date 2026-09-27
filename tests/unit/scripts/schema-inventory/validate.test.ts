/**
 * tests/unit/scripts/schema-inventory/validate.test.ts
 *
 * Input-safety unit tests for the schema inventory utility:
 *   - loopback-only DB URL guard (no hosted/shared capture);
 *   - rejection of non-catalog / data-bearing keys anywhere in a packet;
 *   - strict structural validation (format version, source, sections,
 *     per-section fields, primitive values only);
 *   - incomplete packets FAIL CLOSED (every catalog section required);
 *   - raw SQL fields rejected (only structural + *Hash fields allowed);
 *   - disposition manifest validation.
 */

import { describe, expect, it } from "vitest";
import {
  CATALOG_SECTIONS,
  INVENTORY_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSION,
} from "../../../../scripts/schema-inventory/types";
import {
  InventoryValidationError,
  SECTION_FIELDS,
  FIELD_TYPES,
  assertLoopbackDbUrl,
  assertNoProhibitedKeys,
  isLoopbackDbUrl,
  parseDispositionManifest,
  parseInventoryPacket,
  validateDispositionManifest,
  validateInventoryPacket,
} from "../../../../scripts/schema-inventory/validate";

function emptySections(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const section of CATALOG_SECTIONS) out[section] = [];
  return out;
}

interface PacketLike {
  formatVersion: number;
  source: string;
  capturedAt: string;
  catalog: Record<string, unknown>;
}

function validPacket(): PacketLike {
  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    source: "remote",
    capturedAt: "2026-09-25T00:00:00.000Z",
    catalog: {
      ...emptySections(),
      migrationLedger: [
        {
          identity: "20260318000001",
          source: "supabase_migrations.schema_migrations",
          fields: { version: "20260318000001", name: "advisor_self_activation_lockdown" },
        },
      ],
      tables: [
        {
          identity: "public.advisor",
          source: "pg_class: public.advisor",
          fields: { schema: "public", name: "advisor", kind: "table", persistence: "p" },
        },
      ],
      columns: [
        {
          identity: "public.advisor.advisor_id",
          source: "pg_attribute: public.advisor.advisor_id",
          fields: {
            schema: "public",
            table: "advisor",
            name: "advisor_id",
            ordinal: 1,
            dataType: "integer",
            nullable: false,
            defaultHash: "ab".repeat(32),
            generated: "",
          },
        },
      ],
    },
  };
}

describe("loopback DB URL guard", () => {
  it("accepts loopback postgres URLs", () => {
    expect(isLoopbackDbUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(true);
    expect(isLoopbackDbUrl("postgres://postgres:postgres@localhost:54322/postgres")).toBe(true);
    expect(isLoopbackDbUrl("postgresql://postgres:postgres@[::1]:54322/postgres")).toBe(true);
  });

  it("rejects hosted / shared / non-loopback postgres URLs", () => {
    expect(isLoopbackDbUrl("postgresql://postgres:secret@db.internal.supabase.co:5432/postgres")).toBe(false);
    expect(isLoopbackDbUrl("postgresql://postgres:secret@10.0.0.5:5432/postgres")).toBe(false);
    expect(isLoopbackDbUrl("postgresql://postgres:secret@172.16.0.2:5432/postgres")).toBe(false);
    expect(isLoopbackDbUrl("postgresql://postgres:secret@example.com:5432/postgres")).toBe(false);
  });

  it("rejects non-postgres protocols and malformed URLs", () => {
    expect(isLoopbackDbUrl("http://127.0.0.1:54321")).toBe(false);
    expect(isLoopbackDbUrl("postgresql://user@127.0.0.1:54322/db extra")).toBe(false);
    expect(isLoopbackDbUrl("")).toBe(false);
    expect(isLoopbackDbUrl("not a url")).toBe(false);
  });

  it("assertLoopbackDbUrl throws a generic, secret-free error for hosted URLs", () => {
    const hosted = "postgresql://postgres:super-secret-password@db.internal.supabase.co:5432/postgres";
    expect(() => assertLoopbackDbUrl(hosted)).toThrow(InventoryValidationError);
    let message = "";
    try {
      assertLoopbackDbUrl(hosted);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toContain("super-secret-password");
    expect(message).toContain("loopback");
  });
});

describe("prohibited data-bearing / credential keys", () => {
  it("rejects row-data-shaped keys at the top level", () => {
    const bad = { ...validPacket(), rows: [{ id: 1 }] };
    expect(() => validateInventoryPacket(bad)).toThrow(/rows/);
  });

  it("rejects credential-shaped keys at any depth", () => {
    const bad = {
      ...validPacket(),
      catalog: {
        ...validPacket().catalog,
        tables: [
          {
            identity: "public.advisor",
            source: "pg_class: public.advisor",
            fields: { schema: "public", name: "advisor", kind: "table", persistence: "p" },
            password: "hunter2",
          },
        ],
      },
    };
    expect(() => validateInventoryPacket(bad)).toThrow(/password/);
  });

  it("rejects non-catalog top-level keys", () => {
    const bad = { ...validPacket(), extra: true };
    expect(() => validateInventoryPacket(bad)).toThrow(/top-level key "extra"/);
  });

  it("rejects non-catalog catalog-section keys", () => {
    const bad = {
      ...validPacket(),
      catalog: { ...validPacket().catalog, users: [] },
    };
    expect(() => validateInventoryPacket(bad)).toThrow(/catalog key "users"/);
  });

  it("rejects unknown fields inside a record", () => {
    const packet = validPacket();
    const tables = packet.catalog.tables as Record<string, unknown>[];
    tables[0].fields = {
      schema: "public",
      name: "advisor",
      kind: "table",
      persistence: "p",
      sample_rows: 5,
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/sample_rows/);
  });

  it("rejects non-primitive field values", () => {
    const packet = validPacket();
    const tables = packet.catalog.tables as Record<string, unknown>[];
    tables[0].fields = {
      schema: "public",
      name: "advisor",
      kind: { nested: true },
      persistence: "p",
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/must be a string/);
  });

  it("accepts a well-formed packet", () => {
    expect(() => validateInventoryPacket(validPacket())).not.toThrow();
  });

  it("assertNoProhibitedKeys reports a precise path", () => {
    expect(() => assertNoProhibitedKeys({ a: { b: { data: [1] } } }, "$")).toThrow(/\$\.a\.b\.data/);
  });
});

describe("incomplete packets fail closed (all sections required)", () => {
  it("rejects a packet missing a catalog section", () => {
    const bad = validPacket();
    delete bad.catalog.grants;
    expect(() => validateInventoryPacket(bad)).toThrow(/grants.*missing/);
  });

  it("rejects a packet missing the new expanded sections", () => {
    for (const missing of ["sequences", "views", "extensions", "schemaPrivileges", "defaultPrivileges"]) {
      const bad = validPacket();
      delete bad.catalog[missing];
      expect(() => validateInventoryPacket(bad)).toThrow(new RegExp(`${missing}.*missing`));
    }
  });
});

describe("raw SQL fields are rejected (PII-safe packets)", () => {
  it("rejects a raw constraint definition field", () => {
    const packet = validPacket();
    (packet.catalog.constraints as Record<string, unknown>[]) = [
      {
        identity: "public.student.student_gpa_check",
        source: "pg_constraint: public.student.student_gpa_check",
        fields: { schema: "public", table: "student", name: "student_gpa_check", type: "CHECK", definition: "CHECK ((gpa IS NULL) OR ((gpa >= 0.00) AND (gpa <= 4.00)))" },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/definition/);
  });

  it("rejects a raw column default field", () => {
    const packet = validPacket();
    const cols = packet.catalog.columns as Record<string, unknown>[];
    cols[0].fields = {
      schema: "public",
      table: "advisor",
      name: "advisor_id",
      ordinal: 1,
      dataType: "integer",
      nullable: false,
      default: "nextval('advisor_advisor_id_seq'::regclass)",
      generated: "",
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/default/);
  });

  it("accepts hash-only records", () => {
    const packet = validPacket();
    (packet.catalog.constraints as Record<string, unknown>[]) = [
      {
        identity: "public.student.student_gpa_check",
        source: "pg_constraint: public.student.student_gpa_check",
        fields: {
          schema: "public",
          table: "student",
          name: "student_gpa_check",
          type: "CHECK",
          definitionHash: "ab".repeat(32),
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).not.toThrow();
  });
});

describe("*Hash fields are exactly lowercase 64-char SHA-256 hex", () => {
  it("rejects a hash field containing raw SQL", () => {
    const packet = validPacket();
    (packet.catalog.constraints as Record<string, unknown>[]) = [
      {
        identity: "public.student.student_gpa_check",
        source: "pg_constraint: public.student.student_gpa_check",
        fields: {
          schema: "public",
          table: "student",
          name: "student_gpa_check",
          type: "CHECK",
          definitionHash: "CHECK (gpa >= 0 AND gpa <= 4)",
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/64-char SHA-256/);
  });

  it("rejects a hash field containing an email address", () => {
    const packet = validPacket();
    const cols = packet.catalog.columns as Record<string, unknown>[];
    cols[0].fields = {
      schema: "public",
      table: "advisor",
      name: "email",
      ordinal: 1,
      dataType: "text",
      nullable: true,
      defaultHash: "advisor@example.com",
      generated: "",
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/64-char SHA-256/);
  });

  it("rejects a hash field containing a credential-free URL", () => {
    const packet = validPacket();
    (packet.catalog.policies as Record<string, unknown>[]) = [
      {
        identity: "public.advisor.p",
        source: "pg_policy: public.advisor.p",
        fields: {
          schema: "public",
          table: "advisor",
          name: "p",
          command: "SELECT",
          roles: ["authenticated"],
          permissive: true,
          usingHash: "https://example.com/path",
          withCheckHash: null,
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/64-char SHA-256/);
  });

  it("rejects a hash field containing a secret-shaped value", () => {
    const packet = validPacket();
    const cols = packet.catalog.columns as Record<string, unknown>[];
    cols[0].fields = {
      schema: "public",
      table: "advisor",
      name: "secret_col",
      ordinal: 1,
      dataType: "text",
      nullable: true,
      defaultHash: "sb_secret_local_key_abcdef123456",
      generated: "",
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/64-char SHA-256/);
  });

  it("rejects non-lowercase or wrong-length hex in hash fields", () => {
    const packet = validPacket();
    (packet.catalog.constraints as Record<string, unknown>[]) = [
      {
        identity: "public.student.student_gpa_check",
        source: "pg_constraint: public.student.student_gpa_check",
        fields: {
          schema: "public",
          table: "student",
          name: "student_gpa_check",
          type: "CHECK",
          definitionHash: "AB".repeat(32), // uppercase hex rejected
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/64-char SHA-256/);

    const short = validPacket();
    (short.catalog.constraints as Record<string, unknown>[]) = [
      {
        identity: "public.student.student_gpa_check",
        source: "pg_constraint: public.student.student_gpa_check",
        fields: {
          schema: "public",
          table: "student",
          name: "student_gpa_check",
          type: "CHECK",
          definitionHash: "ab".repeat(31), // 62 chars
        },
      },
    ];
    expect(() => validateInventoryPacket(short)).toThrow(/64-char SHA-256/);
  });

  it("allows null for nullable hash fields (defaultHash/usingHash/withCheckHash)", () => {
    const packet = validPacket();
    const cols = packet.catalog.columns as Record<string, unknown>[];
    cols[0].fields = {
      schema: "public",
      table: "advisor",
      name: "email",
      ordinal: 1,
      dataType: "text",
      nullable: true,
      defaultHash: null,
      generated: "",
    };
    expect(() => validateInventoryPacket(packet)).not.toThrow();
  });
});

describe("structural field types are validated", () => {
  it("rejects a boolean field carrying a string", () => {
    const packet = validPacket();
    const tables = packet.catalog.tables as Record<string, unknown>[];
    tables[0].fields = { schema: "public", name: "advisor", kind: "table", persistence: "p" };
    (packet.catalog.rls as Record<string, unknown>[]) = [
      {
        identity: "public.advisor",
        source: "pg_class(relrowsecurity): public.advisor",
        fields: { schema: "public", table: "advisor", enabled: "yes", forced: false },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/must be a boolean/);
  });

  it("rejects a numeric field carrying a string", () => {
    const packet = validPacket();
    const cols = packet.catalog.columns as Record<string, unknown>[];
    cols[0].fields = {
      schema: "public",
      table: "advisor",
      name: "advisor_id",
      ordinal: "one",
      dataType: "integer",
      nullable: false,
      defaultHash: "ab".repeat(32),
      generated: "",
    };
    expect(() => validateInventoryPacket(packet)).toThrow(/must be a finite number/);
  });

  it("rejects a string-array field carrying a non-array", () => {
    const packet = validPacket();
    (packet.catalog.functions as Record<string, unknown>[]) = [
      {
        identity: "public.is_active_advisor()",
        source: "pg_proc: public.is_active_advisor()",
        fields: {
          schema: "public",
          name: "is_active_advisor",
          signature: "",
          returnType: "boolean",
          language: "sql",
          volatility: "s",
          securityMode: "DEFINER",
          searchPath: "public",
          acl: ["authenticated=X"],
          bodyHash: "ab".repeat(32),
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/array of strings/);
  });

  it("rejects a string-array field containing a non-string", () => {
    const packet = validPacket();
    (packet.catalog.functions as Record<string, unknown>[]) = [
      {
        identity: "public.is_active_advisor()",
        source: "pg_proc: public.is_active_advisor()",
        fields: {
          schema: "public",
          name: "is_active_advisor",
          signature: "",
          returnType: "boolean",
          language: "sql",
          volatility: "s",
          securityMode: "DEFINER",
          searchPath: [],
          acl: ["authenticated=X", 42],
          bodyHash: "ab".repeat(32),
        },
      },
    ];
    expect(() => validateInventoryPacket(packet)).toThrow(/array of strings/);
  });
});

describe("SECTION_FIELDS / FIELD_TYPES consistency", () => {
  it("declares a type for every allowed field in every section", () => {
    for (const section of CATALOG_SECTIONS) {
      for (const field of SECTION_FIELDS[section]) {
        expect(FIELD_TYPES[section][field], `${section}.${field} has a declared type`).toBeDefined();
      }
    }
  });
});

describe("structural packet validation", () => {
  it("rejects non-JSON input", () => {
    expect(() => parseInventoryPacket("not json")).toThrow(InventoryValidationError);
  });

  it("rejects non-object input", () => {
    expect(() => validateInventoryPacket([1, 2, 3])).toThrow(/JSON object/);
  });

  it("rejects unsupported formatVersion", () => {
    const bad = { ...validPacket(), formatVersion: 99 };
    expect(() => validateInventoryPacket(bad)).toThrow(/formatVersion/);
  });

  it("rejects invalid source", () => {
    const bad = { ...validPacket(), source: "production" };
    expect(() => validateInventoryPacket(bad)).toThrow(/source/);
  });

  it("rejects missing capturedAt", () => {
    const bad = validPacket() as unknown as Record<string, unknown>;
    delete bad.capturedAt;
    expect(() => validateInventoryPacket(bad)).toThrow(/capturedAt/);
  });

  it("rejects records missing identity or source", () => {
    const bad = validPacket();
    delete (bad.catalog.tables as Record<string, unknown>[])[0].identity;
    expect(() => validateInventoryPacket(bad)).toThrow(/identity/);
  });

  it("parseInventoryPacket round-trips a serialized packet", () => {
    const parsed = parseInventoryPacket(JSON.stringify(validPacket()));
    expect(parsed.source).toBe("remote");
    expect(parsed.catalog.tables).toHaveLength(1);
    expect(CATALOG_SECTIONS.length).toBeGreaterThanOrEqual(16);
  });
});

describe("disposition manifest validation", () => {
  function validManifest(): Record<string, unknown> {
    return {
      formatVersion: MANIFEST_FORMAT_VERSION,
      reviewed: [
        {
          section: "tables",
          identity: "public.audit_log",
          disposition: "remote-only intended",
          reason: "production audit log, not in the migration chain",
        },
      ],
    };
  }

  it("accepts a well-formed manifest", () => {
    expect(() => validateDispositionManifest(validManifest())).not.toThrow();
    const parsed = parseDispositionManifest(JSON.stringify(validManifest()));
    expect(parsed.reviewed).toHaveLength(1);
    expect(parsed.reviewed[0].disposition).toBe("remote-only intended");
  });

  it("rejects invalid dispositions (auto-labeling is not allowed)", () => {
    const bad = validManifest();
    (bad.reviewed as Record<string, unknown>[])[0].disposition = "conflict";
    expect(() => validateDispositionManifest(bad)).toThrow(/disposition/);
  });

  it("rejects unknown sections and empty identities", () => {
    const badSection = validManifest();
    (badSection.reviewed as Record<string, unknown>[])[0].section = "accounts";
    expect(() => validateDispositionManifest(badSection)).toThrow(/section/);

    const badIdentity = validManifest();
    (badIdentity.reviewed as Record<string, unknown>[])[0].identity = "";
    expect(() => validateDispositionManifest(badIdentity)).toThrow(/identity/);
  });

  it("rejects unknown manifest keys", () => {
    const bad = { ...validManifest(), notes: "x" };
    expect(() => validateDispositionManifest(bad)).toThrow(/notes/);
  });
});