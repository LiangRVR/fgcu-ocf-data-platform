/**
 * tests/contract/advising-application-link.test.ts
 *
 * Behavior contract for migration 20260929000001 (advising ↔ application link,
 * AI-DLC change 2026-09-29-advising-application-link, plan Work 6). Runs
 * against the fresh, isolated Docker-local Supabase lane and covers:
 *
 *   - application.application_year: two applications for ONE fellowship with
 *     different explicit years both insert and read back distinctly — there is
 *     no (student, fellowship, year) uniqueness rule, so distinct cycles are
 *     the model, not duplicates of the fellowship;
 *   - General Advising: advising_meeting.application_id NULL inserts and reads
 *     back as NULL (NULL passes both the direct and the composite FK);
 *   - same-student application scoping: a meeting referencing the student's own
 *     application inserts and reads back;
 *   - nonexistent application: application_id without a matching row fails
 *     with FK 23503 on the direct FK;
 *   - other-student application: referencing ANOTHER student's application
 *     fails with FK 23503 on the composite FK — cross-student integrity is
 *     enforced at the database boundary, never by client-side filtering;
 *   - application/student mismatch UPDATE: retargeting a meeting to another
 *     student's application, or moving the meeting's student away from its
 *     application, is rejected by the composite FK and the row is proven
 *     unchanged;
 *   - historic-style rows: a meeting seeded with NULL application_id and NULL
 *     created_by_advisor_id keeps both NULLs and its exact meeting_date is
 *     readable unchanged (null relationship/year compatibility, R2);
 *   - authenticated creation metadata: an authenticated ACTIVE-advisor INSERT
 *     OVERRIDES forged created_by_advisor_id/created_at with the resolved
 *     active advisor and a fresh database timestamp;
 *   - append-only meetings: direct UPDATEs — including changes to immutable
 *     metadata and ordinary meeting fields — are rejected and the row is
 *     proven unchanged;
 *   - conducted advisor distinct from creator: advisor_id (who conducted the
 *     meeting) is never touched by the metadata trigger and stays distinct
 *     from created_by_advisor_id (who entered the record).
 *
 * Existing RLS expectations are preserved and NOT re-litigated here: the
 * authenticated paths below run through a pre-bound ACTIVE advisor session
 * (which retains SELECT/INSERT access to append-only advising_meeting); the
 * inactive and no-advisor denials remain covered by rls.test.ts. Constraint
 * isolation (FK semantics with no policy interference) runs through the LOCAL
 * service-role client, consistent with constraints.test.ts; the service role
 * is never asserted as an access grant.
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

/** A seeded student for a self-contained assertion; returns its id. */
async function insertStudent(prefix: string): Promise<number> {
  const { data, error } = await service
    .from("student")
    .insert({
      full_name: syntheticName(prefix),
      email: syntheticEmail(prefix),
      is_ch_student: false,
      us_citizen: true,
      first_gen: false,
      honors_college: false,
      class_standing: "Junior",
      gpa: 3.42,
      gender: "NR",
    })
    .select("student_id")
    .single();
  if (error) throw new Error(`insert student ${prefix}: ${error.message}`);
  return data.student_id as number;
}

/** A seeded fellowship for a self-contained assertion; returns its id. */
async function insertFellowship(prefix: string): Promise<number> {
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(prefix) })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`insert fellowship ${prefix}: ${error.message}`);
  return data.fellowship_id as number;
}

/**
 * A seeded application for a self-contained assertion; returns its id. An
 * explicit `application_year` is always named when provided — the same rule
 * the synthetic seed applies — and never invented by the test.
 */
async function insertApplication(
  studentId: number,
  fellowshipId: number,
  applicationYear?: number
): Promise<number> {
  const payload: Record<string, unknown> = {
    student_id: studentId,
    fellowship_id: fellowshipId,
    destination_country: "Testland",
    stage_of_application: "Submitted",
  };
  if (applicationYear !== undefined) payload.application_year = applicationYear;
  const { data, error } = await service
    .from("application")
    .insert(payload)
    .select("application_id")
    .single();
  if (error) throw new Error(`insert application: ${error.message}`);
  return data.application_id as number;
}

