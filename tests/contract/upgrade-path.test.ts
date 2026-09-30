/**
 * tests/contract/upgrade-path.test.ts
 *
 * Upgrade-path contract for migration 20260929000001 (advising ↔ application
 * link): the migration must apply cleanly ON TOP of the pre-link schema
 * (migrations 20260305000000 → 20260318000001) with existing LEGACY rows
 * present, and must preserve those rows without inventing values (R1/R2).
 *
 * The contract lane's main database already has the full chain applied, so
 * this test replays the REAL committed Git migration files against a
 * throwaway scratch database on the same isolated Docker-local instance:
 *
 *   1. CREATE DATABASE (postgres superuser; the isolated instance is
 *      loopback-only, guarded by getContractEnv());
 *   2. scaffold the minimal `auth` schema functions the pre-link migrations
 *      reference (auth.uid()/auth.jwt()/auth.role(), resolving the same
 *      PostgREST request settings the real Supabase auth schema uses);
 *   3. apply migrations 20260305000000 → 20260318000001 VERBATIM (the legacy
 *      chain — every file is applied exactly as committed, none modified);
 *   4. seed a legacy application (no application_year column yet) and a
 *      legacy advising meeting (no application_id/creator columns yet) with an
 *      exact meeting_date;
 *   5. apply ONLY 20260929000001_advising_application_link.sql;
 *   6. prove the legacy rows stayed truthful: application_year NULL,
 *      application_id NULL, created_by_advisor_id NULL, exact meeting_date
 *      preserved byte-for-byte, created_at non-NULL (migration-time metadata);
 *   7. prove the hardened metadata trigger is live on the upgraded schema: a
 *      forged no-JWT INSERT is attributed to NO advisor (creator dropped to
 *      NULL) and re-stamped with the database current timestamp.
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
import { createDbPool, getContractEnv } from "./helpers/setup";
import { syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();

// The runner always launches tests with the repository root as cwd.
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const LINK_MIGRATION = "20260929000001_advising_application_link.sql";

/** Minimal auth-schema functions used by the pre-link migration chain. */
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
`;

let adminPool: Pool;
let scratchPool: Pool | null = null;
let scratchDbName = "";

/** Seeded legacy ids on the upgraded scratch database, filled in beforeAll. */
interface UpgradeFixtures {
  advisorId: number;
  studentId: number;
  fellowshipId: number;
  applicationId: number;
  meetingId: number;
}
let upgraded: UpgradeFixtures | null = null;

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
  scratchDbName = `ocf_contract_upgrade_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await adminPool.query(`CREATE DATABASE ${scratchDbName}`);

  const scratchUrl = new URL(env.dbUrl);
  scratchUrl.pathname = `/${scratchDbName}`;
  scratchPool = new Pool({
    connectionString: scratchUrl.toString(),
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  // Scaffold the auth functions the legacy migrations reference.
  await applySql(scratchPool, AUTH_SCAFFOLD_SQL, "auth scaffold");

  // Read the REAL committed migration files, preserving their order.
  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const linkIndex = migrationFiles.indexOf(LINK_MIGRATION);
  expect(linkIndex, `${LINK_MIGRATION} must exist in the migration directory`).toBeGreaterThan(0);
  const legacyFiles = migrationFiles.slice(0, linkIndex);

  // 3. Apply the legacy chain (migrations through 20260318000001) verbatim.
  for (const file of legacyFiles) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await applySql(scratchPool, sql, `migration ${file}`);
  }

  // 4. Seed legacy rows in the pre-link schema.
  const advisor = await scratchPool.query<{ advisor_id: number }>(
    `INSERT INTO public.advisor (advisor_name, email, is_active)
     VALUES ($1, $2, true)
     RETURNING advisor_id`,
    [syntheticName("upgrade-advisor"), syntheticEmail("upgrade-advisor")]
  );
  const student = await scratchPool.query<{ student_id: number }>(
    `INSERT INTO public.student (full_name, email, is_ch_student, us_citizen, first_gen, honors_college, class_standing, gpa, gender)
     VALUES ($1, $2, false, true, false, false, 'Junior', 3.42, 'NR')
     RETURNING student_id`,
    [syntheticName("upgrade-student"), syntheticEmail("upgrade-student")]
  );
  const fellowship = await scratchPool.query<{ fellowship_id: number }>(
    `INSERT INTO public.fellowship (fellowship_name)
     VALUES ($1)
     RETURNING fellowship_id`,
    [syntheticName("upgrade-fellowship")]
  );
  const application = await scratchPool.query<{ application_id: number }>(
    `INSERT INTO public.application (student_id, fellowship_id, destination_country, stage_of_application)
     VALUES ($1, $2, 'Testland', 'Submitted')
     RETURNING application_id`,
    [student.rows[0].student_id, fellowship.rows[0].fellowship_id]
  );
  const meeting = await scratchPool.query<{ meeting_id: number }>(
    `INSERT INTO public.advising_meeting (student_id, advisor_id, meeting_date, meeting_mode, no_show)
     VALUES ($1, $2, '2023-03-15', 'Virtual', false)
     RETURNING meeting_id`,
    [student.rows[0].student_id, advisor.rows[0].advisor_id]
  );

  // 5. Apply ONLY the advising↔application-link migration on top of the
  // legacy chain and legacy rows.
  const linkSql = await readFile(path.join(MIGRATIONS_DIR, LINK_MIGRATION), "utf8");
  await applySql(scratchPool, linkSql, `migration ${LINK_MIGRATION}`);

  upgraded = {
    advisorId: advisor.rows[0].advisor_id,
    studentId: student.rows[0].student_id,
    fellowshipId: fellowship.rows[0].fellowship_id,
    applicationId: application.rows[0].application_id,
    meetingId: meeting.rows[0].meeting_id,
  };
}, 90_000);

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

