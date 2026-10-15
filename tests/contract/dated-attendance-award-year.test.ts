/**
 * tests/contract/dated-attendance-award-year.test.ts
 *
 * Database contract for migration 20261024000001_dated_attendance_award_year
 * (AI-DLC change `dated-attendance-award-year`): the nullable immutable
 * Fellowship Thursday `event_date` (date) and Scholarship History `award_year`
 * (integer, 1000–9999) base identifiers, the authenticated new-record boundary
 * guards, the appended effective/list view columns, and the extended immutable
 * audit snapshot keys.
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *   - R1 SCHEMA: both columns exist as nullable with the right types; the
 *        null-tolerant award-year CHECK exists; trusted legacy rows keep NULL.
 *   - R2/R3 ENFORCEMENT: an authenticated INSERT missing the identifier is
 *        rejected at the database boundary (42501) with no row and no audit
 *        event; a year outside 1000–9999 is a CHECK violation (23514); valid
 *        boundary values insert.
 *   - Compatibility: a trusted no-JWT technical INSERT (service role) may still
 *        omit the identifiers (legacy/import NULL compatibility).
 *   - R4 PRESERVATION: the base rows stay append-only (authenticated UPDATE and
 *        DELETE denied); corrections remain append-only.
 *   - Audit atomicity: a successful base insert records exactly one immutable
 *        `created` event whose structural snapshot carries the identifier.
 *   - Views: the effective and list views expose the appended identifiers,
 *        including explicit legacy NULL display.
 *
 * Service role is used strictly for local fixture seeding, auth-user creation,
 * the admin pre-bind, and persisted-state/catalog oracle reads (never asserted
 * as an access grant).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Pool } from "pg";
import {
  createAnonClient,
  createDbPool,
  createServiceRoleClient,
  getContractEnv,
} from "./helpers/setup";
import {
  createAuthUser,
  seedCoreFixtures,
  signInWithPassword,
  syntheticEmail,
  syntheticName,
  type SeededCore,
} from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);

let pool: Pool;
let fixtures: SeededCore;
let selfClient: SupabaseClient;
let noAdvisorClient: SupabaseClient;

let seq = 0;
const nextUnique = (prefix: string): string => `${prefix}-${++seq}`;

async function seedStudent(): Promise<number> {
  const tag = nextUnique("dated-student");
  const { data, error } = await service
    .from("student")
    .insert({ full_name: syntheticName(tag), email: syntheticEmail(tag), us_citizen: true })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student: ${error.message}`);
  return data!.student_id as number;
}

async function seedFellowship(): Promise<number> {
  const tag = nextUnique("dated-fellowship");
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(tag) })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship: ${error.message}`);
  return data!.fellowship_id as number;
}

async function auditCount(entityType: string, entityId?: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    entityId === undefined
      ? `SELECT count(*)::text AS n FROM public.audit_event WHERE entity_type = $1`
      : `SELECT count(*)::text AS n FROM public.audit_event WHERE entity_type = $1 AND entity_id = $2`,
    entityId === undefined ? [entityType] : [entityType, entityId]
  );
  return Number(rows[0].n);
}

/** Created events recorded for one subject student (robust under parallel files). */
async function auditCountForStudent(entityType: string, studentId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.audit_event
      WHERE entity_type = $1 AND subject_student_id = $2`,
    [entityType, studentId]
  );
  return Number(rows[0].n);
}

beforeAll(async () => {
  pool = createDbPool(env);
  fixtures = await seedCoreFixtures(service);

  const selfUserId = await createAuthUser(service, fixtures.advisorSelfEmail);
  const { error: bindError } = await service
    .from("advisor")
    .update({ auth_user_id: selfUserId })
    .eq("advisor_id", fixtures.advisorSelfId)
    .select("advisor_id");
  if (bindError) throw new Error(`admin pre-bind self advisor: ${bindError.message}`);

  selfClient = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect(await signInWithPassword(selfClient, fixtures.advisorSelfEmail)).toBe(selfUserId);

  const noAdvisorEmail = syntheticEmail("dated-no-advisor");
  const noAdvisorUserId = await createAuthUser(service, noAdvisorEmail);
  noAdvisorClient = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect(await signInWithPassword(noAdvisorClient, noAdvisorEmail)).toBe(noAdvisorUserId);
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

describe("schema: nullable immutable identifiers + year bound (R1)", () => {
  it("adds fellowship_thursday.event_date as a nullable date and scholarship_history.award_year as a nullable integer", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ( (table_name = 'fellowship_thursday' AND column_name = 'event_date')
             OR (table_name = 'scholarship_history' AND column_name = 'award_year') )
        ORDER BY table_name`
    );
    expect(rows).toEqual([
      { table_name: "fellowship_thursday", column_name: "event_date", data_type: "date", is_nullable: "YES" },
      { table_name: "scholarship_history", column_name: "award_year", data_type: "integer", is_nullable: "YES" },
    ]);
  });

  it("carries the null-tolerant award-year CHECK bounded to 1000–9999", async () => {
    const { rows } = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'scholarship_history'
          AND c.conname = 'scholarship_history_award_year_range_check'
          AND c.contype = 'c'`
    );
    expect(rows, "award-year CHECK exists").toHaveLength(1);
    expect(rows[0].definition).toContain("1000");
    expect(rows[0].definition).toContain("9999");
    expect(rows[0].definition.toUpperCase()).toContain("IS NULL");
  });

  it("keeps trusted legacy rows as NULL (never inferred or backfilled)", async () => {
    const { rows } = await pool.query<{ event_date: string | null; award_year: number | null }>(
      `SELECT ft.event_date, sh.award_year
         FROM public.fellowship_thursday ft
         CROSS JOIN public.scholarship_history sh
        WHERE ft.attendance_id = $1 AND sh.history_id = $2`,
      [fixtures.attendanceId, fixtures.historyId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_date, "legacy attendance event_date stays NULL").toBeNull();
    expect(rows[0].award_year, "legacy award_year stays NULL").toBeNull();
  });

  it("captures both new-record guards as INVOKER with service_role-pinned ACLs and INSERT-only triggers", async () => {
    const functions = [
      "guard_fellowship_thursday_event_date_required",
      "guard_scholarship_history_award_year_required",
    ];
    for (const name of functions) {
      const { rows } = await pool.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT p.prosecdef, p.proconfig
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [name]
      );
      expect(rows, `guard function ${name}`).toHaveLength(1);
      expect(rows[0].prosecdef, `${name} SECURITY INVOKER`).toBe(false);
      expect(rows[0].proconfig, `${name} empty search_path`).toEqual(['search_path=""']);

      const { rows: acl } = await pool.query<{ sr: boolean; auth: boolean; anon: boolean; has_public: boolean }>(
        `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                EXISTS (
                    SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
                     WHERE x.grantee = 0
                ) AS has_public
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [name]
      );
      expect(acl[0].sr, `${name} service_role EXECUTE`).toBe(true);
      expect(acl[0].auth, `${name} authenticated EXECUTE revoked`).toBe(false);
      expect(acl[0].anon, `${name} anon EXECUTE revoked`).toBe(false);
      expect(acl[0].has_public, `${name} PUBLIC EXECUTE revoked`).toBe(false);
    }

    const { rows: triggers } = await pool.query<{ tgname: string; relname: string; has_insert: boolean }>(
      `SELECT t.tgname, c.relname, (t.tgtype::int & 4) <> 0 AS has_insert
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND t.tgname IN ('trg_fellowship_thursday_event_date_required', 'trg_scholarship_history_award_year_required')
          AND NOT t.tgisinternal
        ORDER BY t.tgname`
    );
    expect(triggers.map((r) => r.tgname)).toEqual([
      "trg_fellowship_thursday_event_date_required",
      "trg_scholarship_history_award_year_required",
    ]);
    expect(triggers.every((r) => r.has_insert)).toBe(true);
  });
});