let fixtures: SeededCore;
let selfClient: SupabaseClient;
let selfUserId: string;

// A second student and their OWN application, used only by the cross-student
// (composite FK) and mismatch-update assertions.
let otherStudentId: number;
let otherStudentAppId: number;

beforeAll(async () => {
  fixtures = await seedCoreFixtures(service);

  // A pre-bound ACTIVE advisor session, which has SELECT/INSERT access to the
  // append-only advising_meeting record.
  selfUserId = await createAuthUser(service, fixtures.advisorSelfEmail);
  // ADMIN PRE-BINDING (the only legitimate way auth_user_id is written).
  const { error: bindError } = await service
    .from("advisor")
    .update({ auth_user_id: selfUserId })
    .eq("advisor_id", fixtures.advisorSelfId)
    .select("advisor_id");
  if (bindError) throw new Error(`admin pre-bind self advisor: ${bindError.message}`);

  selfClient = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await signInWithPassword(selfClient, fixtures.advisorSelfEmail);
  expect(signed).toBe(selfUserId);

  otherStudentId = await insertStudent("other-student-app");
  otherStudentAppId = await insertApplication(otherStudentId, fixtures.fellowshipId, 2026);
}, 60_000);

describe("application_year allows distinct cycles for one fellowship", () => {
  it("inserts two applications for the same fellowship with different explicit years", async () => {
    const fellowshipId = await insertFellowship("cycle");
    const year2025 = await insertApplication(fixtures.studentId, fellowshipId, 2025);
    const year2026 = await insertApplication(fixtures.studentId, fellowshipId, 2026);
    expect(year2025).not.toBe(year2026);

    const { data, error } = await service
      .from("application")
      .select("application_id, application_year")
      .in("application_id", [year2025, year2026])
      .order("application_year");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(2);
    expect(data ?? []).toEqual([
      { application_id: year2025, application_year: 2025 },
      { application_id: year2026, application_year: 2026 },
    ]);
  });

  it("seeds the core application with a known explicit application_year", async () => {
    expect(fixtures.applicationYear).toBe(2026);
    const { data, error } = await service
      .from("application")
      .select("application_year")
      .eq("application_id", fixtures.applicationId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.application_year).toBe(2026);
  });
});

describe("advising_meeting.application_id scoping", () => {
  it("inserts and reads back a General Advising meeting with application_id NULL", async () => {
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-10",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: null,
      })
      .select("meeting_id, student_id, application_id")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.student_id).toBe(fixtures.studentId);
    expect(data!.application_id, "General Advising keeps a NULL application_id").toBeNull();
  });

  it("attaches a meeting to the student's own application", async () => {
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-11",
        meeting_mode: "In-Person",
        no_show: false,
        application_id: fixtures.applicationId,
      })
      .select("meeting_id, student_id, application_id")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.application_id).toBe(fixtures.applicationId);
    expect(data!.student_id).toBe(fixtures.studentId);
  });

  it("rejects a meeting referencing a nonexistent application (23503 on the direct FK)", async () => {
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-12",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: 999_999_999,
      });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
    expect(String(error?.message)).toContain("advising_meeting_application_id_fkey");
  });

  it("rejects a meeting referencing another student's application (23503 on the composite FK)", async () => {
    // The direct FK is satisfied (the application exists); only the composite
    // (application_id, student_id) FK — the database integrity control — can
    // reject the cross-student reference.
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-13",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: otherStudentAppId,
      });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
    expect(String(error?.message)).toContain("advising_meeting_application_student_fkey");
  });
});

