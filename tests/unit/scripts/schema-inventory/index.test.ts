/**
 * tests/unit/scripts/schema-inventory/index.test.ts
 *
 * End-to-end public-API test: build remote + local inventories from
 * migration-derived fixtures, diff them (with a reviewed disposition manifest
 * where appropriate), and verify classification, blocking behavior, PII-safe
 * records, and redaction — mirroring the real reconciliation lane (plan
 * Work 2/4) without touching a live database.
 */

import { describe, expect, it } from "vitest";
import {
  assertLoopbackDbUrl,
  captureLocalInventory,
  diffInventories,
  InventoryValidationError,
  parseDispositionManifest,
  parseInventoryPacket,
  redactString,
  toRedactedJson,
  validateInventoryPacket,
} from "../../../../scripts/schema-inventory";
import { INVENTORY_FORMAT_VERSION, type CatalogRecord, type CatalogSection, type DispositionManifest, type SchemaInventory } from "../../../../scripts/schema-inventory/types";

function emptyCatalog(): Record<CatalogSection, CatalogRecord[]> {
  const catalog = {} as Record<CatalogSection, CatalogRecord[]>;
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
    catalog[section] = [];
  }
  return catalog;
}

function packet(
  source: "remote" | "local",
  catalog: Record<CatalogSection, CatalogRecord[]> = emptyCatalog()
): SchemaInventory {
  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    source,
    capturedAt: "2026-09-25T00:00:00.000Z",
    catalog,
  };
}

// Fixture derived from 20260317000004/20260318000001: production records the
// amended A1 SELECT policy (`auth_user_id = auth.uid()`), while the local
// migration chain would produce the older email-match variant — a real
// conflict. The active-staff UPDATE policy is production-only (reviewed
// remote-only intended), the advisor_email_lower_key index is reviewed
// remote-only intended, and the ledger versions differ (reviewed mappings).
const remoteLockdown: Record<CatalogSection, CatalogRecord[]> = {
  ...emptyCatalog(),
  tables: [
    {
      identity: "public.advisor",
      source: "pg_class: public.advisor",
      fields: { schema: "public", name: "advisor", kind: "table", persistence: "p" },
    },
  ],
  functions: [
    {
      identity: "public.guard_advisor_auth_user_id_one_time_bind()",
      source: "pg_proc: public.guard_advisor_auth_user_id_one_time_bind()",
      fields: {
        schema: "public",
        name: "guard_advisor_auth_user_id_one_time_bind",
        signature: "",
        returnType: "trigger",
        language: "plpgsql",
        volatility: "v",
        securityMode: "INVOKER",
        searchPath: [],
        acl: ["=X", "postgres=X"],
        bodyHash: "a".repeat(64),
      },
    },
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
        searchPath: ["public"],
        acl: ["authenticated=X", "postgres=X"],
        bodyHash: "b".repeat(64),
      },
    },
  ],
  triggers: [
    {
      identity: "public.advisor.trg_advisor_auth_user_id_one_time_bind",
      source: "pg_trigger: public.advisor.trg_advisor_auth_user_id_one_time_bind",
      fields: {
        schema: "public",
        table: "advisor",
        name: "trg_advisor_auth_user_id_one_time_bind",
        function: "guard_advisor_auth_user_id_one_time_bind",
        state: "O",
        timing: "ROW",
        events: ["INSERT", "UPDATE"],
        definitionHash: "c".repeat(64),
      },
    },
  ],
  rls: [
    {
      identity: "public.advisor",
      source: "pg_class(relrowsecurity): public.advisor",
      fields: { schema: "public", table: "advisor", enabled: true, forced: false },
    },
  ],
  policies: [
    {
      identity: "public.advisor.advisor_select_self_or_active_staff",
      source: "pg_policy: public.advisor.advisor_select_self_or_active_staff",
      fields: {
        schema: "public",
        table: "advisor",
        name: "advisor_select_self_or_active_staff",
        command: "SELECT",
        roles: ["authenticated"],
        permissive: true,
        usingHash: "d".repeat(64),
        withCheckHash: null,
      },
    },
    {
      identity: "public.advisor.advisor_update_active_staff_only",
      source: "pg_policy: public.advisor.advisor_update_active_staff_only",
      fields: {
        schema: "public",
        table: "advisor",
        name: "advisor_update_active_staff_only",
        command: "UPDATE",
        roles: ["authenticated"],
        permissive: true,
        usingHash: "e".repeat(64),
        withCheckHash: "f".repeat(64),
      },
    },
  ],
  indexes: [
    {
      identity: "public.advisor.advisor_email_lower_key",
      source: "pg_index: public.advisor.advisor_email_lower_key",
      fields: {
        schema: "public",
        table: "advisor",
        name: "advisor_email_lower_key",
        unique: true,
        definitionHash: "1".repeat(64),
      },
    },
  ],
  migrationLedger: [
    {
      identity: "20260924065221",
      source: "supabase_migrations.schema_migrations",
      fields: { version: "20260924065221", name: "advisor_self_activation_lockdown" },
    },
  ],
};