describe("authenticated new-record enforcement (R2/R3)", () => {
  it("rejects a new authenticated Fellowship Thursday insert without an event_date (42501) with no row and no audit event", async () => {
    const studentId = await seedStudent();

    const { data, error } = await selfClient
      .from("fellowship_thursday")
      .insert({ student_id: studentId, attended: true, source_info: "OCF" })
      .select("attendance_id");
    expect(data ?? [], "missing event_date must not insert a row").toHaveLength(0);
    expect(error, "missing event_date must be rejected").not.toBeNull();
    expect(error?.code, "missing event_date rejection code").toBe("42501");
    expect(await auditCountForStudent("fellowship_thursday", studentId), "rejected insert records no audit event").toBe(0);
  });

  it("rejects a new authenticated Scholarship History insert without an award_year (42501) with no row and no audit event", async () => {
    const studentId = await seedStudent();
    const fellowshipId = await seedFellowship();

    const { data, error } = await selfClient
      .from("scholarship_history")
      .insert({ student_id: studentId, fellowship_id: fellowshipId })
      .select("history_id");
    expect(data ?? [], "missing award_year must not insert a row").toHaveLength(0);
    expect(error, "missing award_year must be rejected").not.toBeNull();
    expect(error?.code, "missing award_year rejection code").toBe("42501");
    expect(await auditCountForStudent("scholarship_history", studentId), "rejected insert records no audit event").toBe(0);
  });

  it("accepts a valid event_date and records it atomically with exactly one created audit event", async () => {
    const studentId = await seedStudent();
    const { data, error } = await selfClient
      .from("fellowship_thursday")
      .insert({ student_id: studentId, attended: true, source_info: "OCF", event_date: "2026-10-01" })
      .select("attendance_id, event_date")
      .single();
    expect(error, "valid event_date insert").toBeNull();
    expect(data!.event_date).toBe("2026-10-01");
    const attendanceId = data!.attendance_id as number;

    const events = await auditCount("fellowship_thursday", attendanceId);
    expect(events, "exactly one created event").toBe(1);
    const { rows } = await pool.query<{ action: string; snapshot: string | null; has_key: boolean }>(
      `SELECT action,
              new_values ->> 'event_date' AS snapshot,
              (new_values ? 'event_date') AS has_key
         FROM public.audit_event
        WHERE entity_type = 'fellowship_thursday' AND entity_id = $1`,
      [attendanceId]
    );
    expect(rows[0].action).toBe("created");
    expect(rows[0].has_key, "snapshot carries the event_date key").toBe(true);
    expect(rows[0].snapshot).toBe("2026-10-01");
  });

  it("accepts boundary award years (1000, 9999) and rejects out-of-range years (23514)", async () => {
    const studentId = await seedStudent();
    const fellowshipId = await seedFellowship();

    for (const awardYear of [999, 10000]) {
      const { data, error } = await selfClient
        .from("scholarship_history")
        .insert({ student_id: studentId, fellowship_id: fellowshipId, award_year: awardYear })
        .select("history_id");
      expect(data ?? [], `year ${awardYear} must not insert`).toHaveLength(0);
      expect(error, `year ${awardYear} must be rejected`).not.toBeNull();
      expect(error?.code, `year ${awardYear} rejection code`).toBe("23514");
    }

    for (const awardYear of [1000, 9999]) {
      const { data, error } = await selfClient
        .from("scholarship_history")
        .insert({ student_id: studentId, fellowship_id: fellowshipId, award_year: awardYear })
        .select("history_id, award_year")
        .single();
      expect(error, `year ${awardYear} INSERT`).toBeNull();
      expect(data?.award_year, `year ${awardYear} stored`).toBe(awardYear);
    }
  });

  it("denies a new record to an authenticated user with no active bound advisor (RLS preserved)", async () => {
    const studentId = await seedStudent();
    const { data, error } = await noAdvisorClient
      .from("fellowship_thursday")
      .insert({ student_id: studentId, attended: true, source_info: "OCF", event_date: "2026-10-08" });
    expect(data ?? [], "no-advisor insert returns no row").toHaveLength(0);
    expect(error, "no-advisor insert must be denied").not.toBeNull();
    expect(error?.code, "no-advisor denial code").toBe("42501");
  });

  it("denies anon inserts on the base-history tables (no grant)", async () => {
    const studentId = await seedStudent();
    const { error } = await anon
      .from("scholarship_history")
      .insert({ student_id: studentId, fellowship_id: fixtures.fellowshipId, award_year: 2026 });
    expect(error, "anon insert must be denied").not.toBeNull();
    expect(error?.code, "anon denial code").toBe("42501");
  });

  it("lets a trusted no-JWT technical insert keep NULL identifiers (legacy/import compatibility)", async () => {
    const studentId = await seedStudent();
    const { data: attendance, error: attendanceError } = await service
      .from("fellowship_thursday")
      .insert({ student_id: studentId, attended: false, source_info: "HC" })
      .select("attendance_id, event_date")
      .single();
    expect(attendanceError, "trusted NULL event_date insert").toBeNull();
    expect(attendance?.event_date, "trusted insert keeps NULL").toBeNull();

    const { data: history, error: historyError } = await service
      .from("scholarship_history")
      .insert({ student_id: studentId, fellowship_id: fixtures.fellowshipId })
      .select("history_id, award_year")
      .single();
    expect(historyError, "trusted NULL award_year insert").toBeNull();
    expect(history?.award_year, "trusted insert keeps NULL").toBeNull();

    // The trusted (System) created events still carry the structural keys with
    // an explicit JSON null (a change to/from null stays unambiguous).
    const { rows } = await pool.query<{ has_key: boolean; value: string | null }>(
      `SELECT (new_values ? 'award_year') AS has_key, new_values ->> 'award_year' AS value
         FROM public.audit_event
        WHERE entity_type = 'scholarship_history' AND entity_id = $1`,
      [history!.history_id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].has_key, "System snapshot carries the award_year key").toBe(true);
    expect(rows[0].value, "System snapshot award_year is JSON null").toBeNull();
  });
});