describe("application/student mismatch is rejected on UPDATE", () => {
  it("rejects retargeting a meeting to another student's application", async () => {
    const { data: meeting, error: insertError } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-14",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: fixtures.applicationId,
      })
      .select("meeting_id")
      .single();
    expect(insertError).toBeNull();
    expect(meeting).not.toBeNull();

    const { data, error } = await service
      .from("advising_meeting")
      .update({ application_id: otherStudentAppId })
      .eq("meeting_id", meeting!.meeting_id)
      .select("meeting_id");
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
    expect(String(error?.message)).toContain("advising_meeting_application_student_fkey");

    // The row is unchanged: still attached to the student's own application.
    const { data: unchanged } = await service
      .from("advising_meeting")
      .select("student_id, application_id")
      .eq("meeting_id", meeting!.meeting_id)
      .maybeSingle();
    expect(unchanged).not.toBeNull();
    expect(unchanged!.student_id).toBe(fixtures.studentId);
    expect(unchanged!.application_id).toBe(fixtures.applicationId);
  });

  it("rejects moving a meeting's student away from its application", async () => {
    const { data: meeting, error: insertError } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-18",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: fixtures.applicationId,
      })
      .select("meeting_id")
      .single();
    expect(insertError).toBeNull();
    expect(meeting).not.toBeNull();

    const { data, error } = await service
      .from("advising_meeting")
      .update({ student_id: otherStudentId })
      .eq("meeting_id", meeting!.meeting_id)
      .select("meeting_id");
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
    expect(String(error?.message)).toContain("advising_meeting_application_student_fkey");

    const { data: unchanged } = await service
      .from("advising_meeting")
      .select("student_id, application_id")
      .eq("meeting_id", meeting!.meeting_id)
      .maybeSingle();
    expect(unchanged).not.toBeNull();
    expect(unchanged!.student_id).toBe(fixtures.studentId);
    expect(unchanged!.application_id).toBe(fixtures.applicationId);
  });
});

describe("historic-style meeting rows stay readable (R2)", () => {
  it("keeps NULL application/creator and reads back the exact meeting date", async () => {
    const meetingDate = "2023-03-15";
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: meetingDate,
        meeting_mode: "Virtual",
        no_show: false,
        application_id: null,
        created_by_advisor_id: null,
      })
      .select("meeting_id, meeting_date, application_id, created_by_advisor_id, created_at")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    // NULL relationship and NULL creator both survive; the exact session date
    // is preserved byte-for-byte and is never confused with created_at.
    expect(data!.application_id).toBeNull();
    expect(data!.created_by_advisor_id).toBeNull();
    expect(data!.meeting_date).toBe(meetingDate);
    // The NOT NULL created_at default applied, but it never replaces the date.
    expect(data!.created_at).toBeTruthy();
    expect(String(data!.created_at)).not.toContain(meetingDate);
  });
});

