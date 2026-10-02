/**
 * tests/contract/constraints.test.ts
 *
 * Constraint enforcement contract against the migrated Docker-local database.
 *
 * These assertions are run through the LOCAL service-role client (which
 * bypasses RLS) so that the DB constraints are exercised in isolation from
 * policy logic. The service role is never asserted as an access grant; it is
 * used strictly for local fixture creation and constraint isolation.
 *
 * Also documents the design fact that the denormalized
 * `is_semi_finalist`/`is_finalist` ↔ `stage_of_application` invariant is
 * enforced by the forward-only local CHECK constraint applied by the contract
 * lane as TEST-ONLY SQL (`scripts/test-support/invariant-application-stage-flag.sql`)
 * AFTER the production-equivalent migration chain (mirroring
 * lib/applications/pipeline.ts) — a CHECK, not a trigger. The file
 * deliberately lives OUTSIDE `supabase/migrations/`: it is never part of a
 * deployable migration path.
 *
 * FK delete behavior is asserted FROM THE LOCAL SCHEMA (all local FKs are the
 * Postgres default NO ACTION): deleting a parent with children fails with a
 * foreign-key violation and every child row is preserved. Production
 * delete/retention semantics differ (see the schema-provenance reconciliation);
 * those differences are documented, never asserted here, and no FK is changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDbPool, createServiceRoleClient, getContractEnv } from "./helpers/setup";
import { seedCoreFixtures, syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
let pool: Pool;

beforeAll(() => {
  pool = createDbPool(env);
});

afterAll(async () => {
  await pool.end();
});

/** Fresh student + fellowship for one self-contained constraint assertion. */
let fixtureSeq = 0;
function nextUnique(prefix: string): string {
  // syntheticName/syntheticEmail share one RUN_TOKEN per process, so a plain
  // per-prefix call collides on unique name/email columns across repeated
  // calls; a per-call sequence makes every fixture row unique within the run.
  fixtureSeq += 1;
  return `${prefix}-${fixtureSeq}`;
}

async function insertStudentAndFellowship(): Promise<{ studentId: number; fellowshipId: number }> {
  const tag = nextUnique("constraint");
  const { data: student, error: studentError } = await service
    .from("student")
    .insert({
      full_name: syntheticName(tag),
      email: syntheticEmail(tag),
      us_citizen: true,
    })
    .select("student_id")
    .single();
  if (studentError) throw new Error(`insert constraint student: ${studentError.message}`);
  const { data: fellowship, error: fellowshipError } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(`${tag}-fellowship`) })
    .select("fellowship_id")
    .single();
  if (fellowshipError) throw new Error(`insert constraint fellowship: ${fellowshipError.message}`);
  return {
    studentId: student!.student_id as number,
    fellowshipId: fellowship!.fellowship_id as number,
  };
}

/** Fresh (unbound, inactive) advisor row for one self-contained assertion. */
async function insertAdvisor(): Promise<{ advisor_id: number }> {
  const tag = nextUnique("constraint-advisor");
  const { data, error } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName(tag),
      email: syntheticEmail(tag),
      is_active: false,
    })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`insert constraint advisor: ${error.message}`);
  return { advisor_id: data!.advisor_id as number };
}

/**
 * Insert one child row into every table that references `studentId`/`advisorId`
 * (application, advising_meeting, fellowship_thursday, scholarship_history) so
 * a parent delete under NO ACTION semantics has children to collide with.
 */
async function insertChildRows(studentId: number, fellowshipId: number, advisorId: number): Promise<void> {
  const application = await service.from("application").insert({
    student_id: studentId,
    fellowship_id: fellowshipId,
    stage_of_application: "Started",
  });
  if (application.error) throw new Error(`insert constraint application child: ${application.error.message}`);
  const meeting = await service.from("advising_meeting").insert({
    student_id: studentId,
    advisor_id: advisorId,
    meeting_date: "2026-09-01",
    meeting_mode: "Virtual",
  });
  if (meeting.error) throw new Error(`insert constraint advising_meeting child: ${meeting.error.message}`);
  const attendance = await service.from("fellowship_thursday").insert({
    student_id: studentId,
    attended: true,
    source_info: "OCF",
  });
  if (attendance.error) throw new Error(`insert constraint fellowship_thursday child: ${attendance.error.message}`);
  const history = await service.from("scholarship_history").insert({
    student_id: studentId,
    fellowship_id: fellowshipId,
  });
  if (history.error) throw new Error(`insert constraint scholarship_history child: ${history.error.message}`);
}

