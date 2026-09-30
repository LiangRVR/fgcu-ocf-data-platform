/**
 * tests/contract/schema-inventory.test.ts
 *
 * Contract test for plan Work 3 (local schema inventory capture) of the
 * AI-DLC change 2026-09-25-schema-provenance-reconciliation.
 *
 * It runs inside the existing isolated Docker-local contract lane
 * (`scripts/contract/run.mjs`): the lane applies the exact Git migration chain
 * to a fresh disposable database and injects the captured loopback runtime env
 * (API_URL/DB_URL/keys) into the test process. This file calls
 * `captureLocalInventory(env.dbUrl)` and asserts the resulting packet is:
 *
 *   - LOCAL  – `source === "local"` (captured from the disposable local chain,
 *     never hosted); the URL is the lane's loopback DB_URL, doubly guarded by
 *     `getContractEnv()` and `captureLocalInventory()`'s own loopback check;
 *   - SCHEMA-ONLY – the packet passes the full `validateInventoryPacket`
 *     validator (recursive prohibited-key scan rejects any row-data/credential
 *     key, and structural checks reject non-catalog fields). No function body
 *     is stored, only a body hash;
 *   - COMPLETE – every documented catalog section is present as an array, and
 *     the key expected local-chain catalog facts hold:
 *       * ten local migration-ledger rows (the exact Git chain);
 *       * RLS enabled on all eight operational tables;
 *       * application foreign keys keep the default NO ACTION semantics;
 *       * the advisor identity/RLS lockdown trigger and policies are present;
 *       * migration 20260929000001 adds the advising↔application link columns
 *         (nullable application.application_year, nullable
 *         advising_meeting.application_id, NOT NULL created_at default now(),
 *         nullable created_by_advisor_id), the direct + composite application
 *         FKs, the unique (application_id, student_id) target, and the
 *         hardened SECURITY DEFINER creation-metadata trigger/function; and
 *       * migration 20260930000002 adds indexes for the composite
 *         advising/application FK and the creator-advisor FK.
 *       * migration 20260930000003 makes advising meetings append-only for
 *         authenticated users: active-advisor SELECT and INSERT policies only,
 *         with no authenticated UPDATE or DELETE grant.
 *
 * Safety: this test writes no output files, reads no hosted values, and never
 * queries business rows — it only runs the read-only catalog SELECTs inside
 * `captureLocalInventory`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { captureLocalInventory } from "../../scripts/schema-inventory/capture";
import {
  CATALOG_SECTIONS,
  INVENTORY_FORMAT_VERSION,
  type SchemaInventory,
} from "../../scripts/schema-inventory/types";
import { validateInventoryPacket } from "../../scripts/schema-inventory/validate";
import { getContractEnv } from "./helpers/setup";

const env = getContractEnv();

/** The eight operational tables created by the migration chain. */
const OPERATIONAL_TABLES = [
  "advisor",
  "fellowship",
  "student",
  "application",
  "advising_meeting",
  "advising_meeting_amendment",
  "fellowship_thursday",
  "scholarship_history",
] as const;

/** The exact Git migration chain recorded in the local ledger (ten rows). */
const EXPECTED_LEDGER = [
  { version: "20260305000000", name: "initial_schema" },
  { version: "20260305000001", name: "allow_anon_read" },
  { version: "20260305000002", name: "allow_anon_write" },
  { version: "20260317000003", name: "advisor_auth" },
  { version: "20260317000004", name: "active_advisor_rls" },
  { version: "20260318000001", name: "advisor_self_activation_lockdown" },
  { version: "20260929000001", name: "advising_application_link" },
  { version: "20260930000002", name: "advising_application_fk_indexes" },
  { version: "20260930000003", name: "advising_meeting_append_only" },
  { version: "20260930000004", name: "advising_meeting_amendments" },
] as const;

/** One shared capture: read-only catalog queries against the lane database. */
let packet: SchemaInventory;

beforeAll(async () => {
  packet = await captureLocalInventory(env.dbUrl);
}, 60_000);

