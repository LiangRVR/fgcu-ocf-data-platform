/**
 * tests/unit/scripts/schema-inventory/capture.test.ts
 *
 * Local-capture safety and mapping tests:
 *   - catalog queries are read-only SELECTs over catalog tables only (never
 *     table-row queries, never DML);
 *   - `buildInventoryFromQueries` produces deterministic normalized records
 *     with NO function bodies and NO raw SQL expressions (only *Hash fields);
 *   - FK columns and search_path preserve catalog order;
 *   - trigger state preserves the raw catalog code;
 *   - effective ACLs include default PUBLIC grants;
 *   - packets are PII-safe (emails, URLs, quoted literals, secret-shaped
 *     values never appear raw);
 *   - the loopback guard is enforced before any connection is opened.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_QUERIES,
  buildInventoryFromQueries,
  captureLocalInventory,
  decodePostgresStringArray,
  decodeTriggerType,
  parsePostgresArrayLiteral,
} from "../../../../scripts/schema-inventory/capture";
import { sha256Hex } from "../../../../scripts/schema-inventory/normalize";
import { InventoryValidationError } from "../../../../scripts/schema-inventory/validate";
import { validateInventoryPacket } from "../../../../scripts/schema-inventory/validate";
import { toRedactedJson } from "../../../../scripts/schema-inventory/redact";

/** Build an inventory from a per-section row provider; unmatched sections are []. */
function buildWith(provider: (sql: string) => unknown[]) {
  return buildInventoryFromQueries(async (sql: string) => provider(sql) as never[]);
}

describe("catalog queries are read-only catalog SELECTs", () => {
  it("every query is a SELECT without DML", () => {
    for (const { section, sql } of CATALOG_QUERIES) {
      const trimmed = sql.trim().replace(/\s+/g, " ");
      expect(trimmed.startsWith("SELECT "), `${section} must be a SELECT`).toBe(true);
      expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b/i.test(trimmed)).toBe(false);
    }
  });

  it("only queries catalog/schema tables (never business row tables)", () => {
    const catalogSources = [
      "pg_catalog.",
      "pg_class",
      "pg_attribute",
      "pg_constraint",
      "pg_index",
      "pg_proc",
      "pg_trigger",
      "pg_policy",
      "pg_roles",
      "pg_language",
      "pg_namespace",
      "pg_attrdef",
      "pg_sequence",
      "pg_depend",
      "pg_extension",
      "pg_default_acl",
      "aclexplode",
      "acldefault",
      "unnest",
      "supabase_migrations.schema_migrations",
    ];
    for (const { section, sql } of CATALOG_QUERIES) {
      // No direct references to public.<business table> row data.
      expect(/\bpublic\.[a-z_]+/.test(sql), `${section} must not reference public.<table>`).toBe(false);
      // Every FROM/JOIN target is a catalog source (LATERAL is a keyword, not
      // a table).
      const sources = sql.match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi) ?? [];
      for (const source of sources) {
        const name = source.split(/\s+/)[1];
        if (name === "LATERAL" || name === "lateral") continue;
        const ok = catalogSources.some((s) => name.startsWith(s) || name === s.split(".")[0]);
        expect(ok, `${section}: unexpected source ${name}`).toBe(true);
      }
    }
  });

  it("covers every catalog section", () => {
    const sections = CATALOG_QUERIES.map((q) => q.section);
    for (const required of [
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
    ]) {
      expect(sections, `query for ${required}`).toContain(required);
    }
  });
});