// Local (repository chain) side: the Git migration chain would produce the
// older email-match SELECT policy (a conflict), no active-staff UPDATE policy
// (reviewed remote-only), no email_lower index (reviewed remote-only), and the
// Git-tracked migration version (reviewed local-only missing).
const localLockdown: Record<CatalogSection, CatalogRecord[]> = {
  ...remoteLockdown,
  policies: [
    {
      identity: "public.advisor.advisor_select_self_or_active_staff",
      source: "pg_policy: public.advisor.advisor_select_self_or_active_staff",
      fields: {
        schema: "public",
        table: "advisor",
        name: "advisor_select_self_or_active_staff",
        command: "SELECT",
        roles: ["authenticated"],
        permissive: true,
        usingHash: "9".repeat(64),
        withCheckHash: null,
      },
    },
  ],
  indexes: [],
  migrationLedger: [
    {
      identity: "20260318000001",
      source: "supabase_migrations.schema_migrations",
      fields: { version: "20260318000001", name: "advisor_self_activation_lockdown" },
    },
  ],
};

function reviewedManifest(): DispositionManifest {
  return {
    formatVersion: 1,
    reviewed: [
      { section: "policies", identity: "public.advisor.advisor_update_active_staff_only", disposition: "remote-only intended" },
      { section: "indexes", identity: "public.advisor.advisor_email_lower_key", disposition: "remote-only intended" },
      { section: "migrationLedger", identity: "20260924065221", disposition: "remote-only intended" },
      { section: "migrationLedger", identity: "20260318000001", disposition: "local-only missing" },
    ],
  };
}