describe("valid synthetic inserts succeed (service role, RLS bypassed)", () => {
  it("seeds one row into every operational table", async () => {
    const fixtures = await seedCoreFixtures(service);
    for (const id of [
      fixtures.advisorSelfId,
      fixtures.advisorOtherId,
      fixtures.advisorInactiveId,
      fixtures.studentId,
      fixtures.fellowshipId,
      fixtures.applicationId,
      fixtures.meetingId,
      fixtures.attendanceId,
      fixtures.historyId,
    ]) {
      expect(id).toEqual(expect.any(Number));
    }
  });

  it("accepts GPA boundary values 0.00 and 4.00", async () => {
    for (const gpa of [0.0, 4.0]) {
      const { data, error } = await service
        .from("student")
        .insert({
          full_name: syntheticName("gpa-boundary"),
          email: syntheticEmail("gpa-boundary"),
          us_citizen: true,
          gpa,
        })
.select("student_id")
        .single();
    expect(error, `gpa=${gpa}`).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.student_id).toEqual(expect.any(Number));
    }
  });
});

describe("CHECK constraint enforcement", () => {
  it.each([
    { label: "gpa above 4.00", row: { gpa: 4.5 } },
    { label: "gpa below 0.00", row: { gpa: -0.01 } },
    { label: "unknown class_standing", row: { class_standing: "Alien" } },
    { label: "unknown gender code", row: { gender: "X" } },
  ])("rejects student row with $label", async ({ row }) => {
    const { error } = await service.from("student").insert({
      full_name: syntheticName("check-invalid"),
      email: syntheticEmail("check-invalid"),
      us_citizen: true,
      ...row,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514"); // check_violation
  });

  it("rejects an unknown application stage", async () => {
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({ full_name: syntheticName("stage"), email: syntheticEmail("stage"), us_citizen: true })
      .select("student_id")
      .single();
    expect(studentError).toBeNull();
    expect(student).not.toBeNull();
    const { data: fellowship, error: fellowshipError } = await service
      .from("fellowship")
      .insert({ fellowship_name: syntheticName("stage") })
      .select("fellowship_id")
      .single();
    expect(fellowshipError).toBeNull();
    expect(fellowship).not.toBeNull();
    const { error } = await service.from("application").insert({
      student_id: student!.student_id,
      fellowship_id: fellowship!.fellowship_id,
      stage_of_application: "Queued",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("rejects an unknown advising meeting mode", async () => {
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({ full_name: syntheticName("mode"), email: syntheticEmail("mode"), us_citizen: true })
      .select("student_id")
      .single();
    expect(studentError).toBeNull();
    expect(student).not.toBeNull();
    const { error } = await service.from("advising_meeting").insert({
      student_id: student!.student_id,
      meeting_date: "2026-09-01",
      meeting_mode: "Phone",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("rejects an unknown fellowship_thursday source_info", async () => {
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({ full_name: syntheticName("source"), email: syntheticEmail("source"), us_citizen: true })
      .select("student_id")
      .single();
    expect(studentError).toBeNull();
    expect(student).not.toBeNull();
    const { error } = await service.from("fellowship_thursday").insert({
      student_id: student!.student_id,
      attended: true,
      source_info: "XX",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });
});

describe("referential integrity", () => {
  it("rejects an application referencing a missing student", async () => {
    const { error } = await service.from("application").insert({
      student_id: 999_999_999,
      fellowship_id: 1,
      stage_of_application: "Started",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503"); // foreign_key_violation
  });
});

describe("advisor.role display-vocabulary CHECK (migration 20261001000001)", () => {
  // The trusted service_role client bypasses RLS, so the guard trigger's
  // trusted path passes; these assertions isolate the CHECK constraint: the
  // display role may only ever be the exact values Admin or Advisor.
  it("defaults a role-less advisor insert to the safe 'Advisor' display role", async () => {
    const { data: inserted, error } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("role-default")),
        email: syntheticEmail(nextUnique("role-default")),
        is_active: false,
      })
      .select("advisor_id, role")
      .single();
    expect(error, "role-less advisor INSERT").toBeNull();
    expect(inserted?.role, "default display role").toBe("Advisor");
  });

  it("accepts the exact display values Admin and Advisor through the trusted path", async () => {
    for (const role of ["Admin", "Advisor"] as const) {
      const { data: inserted, error } = await service
        .from("advisor")
        .insert({
          advisor_name: syntheticName(nextUnique(`role-${role}`)),
          email: syntheticEmail(nextUnique(`role-${role}`)),
          is_active: false,
          role,
        })
        .select("advisor_id, role")
        .single();
      expect(error, `role ${role} INSERT`).toBeNull();
      expect(inserted?.role, `stored role ${role}`).toBe(role);
    }
  });

  it("rejects a lowercase 'admin' value with a CHECK violation (23514)", async () => {
    const { data, error } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("role-lowercase")),
        email: syntheticEmail(nextUnique("role-lowercase")),
        is_active: false,
        role: "admin",
      })
      .select("advisor_id");
    expect(data ?? [], "a denied role insert must not return a row").toHaveLength(0);
    expect(error, "lowercase 'admin' must be rejected").not.toBeNull();
    expect(error?.code, "lowercase 'admin' rejection code").toBe("23514"); // check_violation
  });

  it("rejects a free-form role value with a CHECK violation (23514)", async () => {
    const { data, error } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("role-freeform")),
        email: syntheticEmail(nextUnique("role-freeform")),
        is_active: false,
        role: "Superuser",
      })
      .select("advisor_id");
    expect(data ?? [], "a denied role insert must not return a row").toHaveLength(0);
    expect(error, "free-form role must be rejected").not.toBeNull();
    expect(error?.code, "free-form role rejection code").toBe("23514"); // check_violation
  });

  it("accepts a trusted UPDATE of the display role to 'Admin' but rejects an invalid value", async () => {
    const { advisor_id } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("role-update")),
        email: syntheticEmail(nextUnique("role-update")),
        is_active: false,
      })
      .select("advisor_id")
      .single()
      .then(({ data }) => data as unknown as { advisor_id: number });

    const { data: promoted, error: promoteError } = await service
      .from("advisor")
      .update({ role: "Admin" })
      .eq("advisor_id", advisor_id)
      .select("advisor_id, role")
      .single();
    expect(promoteError, "trusted role UPDATE to Admin").toBeNull();
    expect(promoted?.role, "trusted role UPDATE stored value").toBe("Admin");

    const { data: denied, error: invalidError } = await service
      .from("advisor")
      .update({ role: "admin" })
      .eq("advisor_id", advisor_id)
      .select("advisor_id");
    expect(denied ?? [], "an invalid role UPDATE must not return a row").toHaveLength(0);
    expect(invalidError, "lowercase role UPDATE must be rejected").not.toBeNull();
    expect(invalidError?.code, "lowercase role UPDATE rejection code").toBe("23514"); // check_violation

    const { data: row } = await service
      .from("advisor")
      .select("role")
      .eq("advisor_id", advisor_id)
      .maybeSingle();
    expect(row?.role, "rejected UPDATE leaves the stored display role intact").toBe("Admin");
  });
});

describe("unique constraints", () => {
  it("rejects a duplicate advisor_name", async () => {
    const name = syntheticName("duplicate");
    const first = await service.from("advisor").insert({ advisor_name: name, email: syntheticEmail("duplicate"), is_active: true });
    expect(first.error).toBeNull();
    const { error } = await service
      .from("advisor")
      .insert({ advisor_name: name, email: syntheticEmail("duplicate-2"), is_active: true });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505"); // unique_violation
  });
});

describe("NOT NULL enforcement", () => {
  it("rejects a student without an email", async () => {
    const { error } = await service
      .from("student")
      .insert({ full_name: syntheticName("no-email"), us_citizen: true });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23502"); // not_null_violation
  });
});

describe("application stage/flag invariant (test-only CHECK, hardening Work 2)", () => {
  // The denormalized is_semi_finalist/is_finalist flags must be exactly
  // consistent with stage_of_application. The contract lane applies the
  // TEST-ONLY file scripts/test-support/invariant-application-stage-flag.sql
  // AFTER the production-equivalent migration chain; it enforces this with a
  // CHECK constraint that mirrors lib/applications/pipeline.ts
  // (deriveFlags/validateConsistency). Enforcement is a CHECK, not a trigger.
  it("enforces the invariant with a CHECK constraint (not a trigger)", async () => {
    const rows = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid = 'public.application'::regclass
          AND contype = 'c'`
    );
    const names = rows.rows.map((row) => row.conname as string);
    expect(names, "application CHECK constraints").toContain(
      "application_stage_flag_invariant_check"
    );

    // Pins that enforcement is by CHECK, not by a user trigger. The ONLY
    // non-internal user trigger on `application` is the lifecycle archive-
    // parent guard added by migration 20260930000007
    // (`trg_application_archive_parents` / `guard_application_archive_parents`);
    // no trigger implements the stage/flag invariant (before that migration
    // the count was zero, and the guard is not an invariant enforcer).
    const triggers = await pool.query(
      `SELECT t.tgname, f.proname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc f ON f.oid = t.tgfoid
        WHERE n.nspname = 'public'
          AND c.relname = 'application'
          AND NOT t.tgisinternal
        ORDER BY t.tgname`
    );
    expect(triggers.rows.map((row) => row.tgname as string)).toEqual([
      "trg_application_archive_parents",
    ]);
    expect(String(triggers.rows[0].proname)).toBe("guard_application_archive_parents");
  });

  // Exactly the seven stage/flag combinations produced by deriveFlags.
  const validCases: Array<{ stage: string; semi: boolean; final: boolean }> = [
    { stage: "Started", semi: false, final: false },
    { stage: "Submitted", semi: false, final: false },
    { stage: "Under Review", semi: false, final: false },
    { stage: "Rejected", semi: false, final: false },
    { stage: "Semi-Finalist", semi: true, final: false },
    { stage: "Finalist", semi: true, final: true },
    { stage: "Awarded", semi: true, final: true },
  ];

  // Every other combination of the seven stages × two flags is invalid.
  const invalidCases: Array<{ stage: string; semi: boolean; final: boolean }> = [];
  for (const stage of ["Started", "Submitted", "Under Review", "Semi-Finalist", "Finalist", "Awarded", "Rejected"]) {
    for (const semi of [false, true]) {
      for (const final of [false, true]) {
        if (!validCases.some((c) => c.stage === stage && c.semi === semi && c.final === final)) {
          invalidCases.push({ stage, semi, final });
        }
      }
    }
  }
  expect(invalidCases.length).toBe(28 - validCases.length);

  it.each(validCases)(
    "accepts stage $stage with is_semi_finalist=$semi, is_finalist=$final",
    async ({ stage, semi, final }) => {
      const ids = await insertStudentAndFellowship();
      const { data, error } = await service
        .from("application")
        .insert({
          student_id: ids.studentId,
          fellowship_id: ids.fellowshipId,
          stage_of_application: stage,
          is_semi_finalist: semi,
          is_finalist: final,
        })
        .select("application_id")
        .single();
      expect(error, `stage ${stage} sf=${semi} f=${final}`).toBeNull();
      expect(data, `stage ${stage} sf=${semi} f=${final}`).not.toBeNull();
    }
  );

  it.each(invalidCases)(
    "rejects stage $stage with is_semi_finalist=$semi, is_finalist=$final",
    async ({ stage, semi, final }) => {
      const ids = await insertStudentAndFellowship();
      const { data, error } = await service
        .from("application")
        .insert({
          student_id: ids.studentId,
          fellowship_id: ids.fellowshipId,
          stage_of_application: stage,
          is_semi_finalist: semi,
          is_finalist: final,
        });
      expect(data, `stage ${stage} sf=${semi} f=${final} must not insert`).toBeNull();
      expect(error, `stage ${stage} sf=${semi} f=${final} must be rejected`).not.toBeNull();
      expect(error?.code, `stage ${stage} sf=${semi} f=${final} error code`).toBe("23514"); // check_violation
    }
  );
});

describe("foreign-key delete behavior (schema-derived NO ACTION, hardening Work 3)", () => {
  // Every FK in the local migration chain is declared without ON DELETE/ON
  // UPDATE, so Postgres gives each the default NO ACTION semantics. The
  // expected delete behavior is derived from the schema (pg_constraint), never
  // assumed from production (whose delete actions differ and are out of scope).
  it("declares every local FK as NO ACTION on delete and update", async () => {
    const rows = await pool.query(
      `SELECT conname, confdeltype, confupdtype
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND contype = 'f'`
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      // 'a' is the pg_constraint code for NO ACTION (the Postgres default for
      // a plain FK with no ON DELETE/ON UPDATE clause).
      expect(row.confdeltype, `${row.conname} confdeltype`).toBe("a");
      expect(row.confupdtype, `${row.conname} confupdtype`).toBe("a");
    }
  });

  it("blocks deleting a student with children and preserves every child (NO ACTION)", async () => {
    const { studentId, fellowshipId } = await insertStudentAndFellowship();
    const advisorId = (await insertAdvisor()).advisor_id;
    await insertChildRows(studentId, fellowshipId, advisorId);

    const { data, error } = await service.from("student").delete().eq("student_id", studentId);
    expect(error, "NO ACTION delete of a parent student must fail").not.toBeNull();
    expect(error?.code, "student delete FK violation code").toBe("23503");
    expect(data).toBeNull();

    // Child preservation proof: every child still references the student.
    for (const table of ["application", "advising_meeting", "fellowship_thursday", "scholarship_history"] as const) {
      const { data: children, error: childError } = await service
        .from(table)
        .select("student_id")
        .eq("student_id", studentId);
      expect(childError, `${table} child re-read`).toBeNull();
      expect(children ?? [], `${table} child preserved after blocked student delete`).toHaveLength(1);
    }
    // Parent preserved too.
    const { data: parent } = await service.from("student").select("student_id").eq("student_id", studentId);
    expect(parent ?? [], "parent student preserved").toHaveLength(1);
  });

  it("blocks deleting an advisor with advising-meeting children and preserves the meetings (NO ACTION)", async () => {
    const { studentId, fellowshipId } = await insertStudentAndFellowship();
    const advisorId = (await insertAdvisor()).advisor_id;
    await insertChildRows(studentId, fellowshipId, advisorId);

    const { data, error } = await service.from("advisor").delete().eq("advisor_id", advisorId);
    expect(error, "NO ACTION delete of a parent advisor must fail").not.toBeNull();
    expect(error?.code, "advisor delete FK violation code").toBe("23503");
    expect(data).toBeNull();

    // The advising meetings survive and still reference the advisor.
    const { data: meetings } = await service
      .from("advising_meeting")
      .select("meeting_id")
      .eq("advisor_id", advisorId);
    expect(meetings ?? [], "advising meetings preserved after blocked advisor delete").toHaveLength(1);
    const { data: parent } = await service.from("advisor").select("advisor_id").eq("advisor_id", advisorId);
    expect(parent ?? [], "parent advisor preserved").toHaveLength(1);
  });

  it("blocks deleting a fellowship with application/scholarship-history children and preserves them (NO ACTION)", async () => {
    const { studentId, fellowshipId } = await insertStudentAndFellowship();
    const advisorId = (await insertAdvisor()).advisor_id;
    await insertChildRows(studentId, fellowshipId, advisorId);

    const { data, error } = await service.from("fellowship").delete().eq("fellowship_id", fellowshipId);
    expect(error, "NO ACTION delete of a parent fellowship must fail").not.toBeNull();
    expect(error?.code, "fellowship delete FK violation code").toBe("23503");
    expect(data).toBeNull();

    // Application and scholarship-history children are preserved.
    for (const table of ["application", "scholarship_history"] as const) {
      const { data: children } = await service
        .from(table)
        .select("fellowship_id")
        .eq("fellowship_id", fellowshipId);
      expect(children ?? [], `${table} child preserved after blocked fellowship delete`).toHaveLength(1);
    }
    const { data: parent } = await service.from("fellowship").select("fellowship_id").eq("fellowship_id", fellowshipId);
    expect(parent ?? [], "parent fellowship preserved").toHaveLength(1);
  });
});