describe("append-only base rows preserved (R4)", () => {
  it("denies an authenticated UPDATE of the new event_date (42501), preserving the row", async () => {
    const { data } = await selfClient
      .from("fellowship_thursday")
      .insert({ student_id: fixtures.studentId, attended: true, source_info: "OCF", event_date: "2026-10-15" })
      .select("attendance_id, event_date")
      .single();
    const attendanceId = data!.attendance_id as number;

    const { data: denied, error } = await selfClient
      .from("fellowship_thursday")
      .update({ event_date: "2026-01-01" })
      .eq("attendance_id", attendanceId)
      .select("attendance_id");
    expect(denied ?? [], "denied UPDATE returns no row").toHaveLength(0);
    expect(error, "authenticated event_date UPDATE must be denied").not.toBeNull();
    expect(error?.code, "event_date UPDATE denial code").toBe("42501");

    const { rows } = await pool.query<{ event_date: string }>(
      `SELECT event_date::text AS event_date FROM public.fellowship_thursday WHERE attendance_id = $1`,
      [attendanceId]
    );
    expect(rows[0].event_date).toBe("2026-10-15");
  });

  it("denies an authenticated DELETE of a base award (42501), preserving the row", async () => {
    const { data } = await selfClient
      .from("scholarship_history")
      .insert({ student_id: fixtures.studentId, fellowship_id: fixtures.fellowshipId, award_year: 2026 })
      .select("history_id")
      .single();
    const historyId = data!.history_id as number;

    const { data: denied, error } = await selfClient
      .from("scholarship_history")
      .delete()
      .eq("history_id", historyId)
      .select("history_id");
    expect(denied ?? [], "denied DELETE returns no row").toHaveLength(0);
    expect(error, "authenticated award DELETE must be denied").not.toBeNull();
    expect(error?.code, "award DELETE denial code").toBe("42501");
    expect(await auditCount("scholarship_history", historyId), "the row survives").toBe(1);
  });
});

