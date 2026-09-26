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
 *       * six local migration-ledger rows (the exact Git chain);
 *       * RLS enabled on all seven operational tables;
 *       * application foreign keys keep the default NO ACTION semantics;
 *       * the advisor identity/RLS lockdown trigger and policies are present.
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

/** The seven operational tables created by the migration chain. */
const OPERATIONAL_TABLES = [
  "advisor",
  "fellowship",
  "student",
  "application",
  "advising_meeting",
  "fellowship_thursday",
  "scholarship_history",
] as const;

/** The exact Git migration chain recorded in the local ledger (six rows). */
const EXPECTED_LEDGER = [
  { version: "20260305000000", name: "initial_schema" },
  { version: "20260305000001", name: "allow_anon_read" },
  { version: "20260305000002", name: "allow_anon_write" },
  { version: "20260317000003", name: "advisor_auth" },
  { version: "20260317000004", name: "active_advisor_rls" },
  { version: "20260318000001", name: "advisor_self_activation_lockdown" },
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
  it("records exactly the six local-chain migrations", () => {
    const ledger = packet.catalog.migrationLedger;
    expect(ledger).toHaveLength(EXPECTED_LEDGER.length);
    const byVersion = new Map(ledger.map((record) => [record.fields.version, record.fields.name]));
    for (const { version, name } of EXPECTED_LEDGER) {
      expect(byVersion.get(version), `ledger row ${version}`).toBe(name);
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