describe("authenticated active-advisor creation metadata (R4)", () => {
  it("overrides forged creator and timestamp on an authenticated active-advisor INSERT", async () => {
    const forgedCreator = fixtures.advisorOtherId;
    const forgedTime = "2000-01-01T00:00:00.000Z";
    const startMs = Date.now();

    const { data, error } = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorOtherId, // conducted by the OTHER advisor
        meeting_date: "2026-02-15",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: fixtures.applicationId,
        created_by_advisor_id: forgedCreator, // forged: must be overridden
        created_at: forgedTime, // forged: must be overridden
      })
      .select("meeting_id")
      .single();
    const endMs = Date.now();
    expect(error, "authenticated active-staff INSERT must succeed").toBeNull();
    expect(data).not.toBeNull();

    // Service-role re-read: what the trigger actually persisted.
    const { data: row } = await service
      .from("advising_meeting")
      .select("advisor_id, application_id, created_by_advisor_id, created_at")
      .eq("meeting_id", data!.meeting_id)
      .maybeSingle();
    expect(row).not.toBeNull();

    // The resolved active advisor (self) replaces the forged creator; the
    // forged timestamp is replaced by a fresh database-stamped value inside
    // the insert window (generous tolerance for clock skew).
    expect(row!.created_by_advisor_id, "forged creator must be overridden").toBe(fixtures.advisorSelfId);
    expect(String(row!.created_at), "forged timestamp must be overridden").not.toBe(forgedTime);
    const storedMs = new Date(String(row!.created_at)).getTime();
    expect(storedMs).toBeGreaterThanOrEqual(startMs - 120_000);
    expect(storedMs).toBeLessThanOrEqual(endMs + 120_000);

    // The application scoping and the conducted advisor survive untouched.
    expect(row!.application_id).toBe(fixtures.applicationId);
    expect(row!.advisor_id).toBe(fixtures.advisorOtherId);
  });

  it("discards forged creator/time on a no-JWT service/technical INSERT", async () => {
    // The service-role session carries NO JWT `sub` claim (auth.uid() is
    // NULL), so this is the trusted technical path. The hardened trigger must
    // UNCONDITIONALLY drop a forged creator (a technical write is never
    // attributed to an advisor) and re-stamp the forged timestamp.
    const forgedTime = "2000-01-01T00:00:00.000Z";
    const startMs = Date.now();
    const { data, error } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-19",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: null,
        created_by_advisor_id: fixtures.advisorOtherId, // forged: must be dropped
        created_at: forgedTime, // forged: must be dropped
      })
      .select("meeting_id")
      .single();
    const endMs = Date.now();
    expect(error, "technical no-JWT INSERT must succeed").toBeNull();
    expect(data).not.toBeNull();

    const { data: row } = await service
      .from("advising_meeting")
      .select("created_by_advisor_id, created_at")
      .eq("meeting_id", data!.meeting_id)
      .maybeSingle();
    expect(row).not.toBeNull();
    // No JWT/technical session ⇒ creator is unconditionally NULL, never the
    // forged advisor.
    expect(row!.created_by_advisor_id, "forged creator must be dropped to NULL").toBeNull();
    // The forged timestamp is replaced by the database current timestamp.
    expect(String(row!.created_at), "forged timestamp must be dropped").not.toBe(forgedTime);
    const storedMs = new Date(String(row!.created_at)).getTime();
    expect(storedMs).toBeGreaterThanOrEqual(startMs - 120_000);
    expect(storedMs).toBeLessThanOrEqual(endMs + 120_000);
  });

  it("keeps the conducting advisor (advisor_id) distinct from the creator", async () => {
    const { data: meeting, error } = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorOtherId,
        meeting_date: "2026-02-16",
        meeting_mode: "In-Person",
        no_show: false,
        application_id: null,
      })
      .select("meeting_id")
      .single();
    expect(error).toBeNull();
    expect(meeting).not.toBeNull();

    const { data: row } = await service
      .from("advising_meeting")
      .select("advisor_id, created_by_advisor_id")
      .eq("meeting_id", meeting!.meeting_id)
      .maybeSingle();
    expect(row).not.toBeNull();
    expect(row!.advisor_id, "the conducted-by advisor").toBe(fixtures.advisorOtherId);
    expect(row!.created_by_advisor_id, "the entered-by creator").toBe(fixtures.advisorSelfId);
    expect(row!.created_by_advisor_id, "creator and conductor must be distinct roles").not.toBe(row!.advisor_id);
  });

  it("rejects changes to created_at/created_by_advisor_id and proves the row unchanged", async () => {
    const { data: meeting, error: insertError } = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-02-17",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: null,
      })
      .select("meeting_id")
      .single();
    expect(insertError).toBeNull();
    expect(meeting).not.toBeNull();
    const meetingId = meeting!.meeting_id;

    const { data: before } = await service
      .from("advising_meeting")
      .select("created_at, created_by_advisor_id, meeting_mode")
      .eq("meeting_id", meetingId)
      .maybeSingle();
    expect(before).not.toBeNull();
    expect(before!.created_by_advisor_id).toBe(fixtures.advisorSelfId);

    // (a) Change the creator: rejected fail-closed by the metadata trigger.
    const creatorChange = await selfClient
      .from("advising_meeting")
      .update({ created_by_advisor_id: fixtures.advisorOtherId })
      .eq("meeting_id", meetingId)
      .select("meeting_id");
    expect(creatorChange.data ?? []).toHaveLength(0);
    expect(creatorChange.error, "creator change must be rejected").not.toBeNull();
    expect(["42501", "P0001"]).toContain(creatorChange.error!.code);

    // (b) Change the timestamp: rejected fail-closed by the metadata trigger.
    const timeChange = await selfClient
      .from("advising_meeting")
      .update({ created_at: "2000-01-01T00:00:00.000Z" })
      .eq("meeting_id", meetingId)
      .select("meeting_id");
    expect(timeChange.data ?? []).toHaveLength(0);
    expect(timeChange.error, "timestamp change must be rejected").not.toBeNull();
    expect(["42501", "P0001"]).toContain(timeChange.error!.code);

    // Both denials are proven against the unchanged real row (R4).
    const { data: after } = await service
      .from("advising_meeting")
      .select("created_at, created_by_advisor_id, meeting_mode")
      .eq("meeting_id", meetingId)
      .maybeSingle();
    expect(after).toEqual(before);

    // (c) The append-only authorization also rejects an ordinary meeting edit.
    const edit = await selfClient
      .from("advising_meeting")
      .update({ meeting_mode: "In-Person" })
      .eq("meeting_id", meetingId)
      .select("meeting_mode");
    expect(edit.data ?? []).toHaveLength(0);
    expect(edit.error, "ordinary meeting edit must be rejected").not.toBeNull();
    expect(edit.error?.code).toBe("42501");

    const { data: final } = await service
      .from("advising_meeting")
      .select("created_at, created_by_advisor_id, meeting_mode")
      .eq("meeting_id", meetingId)
      .maybeSingle();
    expect(final).not.toBeNull();
    expect(final).toEqual(before);
  });
});

