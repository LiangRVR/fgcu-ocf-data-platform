/**
 * tests/contract/append-only-immutability.test.ts
 *
 * Attempt-level immutability proof for the two remaining append-only tables and
 * the current-state DELETE boundary — the release-matrix cells the existing
 * suites assert only at the catalog/policy-shape level:
 *
 *   - `advising_meeting` and `advising_meeting_amendment`: `schema.test.ts`
 *     asserts the policy shape and the revoked `authenticated` UPDATE/DELETE
 *     grants, and `historical-audit-activity.test.ts` proves the revoked
 *     TRUNCATE. No suite yet executes a REAL authenticated-client UPDATE/DELETE
 *     attempt and proves it is denied with 42501 while the row survives — the
 *     same attempt-level proof `historical-integrity.test.ts` already makes for
 *     the Fellowship-Thursday/Scholarship base and amendment tables.
 *   - `student`/`fellowship`/`application`/`advisor`: `versioned-current-state-
 *     writers.test.ts` proves the revoked direct UPDATE attempt; the revoked
 *     DELETE grant (migration 20260930000006) is asserted only through
 *     `has_table_privilege` in `schema.test.ts`. This suite executes the real
 *     authenticated DELETE attempt for each.
 *
 * These are attempt-level proofs, not catalog proxies: a session signed in with
 * the anon key as a real active bound advisor calls PostgREST, so RLS/grants
 * are exercised exactly as a browser request would be. Service role is used
 * only to seed synthetic fixtures, create the auth user, pre-bind the advisor,
 * and re-read the untouched rows (never asserted as an access grant).
 *
 * Run inside the existing isolated Docker-local contract lane
 * (`scripts/contract/run.mjs`) — loopback only, full migration chain applied.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient, getContractEnv } from "./helpers/setup";
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

let fixtures: SeededCore;
let selfClient: SupabaseClient;

/** Dedicated rows whose immutability this suite asserts. */
let meetingId: number;
let amendmentId: number;

async function readRow<T = Record<string, unknown>>(
  table: string,
  idColumn: string,
  id: number
): Promise<T | null> {
  const { data } = await service.from(table).select("*").eq(idColumn, id).maybeSingle();
  return (data as T | null) ?? null;
}

/** Count the audit events for one (entity_type, entity_id) as the service oracle. */
async function auditCount(entityType: string, entityId: number): Promise<number> {
  const { count } = await service
    .from("audit_event")
    .select("audit_id", { count: "exact", head: true })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  return count ?? 0;
}

beforeAll(async () => {
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

  // A dedicated append-only meeting plus one amendment. Both are seeded through
  // the signed-in ACTIVE advisor: the amendment trigger only accepts an
  // authenticated active-advisor creator, so the service role cannot seed it.
  const { data: meeting, error: meetingError } = await selfClient
    .from("advising_meeting")
    .insert({
      student_id: fixtures.studentId,
      advisor_id: fixtures.advisorSelfId,
      meeting_date: "2026-09-15",
      meeting_mode: "Virtual",
      no_show: false,
      notes: "Immutable advising fixture (never mutated)",
    })
    .select("meeting_id")
    .single();
  if (meetingError) throw new Error(`seed advising_meeting: ${meetingError.message}`);
  meetingId = meeting.meeting_id as number;

  const { data: amendment, error: amendmentError } = await selfClient
    .from("advising_meeting_amendment")
    .insert({
      meeting_id: meetingId,
      reason: "Immutable amendment fixture",
      details: "Append-only; must never be updated or deleted.",
    })
    .select("amendment_id")
    .single();
  if (amendmentError) throw new Error(`seed advising_meeting_amendment: ${amendmentError.message}`);
  amendmentId = amendment.amendment_id as number;
}, 60_000);

