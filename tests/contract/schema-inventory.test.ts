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
 *       * twenty local migration-ledger rows (the exact Git chain);
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
 *         with no authenticated UPDATE or DELETE grant;
 *       * migration 20260930000005 adds the entity-lifecycle catalog: nullable
 *         `student.archived_at` / `fellowship.archived_at` (timestamptz, no
 *         default), the archive-filter indexes, the trusted INVOKER
 *         `is_ocf_admin()` predicate, the SECURITY DEFINER
 *         `lifecycle_transition(text, text, integer)` RPC, and the
 *         invoker-security column-scoped lifecycle guard triggers/functions
 *         (EXECUTE pinned to authenticated / service_role only);
 *       * migration 20260930000006 locks down authenticated DELETE on the core
 *         historical entities (`advisor`, `student`, `fellowship`,
 *         `application`): the authenticated DELETE table grant is revoked and
 *         the FOR ALL / DELETE RLS policies are replaced by explicit
 *         SELECT/INSERT/UPDATE policies, while `fellowship_thursday` /
 *         `scholarship_history` keep authenticated DELETE and
 *         `advising_meeting` / `advising_meeting_amendment` stay append-only;
 *       * migration 20260930000007 (review remediation) replaces the
 *         `lifecycle_transition` RPC to require an ACTIVE bound advisor in
 *         addition to the `ocf_admin` claim, and adds invoker-security
 *         archive-parent guard triggers/functions (EXECUTE pinned to
 *         service_role only) on the operational child tables `application`,
 *         `advising_meeting`, `fellowship_thursday`, and `scholarship_history`;
 *       * migration 20261001000001 (explicit admin/advisor permissions)
 *         normalizes `advisor.role` to the exact display vocabulary
 *         `Admin`/`Advisor` and pins it with a CHECK constraint plus the
 *         `'Advisor'` column default, hardens `is_ocf_admin()` to a strict
 *         JSON-boolean claim comparison, adds the SECURITY DEFINER
 *         `is_effective_admin()` predicate (active bound advisor + boolean
 *         claim), and adds the invoker-security `guard_advisor_role_display`
 *         trigger/function (EXECUTE pinned to service_role only) that rejects
 *         direct authenticated writes to the protected display role.
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