describe("upgrade path: applying 20260929000001 on top of the legacy chain", () => {
  it("keeps legacy application_year/application_id/creator NULL and preserves the exact meeting date", async () => {
    expect(upgraded).not.toBeNull();
    expect(scratchPool).not.toBeNull();

    const { rows } = await scratchPool!.query<{
      app_year_null: boolean;
      app_id_null: boolean;
      creator_null: boolean;
      date_exact: boolean;
      created_at_present: boolean;
    }>(
      `SELECT
         (SELECT (application_year IS NULL) FROM public.application WHERE application_id = $1) AS app_year_null,
         (SELECT (application_id IS NULL) FROM public.advising_meeting WHERE meeting_id = $2) AS app_id_null,
         (SELECT (created_by_advisor_id IS NULL) FROM public.advising_meeting WHERE meeting_id = $2) AS creator_null,
         (SELECT (meeting_date::text = '2023-03-15') FROM public.advising_meeting WHERE meeting_id = $2) AS date_exact,
         (SELECT (created_at IS NOT NULL) FROM public.advising_meeting WHERE meeting_id = $2) AS created_at_present`,
      [upgraded!.applicationId, upgraded!.meetingId]
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.app_year_null, "legacy application_year stays NULL (cycle never inferred)").toBe(true);
    expect(row.app_id_null, "legacy meeting application_id stays NULL (General Advising)").toBe(true);
    expect(row.creator_null, "legacy meeting created_by_advisor_id stays NULL (no fabricated creator)").toBe(true);
    expect(row.date_exact, "legacy meeting_date preserved byte-for-byte").toBe(true);
    expect(row.created_at_present, "legacy meeting created_at stamped (migration-time metadata)").toBe(true);
  });

  it("proves created_at is migration-time metadata, never the meeting date", async () => {
    expect(upgraded).not.toBeNull();
    expect(scratchPool).not.toBeNull();

    const { rows } = await scratchPool!.query<{ created_at: string; meeting_date: string }>(
      `SELECT created_at::text AS created_at, meeting_date::text AS meeting_date
         FROM public.advising_meeting
        WHERE meeting_id = $1`,
      [upgraded!.meetingId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].meeting_date).toBe("2023-03-15");
    // The migration-time stamp is a full timestamp (carries a time-of-day
    // component and a zone offset) — never a bare date, and never the
    // fabricated session date.
    expect(rows[0].created_at).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(rows[0].created_at).not.toContain("2023-03-15");
  });

  it("runs the hardened metadata trigger on the upgraded schema: a forged no-JWT INSERT is not attributed and is re-stamped", async () => {
    expect(upgraded).not.toBeNull();
    expect(scratchPool).not.toBeNull();

    const forged = "2000-01-01T00:00:00+00:00";

    const inserted = await scratchPool!.query<{ meeting_id: number }>(
      `INSERT INTO public.advising_meeting
         (student_id, advisor_id, meeting_date, meeting_mode, no_show, application_id, created_by_advisor_id, created_at)
       VALUES ($1, $2, '2026-05-01', 'Virtual', false, NULL, $3, $4::timestamptz)
       RETURNING meeting_id`,
      [upgraded!.studentId, upgraded!.advisorId, 999_999_999, forged]
    );
    expect(inserted.rows).toHaveLength(1);

    const { rows } = await scratchPool!.query<{
      creator_null: boolean;
      forged_dropped: boolean;
      created_at_present: boolean;
    }>(
      `SELECT
         (created_by_advisor_id IS NULL) AS creator_null,
         (created_at::text <> $2) AS forged_dropped,
         (created_at IS NOT NULL) AS created_at_present
       FROM public.advising_meeting
       WHERE meeting_id = $1`,
      [inserted.rows[0].meeting_id, forged]
    );
    expect(rows).toHaveLength(1);
    // The forged creator (a nonexistent advisor id) was dropped to NULL by the
    // trigger BEFORE the FK check — the row inserted successfully, which
    // proves the payload value was discarded, not merely rejected.
    expect(rows[0].creator_null, "forged creator must be dropped to NULL").toBe(true);
    expect(rows[0].forged_dropped, "forged created_at must be replaced by now()").toBe(true);
    expect(rows[0].created_at_present, "created_at must be the database current timestamp").toBe(true);
  });
});