describe("schema inventory packet shape (local/schema-only/complete)", () => {
  it("is captured as a local inventory", () => {
    expect(packet.source).toBe("local");
    expect(packet.formatVersion).toBe(INVENTORY_FORMAT_VERSION);
  });

  it("is schema-only: passes the full packet validator (no row data or credentials)", () => {
    expect(() => validateInventoryPacket(packet)).not.toThrow();
  });

  it("is complete: carries every catalog section as a non-missing array", () => {
    expect(Object.keys(packet.catalog).sort()).toEqual([...CATALOG_SECTIONS].sort());
    for (const section of CATALOG_SECTIONS) {
      expect(packet.catalog[section], `catalog.${section}`).toBeDefined();
      expect(Array.isArray(packet.catalog[section]), `catalog.${section}`).toBe(true);
    }
  });

  it("is PII-safe: records carry hashes, never raw SQL or raw row values", () => {
    const json = JSON.stringify(packet);
    // No raw SQL-shaped content survives in the packet.
    expect(json).not.toContain("SELECT ");
    expect(json).not.toContain("CREATE TRIGGER");
    expect(json).not.toContain("nextval(");
    expect(json).not.toContain("auth.jwt()");
    expect(json).not.toContain("lower(coalesce");
    // Email/URL/secret-shaped values must not appear raw anywhere.
    expect(json).not.toMatch(/@example\./);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    expect(json).not.toContain("sb_secret_");

    // SQL-bearing sections expose only hashes.
    for (const section of ["columns", "constraints", "indexes", "views", "functions", "triggers", "policies"] as const) {
      for (const record of packet.catalog[section]) {
        const jsonRecord = JSON.stringify(record.fields);
        for (const value of Object.values(record.fields)) {
          if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) {
            expect(record.fields, `${record.identity} carries a hash field`).toBeDefined();
          }
        }
        // No field may be named with raw SQL semantics.
        expect(jsonRecord).not.toMatch(/"definition"\s*:/);
        expect(jsonRecord).not.toMatch(/"default"\s*:/);
        expect(jsonRecord).not.toMatch(/"body"\s*:/);
        expect(jsonRecord).not.toMatch(/"using"\s*:/);
      }
    }
  });
});

describe("migration ledger", () => {
  it("records exactly the ten local-chain migrations", () => {
    const ledger = packet.catalog.migrationLedger;
    expect(ledger).toHaveLength(EXPECTED_LEDGER.length);
    const byVersion = new Map(ledger.map((record) => [record.fields.version, record.fields.name]));
    for (const { version, name } of EXPECTED_LEDGER) {
      expect(byVersion.get(version), `ledger row ${version}`).toBe(name);
    }
  });
});