/** The exact Git migration chain recorded in the local ledger (twenty rows). */
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
  { version: "20260930000005", name: "entity_lifecycle_archiving" },
  { version: "20260930000006", name: "core_history_delete_lockdown" },
  { version: "20260930000007", name: "lifecycle_review_remediation" },
  { version: "20261001000001", name: "explicit_admin_advisor_permissions" },
  { version: "20261002000001", name: "advisor_self_service_role_reconciliation" },
  { version: "20261003000001", name: "advisor_role_change_lock" },
  { version: "20261004000001", name: "advisor_role_fenced_write" },
  { version: "20261005000001", name: "advisor_role_fenced_read" },
  { version: "20261006000001", name: "advisor_role_display_reconcile" },
  { version: "20261007000001", name: "atomic_advisor_role_change" },
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
  it("records exactly the twenty local-chain migrations", () => {
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

  it("records EXECUTE revoked from PUBLIC, anon, and authenticated on the amendment metadata function", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "set_advising_meeting_amendment_created_metadata"
    );
    expect(fn, "amendment metadata function").toBeDefined();
    // Effective ACL (proacl, default PUBLIC EXECUTE never hidden): the
    // amendment migration REVOKEs ALL from PUBLIC/anon/authenticated and grants
    // EXECUTE only to service_role — so the ACL must be non-empty (service_role
    // pins it; never an empty fallback) and carry no PUBLIC (`=X`), anon, or
    // authenticated EXECUTE entry.
    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "amendment metadata function must carry an effective ACL").toBe(true);
    // No exposed role may hold EXECUTE — with or without the grant option
    // (`X*`, the aclitem `*` suffix) — on the hardened function. normalizeAcl
    // strips only the grantor suffix, so PUBLIC (`=X`/`=X*`), anon, and
    // authenticated entries survive verbatim and must all be absent.
    const exposedExecutes = acl.filter((entry) =>
      ["=X", "=X*", "anon=X", "anon=X*", "authenticated=X", "authenticated=X*"].includes(entry)
    );
    expect(
      exposedExecutes,
      "PUBLIC/anon/authenticated must hold no EXECUTE (with or without grant option) on the amendment metadata function"
    ).toHaveLength(0);
    expect(acl, "service_role EXECUTE pins the amendment metadata function ACL").toContain("service_role=X");
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

describe("entity lifecycle archiving catalog (migration 20260930000005)", () => {
  it("captures the lifecycle columns as nullable timestamptz with no default", () => {
    const columns = packet.catalog.columns;
    const byIdentity = new Map(columns.map((record) => [record.identity, record]));

    for (const identity of ["public.student.archived_at", "public.fellowship.archived_at"]) {
      const record = byIdentity.get(identity);
      expect(record, `column ${identity}`).toBeDefined();
      expect(record!.fields.dataType, `${identity} data type`).toBe("timestamp with time zone");
      expect(record!.fields.nullable, `${identity} nullable`).toBe(true);
      // No default expression: only the lifecycle RPC (or a trusted technical
      // session) writes the field, so a DEFAULT would be misleading.
      expect(record!.fields.defaultHash, `${identity} defaultHash`).toBeNull();
    }
  });

  it("captures the lifecycle archive-filter indexes", () => {
    const indexes = packet.catalog.indexes.map((record) => record.identity);
    expect(indexes, "student archive index").toContain("public.student.idx_student_archived_at");
    expect(indexes, "fellowship archive index").toContain("public.fellowship.idx_fellowship_archived_at");
  });

  it("captures is_ocf_admin as a trusted INVOKER predicate with authenticated EXECUTE and no PUBLIC/anon EXECUTE", () => {
    const fn = packet.catalog.functions.find((record) => record.fields.name === "is_ocf_admin");
    expect(fn, "is_ocf_admin function").toBeDefined();
    expect(fn!.fields.securityMode, "is_ocf_admin security mode").toBe("INVOKER");
    expect(fn!.fields.searchPath, "is_ocf_admin search path").toEqual([]);
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "is_ocf_admin must carry an effective ACL").toBe(true);
    expect(acl, "authenticated EXECUTE on is_ocf_admin").toContain("authenticated=X");
    // No PUBLIC (`=X`/`=X*`) or anon EXECUTE — with or without grant option.
    const exposed = acl.filter((entry) => ["=X", "=X*", "anon=X", "anon=X*"].includes(entry));
    expect(exposed, "no PUBLIC/anon EXECUTE on is_ocf_admin").toHaveLength(0);
  });

  it("captures lifecycle_transition as SECURITY DEFINER with authenticated EXECUTE and no PUBLIC/anon EXECUTE", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "lifecycle_transition"
    );
    expect(fn, "lifecycle_transition function").toBeDefined();
    expect(fn!.fields.securityMode, "lifecycle_transition security mode").toBe("DEFINER");
    expect(fn!.fields.searchPath, "lifecycle_transition search path").toEqual([]);
    expect(String(fn!.fields.signature), "lifecycle_transition signature").toContain("text");
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "lifecycle_transition must carry an effective ACL").toBe(true);
    expect(acl, "authenticated EXECUTE on lifecycle_transition").toContain("authenticated=X");
    const exposed = acl.filter((entry) => ["=X", "=X*", "anon=X", "anon=X*"].includes(entry));
    expect(exposed, "no PUBLIC/anon EXECUTE on lifecycle_transition").toHaveLength(0);
  });

  it("captures the invoker-security lifecycle guard functions with service_role-pinned ACLs", () => {
    const byName = new Map(packet.catalog.functions.map((record) => [record.fields.name, record]));
    for (const name of [
      "guard_student_archived_at_lifecycle",
      "guard_fellowship_archived_at_lifecycle",
      "guard_advisor_is_active_lifecycle",
    ]) {
      const fn = byName.get(name);
      expect(fn, `guard function ${name}`).toBeDefined();
      expect(fn!.fields.securityMode, `${name} security mode`).toBe("INVOKER");
      expect(fn!.fields.searchPath, `${name} search path`).toEqual([]);
      expect(String(fn!.fields.bodyHash), `${name} bodyHash`).toMatch(/^[0-9a-f]{64}$/);

      const acl = fn!.fields.acl as string[];
      expect(Array.isArray(acl) && acl.length > 0, `${name} must carry an effective ACL`).toBe(true);
      // PUBLIC/anon/authenticated EXECUTE revoked; service_role EXECUTE pins the
      // ACL non-empty (never the default PUBLIC fallback).
      const exposed = acl.filter((entry) =>
        ["=X", "=X*", "anon=X", "anon=X*", "authenticated=X", "authenticated=X*"].includes(entry)
      );
      expect(exposed, `${name} PUBLIC/anon/authenticated EXECUTE`).toHaveLength(0);
      expect(acl, `${name} service_role EXECUTE`).toContain("service_role=X");
    }
  });

  it("captures the lifecycle column-scoped triggers on student, fellowship, and advisor", () => {
    const byName = new Map(packet.catalog.triggers.map((record) => [record.fields.name, record]));
    const expected: Array<{ name: string; table: string; function: string }> = [
      {
        name: "trg_student_archived_at_lifecycle",
        table: "student",
        function: "guard_student_archived_at_lifecycle",
      },
      {
        name: "trg_fellowship_archived_at_lifecycle",
        table: "fellowship",
        function: "guard_fellowship_archived_at_lifecycle",
      },
      {
        name: "trg_advisor_is_active_lifecycle",
        table: "advisor",
        function: "guard_advisor_is_active_lifecycle",
      },
    ];
    for (const { name, table, function: fnName } of expected) {
      const record = byName.get(name);
      expect(record, `trigger ${name}`).toBeDefined();
      expect(record!.fields.table, `${name} table`).toBe(table);
      expect(String(record!.fields.function), `${name} function`).toContain(fnName);
      expect(record!.fields.state, `${name} state`).toBe("O");
      expect(String(record!.fields.timing), `${name} timing`).toBe("ROW");
      expect(record!.fields.events, `${name} events`).toContain("INSERT");
      expect(record!.fields.events, `${name} events`).toContain("UPDATE");
      expect(String(record!.fields.definitionHash), `${name} definitionHash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("core-history DELETE lockdown catalog (migration 20260930000006)", () => {
  it("captures no authenticated DELETE table grant on advisor, student, fellowship, or application", () => {
    const grants = packet.catalog.grants.filter(
      (record) =>
        record.fields.objectType === "TABLE" &&
        ["advisor", "student", "fellowship", "application"].includes(String(record.fields.objectName)) &&
        record.fields.grantee === "authenticated"
    );
    expect(grants.length, "core tables must carry authenticated table grants").toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant.fields.privilege, `${grant.fields.objectName} authenticated grant`).not.toBe("DELETE");
    }
  });

  it("captures explicit SELECT/INSERT/UPDATE active-advisor policies and no DELETE policy on the core tables", () => {
    const policies = packet.catalog.policies.filter(
      (record) =>
        ["advisor", "student", "fellowship", "application"].includes(String(record.fields.table)) &&
        Array.isArray(record.fields.roles) &&
        record.fields.roles.includes("authenticated")
    );
    expect(
      policies.some((record) => String(record.fields.command).toUpperCase() === "DELETE"),
      "no DELETE policy may exist on the core tables"
    ).toBe(false);

    const byTable = new Map<string, string[]>();
    for (const record of policies) {
      const list = byTable.get(String(record.fields.table)) ?? [];
      list.push(String(record.fields.command).toUpperCase());
      byTable.set(String(record.fields.table), list);
    }
    for (const table of ["student", "fellowship", "application"]) {
      expect(byTable.get(table)?.sort(), `${table} policy commands`).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
    // Migration 20261002000001: advisor keeps only its self-or-active-staff
    // SELECT and its self-scoped UPDATE policy (advisor_update_own_profile);
    // the broad authenticated INSERT policy is dropped (advisor rows are
    // created only through the trusted service-role provisioning path).
    expect(byTable.get("advisor")?.sort(), "advisor policy commands").toEqual(["SELECT", "UPDATE"]);
  });

  it("keeps authenticated DELETE on the operational rows fellowship_thursday and scholarship_history", () => {
    const deleteGrants = packet.catalog.grants.filter(
      (record) =>
        record.fields.objectType === "TABLE" &&
        ["fellowship_thursday", "scholarship_history"].includes(String(record.fields.objectName)) &&
        record.fields.grantee === "authenticated" &&
        record.fields.privilege === "DELETE"
    );
    expect(deleteGrants.map((record) => record.fields.objectName).sort()).toEqual([
      "fellowship_thursday",
      "scholarship_history",
    ]);
  });
});

describe("lifecycle review remediation catalog (migration 20260930000007)", () => {
  it("keeps lifecycle_transition as SECURITY DEFINER with authenticated EXECUTE after the review-remediation replacement", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "lifecycle_transition"
    );
    expect(fn, "lifecycle_transition function").toBeDefined();
    // The review-remediation migration replaces the body in place with
    // CREATE OR REPLACE FUNCTION; the security posture is preserved.
    expect(fn!.fields.securityMode, "lifecycle_transition security mode").toBe("DEFINER");
    expect(fn!.fields.searchPath, "lifecycle_transition search path").toEqual([]);
    expect(String(fn!.fields.signature), "lifecycle_transition signature").toContain("text");
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "lifecycle_transition must carry an effective ACL").toBe(true);
    expect(acl, "authenticated EXECUTE on lifecycle_transition").toContain("authenticated=X");
    const exposed = acl.filter((entry) => ["=X", "=X*", "anon=X", "anon=X*"].includes(entry));
    expect(exposed, "no PUBLIC/anon EXECUTE on lifecycle_transition").toHaveLength(0);
  });

  it("captures the four archive-parent guard functions as INVOKER with service_role-pinned ACLs", () => {
    const byName = new Map(packet.catalog.functions.map((record) => [record.fields.name, record]));
    for (const name of [
      "guard_application_archive_parents",
      "guard_advising_meeting_archive_student",
      "guard_fellowship_thursday_archive_student",
      "guard_scholarship_history_archive_parents",
    ]) {
      const fn = byName.get(name);
      expect(fn, `guard function ${name}`).toBeDefined();
      expect(fn!.fields.securityMode, `${name} security mode`).toBe("INVOKER");
      expect(fn!.fields.searchPath, `${name} search path`).toEqual([]);
      expect(String(fn!.fields.bodyHash), `${name} bodyHash`).toMatch(/^[0-9a-f]{64}$/);

      const acl = fn!.fields.acl as string[];
      expect(Array.isArray(acl) && acl.length > 0, `${name} must carry an effective ACL`).toBe(true);
      const exposed = acl.filter((entry) =>
        ["=X", "=X*", "anon=X", "anon=X*", "authenticated=X", "authenticated=X*"].includes(entry)
      );
      expect(exposed, `${name} PUBLIC/anon/authenticated EXECUTE`).toHaveLength(0);
      expect(acl, `${name} service_role EXECUTE`).toContain("service_role=X");
    }
  });

  it("captures the archive-parent column-scoped triggers on the four operational child tables", () => {
    const byName = new Map(packet.catalog.triggers.map((record) => [record.fields.name, record]));
    const expected: Array<{ name: string; table: string; function: string }> = [
      { name: "trg_application_archive_parents", table: "application", function: "guard_application_archive_parents" },
      {
        name: "trg_advising_meeting_archive_student",
        table: "advising_meeting",
        function: "guard_advising_meeting_archive_student",
      },
      {
        name: "trg_fellowship_thursday_archive_student",
        table: "fellowship_thursday",
        function: "guard_fellowship_thursday_archive_student",
      },
      {
        name: "trg_scholarship_history_archive_parents",
        table: "scholarship_history",
        function: "guard_scholarship_history_archive_parents",
      },
    ];
    for (const { name, table, function: fnName } of expected) {
      const record = byName.get(name);
      expect(record, `trigger ${name}`).toBeDefined();
      expect(record!.fields.table, `${name} table`).toBe(table);
      expect(String(record!.fields.function), `${name} function`).toContain(fnName);
      expect(record!.fields.state, `${name} state`).toBe("O");
      expect(String(record!.fields.timing), `${name} timing`).toBe("ROW");
      expect(record!.fields.events, `${name} events`).toContain("INSERT");
      expect(record!.fields.events, `${name} events`).toContain("UPDATE");
      expect(String(record!.fields.definitionHash), `${name} definitionHash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("explicit admin/advisor permissions catalog (migration 20261001000001)", () => {
  it("captures advisor.role as the NOT NULL display column with the 'Advisor' default", () => {
    const column = packet.catalog.columns.find(
      (record) => record.identity === "public.advisor.role"
    );
    expect(column, "public.advisor.role").toBeDefined();
    expect(column!.fields.dataType, "advisor.role data type").toBe("text");
    expect(column!.fields.nullable, "advisor.role must stay NOT NULL").toBe(false);
    // Raw defaults are hashed (schema-only): the forward-only migration sets
    // the safe 'Advisor' default, so a default expression must be present.
    expect(String(column!.fields.defaultHash), "advisor.role defaultHash").toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures the advisor_role_display_check CHECK constraint pinning the vocabulary", () => {
    const constraint = packet.catalog.constraints.find(
      (record) => record.identity === "public.advisor.advisor_role_display_check"
    );
    expect(constraint, "advisor_role_display_check").toBeDefined();
    expect(constraint!.fields.type, "advisor_role_display_check type").toBe("CHECK");
    expect(String(constraint!.fields.definitionHash), "advisor_role_display_check definitionHash").toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("keeps is_ocf_admin as the trusted INVOKER predicate with authenticated EXECUTE after the strict-boolean replacement", () => {
    const fn = packet.catalog.functions.find((record) => record.fields.name === "is_ocf_admin");
    expect(fn, "is_ocf_admin function").toBeDefined();
    expect(fn!.fields.securityMode, "is_ocf_admin security mode").toBe("INVOKER");
    expect(fn!.fields.searchPath, "is_ocf_admin search path").toEqual([]);
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "is_ocf_admin must carry an effective ACL").toBe(true);
    expect(acl, "authenticated EXECUTE on is_ocf_admin").toContain("authenticated=X");
    const exposed = acl.filter((entry) => ["=X", "=X*", "anon=X", "anon=X*"].includes(entry));
    expect(exposed, "no PUBLIC/anon EXECUTE on is_ocf_admin").toHaveLength(0);
  });

  it("captures is_effective_admin as SECURITY DEFINER with authenticated EXECUTE and no PUBLIC/anon EXECUTE", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "is_effective_admin"
    );
    expect(fn, "is_effective_admin function").toBeDefined();
    expect(fn!.fields.securityMode, "is_effective_admin security mode").toBe("DEFINER");
    expect(fn!.fields.searchPath, "is_effective_admin search path").toEqual([]);
    expect(String(fn!.fields.bodyHash)).toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "is_effective_admin must carry an effective ACL").toBe(true);
    expect(acl, "authenticated EXECUTE on is_effective_admin").toContain("authenticated=X");
    const exposed = acl.filter((entry) => ["=X", "=X*", "anon=X", "anon=X*"].includes(entry));
    expect(exposed, "no PUBLIC/anon EXECUTE on is_effective_admin").toHaveLength(0);
  });

  it("captures the guard_advisor_role_display function as INVOKER with service_role-pinned ACLs", () => {
    const fn = packet.catalog.functions.find(
      (record) => record.fields.name === "guard_advisor_role_display"
    );
    expect(fn, "guard_advisor_role_display function").toBeDefined();
    expect(fn!.fields.securityMode, "guard_advisor_role_display security mode").toBe("INVOKER");
    expect(fn!.fields.searchPath, "guard_advisor_role_display search path").toEqual([]);
    expect(String(fn!.fields.bodyHash), "guard_advisor_role_display bodyHash").toMatch(/^[0-9a-f]{64}$/);

    const acl = fn!.fields.acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "guard_advisor_role_display must carry an effective ACL").toBe(true);
    const exposed = acl.filter((entry) =>
      ["=X", "=X*", "anon=X", "anon=X*", "authenticated=X", "authenticated=X*"].includes(entry)
    );
    expect(exposed, "guard_advisor_role_display PUBLIC/anon/authenticated EXECUTE").toHaveLength(0);
    expect(acl, "guard_advisor_role_display service_role EXECUTE").toContain("service_role=X");
  });

  it("captures the role column-scoped trigger on public.advisor", () => {
    const record = packet.catalog.triggers.find(
      (trigger) => trigger.fields.name === "trg_advisor_role_display"
    );
    expect(record, "trigger trg_advisor_role_display").toBeDefined();
    expect(record!.fields.table, "trg_advisor_role_display table").toBe("advisor");
    expect(String(record!.fields.function), "trg_advisor_role_display function").toContain(
      "guard_advisor_role_display"
    );
    expect(record!.fields.state, "trg_advisor_role_display state").toBe("O");
    expect(String(record!.fields.timing), "trg_advisor_role_display timing").toBe("ROW");
    expect(record!.fields.events, "trg_advisor_role_display events").toContain("INSERT");
    expect(record!.fields.events, "trg_advisor_role_display events").toContain("UPDATE");
    expect(String(record!.fields.definitionHash), "trg_advisor_role_display definitionHash").toMatch(
      /^[0-9a-f]{64}$/
    );
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
    // Migration 20261002000001 replaced the broad active-staff UPDATE policy
    // with the self-scoped own-profile UPDATE policy.
    expect(policyNames, "self-scoped own-profile UPDATE policy").toContain(
      "advisor_update_own_profile"
    );
    // No authenticated advisor INSERT policy exists (trusted provisioning only).
    expect(policyNames, "no advisor_insert_active_staff policy").not.toContain(
      "advisor_insert_active_staff"
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