describe("end-to-end reconciliation pipeline", () => {
  it("classifies the real remote/local divergence with blocking dispositions", () => {
    const remote = packet("remote", remoteLockdown);
    const local = packet("local", localLockdown);
    const register = diffInventories(remote, local, reviewedManifest());

    const byKey = new Map(register.entries.map((e) => [e.identity, e.disposition]));

    // Identical lockdown objects are equivalent.
    expect(byKey.get("public.advisor")).toBe("equivalent");
    expect(byKey.get("public.advisor.trg_advisor_auth_user_id_one_time_bind")).toBe("equivalent");
    expect(byKey.get("public.advisor.advisor_select_self_or_active_staff")).toBe("conflict");

    // Reviewed remote-only objects.
    expect(byKey.get("public.advisor.advisor_update_active_staff_only")).toBe("remote-only intended");
    expect(byKey.get("public.advisor.advisor_email_lower_key")).toBe("remote-only intended");
    expect(byKey.get("20260924065221")).toBe("remote-only intended");

    // Reviewed local-only object.
    expect(byKey.get("20260318000001")).toBe("local-only missing");

    expect(register.blocked).toBe(true); // the policy conflict blocks
    expect(register.summary.conflict).toBe(1);
    expect(register.summary.equivalent).toBeGreaterThanOrEqual(4);
    expect(register.summary["remote-only intended"]).toBe(3);
    expect(register.summary["local-only missing"]).toBe(1);
    expect(register.summary.unknown).toBe(0);
  });

  it("blocks when unmatched objects lack manifest authorization", () => {
    // Drop the manifest: the reviewed objects become unknown and block.
    const register = diffInventories(packet("remote", remoteLockdown), packet("local", localLockdown));
    expect(register.blocked).toBe(true);
    expect(register.summary.unknown).toBeGreaterThanOrEqual(4);
    expect(register.summary["remote-only intended"]).toBe(0);
    expect(register.summary["local-only missing"]).toBe(0);
  });

  it("fails closed through the public assertNoBlocking API", () => {
    const register = diffInventories(packet("remote", remoteLockdown), packet("local", localLockdown));
    expect(register.blocked).toBe(true);
  });

  it("serializes a redacted register with no credentials", () => {
    const register = diffInventories(packet("remote", remoteLockdown), packet("local", localLockdown), reviewedManifest());
    const json = toRedactedJson(register);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("postgresql://");
    expect(json).not.toContain("eyJ");
  });

  it("records carry hashes, not raw SQL", () => {
    const remote = packet("remote", remoteLockdown);
    const json = JSON.stringify(remote);
    for (const record of Object.values(remote.catalog).flat()) {
      for (const value of Object.values(record.fields)) {
        if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) continue;
        // Every string field is either a short structural token or null.
        expect(json, `raw SQL leak in ${record.identity}`).not.toContain("SELECT ");
      }
    }
  });
});

describe("public API input/output safety", () => {
  it("round-trips packets through parse + validate without mutation", () => {
    const original = packet("remote", remoteLockdown);
    const text = JSON.stringify(original);
    const parsed = parseInventoryPacket(text);
    const validated = validateInventoryPacket(JSON.parse(text));
    expect(parsed).toEqual(validated);
    expect(validated.catalog.policies).toHaveLength(2);
    expect(validated.catalog.extensions).toEqual([]);
  });

  it("rejects a packet carrying row-data under a catalog section", () => {
    const bad = packet("remote");
    bad.catalog.tables = [
      {
        identity: "public.student",
        source: "pg_class: public.student",
        fields: { schema: "public", name: "student", kind: "table", persistence: "p" },
        rows: [{ full_name: "Jane Doe", gpa: 3.9 }],
      } as unknown as CatalogRecord,
    ];
    const text = JSON.stringify(bad);
    expect(() => parseInventoryPacket(text)).toThrow(InventoryValidationError);
  });

  it("round-trips and validates a disposition manifest", () => {
    const manifest = reviewedManifest();
    const parsed = parseDispositionManifest(JSON.stringify(manifest));
    expect(parsed.reviewed).toHaveLength(4);
  });

  it("redactString masks credentials embedded in catalog text", () => {
    const text = "CHECK (connection_string = 'postgresql://user:sekrit@127.0.0.1/db')";
    const out = redactString(text);
    expect(out).not.toContain("sekrit");
    expect(out).toContain("[REDACTED]");
  });

  it("assertLoopbackDbUrl accepts localhost and rejects hosted", () => {
    expect(() => assertLoopbackDbUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).not.toThrow();
    expect(() => assertLoopbackDbUrl("postgresql://postgres:pass@db.supabase.co:5432/postgres")).toThrow(InventoryValidationError);
  });

  it("captureLocalInventory rejects non-loopback URLs (no live DB needed)", async () => {
    await expect(captureLocalInventory("postgresql://postgres:pw@10.0.0.9:5432/postgres")).rejects.toBeInstanceOf(
      InventoryValidationError
    );
  });
});