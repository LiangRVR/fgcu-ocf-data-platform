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
 * `is_semi_finalist`/`is_finalist` ↔ `stage_of_application` invariant has no
 * DB trigger — it is an application-layer invariant only.
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

describe("application stage denormalization invariant (documented design fact)", () => {
  it("has no DB trigger enforcing is_semi_finalist/is_finalist vs stage_of_application", async () => {
    const rows = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'application'
          AND NOT t.tgisinternal`
    );
    expect(rows.rows[0].n).toBe(0);
  });
});