describe("effective/list views expose the identifiers (R1/R4)", () => {
  it("exposes event_date through the effective and list views, including legacy NULL", async () => {
    const effective = await selfClient
      .from("effective_fellowship_thursday")
      .select("attendance_id, event_date")
      .eq("attendance_id", fixtures.attendanceId)
      .maybeSingle();
    expect(effective.error, "effective view read").toBeNull();
    expect(effective.data?.event_date, "legacy effective event_date stays NULL").toBeNull();

    const list = await selfClient
      .from("fellowship_thursday_list")
      .select("attendance_id, event_date")
      .eq("attendance_id", fixtures.attendanceId)
      .maybeSingle();
    expect(list.error, "list view read").toBeNull();
    expect(list.data?.event_date, "legacy list event_date stays NULL").toBeNull();
  });

  it("exposes award_year through the effective and list views", async () => {
    const studentId = await seedStudent();
    const fellowshipId = await seedFellowship();
    const { data } = await selfClient
      .from("scholarship_history")
      .insert({ student_id: studentId, fellowship_id: fellowshipId, award_year: 2024 })
      .select("history_id")
      .single();
    const historyId = data!.history_id as number;

    for (const view of ["effective_scholarship_history", "scholarship_history_list"] as const) {
      const result = await selfClient
        .from(view)
        .select("history_id, award_year")
        .eq("history_id", historyId)
        .maybeSingle();
      expect(result.error, `${view} read`).toBeNull();
      expect(result.data?.award_year, `${view} award_year`).toBe(2024);
    }
  });
});