describe("advising base/amendment append-only immutability (R4)", () => {
  it("denies an authenticated UPDATE of the base meeting (42501), preserving the row and its history", async () => {
    const before = await readRow("advising_meeting", "meeting_id", meetingId);
    expect(before, "seeded meeting exists").not.toBeNull();
    const auditBefore = await auditCount("advising_meeting", meetingId);

    const { data, error } = await selfClient
      .from("advising_meeting")
      .update({ meeting_mode: "In-Person", notes: "TAMPERED" })
      .eq("meeting_id", meetingId)
      .select("meeting_id");
    expect(error, "authenticated advising_meeting UPDATE must be denied").not.toBeNull();
    expect(error?.code, "advising_meeting UPDATE denial code").toBe("42501");
    expect(data ?? [], "denied UPDATE returns no row").toHaveLength(0);

    const after = await readRow("advising_meeting", "meeting_id", meetingId);
    expect(after, "the meeting row is byte-for-byte preserved").toEqual(before);
    expect(await auditCount("advising_meeting", meetingId), "denied UPDATE records no event").toBe(
      auditBefore
    );
  });

  it("denies an authenticated DELETE of the base meeting (42501), preserving the row", async () => {
    const before = await readRow("advising_meeting", "meeting_id", meetingId);
    expect(before).not.toBeNull();

    const { data, error } = await selfClient
      .from("advising_meeting")
      .delete()
      .eq("meeting_id", meetingId)
      .select("meeting_id");
    expect(error, "authenticated advising_meeting DELETE must be denied").not.toBeNull();
    expect(error?.code, "advising_meeting DELETE denial code").toBe("42501");
    expect(data ?? [], "denied DELETE returns no row").toHaveLength(0);

    const after = await readRow("advising_meeting", "meeting_id", meetingId);
    expect(after, "the meeting row survives the denied DELETE").toEqual(before);
  });

  it("denies an authenticated UPDATE of the amendment (42501), preserving the append-only row", async () => {
    const before = await readRow("advising_meeting_amendment", "amendment_id", amendmentId);
    expect(before, "seeded amendment exists").not.toBeNull();
    const auditBefore = await auditCount("advising_meeting_amendment", amendmentId);

    const { data, error } = await selfClient
      .from("advising_meeting_amendment")
      .update({ reason: "TAMPERED", details: "TAMPERED" })
      .eq("amendment_id", amendmentId)
      .select("amendment_id");
    expect(error, "authenticated advising_meeting_amendment UPDATE must be denied").not.toBeNull();
    expect(error?.code, "advising_meeting_amendment UPDATE denial code").toBe("42501");
    expect(data ?? [], "denied UPDATE returns no row").toHaveLength(0);

    const after = await readRow("advising_meeting_amendment", "amendment_id", amendmentId);
    expect(after, "the amendment row is byte-for-byte preserved").toEqual(before);
    expect(
      await auditCount("advising_meeting_amendment", amendmentId),
      "denied UPDATE records no event"
    ).toBe(auditBefore);
  });

  it("denies an authenticated DELETE of the amendment (42501), preserving the append-only row", async () => {
    const before = await readRow("advising_meeting_amendment", "amendment_id", amendmentId);
    expect(before).not.toBeNull();

    const { data, error } = await selfClient
      .from("advising_meeting_amendment")
      .delete()
      .eq("amendment_id", amendmentId)
      .select("amendment_id");
    expect(error, "authenticated advising_meeting_amendment DELETE must be denied").not.toBeNull();
    expect(error?.code, "advising_meeting_amendment DELETE denial code").toBe("42501");
    expect(data ?? [], "denied DELETE returns no row").toHaveLength(0);

    const after = await readRow("advising_meeting_amendment", "amendment_id", amendmentId);
    expect(after, "the amendment row survives the denied DELETE").toEqual(before);
  });
});

describe("current-state DELETE is denied (R4)", () => {
  it("denies authenticated DELETE on student/fellowship/application/advisor (42501), preserving every row", async () => {
    // Fresh, dedicated rows so the assertion never depends on shared fixtures.
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({
        full_name: syntheticName("delete-denied-student"),
        email: syntheticEmail("delete-denied-student"),
        us_citizen: true,
      })
      .select("student_id")
      .single();
    expect(studentError, "seed delete-denied student").toBeNull();

    const { data: fellowship, error: fellowshipError } = await service
      .from("fellowship")
      .insert({ fellowship_name: syntheticName("delete-denied-fellowship") })
      .select("fellowship_id")
      .single();
    expect(fellowshipError, "seed delete-denied fellowship").toBeNull();

    const { data: application, error: applicationError } = await service
      .from("application")
      .insert({
        student_id: student!.student_id,
        fellowship_id: fellowship!.fellowship_id,
        destination_country: "Testland",
        stage_of_application: "Submitted",
        application_year: 2026,
      })
      .select("application_id")
      .single();
    expect(applicationError, "seed delete-denied application").toBeNull();

    const { data: advisor, error: advisorError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("delete-denied-advisor"),
        email: syntheticEmail("delete-denied-advisor"),
        is_active: true,
      })
      .select("advisor_id")
      .single();
    expect(advisorError, "seed delete-denied advisor").toBeNull();

    const targets: Array<{ table: string; idColumn: string; id: number }> = [
      { table: "student", idColumn: "student_id", id: student!.student_id as number },
      { table: "fellowship", idColumn: "fellowship_id", id: fellowship!.fellowship_id as number },
      { table: "application", idColumn: "application_id", id: application!.application_id as number },
      { table: "advisor", idColumn: "advisor_id", id: advisor!.advisor_id as number },
    ];

    for (const target of targets) {
      const before = await readRow(target.table, target.idColumn, target.id);
      expect(before, `${target.table} seeded row exists`).not.toBeNull();

      const { data, error } = await selfClient
        .from(target.table)
        .delete()
        .eq(target.idColumn, target.id)
        .select(target.idColumn);
      expect(error, `authenticated DELETE on ${target.table} must be denied`).not.toBeNull();
      expect(error?.code, `${target.table} DELETE denial code`).toBe("42501");
      expect(data ?? [], `denied ${target.table} DELETE returns no row`).toHaveLength(0);

      const after = await readRow(target.table, target.idColumn, target.id);
      expect(after, `${target.table} row survives the denied DELETE`).toEqual(before);
    }
  });
});