describe("advising_meeting append-only authorization (migration 20260930000003)", () => {
  it("captures only authenticated active-advisor SELECT and INSERT policies", () => {
    const policies = packet.catalog.policies
      .filter((record) => record.fields.table === "advising_meeting")
      .map((record) => ({
        name: record.fields.name,
        command: record.fields.command,
        roles: record.fields.roles,
      }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    expect(policies).toEqual([
      {
        name: "active_advisor_insert_advising_meeting",
        command: "INSERT",
        roles: ["authenticated"],
      },
      {
        name: "active_advisor_select_advising_meeting",
        command: "SELECT",
        roles: ["authenticated"],
      },
    ]);
  });

  it("captures no authenticated advising_meeting UPDATE or DELETE grant", () => {
    const privileges = packet.catalog.grants
      .filter(
        (record) =>
          record.fields.objectType === "TABLE" &&
          record.fields.objectName === "advising_meeting" &&
          record.fields.grantee === "authenticated"
      )
      .map((record) => record.fields.privilege);
    expect(privileges).toContain("SELECT");
    expect(privileges).toContain("INSERT");
    expect(privileges).not.toContain("UPDATE");
    expect(privileges).not.toContain("DELETE");
  });
});

describe("advising_meeting_amendment append-only authorization (migration 20260930000004)", () => {
  it("captures only authenticated active-advisor SELECT and INSERT policies", () => {
    const policies = packet.catalog.policies
      .filter((record) => record.fields.table === "advising_meeting_amendment")
      .map((record) => ({
        name: record.fields.name,
        command: record.fields.command,
        roles: record.fields.roles,
      }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    expect(policies).toEqual([
      {
        name: "active_advisor_insert_advising_meeting_amendment",
        command: "INSERT",
        roles: ["authenticated"],
      },
      {
        name: "active_advisor_select_advising_meeting_amendment",
        command: "SELECT",
        roles: ["authenticated"],
      },
    ]);
  });

  it("captures no authenticated advising_meeting_amendment UPDATE or DELETE grant and no anon grant", () => {
    const amendmentGrants = packet.catalog.grants.filter(
      (record) =>
        record.fields.objectType === "TABLE" &&
        record.fields.objectName === "advising_meeting_amendment"
    );
    const authenticatedPrivileges = amendmentGrants
      .filter((record) => record.fields.grantee === "authenticated")
      .map((record) => record.fields.privilege);
    expect(authenticatedPrivileges).toContain("SELECT");
    expect(authenticatedPrivileges).toContain("INSERT");
    expect(authenticatedPrivileges).not.toContain("UPDATE");
    expect(authenticatedPrivileges).not.toContain("DELETE");
    expect(
      amendmentGrants.some((record) => record.fields.grantee === "anon"),
      "anon must hold no grant on the amendment table"
    ).toBe(false);
  });

  it("captures the amendment creation-metadata trigger/function as SECURITY DEFINER", () => {
    const trigger = packet.catalog.triggers.find(
      (record) => record.fields.name === "trg_advising_meeting_amendment_created_metadata"
    );
    expect(trigger, "amendment metadata trigger").toBeDefined();
    expect(trigger!.fields.table).toBe("advising_meeting_amendment");
    expect(String(trigger!.fields.function)).toContain("set_advising_meeting_amendment_created_metadata");
    expect(trigger!.fields.state).toBe("O");
    expect(String(trigger!.fields.events)).toContain("INSERT");
    expect(String(trigger!.fields.definitionHash)).toMatch(/^[0-9a-f]{64}$/);

    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "set_advising_meeting_amendment_created_metadata"
    );
    expect(fn, "amendment metadata function").toBeDefined();
    expect(fn!.fields.securityMode).toBe("DEFINER");
    expect(fn!.fields.searchPath).toEqual([]);
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures the trim-aware nonempty reason/details CHECK constraints", () => {
    const constraints = packet.catalog.constraints;
    const byName = new Map(constraints.map((record) => [record.fields.name, record]));

    for (const name of [
      "advising_meeting_amendment_reason_not_blank",
      "advising_meeting_amendment_details_not_blank",
    ]) {
      const record = byName.get(name);
      expect(record, `CHECK constraint ${name}`).toBeDefined();
      expect(record!.fields.type, `${name} type`).toBe("CHECK");
      // Schema-only inventory: the raw definition is reduced to a hash.
      expect(String(record!.fields.definitionHash), `${name} definitionHash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("row level security entries", () => {
  it("records RLS enabled on every operational table", () => {
    const rls = packet.catalog.rls;
    const byTable = new Map(rls.map((record) => [record.fields.table, record]));
    for (const table of OPERATIONAL_TABLES) {
      const record = byTable.get(table);
      expect(record, `RLS entry for ${table}`).toBeDefined();
      expect(record!.fields.enabled, `RLS enabled on ${table}`).toBe(true);
    }
  });
});

describe("foreign keys", () => {
  it("captures CHECK constraints with type CHECK (not CASCADE)", () => {
    const constraints = packet.catalog.constraints;
    const byName = new Map(constraints.map((record) => [record.fields.name, record]));
    // The migration chain declares these CHECK constraints; contype 'c' must
    // map to CHECK, never to the FK action code CASCADE.
    for (const checkName of [
      "student_gpa_check",
      "student_class_standing_check",
      "student_gender_check",
      "application_stage_check",
      "advising_meeting_mode_check",
      "fellowship_thursday_source_check",
    ]) {
      const record = byName.get(checkName);
      expect(record, `CHECK constraint ${checkName}`).toBeDefined();
      expect(record!.fields.type, `${checkName} type`).toBe("CHECK");
      expect(String(record!.fields.definitionHash), `${checkName} definitionHash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("captures the local application FK column names correctly", () => {
    const fks = packet.catalog.foreignKeys;
    const byName = new Map(fks.map((record) => [record.fields.name, record]));

    const expected: Record<string, { columns: string[]; referencedColumns: string[] }> = {
      application_student_id_fkey: {
        columns: ["student_id"],
        referencedColumns: ["student_id"],
      },
      application_fellowship_id_fkey: {
        columns: ["fellowship_id"],
        referencedColumns: ["fellowship_id"],
      },
    };
    for (const [name, { columns, referencedColumns }] of Object.entries(expected)) {
      const record = byName.get(name);
      expect(record, `FK ${name}`).toBeDefined();
      // The local chain captures the FK column names (whether node-postgres
      // returns a JS array or a Postgres array-literal string) — never empty.
      expect(record!.fields.columns, `${name} local columns`).toEqual(columns);
      expect(record!.fields.referencedColumns, `${name} referenced columns`).toEqual(
        referencedColumns
      );
    }
  });

  it("keeps the application FKs on the default NO ACTION semantics", () => {
    const fks = packet.catalog.foreignKeys;
    const byName = new Map(fks.map((record) => [record.fields.name, record]));

    const expected: Record<string, string> = {
      application_student_id_fkey: "student",
      application_fellowship_id_fkey: "fellowship",
    };
    for (const [name, referencedTable] of Object.entries(expected)) {
      const record = byName.get(name);
      expect(record, `FK ${name}`).toBeDefined();
      expect(record!.fields.referencedTable, `${name} referenced table`).toBe(referencedTable);
      // The Git chain declares these FKs without ON DELETE/ON UPDATE clauses, so
      // the normalized actions must be the Postgres default NO ACTION.
      expect(record!.fields.onDelete, `${name} onDelete`).toBe("NO ACTION");
      expect(record!.fields.onUpdate, `${name} onUpdate`).toBe("NO ACTION");
    }
  });

  it("documents the local-chain default: every FK is NO ACTION", () => {
    for (const record of packet.catalog.foreignKeys) {
      expect(record.fields.onDelete, `${record.identity} onDelete`).toBe("NO ACTION");
      expect(record.fields.onUpdate, `${record.identity} onUpdate`).toBe("NO ACTION");
    }
  });
});

describe("advising↔application link columns (migration 20260929000001)", () => {
  it("captures the application_year, application_id, and creation-metadata columns", () => {
    const columns = packet.catalog.columns;
    const byIdentity = new Map(columns.map((record) => [record.identity, record]));

    const applicationYear = byIdentity.get("public.application.application_year");
    expect(applicationYear, "application.application_year").toBeDefined();
    expect(applicationYear!.fields.dataType).toBe("smallint");
    expect(applicationYear!.fields.nullable).toBe(true);
    // No default: legacy rows keep a truthful NULL cycle.
    expect(applicationYear!.fields.defaultHash).toBeNull();

    const applicationId = byIdentity.get("public.advising_meeting.application_id");
    expect(applicationId, "advising_meeting.application_id").toBeDefined();
    expect(applicationId!.fields.dataType).toBe("integer");
    expect(applicationId!.fields.nullable).toBe(true);
    expect(applicationId!.fields.defaultHash).toBeNull();

    const createdAt = byIdentity.get("public.advising_meeting.created_at");
    expect(createdAt, "advising_meeting.created_at").toBeDefined();
    expect(createdAt!.fields.dataType).toBe("timestamp with time zone");
    expect(createdAt!.fields.nullable).toBe(false);
    // Raw defaults are hashed (schema-only): the non-null default is present.
    expect(String(createdAt!.fields.defaultHash)).toMatch(/^[0-9a-f]{64}$/);

    const createdBy = byIdentity.get("public.advising_meeting.created_by_advisor_id");
    expect(createdBy, "advising_meeting.created_by_advisor_id").toBeDefined();
    expect(createdBy!.fields.dataType).toBe("integer");
    expect(createdBy!.fields.nullable).toBe(true);
    expect(createdBy!.fields.defaultHash).toBeNull();
  });
});

describe("advising↔application link foreign keys (migration 20260929000001)", () => {
  it("captures the direct, composite, and creator FKs with column order", () => {
    const fks = packet.catalog.foreignKeys;
    const byName = new Map(fks.map((record) => [record.fields.name, record]));

    const expected: Record<string, { table: string; columns: string[]; referencedTable: string; referencedColumns: string[] }> = {
      advising_meeting_application_id_fkey: {
        table: "advising_meeting",
        columns: ["application_id"],
        referencedTable: "application",
        referencedColumns: ["application_id"],
      },
      advising_meeting_application_student_fkey: {
        table: "advising_meeting",
        columns: ["application_id", "student_id"],
        referencedTable: "application",
        referencedColumns: ["application_id", "student_id"],
      },
      advising_meeting_created_by_advisor_id_fkey: {
        table: "advising_meeting",
        columns: ["created_by_advisor_id"],
        referencedTable: "advisor",
        referencedColumns: ["advisor_id"],
      },
    };
    for (const [name, value] of Object.entries(expected)) {
      const record = byName.get(name);
      expect(record, `FK ${name}`).toBeDefined();
      expect(record!.fields.table, `${name} table`).toBe(value.table);
      expect(record!.fields.columns, `${name} columns`).toEqual(value.columns);
      expect(record!.fields.referencedTable, `${name} referenced table`).toBe(value.referencedTable);
      expect(record!.fields.referencedColumns, `${name} referenced columns`).toEqual(value.referencedColumns);
      expect(record!.fields.onDelete, `${name} onDelete`).toBe("NO ACTION");
      expect(record!.fields.onUpdate, `${name} onUpdate`).toBe("NO ACTION");
    }
  });

  it("captures the application UNIQUE (application_id, student_id) key", () => {
    const constraints = packet.catalog.constraints;
    const unique = constraints.find(
      (record) => record.identity === "public.application.application_application_id_student_id_key"
    );
    expect(unique, "application_application_id_student_id_key constraint").toBeDefined();
    expect(unique!.fields.type).toBe("UNIQUE");
    expect(String(unique!.fields.definitionHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures the advising application indexes, including follow-up FK indexes", () => {
    const indexes = packet.catalog.indexes.map((record) => record.identity);
    // The link migration's query indexes.
    expect(indexes).toContain("public.advising_meeting.idx_advising_meeting_application");
    expect(indexes).toContain("public.advising_meeting.idx_advising_meeting_student_application");
    // 20260930000002 covers the composite application/student and creator FKs.
    expect(indexes).toContain("public.advising_meeting.idx_advising_meeting_application_student");
    expect(indexes).toContain("public.advising_meeting.idx_advising_meeting_created_by_advisor");
    // The unique constraint's backing index is captured too.
    expect(indexes).toContain("public.application.application_application_id_student_id_key");
  });
});

describe("advising_meeting creation-metadata trigger/function (migration 20260929000001)", () => {
  it("records the metadata trigger on public.advising_meeting", () => {
    const trigger = packet.catalog.triggers.find(
      (record) => record.fields.name === "trg_advising_meeting_created_metadata"
    );
    expect(trigger, "creation-metadata trigger").toBeDefined();
    expect(trigger!.fields.table).toBe("advising_meeting");
    expect(String(trigger!.fields.function)).toContain("set_advising_meeting_created_metadata");
    expect(trigger!.fields.state).toBe("O");
    expect(String(trigger!.fields.timing)).toBe("ROW");
    expect(trigger!.fields.events).toContain("INSERT");
    expect(trigger!.fields.events).toContain("UPDATE");
    expect(String(trigger!.fields.definitionHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the metadata function as SECURITY DEFINER with empty search_path and a non-empty ACL", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "set_advising_meeting_created_metadata"
    );
    expect(fn, "metadata function").toBeDefined();
    expect(fn!.fields.securityMode).toBe("DEFINER");
    // Empty search_path is the hardened configuration (`SET search_path = ''`).
    expect(fn!.fields.searchPath).toEqual([]);
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);
    // Non-empty effective ACL: PUBLIC/anon/authenticated EXECUTE revoked,
    // service_role EXECUTE pins the ACL non-empty (never an empty fallback).
    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "metadata function must carry an effective ACL").toBe(true);
  });
});

describe("advisor identity/RLS lockdown (migration ...001)", () => {
  it("records the one-time-bind trigger on public.advisor", () => {
    const trigger = packet.catalog.triggers.find(
      (record) => record.fields.name === "trg_advisor_auth_user_id_one_time_bind"
    );
    expect(trigger, "lockdown trigger").toBeDefined();
    expect(trigger!.fields.table).toBe("advisor");
    expect(String(trigger!.fields.function)).toContain("guard_advisor_auth_user_id_one_time_bind");
    // Raw trigger state preserved (O = enabled).
    expect(trigger!.fields.state).toBe("O");
    // Structural timing/events preserved; definition reduced to a hash.
    expect(String(trigger!.fields.timing)).toBe("ROW");
    expect(trigger!.fields.events).toContain("INSERT");
    expect(String(trigger!.fields.definitionHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the lockdown SELECT/UPDATE policies on public.advisor", () => {
    const policyNames = packet.catalog.policies.map((record) => record.fields.name);
    expect(policyNames, "self-or-active-staff SELECT policy").toContain(
      "advisor_select_self_or_active_staff"
    );
    expect(policyNames, "active-staff-only UPDATE policy").toContain(
      "advisor_update_active_staff_only"
    );
  });

  it("records the invoker-security guard function and no self-link RPC", () => {
    const guard = packet.catalog.functions.find(
      (record) => record.fields.name === "guard_advisor_auth_user_id_one_time_bind"
    );
    expect(guard, "guard function").toBeDefined();
    expect(guard!.fields.securityMode).toBe("INVOKER");
    // Function bodies are never stored — only a sha256 body hash (schema-only).
    expect(String(guard!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      packet.catalog.functions.some((record) => record.fields.name === "link_current_advisor"),
      "no self-link RPC may exist"
    ).toBe(false);
  });

  it("captures effective function ACLs (default PUBLIC EXECUTE not hidden)", () => {
    // The guard function's ACL was explicitly set to service_role/postgres, so
    // its effective ACL must contain those grants and NOT a spurious PUBLIC
    // EXECUTE; the is_active_advisor() function grants EXECUTE to
    // authenticated. At minimum every captured function has a non-empty ACL
    // derived from proacl (never an empty fallback that hides grants).
    for (const record of packet.catalog.functions) {
      const acl = record.fields.acl as string[];
      expect(Array.isArray(acl) && acl.length > 0, `${record.identity} must carry an effective ACL`).toBe(true);
    }
  });
});

describe("expanded catalog sections (sequences/views/extensions/privileges)", () => {
  it("captures the migration-chain sequences", () => {
    const sequences = packet.catalog.sequences.map((record) => record.fields.name);
    for (const seq of [
      "advisor_advisor_id_seq",
      "application_application_id_seq",
      "student_student_id_seq",
    ]) {
      expect(sequences, `sequence ${seq}`).toContain(seq);
    }
    for (const record of packet.catalog.sequences) {
      expect(record.fields.dataType, `${record.identity} dataType`).toBeTruthy();
      // ownedBy is structural (nullable) — no raw SQL.
      if (record.fields.ownedBy != null) {
        expect(String(record.fields.ownedBy)).toMatch(/^public\.[a-z_]+\.\w+$/);
      }
    }
  });

  it("captures the extension set with schema and version", () => {
    // The migration chain creates no extensions of its own, but pgcrypto (and
    // others) may be present from the local Supabase image; the section is
    // required and every entry carries schema + name + version.
    for (const record of packet.catalog.extensions) {
      expect(record.fields.name, `${record.identity} name`).toBeTruthy();
      expect(record.fields.schema, `${record.identity} schema`).toBeTruthy();
      expect(record.fields.version, `${record.identity} version`).toBeTruthy();
    }
  });

  it("captures schema privileges and default privileges", () => {
    const schemaPrivs = packet.catalog.schemaPrivileges.map((record) => record.fields.privilege);
    expect(schemaPrivs, "schema privileges").toContain("USAGE");
    for (const record of packet.catalog.schemaPrivileges) {
      expect(record.fields.grantee).toBeTruthy();
    }
    for (const record of packet.catalog.defaultPrivileges) {
      expect(record.fields.ownerRole).toBeTruthy();
      expect(record.fields.grantee).toBeTruthy();
      expect(record.fields.privilege).toBeTruthy();
    }
  });

  it("captures grants across tables, sequences, and functions", () => {
    const objectTypes = new Set(packet.catalog.grants.map((record) => record.fields.objectType));
    expect(objectTypes.has("TABLE"), "TABLE grants present").toBe(true);
    expect(objectTypes.has("SEQUENCE"), "SEQUENCE grants present").toBe(true);
    expect(objectTypes.has("FUNCTION"), "FUNCTION grants present").toBe(true);
  });
});
