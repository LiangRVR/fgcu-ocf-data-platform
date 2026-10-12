/**
 * tests/contract/audit-upgrade-path.test.ts
 *
 * Upgrade-path contract for migration 20261012000001_immutable_audit (the
 * immutable audit trail), mirroring the `upgrade-path.test.ts` technique: the
 * REAL committed migration files are replayed VERBATIM against a throwaway
 * scratch database on the same isolated Docker-local instance, with legacy
 * pre-existing rows present before the audit migration applies.
 *
 * Proves:
 *
 *  - NO BASELINE FABRICATION (R9): rows that already exist when the audit
 *    migration applies receive NO audit events — `public.audit_event` is empty
 *    immediately after the upgrade and those legacy rows stay byte-for-byte
 *    unchanged (the migration never touches pre-existing data).
 *  - FIRST-EVENT AFTER UPGRADE: the first later mutation on a legacy row
 *    writes exactly the FIRST event, with no request actor → System/system
 *    origin, and the approved explicit snapshot whitelist (including
 *    `student.archived_at`) — nothing is inferred or backfilled.
 *  - ATOMIC ROLLBACK (R3): a FORCED audit-INSERT failure (a transaction-scoped
 *    BEFORE INSERT trigger on audit_event that raises) aborts and rolls back
 *    the source mutation together with the audit row — the legacy row is
 *    unchanged and no audit event survives.
 *
 * Safety: the scratch database exists only on the loopback instance, is named
 * uniquely per run, and is dropped in teardown. No migration file is modified
 * or re-ordered. The service role / direct SQL are used strictly for this
 * local replay (never asserted as an access grant).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { attachPoolErrorHandler, createDbPool, getContractEnv } from "./helpers/setup";
import { syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();

// The runner always launches tests with the repository root as cwd.
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const AUDIT_MIGRATION = "20261012000001_immutable_audit.sql";

/** Minimal auth-schema functions used by the pre-audit migration chain. */
const AUTH_SCAFFOLD_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text
$$;