describe("PostgREST direct-FK embed alongside the advising relation constraints", () => {
  // Real REST-API integration: `advising_meeting` now has TWO FKs to
  // `application` (direct + composite). PostgREST needs the explicit FK-name
  // hint to embed the application through the DIRECT relationship; the embed
  // must coexist with the composite (application_id, student_id) constraint
  // that guards the same row.
  it("embeds application data via application!advising_meeting_application_id_fkey(...)", async () => {
    // One meeting attached to the student's own application and one General
    // Advising meeting, read back through the authenticated active-advisor API.
    const attached = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-03-01",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: fixtures.applicationId,
      })
      .select("meeting_id")
      .single();
    expect(attached.error).toBeNull();
    expect(attached.data).not.toBeNull();

    const general = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorSelfId,
        meeting_date: "2026-03-02",
        meeting_mode: "Virtual",
        no_show: false,
        application_id: null,
      })
      .select("meeting_id")
      .single();
    expect(general.error).toBeNull();
    expect(general.data).not.toBeNull();

    const { data, error } = await selfClient
      .from("advising_meeting")
      .select(
        "meeting_id, application_id, application!advising_meeting_application_id_fkey(application_id, application_year, fellowship_id)"
      )
      .in("meeting_id", [attached.data!.meeting_id, general.data!.meeting_id])
      .order("meeting_id");
    expect(error, "direct-FK embed query must succeed").toBeNull();
    expect(data ?? []).toHaveLength(2);

    const byId = new Map((data ?? []).map((row) => [row.meeting_id as number, row]));
    const attachedRow = byId.get(attached.data!.meeting_id);
    const generalRow = byId.get(general.data!.meeting_id);

    // The embedded application comes back with its cycle and fellowship.
    expect(attachedRow).toBeDefined();
    expect(attachedRow!.application_id).toBe(fixtures.applicationId);
    expect(attachedRow!.application).toEqual({
      application_id: fixtures.applicationId,
      application_year: 2026,
      fellowship_id: fixtures.fellowshipId,
    });

    // General Advising: NULL application_id embeds as NULL, not an error.
    expect(generalRow).toBeDefined();
    expect(generalRow!.application_id).toBeNull();
    expect(generalRow!.application).toBeNull();
  });
});