describe("buildInventoryFromQueries", () => {
  it("builds a valid inventory with every section (packet validates)", async () => {
    const inventory = await buildWith(() => []);
    expect(() => validateInventoryPacket(inventory)).not.toThrow();
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
    ]) {
      expect(Array.isArray(inventory.catalog[section as keyof typeof inventory.catalog]), section).toBe(true);
    }
  });

  it("normalizes a minimal local catalog without row data, function bodies, or raw SQL", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("schema_migrations")) {
        return [{ version: "20260318000001", name: "advisor_self_activation_lockdown" }];
      }
      if (sql.includes("pg_proc") && sql.includes("proname")) {
        return [
          {
            schema: "public",
            name: "guard_advisor_auth_user_id_one_time_bind",
            signature: "",
            return_type: "trigger",
            language: "plpgsql",
            volatility: "v",
            security_mode: "INVOKER",
            config: ["search_path="],
            acl: ["=X/postgres", "postgres=X/postgres"],
            body: "BEGIN IF NEW.auth_user_id IS NULL THEN RETURN NEW; END IF; END;",
          },
        ];
      }
      return [];
    });

    const inventory = await buildInventoryFromQueries(runQuery);
    expect(inventory.source).toBe("local");
    expect(inventory.catalog.migrationLedger).toEqual([
      {
        identity: "20260318000001",
        source: "supabase_migrations.schema_migrations",
        fields: { version: "20260318000001", name: "advisor_self_activation_lockdown" },
      },
    ]);

    const fn = inventory.catalog.functions[0];
    expect(fn.identity).toContain("public.guard_advisor_auth_user_id_one_time_bind");
    expect(fn.fields.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    // Function body must never be present.
    expect(Object.values(fn.fields)).not.toContain(
      "BEGIN IF NEW.auth_user_id IS NULL THEN RETURN NEW; END IF; END;"
    );
    // Effective ACL preserves default PUBLIC EXECUTE (=X).
    expect(fn.fields.acl).toEqual(["=X", "postgres=X"]);
  });

  it("produces deterministic output for identical inputs", async () => {
    const rows = [
      {
        schema: "public",
        table: "advisor",
        name: "advisor_id",
        ordinal: 1,
        data_type: "integer",
        nullable: false,
        default_expr: "nextval('advisor_advisor_id_seq'::regclass)",
        generated: "",
      },
    ];
    const make = () =>
      buildInventoryFromQueries(async (sql: string) => (sql.includes("pg_attribute") ? rows : []));
    const a = await make();
    const b = await make();
    expect(JSON.stringify(a.catalog.columns)).toBe(JSON.stringify(b.catalog.columns));
  });

  it("normalizes FK actions, columns, and references (JS-array shape)", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("contype = 'f'") || sql.includes("con.contype = 'f'")) {
        return [
          {
            schema: "public",
            table: "application",
            name: "application_student_id_fkey",
            on_delete: "a",
            on_update: "c",
            deferrable: false,
            initially_deferred: false,
            columns: ["student_id"],
            referenced_schema: "public",
            referenced_table: "student",
            referenced_columns: ["student_id"],
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fk = inventory.catalog.foreignKeys[0];
    expect(fk.fields.onDelete).toBe("NO ACTION");
    expect(fk.fields.onUpdate).toBe("CASCADE");
    expect(fk.fields.columns).toEqual(["student_id"]);
    expect(fk.fields.referencedTable).toBe("student");
  });

  it("maps constraints with the CHECK-aware contype mapper", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_get_constraintdef")) {
        return [
          {
            schema: "public",
            table: "student",
            name: "student_gpa_check",
            type: "c", // pg_constraint contype 'c' = CHECK, NOT CASCADE
            definition: "CHECK ((gpa IS NULL) OR ((gpa >= 0.00) AND (gpa <= 4.00)))",
          },
          {
            schema: "public",
            table: "student",
            name: "student_pkey",
            type: "p",
            definition: "PRIMARY KEY (student_id)",
          },
          {
            schema: "public",
            table: "advisor",
            name: "advisor_advisor_name_key",
            type: "u",
            definition: "UNIQUE (advisor_name)",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const byName = new Map(inventory.catalog.constraints.map((c) => [c.fields.name, c.fields.type]));
    expect(byName.get("student_gpa_check")).toBe("CHECK");
    expect(byName.get("student_pkey")).toBe("PRIMARY KEY");
    expect(byName.get("advisor_advisor_name_key")).toBe("UNIQUE");
    // A CHECK constraint must NEVER be mislabeled CASCADE (the FK action code).
    expect(byName.get("student_gpa_check")).not.toBe("CASCADE");
    for (const record of inventory.catalog.constraints) {
      expect(record.fields.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hashes function bodies verbatim (comments and dollar-quotes preserved)", async () => {
    const body = "SELECT 1 -- line comment\n, 2; $$body$$  content";
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_proc") && sql.includes("proname")) {
        return [
          {
            schema: "public",
            name: "verbatim_fn",
            signature: "",
            return_type: "void",
            language: "sql",
            volatility: "v",
            security_mode: "INVOKER",
            config: [],
            acl: ["=X/postgres"],
            body,
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fn = inventory.catalog.functions[0];
    // Body hash must be sha256 of the VERBATIM body, not a normalized form.
    expect(fn.fields.bodyHash).toBe(sha256Hex(body));
  });

  it("preserves FK column ORDER for composite keys (no sorting)", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("contype = 'f'") || sql.includes("con.contype = 'f'")) {
        return [
          {
            schema: "public",
            table: "pairing",
            name: "pairing_composite_fkey",
            on_delete: "a",
            on_update: "a",
            deferrable: false,
            initially_deferred: false,
            columns: ["advisor_id", "student_id"],
            referenced_schema: "public",
            referenced_table: "member",
            referenced_columns: ["advisor_id", "student_id"],
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fk = inventory.catalog.foreignKeys[0];
    // Order must be preserved, NOT alphabetized.
    expect(fk.fields.columns).toEqual(["advisor_id", "student_id"]);
    expect(fk.fields.referencedColumns).toEqual(["advisor_id", "student_id"]);
  });

  it("decodes FK columns from a Postgres array-literal string (name[] shape)", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("contype = 'f'") || sql.includes("con.contype = 'f'")) {
        return [
          {
            schema: "public",
            table: "application",
            name: "application_student_id_fkey",
            on_delete: "a",
            on_update: "a",
            deferrable: false,
            initially_deferred: false,
            columns: "{student_id}",
            referenced_schema: "public",
            referenced_table: "student",
            referenced_columns: "{student_id}",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fk = inventory.catalog.foreignKeys[0];
    expect(fk.fields.columns).toEqual(["student_id"]);
    expect(fk.fields.referencedColumns).toEqual(["student_id"]);
  });

  it("decodes multi-column FK arrays from array-literal strings preserving order", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("contype = 'f'") || sql.includes("con.contype = 'f'")) {
        return [
          {
            schema: "public",
            table: "meeting",
            name: "meeting_pair_fkey",
            on_delete: "n",
            on_update: "c",
            deferrable: true,
            initially_deferred: true,
            columns: "{student_id,advisor_id}",
            referenced_schema: "public",
            referenced_table: "pairing",
            referenced_columns: "{student_id,advisor_id}",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fk = inventory.catalog.foreignKeys[0];
    expect(fk.fields.columns).toEqual(["student_id", "advisor_id"]);
    expect(fk.fields.referencedColumns).toEqual(["student_id", "advisor_id"]);
  });

  it("preserves search_path order on functions", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_proc") && sql.includes("proname")) {
        return [
          {
            schema: "public",
            name: "is_active_advisor",
            signature: "",
            return_type: "boolean",
            language: "sql",
            volatility: "s",
            security_mode: "DEFINER",
            config: ["search_path=pg_catalog, public"],
            acl: ["authenticated=X/postgres"],
            body: "SELECT EXISTS (SELECT 1)",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    expect(inventory.catalog.functions[0].fields.searchPath).toEqual(["pg_catalog", "public"]);
  });

  it("preserves raw trigger state and derives timing/events from tgtype", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_trigger")) {
        return [
          {
            schema: "public",
            table: "advisor",
            name: "trg_advisor_auth_user_id_one_time_bind",
            function: "guard_advisor_auth_user_id_one_time_bind",
            state: "O",
            tgtype: 1 | 2 | 16, // ROW + BEFORE + UPDATE
            definition: "CREATE TRIGGER trg ... BEFORE UPDATE OF auth_user_id ON public.advisor",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const trg = inventory.catalog.triggers[0];
    expect(trg.fields.state).toBe("O");
    expect(trg.fields.timing).toBe("ROW");
    expect(trg.fields.events).toEqual(["UPDATE"]);
    expect(trg.fields.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records raw disabled/replica trigger state distinctly", () => {
    expect(decodeTriggerType(1 | 2 | 4 | 8 | 16 | 32)).toEqual({
      timing: "ROW",
      events: ["INSERT", "DELETE", "UPDATE", "TRUNCATE"],
    });
    expect(decodeTriggerType(2)).toEqual({ timing: "STATEMENT", events: [] });
  });

  it("decodes policy roles from a Postgres array-literal string and hashes qualifiers", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_policy")) {
        return [
          {
            schema: "public",
            table: "advisor",
            name: "advisor_select_self_or_active_staff",
            command: "r",
            permissive: true,
            roles: "{authenticated}",
            using_expr: "public.is_active_advisor()",
            with_check_expr: null,
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const policy = inventory.catalog.policies[0];
    expect(policy.fields.roles).toEqual(["authenticated"]);
    expect(policy.fields.command).toBe("SELECT");
    expect(policy.fields.usingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.fields.withCheckHash).toBeNull();
    // Raw qualifier never retained.
    expect(Object.values(policy.fields)).not.toContain("public.is_active_advisor()");
  });

  it("decodes function config/ACL from array-literal strings", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_proc") && sql.includes("proname")) {
        return [
          {
            schema: "public",
            name: "guard_advisor_auth_user_id_one_time_bind",
            signature: "",
            return_type: "trigger",
            language: "plpgsql",
            volatility: "v",
            security_mode: "INVOKER",
            config: "{search_path=}",
            acl: "{=X/postgres,postgres=X/postgres}",
            body: "BEGIN RETURN NEW; END;",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const fn = inventory.catalog.functions[0];
    expect(fn.fields.searchPath).toEqual([]);
    expect(fn.fields.acl).toEqual(["=X", "postgres=X"]);
  });

  it("maps sequences, views, extensions, schema privileges, and default privileges", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_sequence")) {
        return [
          {
            schema: "public",
            name: "advisor_advisor_id_seq",
            data_type: "integer",
            owned_by: "public.advisor.advisor_id",
          },
        ];
      }
      if (sql.includes("pg_get_viewdef")) {
        return [
          { schema: "public", name: "active_advisors", kind: "view", definition: "SELECT 1 FROM public.advisor" },
        ];
      }
      if (sql.includes("pg_extension")) {
        return [{ schema: "extensions", name: "pgcrypto", version: "1.3" }];
      }
      if (sql.includes("pg_namespace") && sql.includes("nspacl")) {
        return [{ schema: "public", grantee: "PUBLIC", privilege: "USAGE", grantable: false }];
      }
      if (sql.includes("pg_default_acl")) {
        return [
          {
            owner_role: "postgres",
            schema: "public",
            object_type: "FUNCTION",
            grantee: "PUBLIC",
            privilege: "EXECUTE",
            grantable: false,
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);

    const seq = inventory.catalog.sequences[0];
    expect(seq.fields).toMatchObject({ schema: "public", name: "advisor_advisor_id_seq", dataType: "integer", ownedBy: "public.advisor.advisor_id" });

    const view = inventory.catalog.views[0];
    expect(view.fields.kind).toBe("view");
    expect(view.fields.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(view.fields)).not.toContain("SELECT 1 FROM public.advisor");

    expect(inventory.catalog.extensions[0].fields).toMatchObject({ schema: "extensions", name: "pgcrypto" });
    expect(inventory.catalog.schemaPrivileges[0].fields).toMatchObject({ grantee: "PUBLIC", privilege: "USAGE" });
    expect(inventory.catalog.defaultPrivileges[0].fields).toMatchObject({
      ownerRole: "postgres",
      objectType: "FUNCTION",
      grantee: "PUBLIC",
      privilege: "EXECUTE",
    });
  });

  it("maps function grants with effective ACLs including PUBLIC EXECUTE", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("aclexplode") && sql.includes("pg_proc")) {
        return [
          {
            schema: "public",
            object_type: "FUNCTION",
            object_name: "guard_advisor_auth_user_id_one_time_bind()",
            grantee: "PUBLIC",
            privilege: "EXECUTE",
            grantable: false,
          },
          {
            schema: "public",
            object_type: "FUNCTION",
            object_name: "guard_advisor_auth_user_id_one_time_bind()",
            grantee: "postgres",
            privilege: "EXECUTE",
            grantable: true,
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const grants = inventory.catalog.grants;
    expect(grants).toHaveLength(2);
    expect(grants[0].fields).toMatchObject({ objectType: "FUNCTION", grantee: "PUBLIC", privilege: "EXECUTE" });
  });
});

describe("PII-safe packets (raw SQL never retained)", () => {
  it("never retains emails, URLs, quoted literals, or secret-shaped values raw", async () => {
    const secretLiteral = "sb_secret_local_key_abcdef123456";
    const email = "advisor@example.com";
    const url = "https://example.com/x?token=abc";
    const quoted = "It''s a  quoted  value";
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_get_constraintdef")) {
        return [
          {
            schema: "public",
            table: "advisor",
            name: "advisor_email_check",
            type: "c",
            definition: `CHECK (email = '${email}' AND url <> '${url}' AND label = '${quoted}')`,
          },
        ];
      }
      if (sql.includes("pg_attrdef") || sql.includes("pg_get_expr")) {
        return [
          {
            schema: "public",
            table: "advisor",
            name: "secret_col",
            ordinal: 1,
            data_type: "text",
            nullable: true,
            default_expr: `'${secretLiteral}'`,
            generated: "",
          },
        ];
      }
      return [];
    });
    const inventory = await buildInventoryFromQueries(runQuery);
    const json = JSON.stringify(inventory);
    // Raw values never appear.
    expect(json).not.toContain(email);
    expect(json).not.toContain(url);
    expect(json).not.toContain(secretLiteral);
    expect(json).not.toContain(quoted);
    // Hashes do.
    expect(inventory.catalog.constraints[0].fields.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inventory.catalog.columns[0].fields.defaultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redacted JSON output carries no secret-shaped content", () => {
    const value = {
      ok: true,
      conn: "postgresql://postgres:hunter2@127.0.0.1:54322/db",
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
    };
    const json = toRedactedJson(value);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("eyJhbGci");
    expect(json).toContain("[REDACTED]");
  });
});

describe("decodePostgresStringArray / parsePostgresArrayLiteral", () => {
  it("passes JS arrays through as string arrays in order", () => {
    expect(decodePostgresStringArray(["b", "a"])).toEqual(["b", "a"]);
    expect(decodePostgresStringArray(["a", 1, null])).toEqual(["a", "1", ""]);
  });

  it("parses a simple array literal in order", () => {
    expect(parsePostgresArrayLiteral("{student_id,advisor_id}")).toEqual(["student_id", "advisor_id"]);
    expect(parsePostgresArrayLiteral("{a,b,c}")).toEqual(["a", "b", "c"]);
  });

  it("handles quoted elements, commas, and escaped quotes", () => {
    expect(parsePostgresArrayLiteral('{"a b","c,d"}')).toEqual(["a b", "c,d"]);
    expect(parsePostgresArrayLiteral('{"a\\"b"}')).toEqual(['a"b']);
    expect(parsePostgresArrayLiteral('{""}')).toEqual([""]);
  });

  it("handles empty arrays and NULL elements position-preservingly", () => {
    expect(parsePostgresArrayLiteral("{}")).toEqual([]);
    expect(parsePostgresArrayLiteral("{a,NULL,b}")).toEqual(["a", "", "b"]);
  });

  it("returns [] for non-array-literal strings and non-string input", () => {
    expect(parsePostgresArrayLiteral("not-an-array")).toEqual([]);
    expect(parsePostgresArrayLiteral("")).toEqual([]);
    expect(decodePostgresStringArray(null)).toEqual([]);
    expect(decodePostgresStringArray(undefined)).toEqual([]);
    expect(decodePostgresStringArray(42)).toEqual([]);
  });
});

describe("captureLocalInventory loopback enforcement", () => {
  it("rejects a hosted URL before any connection attempt", async () => {
    const hosted = "postgresql://postgres:secret@db.internal.supabase.co:5432/postgres";
    await expect(captureLocalInventory(hosted)).rejects.toBeInstanceOf(InventoryValidationError);
  });

  it("rejects a non-loopback local-network URL", async () => {
    const lan = "postgresql://postgres:secret@192.168.1.10:5432/postgres";
    await expect(captureLocalInventory(lan)).rejects.toBeInstanceOf(InventoryValidationError);
  });
});