-- The 20261002000001 migration's apply-time statement resolves
-- auth.users.raw_app_meta_data.ocf_admin for existing advisor rows; a minimal
-- stub (never populated, never asserted) satisfies that resolution while the
-- explorer/adjuster functions remain plpgsql (bodies are not checked at
-- CREATE time).
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    raw_app_meta_data jsonb DEFAULT '{}'::jsonb
);
`;

/** The approved student snapshot whitelist (sorted for equality checks). */
const STUDENT_WHITELIST_SORTED = [
  "age",
  "archived_at",
  "class_standing",
  "email",
  "first_gen",
  "full_name",
  "gender",
  "gpa",
  "honors_college",
  "is_ch_student",
  "languages",
  "major",
  "minor",
  "pronouns",
  "race_ethnicity",
  "us_citizen",
].sort();

let adminPool: Pool;
let scratchPool: Pool | null = null;
let scratchDbName = "";

interface AuditUpgradeFixtures {
  studentId: number;
  fellowshipId: number;
  applicationId: number;
  original: {
    studentFullName: string;
    studentEmail: string;
    studentGpa: number;
    classStanding: string;
    fellowshipName: string;
    appStage: string;
    appYear: number;
    destinationCountry: string;
  };
}
let upgraded: AuditUpgradeFixtures | null = null;

async function applySql(pool: Pool, sql: string, label: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (caught) {
    throw new Error(`${label} failed on the scratch database: ${(caught as Error).message}`);
  }
}

beforeAll(async () => {
  adminPool = createDbPool(env);

  // A scratch database unique to this run on the isolated lane instance.
  scratchDbName = `ocf_contract_audit_upgrade_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await adminPool.query(`CREATE DATABASE ${scratchDbName}`);

  const scratchUrl = new URL(env.dbUrl);
  scratchUrl.pathname = `/${scratchDbName}`;
  scratchPool = attachPoolErrorHandler(
    new Pool({
      connectionString: scratchUrl.toString(),
      max: 2,
      connectionTimeoutMillis: 10_000,
    }),
    "audit-upgrade-path scratch"
  );

  // Scaffold the auth functions the pre-audit migrations reference.
  await applySql(scratchPool, AUTH_SCAFFOLD_SQL, "auth scaffold");

  // Read the REAL committed migration files, preserving their order.
  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const auditIndex = migrationFiles.indexOf(AUDIT_MIGRATION);
  expect(auditIndex, `${AUDIT_MIGRATION} must exist in the migration directory`).toBeGreaterThan(0);
  const preAuditFiles = migrationFiles.slice(0, auditIndex);

  // Apply the ENTIRE pre-audit chain (20260305000000 → 20261011000001)
  // verbatim, so the audit migration runs over the exact production schema.
  for (const file of preAuditFiles) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await applySql(scratchPool, sql, `migration ${file}`);
  }

  // Seed LEGACY pre-existing rows BEFORE the audit migration applies.
  const studentName = syntheticName("audit-upgrade-student");
  const studentEmail = syntheticEmail("audit-upgrade-student");
  const student = await scratchPool.query<{ student_id: number }>(
    `INSERT INTO public.student (full_name, email, is_ch_student, us_citizen, first_gen, honors_college, class_standing, gpa, gender)
     VALUES ($1, $2, false, true, false, false, 'Junior', 3.42, 'NR')
     RETURNING student_id`,
    [studentName, studentEmail]
  );
  const fellowshipName = syntheticName("audit-upgrade-fellowship");
  const fellowship = await scratchPool.query<{ fellowship_id: number }>(
    `INSERT INTO public.fellowship (fellowship_name)
     VALUES ($1)
     RETURNING fellowship_id`,
    [fellowshipName]
  );
  const application = await scratchPool.query<{ application_id: number }>(
    `INSERT INTO public.application (student_id, fellowship_id, destination_country, stage_of_application, application_year)
     VALUES ($1, $2, 'Testland', 'Submitted', 2026)
     RETURNING application_id`,
    [student.rows[0].student_id, fellowship.rows[0].fellowship_id]
  );

  // Apply the immutable-audit migration ON TOP of the existing rows.
  const auditSql = await readFile(path.join(MIGRATIONS_DIR, AUDIT_MIGRATION), "utf8");
  await applySql(scratchPool, auditSql, `migration ${AUDIT_MIGRATION}`);

  upgraded = {
    studentId: student.rows[0].student_id,
    fellowshipId: fellowship.rows[0].fellowship_id,
    applicationId: application.rows[0].application_id,
    original: {
      studentFullName: studentName,
      studentEmail: studentEmail,
      studentGpa: 3.42,
      classStanding: "Junior",
      fellowshipName,
      appStage: "Submitted",
      appYear: 2026,
      destinationCountry: "Testland",
    },
  };
}, 150_000);

afterAll(async () => {
  if (scratchPool) {
    await scratchPool.end();
    scratchPool = null;
  }
  if (adminPool && scratchDbName) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchDbName} WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  }
});

