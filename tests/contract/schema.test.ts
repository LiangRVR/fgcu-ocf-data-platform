/**
 * tests/contract/schema.test.ts
 *
 * Schema contract: asserts that the full migration chain
 * (20260305000000 → 20260929000001) produced exactly the expected steady state
 * on a fresh, isolated Docker-local instance:
 *   - all seven operational tables exist, with their PKs, FKs, and indexes;
 *   - the documented CHECK constraints exist;
 *   - RLS is enabled on every table;
 *   - migration ...004 privilege steady state: `anon` has no schema/table/
 *     sequence access; `authenticated` has full CRUD and sequence access;
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
  "fellowship_thursday",
  "scholarship_history",
] as const;

const EXPECTED_PKS: Record<string, string> = {
  advisor: "advisor_id",
  fellowship: "fellowship_id",
  student: "student_id",
  application: "application_id",
  advising_meeting: "meeting_id",
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
];

const EXPECTED_CHECKS = [
  "student_gpa_check",
  "student_class_standing_check",
  "student_gender_check",
  "application_stage_check",
  "advising_meeting_mode_check",
  "fellowship_thursday_source_check",
];

const EXPECTED_SEQUENCES = [
  "advisor_advisor_id_seq",
  "fellowship_fellowship_id_seq",
  "student_student_id_seq",
  "application_application_id_seq",
  "advising_meeting_meeting_id_seq",
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
  it("creates all seven operational tables", async () => {
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
  it("defines the seven backing sequences", async () => {
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

describe("migration ...004 privilege steady state", () => {
  it("revokes all anon access and grants authenticated CRUD on every table", async () => {
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
      for (const col of ["auth_select", "auth_insert", "auth_update", "auth_delete"] as const) {
        expect(row[col], `${row.relname}.${col}`).toBe(true);
      }
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
