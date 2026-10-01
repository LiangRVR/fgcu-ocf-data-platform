/**
 * tests/contract/schema.test.ts
 *
 * Schema contract: asserts that the full migration chain
 * (20260305000000 → 20260930000006) produced exactly the expected steady state
 * on a fresh, isolated Docker-local instance:
 *   - all eight operational tables exist, with their PKs, FKs, and indexes;
 *   - the documented CHECK constraints exist;
 *   - RLS is enabled on every table;
 *   - privilege steady state (migrations ...004 + ...006): `anon` has no
 *     schema/table/sequence access; `authenticated` has CRUD and sequence
 *     access except that `advising_meeting` and `advising_meeting_amendment`
 *     are SELECT/INSERT-only AND the core historical entities `advisor`,
 *     `student`, `fellowship`, and `application` are SELECT/INSERT/UPDATE-only
 *     (authenticated DELETE revoked by migration 20260930000006);
 *   - migration 20260929000001 adds the advising↔application link columns
 *     (nullable `application.application_year`, nullable
 *     `advising_meeting.application_id`, NOT NULL `created_at` default
 *     now(), nullable `created_by_advisor_id`), the direct + composite
 *     application FKs and indexes, and the hardened non-RPC creation-metadata
 *     trigger (SECURITY DEFINER, empty search_path, EXECUTE revoked).
 *
 * Inspects the real migrated catalogs via Postgres (pg), never the hosted DB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDbPool, getContractEnv } from "./helpers/setup";

const env = getContractEnv();
let pool: Pool;

const TABLES = [
  "advisor",
  "fellowship",
  "student",
  "application",
  "advising_meeting",
  "advising_meeting_amendment",
  "fellowship_thursday",
  "scholarship_history",
] as const;

const EXPECTED_PKS: Record<string, string> = {
  advisor: "advisor_id",
  fellowship: "fellowship_id",
  student: "student_id",
  application: "application_id",
  advising_meeting: "meeting_id",
  advising_meeting_amendment: "amendment_id",
  fellowship_thursday: "attendance_id",
  scholarship_history: "history_id",
};

const EXPECTED_FKS: Record<string, { table: string; columns: string[]; foreignTable: string }> = {
  application_student_id_fkey: { table: "application", columns: ["student_id"], foreignTable: "student" },
  application_fellowship_id_fkey: { table: "application", columns: ["fellowship_id"], foreignTable: "fellowship" },
  advising_meeting_student_id_fkey: { table: "advising_meeting", columns: ["student_id"], foreignTable: "student" },
  advising_meeting_advisor_id_fkey: { table: "advising_meeting", columns: ["advisor_id"], foreignTable: "advisor" },
  // migration 20260929000001: direct + composite advising↔application FKs and
  // the creator FK to advisor.
  advising_meeting_application_id_fkey: { table: "advising_meeting", columns: ["application_id"], foreignTable: "application" },
  advising_meeting_application_student_fkey: { table: "advising_meeting", columns: ["application_id", "student_id"], foreignTable: "application" },
  advising_meeting_created_by_advisor_id_fkey: { table: "advising_meeting", columns: ["created_by_advisor_id"], foreignTable: "advisor" },
  advising_meeting_amendment_meeting_id_fkey: { table: "advising_meeting_amendment", columns: ["meeting_id"], foreignTable: "advising_meeting" },
  advising_meeting_amendment_created_by_advisor_id_fkey: { table: "advising_meeting_amendment", columns: ["created_by_advisor_id"], foreignTable: "advisor" },
  fellowship_thursday_student_id_fkey: { table: "fellowship_thursday", columns: ["student_id"], foreignTable: "student" },
  scholarship_history_student_id_fkey: { table: "scholarship_history", columns: ["student_id"], foreignTable: "student" },
  scholarship_history_fellowship_id_fkey: { table: "scholarship_history", columns: ["fellowship_id"], foreignTable: "fellowship" },
};

const EXPECTED_INDEXES = [
  "idx_student_email",
  "idx_student_is_ch",
  "idx_student_class_standing",
  "idx_application_student",
  "idx_application_fellowship",
  "idx_application_stage",
  "idx_advising_meeting_student",
  "idx_advising_meeting_date",
  "idx_fellowship_thursday_student",
  "idx_scholarship_history_student",
  "idx_scholarship_history_fellowship",
  "idx_advisor_is_active",
  // partial unique indexes from migration 20260317000003
  "advisor_email_key",
  "advisor_auth_user_id_key",
  // forward-only case-insensitive advisor-email uniqueness from ...001 (R11)
  "advisor_email_lower_key",
  // migration 20260929000001: unique (application_id, student_id) target and
  // the advising application indexes
  "application_application_id_student_id_key",
  "idx_advising_meeting_application",
  "idx_advising_meeting_student_application",
  "idx_advising_meeting_application_student",
  "idx_advising_meeting_created_by_advisor",
  "idx_advising_meeting_amendment_meeting",
  "idx_advising_meeting_amendment_created_by_advisor",
];

const EXPECTED_CHECKS = [
  "student_gpa_check",
  "student_class_standing_check",
  "student_gender_check",
  "application_stage_check",
  "advising_meeting_mode_check",
  "fellowship_thursday_source_check",
  "advising_meeting_amendment_reason_not_blank",
  "advising_meeting_amendment_details_not_blank",
];

const EXPECTED_SEQUENCES = [
  "advisor_advisor_id_seq",
  "fellowship_fellowship_id_seq",
  "student_student_id_seq",
  "application_application_id_seq",
  "advising_meeting_meeting_id_seq",
  "advising_meeting_amendment_amendment_id_seq",
  "fellowship_thursday_attendance_id_seq",
  "scholarship_history_history_id_seq",
];

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await pool.query(sql, params);
  return result.rows as Row[];
}

beforeAll(() => {
  pool = createDbPool(env);
});

afterAll(async () => {
  await pool.end();
});

describe("tables exist", () => {
  it("creates all eight operational tables", async () => {
    const rows = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );
    const names = rows.map((row) => row.table_name as string);
    for (const table of TABLES) {
      expect(names, `table ${table}`).toContain(table);
    }
  });
});

describe("primary keys", () => {
  it("assigns the documented single-column PK to every table", async () => {
    const rows = await query(
      `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
        ORDER BY tc.table_name, kcu.ordinal_position`
    );
    const pkByTable: Record<string, string[]> = {};
    for (const row of rows) {
      const table = row.table_name as string;
      (pkByTable[table] ??= []).push(row.column_name as string);
    }
    for (const table of TABLES) {
      expect(pkByTable[table], `PK for ${table}`).toEqual([EXPECTED_PKS[table]]);
    }
  });
});

describe("foreign keys", () => {
  it("defines the documented FK constraints", async () => {
    const rows = await query(
      `SELECT tc.constraint_name,
              tc.table_name,
              array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS columns,
              (SELECT DISTINCT ccu.table_name
                 FROM information_schema.constraint_column_usage AS ccu
                WHERE ccu.constraint_name = tc.constraint_name
                  AND ccu.table_schema = tc.table_schema) AS foreign_table_name
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
        GROUP BY tc.constraint_name, tc.table_name, tc.table_schema
        ORDER BY tc.constraint_name`
    );
    const fkByName: Record<string, { table: string; columns: string[]; foreignTable: string }> = {};
    for (const row of rows) {
      fkByName[row.constraint_name as string] = {
        table: row.table_name as string,
        columns: row.columns as string[],
        foreignTable: row.foreign_table_name as string,
      };
    }
    for (const [name, expected] of Object.entries(EXPECTED_FKS)) {
      expect(fkByName[name], `FK ${name}`).toEqual(expected);
    }
  });
});

describe("indexes", () => {
  it("creates the documented indexes including the partial unique email/auth indexes", async () => {
    const rows = await query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
    const names = rows.map((row) => row.indexname as string);
    for (const index of EXPECTED_INDEXES) {
      expect(names, `index ${index}`).toContain(index);
    }
  });
});

describe("CHECK constraints", () => {
  it("defines the documented CHECK constraints", async () => {
    const rows = await query(
      "SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'"
    );
    const names = rows.map((row) => row.conname as string);
    for (const check of EXPECTED_CHECKS) {
      expect(names, `CHECK ${check}`).toContain(check);
    }
  });
});

describe("sequences", () => {
  it("defines the eight backing sequences", async () => {
    const rows = await query(
      "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'"
    );
    const names = rows.map((row) => row.sequence_name as string);
    for (const sequence of EXPECTED_SEQUENCES) {
      expect(names, `sequence ${sequence}`).toContain(sequence);
    }
  });
});

describe("advising↔application link columns and defaults (migration 20260929000001)", () => {
  it("adds nullable application.application_year SMALLINT with no default", async () => {
    const rows = await query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'application'
          AND column_name = 'application_year'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type, "application_year data type").toBe("smallint");
    expect(rows[0].is_nullable, "application_year nullable").toBe("YES");
    expect(rows[0].column_default, "application_year has no default (NULL for legacy rows)").toBeNull();
  });

  it("adds nullable advising_meeting.application_id INTEGER with no default", async () => {
    const rows = await query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'advising_meeting'
          AND column_name = 'application_id'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type, "application_id data type").toBe("integer");
    expect(rows[0].is_nullable, "application_id nullable (General Advising)").toBe("YES");
    expect(rows[0].column_default, "application_id has no default").toBeNull();
  });

  it("adds NOT NULL advising_meeting.created_at TIMESTAMPTZ DEFAULT now()", async () => {
    const rows = await query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'advising_meeting'
          AND column_name = 'created_at'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type, "created_at data type").toBe("timestamp with time zone");
    expect(rows[0].is_nullable, "created_at not nullable").toBe("NO");
    expect(rows[0].column_default, "created_at default now()").toBe("now()");
  });

  it("adds nullable advising_meeting.created_by_advisor_id INTEGER with no default", async () => {
    const rows = await query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'advising_meeting'
          AND column_name = 'created_by_advisor_id'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type, "created_by_advisor_id data type").toBe("integer");
    expect(rows[0].is_nullable, "created_by_advisor_id nullable (legacy/technical writes)").toBe("YES");
    expect(rows[0].column_default, "created_by_advisor_id has no default").toBeNull();
  });

  it("adds the application UNIQUE (application_id, student_id) key as the composite FK target", async () => {
    const rows = await query(
      `SELECT conname, contype
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conname = 'application_application_id_student_id_key'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contype, "unique constraint type").toBe("u");
  });
});

describe("advising_meeting creation-metadata trigger (migration 20260929000001)", () => {
  it("creates the BEFORE INSERT OR UPDATE OF created_at, created_by_advisor_id trigger on public.advising_meeting", async () => {
    const rows = await query(
      `SELECT t.tgname, t.tgtype, t.tgenabled, a.attname AS column_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(t.tgattr)
        WHERE n.nspname = 'public'
          AND c.relname = 'advising_meeting'
          AND NOT t.tgisinternal`
    );
    const triggers = rows.filter((row) => row.tgname === "trg_advising_meeting_created_metadata");
    // Column-scoped triggers join one row per scoped attribute (the two
    // metadata columns), so the filter returns both rows for the single trigger.
    expect(triggers.length, "the creation-metadata trigger must exist").toBeGreaterThan(0);
    // tgtype bitmask: 1 (ROW) + 2 (BEFORE) + 4 (INSERT) + 16 (UPDATE) = 23.
    expect(triggers[0].tgtype, "trigger must be BEFORE ROW INSERT OR UPDATE").toBe(23);
    expect(triggers[0].tgenabled, "trigger must be enabled").toBe("O");
    // Column-scoped via UPDATE OF created_at, created_by_advisor_id.
    expect(
      triggers.map((row) => row.column_name).sort(),
      "trigger must be scoped to the two metadata columns"
    ).toEqual(["created_at", "created_by_advisor_id"]);
  });

  it("backing function is SECURITY DEFINER with empty search_path and no PUBLIC/authenticated/anon EXECUTE", async () => {
    const rows = await query(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('authenticated', 'public.set_advising_meeting_created_metadata()', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.set_advising_meeting_created_metadata()', 'EXECUTE') AS anon_exec,
              has_function_privilege('service_role', 'public.set_advising_meeting_created_metadata()', 'EXECUTE') AS sr_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'set_advising_meeting_created_metadata'`
    );
    expect(rows).toHaveLength(1);
    // prosecdef = true ⇒ SECURITY DEFINER (the narrow advisor lookup runs as
    // the migration owner; empty search_path + qualified relations harden it).
    expect(rows[0].prosecdef, "metadata function must be SECURITY DEFINER").toBe(true);
    // PostgreSQL stores an empty search_path GUC as search_path="" (quoted).
    expect(rows[0].proconfig, "metadata function must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows[0].auth_exec, "no authenticated EXECUTE on the metadata function").toBe(false);
    expect(rows[0].anon_exec, "no anon EXECUTE on the metadata function").toBe(false);
    expect(rows[0].sr_exec, "service_role EXECUTE pins a non-default non-empty ACL").toBe(true);
  });
});

describe("row level security", () => {
  it("enables RLS on every operational table", async () => {
    const rows = await query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity
        ORDER BY c.relname`
    );
    const names = rows.map((row) => row.relname as string);
    for (const table of TABLES) {
      expect(names, `RLS on ${table}`).toContain(table);
    }
  });
});

describe("no self-link RPC exists (identity binding is admin-only, R11)", () => {
  it("does not create link_current_advisor or any other self-link function", async () => {
    const rows = await query(
      `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('link_current_advisor', 'link_self', 'self_link_advisor')`
    );
    expect(rows, "no self-link RPC may exist in the fixed schema").toHaveLength(0);
  });
});

describe("invoker-security one-time-bind trigger (rows 16-24, R1/R11)", () => {
  it("creates the BEFORE INSERT OR UPDATE OF auth_user_id trigger on public.advisor", async () => {
    const rows = await query(
      `SELECT t.tgname, t.tgtype, t.tgenabled, a.attname AS column_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(t.tgattr)
        WHERE n.nspname = 'public'
          AND c.relname = 'advisor'
          AND NOT t.tgisinternal`
    );
    const trigger = rows.find((row) => row.tgname === "trg_advisor_auth_user_id_one_time_bind");
    expect(trigger, "the one-time-bind trigger must exist").toBeTruthy();
    // tgtype bitmask: 1 (ROW) + 2 (BEFORE) + 4 (INSERT) + 16 (UPDATE) = 23, and
    // the trigger is column-scoped to `auth_user_id` via UPDATE OF.
    expect(trigger!.tgtype).toBe(23);
    expect(trigger!.column_name, "trigger must be scoped to auth_user_id").toBe("auth_user_id");
    expect(trigger!.tgenabled, "trigger must be enabled").toBe("O");
  });

  it("backing guard function is SECURITY INVOKER with no PUBLIC/authenticated/anon EXECUTE", async () => {
    const rows = await query(
      `SELECT p.prosecdef, p.proacl,
              has_function_privilege('authenticated', 'public.guard_advisor_auth_user_id_one_time_bind()', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.guard_advisor_auth_user_id_one_time_bind()', 'EXECUTE') AS anon_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'guard_advisor_auth_user_id_one_time_bind'`
    );
    expect(rows).toHaveLength(1);
    // prosecdef = false ⇒ SECURITY INVOKER (the trust check sees the real
    // invoking session and cannot be bypassed by definer privilege).
    expect(rows[0].prosecdef, "guard function must be SECURITY INVOKER").toBe(false);
    expect(rows[0].auth_exec, `no authenticated EXECUTE on the guard function (proacl=${rows[0].proacl})`).toBe(false);
    expect(rows[0].anon_exec, `no anon EXECUTE on the guard function (proacl=${rows[0].proacl})`).toBe(false);
  });
});

describe("privilege steady state (migrations ...004 + ...006 core-history DELETE lockdown)", () => {
  it("revokes anon access entirely and restricts authenticated DELETE to non-core operational rows", async () => {
    const rows = await query(
      `SELECT c.relname,
              has_table_privilege('anon', c.oid, 'SELECT')   AS anon_select,
              has_table_privilege('anon', c.oid, 'INSERT')   AS anon_insert,
              has_table_privilege('anon', c.oid, 'UPDATE')   AS anon_update,
              has_table_privilege('anon', c.oid, 'DELETE')   AS anon_delete,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
              has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
              has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update,
              has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_delete
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [TABLES]
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) {
      for (const col of ["anon_select", "anon_insert", "anon_update", "anon_delete"] as const) {
        expect(row[col], `${row.relname}.${col}`).toBe(false);
      }
      for (const col of ["auth_select", "auth_insert"] as const) {
        expect(row[col], `${row.relname}.${col}`).toBe(true);
      }
    }

    // UPDATE is revoked from authenticated only on the append-only histories.
    const updateRevoked = new Set(["advising_meeting", "advising_meeting_amendment"]);
    // DELETE is revoked from authenticated on the append-only histories AND on
    // the core historical entities (migration 20260930000006). The operational
    // rows fellowship_thursday / scholarship_history keep authenticated DELETE.
    const deleteRevoked = new Set([
      "advisor",
      "student",
      "fellowship",
      "application",
      "advising_meeting",
      "advising_meeting_amendment",
    ]);
    for (const row of rows) {
      expect(row.auth_update, `${row.relname}.auth_update`).toBe(!updateRevoked.has(String(row.relname)));
      expect(row.auth_delete, `${row.relname}.auth_delete`).toBe(!deleteRevoked.has(String(row.relname)));
    }
  });

  it("permits schema usage while table and sequence privileges enforce access", async () => {
    const rows = await query(
      "SELECT has_schema_privilege('anon', 'public', 'USAGE') AS anon_usage, has_schema_privilege('authenticated', 'public', 'USAGE') AS auth_usage"
    );
    expect(rows[0].anon_usage).toBe(true);
    expect(rows[0].auth_usage).toBe(true);
  });

  it("revokes anon sequence access and grants usage+select to authenticated", async () => {
    const rows = await query(
      `SELECT sequence_name,
              has_sequence_privilege('anon', 'public.' || sequence_name, 'USAGE')  AS anon_usage,
              has_sequence_privilege('anon', 'public.' || sequence_name, 'SELECT') AS anon_select,
              has_sequence_privilege('authenticated', 'public.' || sequence_name, 'USAGE')  AS auth_usage,
              has_sequence_privilege('authenticated', 'public.' || sequence_name, 'SELECT') AS auth_select
         FROM information_schema.sequences
        WHERE sequence_schema = 'public'
          AND sequence_name = ANY($1::text[])
        ORDER BY sequence_name`,
      [EXPECTED_SEQUENCES]
    );
    expect(rows).toHaveLength(EXPECTED_SEQUENCES.length);
    for (const row of rows) {
      expect(row.anon_usage, `${row.sequence_name}.anon_usage`).toBe(false);
      expect(row.anon_select, `${row.sequence_name}.anon_select`).toBe(false);
      expect(row.auth_usage, `${row.sequence_name}.auth_usage`).toBe(true);
      expect(row.auth_select, `${row.sequence_name}.auth_select`).toBe(true);
    }
  });
});

describe("core-history DELETE lockdown policy shape (migration 20260930000006)", () => {
  it("leaves no authenticated DELETE policy on advisor, student, fellowship, or application", async () => {
    const rows = await query(
      `SELECT tablename, policyname, cmd, roles::text[] AS roles
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname`,
      [["advisor", "student", "fellowship", "application"]]
    );
    const deletePolicies = rows.filter((row) => String(row.cmd).toUpperCase().includes("DELETE"));
    expect(deletePolicies, "no DELETE policy may exist on the core tables").toHaveLength(0);

    // The FOR ALL active-advisor policies were split into explicit SELECT /
    // INSERT / UPDATE policies (the append-only advising_meeting style); the
    // advisor DELETE policy is gone while its SELECT/INSERT/UPDATE remain.
    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      const table = String(row.tablename);
      const list = byTable.get(table) ?? [];
      list.push(`${String(row.cmd).toUpperCase()}:${String(row.policyname)}`);
      byTable.set(table, list);
    }
    expect(byTable.get("student")?.sort()).toEqual([
      "INSERT:active_advisor_insert_student",
      "SELECT:active_advisor_select_student",
      "UPDATE:active_advisor_update_student",
    ]);
    expect(byTable.get("fellowship")?.sort()).toEqual([
      "INSERT:active_advisor_insert_fellowship",
      "SELECT:active_advisor_select_fellowship",
      "UPDATE:active_advisor_update_fellowship",
    ]);
    expect(byTable.get("application")?.sort()).toEqual([
      "INSERT:active_advisor_insert_application",
      "SELECT:active_advisor_select_application",
      "UPDATE:active_advisor_update_application",
    ]);
    expect(byTable.get("advisor")?.sort()).toEqual([
      "INSERT:advisor_insert_active_staff",
      "SELECT:advisor_select_self_or_active_staff",
      "UPDATE:advisor_update_active_staff_only",
    ]);
  });

  it("keeps service_role DELETE privileges on the core tables (fixture-cleanup path)", async () => {
    const rows = await query(
      `SELECT c.relname,
              has_table_privilege('service_role', c.oid, 'DELETE') AS sr_delete
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [["advisor", "student", "fellowship", "application"]]
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.sr_delete, `${row.relname}.service_role DELETE`).toBe(true);
    }
  });
});

describe("advising_meeting append-only policy shape (migration 20260930000003)", () => {
  it("has only active-advisor SELECT and INSERT policies, never UPDATE or DELETE", async () => {
    const rows = await query(
      `SELECT policyname, cmd, roles::text[] AS roles
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'advising_meeting'
        ORDER BY policyname`
    );
    expect(rows).toEqual([
      { policyname: "active_advisor_insert_advising_meeting", cmd: "INSERT", roles: ["authenticated"] },
      { policyname: "active_advisor_select_advising_meeting", cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });
});

describe("advising_meeting_amendment schema and policy shape (migration 20260930000004)", () => {
  it("uses required meeting, creator, timestamp, reason, and details columns", async () => {
    const rows = await query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'advising_meeting_amendment'
        ORDER BY ordinal_position`
    );
    expect(rows).toEqual([
      { column_name: "amendment_id", data_type: "integer", is_nullable: "NO", column_default: expect.any(String) },
      { column_name: "meeting_id", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "created_by_advisor_id", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { column_name: "reason", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "details", data_type: "text", is_nullable: "NO", column_default: null },
    ]);
  });

  it("has only active-advisor SELECT and INSERT policies, never UPDATE or DELETE", async () => {
    const rows = await query(
      `SELECT policyname, cmd, roles::text[] AS roles
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'advising_meeting_amendment'
        ORDER BY policyname`
    );
    expect(rows).toEqual([
      { policyname: "active_advisor_insert_advising_meeting_amendment", cmd: "INSERT", roles: ["authenticated"] },
      { policyname: "active_advisor_select_advising_meeting_amendment", cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });

  it("enforces trim-aware nonempty reason and details via CHECK constraints", async () => {
    const rows = await query(
      `SELECT c.conname, a.attname AS column_name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint AS c
         JOIN pg_class AS t ON t.oid = c.conrelid
         JOIN pg_namespace AS n ON n.oid = t.relnamespace
         JOIN pg_attribute AS a
           ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE n.nspname = 'public'
          AND t.relname = 'advising_meeting_amendment'
          AND c.contype = 'c'
        ORDER BY c.conname`
    );
    expect(
      rows.map((row) => ({ conname: row.conname, column_name: row.column_name }))
    ).toEqual([
      { conname: "advising_meeting_amendment_details_not_blank", column_name: "details" },
      { conname: "advising_meeting_amendment_reason_not_blank", column_name: "reason" },
    ]);
    for (const row of rows) {
      // Trim-aware: the CHECK trims whitespace and requires a non-empty result.
      expect(String(row.definition), `${row.conname} is trim-aware`).toContain("btrim");
      expect(String(row.definition), `${row.conname} rejects empty`).toContain("<>");
    }
  });

  it("defines the amendment retrieval index on (meeting_id, created_at, amendment_id)", async () => {
    const rows = await query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_advising_meeting_amendment_meeting'`
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].indexdef)).toMatch(/\(meeting_id, created_at, amendment_id\)/);
  });
});

describe("entity lifecycle archiving steady state (migration 20260930000005)", () => {
  it("adds nullable student.archived_at and fellowship.archived_at TIMESTAMPTZ with no default", async () => {
    const rows = await query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'archived_at'
        ORDER BY table_name`
    );
    expect(rows.map((row) => row.table_name)).toEqual(["fellowship", "student"]);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.archived_at data type`).toBe("timestamp with time zone");
      expect(row.is_nullable, `${row.table_name}.archived_at nullable`).toBe("YES");
      expect(row.column_default, `${row.table_name}.archived_at has no default`).toBeNull();
    }
  });

  it("creates the archive-filter lifecycle indexes", async () => {
    const rows = await query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_student_archived_at', 'idx_fellowship_archived_at')`
    );
    const names = rows.map((row) => row.indexname as string);
    expect(names, "student archive index").toContain("idx_student_archived_at");
    expect(names, "fellowship archive index").toContain("idx_fellowship_archived_at");
  });

  it("creates is_ocf_admin as a SECURITY INVOKER trusted predicate with empty search_path and authenticated-only EXECUTE", async () => {
    const rows = await query(
      `SELECT p.prosecdef, p.proconfig, p.proacl::text[] AS acl,
              has_function_privilege('authenticated', 'public.is_ocf_admin()', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.is_ocf_admin()', 'EXECUTE') AS anon_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'is_ocf_admin'`
    );
    expect(rows).toHaveLength(1);
    // prosecdef = false ⇒ SECURITY INVOKER: the JWT claim GUCs resolve the same
    // for authenticated and definer contexts, so no definer privilege is used.
    expect(rows[0].prosecdef, "is_ocf_admin must be SECURITY INVOKER").toBe(false);
    expect(rows[0].proconfig, "is_ocf_admin must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows[0].auth_exec, "authenticated EXECUTE on is_ocf_admin").toBe(true);
    expect(rows[0].anon_exec, "no anon EXECUTE on is_ocf_admin").toBe(false);

    // Effective ACL: the migration REVOKEs ALL from PUBLIC and anon. A PUBLIC
    // grant is an aclitem with an EMPTY grantee (`=X/...`), so no captured
    // entry may start with `=`.
    const acl = rows[0].acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "is_ocf_admin must carry an effective ACL").toBe(true);
    const publicEntries = acl.filter((entry) => entry.startsWith("="));
    expect(publicEntries, "no PUBLIC EXECUTE on is_ocf_admin").toHaveLength(0);
  });

  it("creates lifecycle_transition as SECURITY DEFINER with empty search_path; technical sessions are rejected by the actor check", async () => {
    const rows = await query(
      `SELECT p.prosecdef, p.proconfig, p.proacl::text[] AS acl,
              has_function_privilege('authenticated', 'public.lifecycle_transition(text, text, integer)', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.lifecycle_transition(text, text, integer)', 'EXECUTE') AS anon_exec,
              has_function_privilege('service_role', 'public.lifecycle_transition(text, text, integer)', 'EXECUTE') AS sr_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'lifecycle_transition'`
    );
    expect(rows).toHaveLength(1);
    // prosecdef = true ⇒ SECURITY DEFINER (migration-owned): the RPC is the only
    // normal lifecycle path and runs with the migration owner's privileges.
    expect(rows[0].prosecdef, "lifecycle_transition must be SECURITY DEFINER").toBe(true);
    expect(rows[0].proconfig, "lifecycle_transition must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows[0].auth_exec, "authenticated EXECUTE on lifecycle_transition").toBe(true);
    expect(rows[0].anon_exec, "no anon EXECUTE on lifecycle_transition").toBe(false);
    // Supabase default privileges grant EXECUTE on new `public` functions to
    // service_role as well; the migration does not revoke that. The operative
    // technical-session control is the RPC's actor derivation: `auth.uid()`
    // is NULL for a service_role/DBA session, so the RPC raises 42501 and the
    // transition can never be completed or attributed (proven behaviorally in
    // lifecycle-archiving.test.ts). Pin the default-grant reality so a future
    // ACL change is noticed.
    expect(rows[0].sr_exec, "service_role retains default-granted EXECUTE (denied later by the actor check)").toBe(true);
    // No PUBLIC EXECUTE survives the migration's REVOKE ALL FROM PUBLIC.
    const acl = rows[0].acl as string[];
    expect(Array.isArray(acl) && acl.length > 0, "lifecycle_transition must carry an effective ACL").toBe(true);
    const publicEntries = acl.filter((entry) => entry.startsWith("="));
    expect(publicEntries, "no PUBLIC EXECUTE on lifecycle_transition").toHaveLength(0);
  });

  it("creates the invoker-security lifecycle guard functions with service_role-pinned EXECUTE", async () => {
    const rows = await query(
      `SELECT p.proname,
              p.prosecdef,
              has_function_privilege('authenticated', 'public.' || p.proname || '()', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.' || p.proname || '()', 'EXECUTE') AS anon_exec,
              has_function_privilege('service_role', 'public.' || p.proname || '()', 'EXECUTE') AS sr_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'guard_student_archived_at_lifecycle',
            'guard_fellowship_archived_at_lifecycle',
            'guard_advisor_is_active_lifecycle'
          )
        ORDER BY p.proname`
    );
    expect(rows.map((row) => row.proname)).toEqual([
      "guard_advisor_is_active_lifecycle",
      "guard_fellowship_archived_at_lifecycle",
      "guard_student_archived_at_lifecycle",
    ]);
    for (const row of rows) {
      // SECURITY INVOKER: current_user/session_user reflect the real executing
      // session, so the trust check cannot be granted away by definer privilege.
      expect(row.prosecdef, `${row.proname} must be SECURITY INVOKER`).toBe(false);
      expect(row.auth_exec, `no authenticated EXECUTE on ${row.proname}`).toBe(false);
      expect(row.anon_exec, `no anon EXECUTE on ${row.proname}`).toBe(false);
      expect(row.sr_exec, `service_role EXECUTE pins the ${row.proname} ACL`).toBe(true);
    }
  });

  it("creates the column-scoped lifecycle triggers enabled on student, fellowship, and advisor", async () => {
    const rows = await query(
      `SELECT t.tgname, c.relname AS table, f.proname AS function, t.tgtype, t.tgenabled,
              a.attname AS column_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc f ON f.oid = t.tgfoid
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(t.tgattr)
        WHERE n.nspname = 'public'
          AND t.tgname IN (
            'trg_student_archived_at_lifecycle',
            'trg_fellowship_archived_at_lifecycle',
            'trg_advisor_is_active_lifecycle'
          )
          AND NOT t.tgisinternal
        ORDER BY t.tgname, a.attname`
    );
    const expected = [
      { tgname: "trg_advisor_is_active_lifecycle", table: "advisor", column: "is_active", function: "guard_advisor_is_active_lifecycle" },
      { tgname: "trg_fellowship_archived_at_lifecycle", table: "fellowship", column: "archived_at", function: "guard_fellowship_archived_at_lifecycle" },
      { tgname: "trg_student_archived_at_lifecycle", table: "student", column: "archived_at", function: "guard_student_archived_at_lifecycle" },
    ];
    expect(rows).toHaveLength(3);
    for (const [index, want] of expected.entries()) {
      expect(rows[index].tgname).toBe(want.tgname);
      expect(rows[index].table, `${want.tgname} table`).toBe(want.table);
      expect(rows[index].column_name, `${want.tgname} must be column-scoped`).toBe(want.column);
      expect(String(rows[index].function), `${want.tgname} function`).toContain(want.function);
      expect(rows[index].tgenabled, `${want.tgname} must be enabled`).toBe("O");
      // tgtype bitmask: 1 (ROW) + 2 (BEFORE) + 4 (INSERT) + 16 (UPDATE) = 23.
      expect(rows[index].tgtype, `${want.tgname} must be BEFORE ROW INSERT OR UPDATE`).toBe(23);
    }
  });

  it("keeps every FK on the default NO ACTION semantics (no FK touched by migration ...005)", async () => {
    const rows = await query(
      `SELECT conname, confdeltype, confupdtype
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND contype = 'f'`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.confdeltype, `${row.conname} confdeltype`).toBe("a");
      expect(row.confupdtype, `${row.conname} confupdtype`).toBe("a");
    }
  });
});