describe("audit upgrade path: applying the immutable-audit migration over existing rows", () => {
  it("leaves audit_event empty and legacy rows unchanged, then emits the first event only on the first later mutation", async () => {
    expect(upgraded).not.toBeNull();
    expect(scratchPool).not.toBeNull();

    // R9: the upgraded table exists and contains NO baseline events for the
    // pre-existing rows. Nothing is fabricated, inferred, or backfilled.
    const tableState = await scratchPool!.query<{ exists: boolean; n: number }>(
      `SELECT to_regclass('public.audit_event') IS NOT NULL AS exists,
              (SELECT count(*)::int FROM public.audit_event) AS n`
    );
    expect(tableState.rows[0].exists, "audit_event is created by the upgrade migration").toBe(true);
    expect(tableState.rows[0].n, "no baseline events for pre-existing rows").toBe(0);

    // The legacy rows are byte-for-byte unchanged by the audit migration.
    const legacy = await scratchPool!.query<{
      full_name: string;
      email: string;
      gpa: number;
      class_standing: string;
      fellowship_name: string;
      destination_country: string;
      stage_of_application: string;
      application_year: number;
    }>(
      `SELECT s.full_name, s.email, s.gpa::float8 AS gpa, s.class_standing,
              f.fellowship_name,
              a.destination_country, a.stage_of_application, a.application_year
         FROM public.student s
         JOIN public.application a ON a.student_id = s.student_id
         JOIN public.fellowship f ON f.fellowship_id = a.fellowship_id
        WHERE s.student_id = $1`,
      [upgraded!.studentId]
    );
    expect(legacy.rows).toHaveLength(1);
    expect(legacy.rows[0]).toEqual({
      full_name: upgraded!.original.studentFullName,
      email: upgraded!.original.studentEmail,
      gpa: upgraded!.original.studentGpa,
      class_standing: upgraded!.original.classStanding,
      fellowship_name: upgraded!.original.fellowshipName,
      destination_country: upgraded!.original.destinationCountry,
      stage_of_application: upgraded!.original.appStage,
      application_year: upgraded!.original.appYear,
    });

    // The FIRST later mutation emits exactly the FIRST event. This technical
    // session has no request actor, so the event is System/system origin.
    await scratchPool!.query("UPDATE public.student SET gpa = 3.8 WHERE student_id = $1", [
      upgraded!.studentId,
    ]);
    const events = await scratchPool!.query<{
      entity_type: string;
      entity_id: number;
      action: string;
      actor_advisor_id: number | null;
      actor_name_snapshot: string;
      origin: string;
      old_values: Record<string, unknown>;
      new_values: Record<string, unknown>;
      changes: Record<string, { old: unknown; new: unknown }>;
    }>(
      `SELECT entity_type, entity_id, action, actor_advisor_id, actor_name_snapshot,
              origin, old_values, new_values, changes
         FROM public.audit_event
        ORDER BY audit_id`
    );
    expect(events.rows, "exactly the first audit event").toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      entity_type: "student",
      entity_id: upgraded!.studentId,
      action: "updated",
      actor_advisor_id: null,
      actor_name_snapshot: "System",
      origin: "system",
    });
    expect(events.rows[0].old_values).toMatchObject({ gpa: upgraded!.original.studentGpa });
    expect(events.rows[0].new_values).toMatchObject({ gpa: 3.8 });
    expect(events.rows[0].changes).toEqual({
      gpa: { old: upgraded!.original.studentGpa, new: 3.8 },
    });
    // The user-approved explicit snapshot whitelist is preserved on the upgrade
    // path (student.archived_at is intentionally a whitelist member).
    expect(Object.keys(events.rows[0].new_values).sort(), "student whitelist exactly").toEqual(
      STUDENT_WHITELIST_SORTED
    );
  });

  it("forcibly fails the audit INSERT and proves the source mutation rolls back atomically", async () => {
    expect(upgraded).not.toBeNull();
    expect(scratchPool).not.toBeNull();

    // A transaction-scoped forced failure: a BEFORE INSERT trigger on
    // audit_event raises, so the AFTER-audit helper's INSERT aborts inside the
    // same transaction as the source mutation.
    await scratchPool!.query(
      `CREATE OR REPLACE FUNCTION public._test_force_audit_insert_failure()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $fn$
       BEGIN
         RAISE EXCEPTION 'forced audit insert failure for rollback proof'
           USING ERRCODE = 'P0001';
       END;
       $fn$`
    );
    await scratchPool!.query(
      `CREATE TRIGGER trg_test_force_audit_insert_failure
         BEFORE INSERT ON public.audit_event
         FOR EACH ROW
         EXECUTE FUNCTION public._test_force_audit_insert_failure()`
    );

    try {
      const beforeCount = await scratchPool!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.audit_event"
      );
      await scratchPool!.query("BEGIN");
      try {
        await expect(
          scratchPool!.query(
            "UPDATE public.student SET gpa = 4.0 WHERE student_id = $1",
            [upgraded!.studentId]
          )
        ).rejects.toMatchObject({ code: "P0001" });
      } finally {
        await scratchPool!.query("ROLLBACK");
      }

      // Neither the source mutation nor a partial audit row survives.
      const afterCount = await scratchPool!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.audit_event"
      );
      expect(afterCount.rows[0].n, "no audit row survives the rolled-back transaction").toBe(
        beforeCount.rows[0].n
      );
      const { rows } = await scratchPool!.query<{ gpa: number }>(
        "SELECT gpa::float8 AS gpa FROM public.student WHERE student_id = $1",
        [upgraded!.studentId]
      );
      expect(rows[0].gpa, "the source mutation is rolled back with the failed audit INSERT").toBe(3.8);
    } finally {
      await scratchPool!.query(
        "DROP TRIGGER IF EXISTS trg_test_force_audit_insert_failure ON public.audit_event"
      );
      await scratchPool!.query("DROP FUNCTION IF EXISTS public._test_force_audit_insert_failure()");
    }
  });
});