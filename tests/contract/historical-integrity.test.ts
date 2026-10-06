/**
 * tests/contract/historical-integrity.test.ts
 *
 * Contract coverage for the historical-integrity remediation (migration
 * 20261008000001): append-only Fellowship Thursday and Scholarship History
 * amendments, the base-history SELECT/INSERT lockdown, the shared SECURITY
 * INVOKER effective-value views, the explicit source-to-NULL correction, the
 * terminal Void semantics, and the authenticated new-meeting advisor guard.
 *
 * Run inside the existing isolated Docker-local contract lane
 * (`scripts/contract/run.mjs`) — loopback only, full migration chain applied.
 * Service role is used strictly for local fixture seeding, auth-user creation,
 * admin pre-binding, and unchanged-row re-reads (never asserted as a grant).
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
let noAdvisorClient: SupabaseClient;
let otherFellowshipId: number;

async function readTable<T = Record<string, unknown>>(
  table: string,
  idColumn: string,
  id: number
): Promise<T | null> {
  const { data } = await service.from(table).select("*").eq(idColumn, id).maybeSingle();
  return (data as T | null) ?? null;
}

beforeAll(async () => {
  fixtures = await seedCoreFixtures(service);

  // A second fellowship for the scholarship correction target.
  const { data: other, error: otherError } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName("correction-target") })
    .select("fellowship_id")
    .single();
  if (otherError) throw new Error(`seed correction fellowship: ${otherError.message}`);
  otherFellowshipId = other.fellowship_id as number;

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
  const selfSigned = await signInWithPassword(selfClient, fixtures.advisorSelfEmail);
  expect(selfSigned).toBe(selfUserId);

  const noAdvisorEmail = syntheticEmail("hist-integrity-no-advisor");
  const noAdvisorUserId = await createAuthUser(service, noAdvisorEmail);
  noAdvisorClient = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const noAdvisorSigned = await signInWithPassword(noAdvisorClient, noAdvisorEmail);
  expect(noAdvisorSigned).toBe(noAdvisorUserId);
}, 60_000);

describe("Fellowship Thursday append-only corrections (R1/R2)", () => {
  it("corrects attendance through append-only amendments without mutating the original row", async () => {
    const originalBefore = await readTable("fellowship_thursday", "attendance_id", fixtures.attendanceId);

    const forgedTime = "2000-01-01T00:00:00.000Z";
    const sourceAmendment = await selfClient
      .from("fellowship_thursday_amendment")
      .insert({
        attendance_id: fixtures.attendanceId,
        reason: "Source was recorded from the wrong program",
        details: "Corrected to Honors College referral.",
        corrects_source_info: true,
        corrected_source_info: "HC",
        created_by_advisor_id: fixtures.advisorOtherId, // forged: must be overwritten
        created_at: forgedTime, // forged: must be overwritten
      })
      .select("amendment_id")
      .single();
    expect(sourceAmendment.error, "source-correction INSERT").toBeNull();
    expect(sourceAmendment.data).not.toBeNull();

    const attendedAmendment = await selfClient
      .from("fellowship_thursday_amendment")
      .insert({
        attendance_id: fixtures.attendanceId,
        reason: "Student did not attend after all",
        corrects_source_info: false,
        corrected_attended: false,
      })
      .select("amendment_id")
      .single();
    expect(attendedAmendment.error, "attended-correction INSERT").toBeNull();
    expect(attendedAmendment.data).not.toBeNull();

    // The original base row is byte-for-byte unchanged by the corrections.
    const originalAfter = await readTable("fellowship_thursday", "attendance_id", fixtures.attendanceId);
    expect(originalAfter, "corrections must never mutate the base attendance").toEqual(originalBefore);

    // The per-attendance amendment chain is readable, ordered chronologically,
    // with server-authored attribution (the forged creator/time was ignored).
    const { data: amendments, error: readError } = await selfClient
      .from("fellowship_thursday_amendment")
      .select("amendment_id, attendance_id, reason, corrects_source_info, corrected_source_info, corrected_attended, created_by_advisor_id, created_at")
      .eq("attendance_id", fixtures.attendanceId)
      .order("created_at")
      .order("amendment_id");
    expect(readError, "amendment chain SELECT").toBeNull();
    expect(amendments ?? []).toHaveLength(2);
    expect(amendments?.[0]).toMatchObject({
      attendance_id: fixtures.attendanceId,
      reason: "Source was recorded from the wrong program",
      corrects_source_info: true,
      corrected_source_info: "HC",
      corrected_attended: null,
      created_by_advisor_id: fixtures.advisorSelfId,
    });
    expect(String(amendments?.[0]?.created_at)).not.toBe(forgedTime);
    expect(amendments?.[1]).toMatchObject({
      corrects_source_info: false,
      corrected_attended: false,
      created_by_advisor_id: fixtures.advisorSelfId,
    });

    // The effective boundary resolves ONE row per attendance (never one row
    // per amendment — corrections cannot inflate attendance counts) with the
    // newest applicable correction per field. The base row still recorded
    // attended=true; the newest attendance correction (false) wins.
    const { data: effective, error: effectiveError } = await selfClient
      .from("effective_fellowship_thursday")
      .select("attendance_id, attended, source_info, base_attended, base_source_info, has_amendments")
      .eq("attendance_id", fixtures.attendanceId);
    expect(effectiveError, "effective view SELECT").toBeNull();
    expect(effective ?? []).toHaveLength(1);
    expect(effective?.[0]).toMatchObject({
      attendance_id: fixtures.attendanceId,
      attended: false,
      source_info: "HC",
      base_attended: true,
      base_source_info: "OCF",
      has_amendments: true,
    });
  });

  it("supports an explicit correction of source_info to NULL (never falls back to the base value)", async () => {
    const { data, error } = await selfClient
      .from("fellowship_thursday_amendment")
      .insert({
        attendance_id: fixtures.attendanceId,
        reason: "The recorded source was wrong and is now unknown",
        corrects_source_info: true,
        corrected_source_info: null,
        corrected_attended: null,
      })
      .select("amendment_id")
      .single();
    expect(error, "explicit NULL source-correction INSERT").toBeNull();
    expect(data).not.toBeNull();

    const { data: effective } = await selfClient
      .from("effective_fellowship_thursday")
      .select("source_info, base_source_info")
      .eq("attendance_id", fixtures.attendanceId)
      .maybeSingle();
    expect(effective, "effective row").not.toBeNull();
    // The newest source correction explicitly sets source_info to NULL; the
    // base 'OCF' value must NOT leak back through a naive COALESCE fallback.
    // The immutable base column stays readable as base_source_info for audit.
    expect(effective?.source_info, "effective source corrected to NULL").toBeNull();
    expect(effective?.base_source_info, "original base source preserved").toBe("OCF");
  });

  it("requires at least one field correction and rejects payload/source inconsistencies (23514)", async () => {
    const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
      {
        label: "no correction at all",
        payload: { attendance_id: fixtures.attendanceId, reason: "Nothing corrected" },
      },
      {
        label: "corrected value without the flag",
        payload: {
          attendance_id: fixtures.attendanceId,
          reason: "Flag missing",
          corrects_source_info: false,
          corrected_source_info: "MM",
        },
      },
      {
        label: "unknown corrected source",
        payload: {
          attendance_id: fixtures.attendanceId,
          reason: "Unknown source",
          corrects_source_info: true,
          corrected_source_info: "XX",
        },
      },
      {
        label: "blank reason",
        payload: { attendance_id: fixtures.attendanceId, reason: "   ", corrects_source_info: true },
      },
    ];
    for (const c of cases) {
      const { data, error } = await selfClient.from("fellowship_thursday_amendment").insert(c.payload);
      expect(data ?? [], `${c.label} must not insert`).toHaveLength(0);
      expect(error, `${c.label} must be rejected`).not.toBeNull();
      expect(error?.code, `${c.label} rejection code`).toBe("23514");
    }
  });

  it("locks the base attendance and the amendment rows against UPDATE and DELETE (row preserved)", async () => {
    const baseBefore = await readTable("fellowship_thursday", "attendance_id", fixtures.attendanceId);

    const updateBase = await selfClient
      .from("fellowship_thursday")
      .update({ attended: false })
      .eq("attendance_id", fixtures.attendanceId)
      .select("attendance_id");
    expect(updateBase.data ?? [], "base attendance UPDATE affected rows").toHaveLength(0);
    expect(updateBase.error, "base attendance UPDATE must be denied").not.toBeNull();
    expect(updateBase.error?.code, "base attendance UPDATE denial code").toBe("42501");

    const deleteBase = await selfClient
      .from("fellowship_thursday")
      .delete()
      .eq("attendance_id", fixtures.attendanceId);
    expect(deleteBase.data ?? [], "base attendance DELETE affected rows").toHaveLength(0);
    expect(deleteBase.error, "base attendance DELETE must be denied").not.toBeNull();
    expect(deleteBase.error?.code, "base attendance DELETE denial code").toBe("42501");

    const baseAfter = await readTable("fellowship_thursday", "attendance_id", fixtures.attendanceId);
    expect(baseAfter, "base attendance preserved after denied mutations").toEqual(baseBefore);

    const { data: amendmentIdRow } = await service
      .from("fellowship_thursday_amendment")
      .select("amendment_id")
      .eq("attendance_id", fixtures.attendanceId)
      .order("amendment_id", { ascending: true })
      .limit(1)
      .maybeSingle();
    expect(amendmentIdRow).not.toBeNull();
    const amendmentId = amendmentIdRow!.amendment_id as number;
    const amendmentBefore = await readTable("fellowship_thursday_amendment", "amendment_id", amendmentId);

    const updateAmendment = await selfClient
      .from("fellowship_thursday_amendment")
      .update({ reason: "This must not apply" })
      .eq("amendment_id", amendmentId)
      .select("amendment_id");
    expect(updateAmendment.data ?? [], "amendment UPDATE affected rows").toHaveLength(0);
    expect(updateAmendment.error, "amendment UPDATE must be denied").not.toBeNull();
    expect(updateAmendment.error?.code, "amendment UPDATE denial code").toBe("42501");

    const deleteAmendment = await selfClient
      .from("fellowship_thursday_amendment")
      .delete()
      .eq("amendment_id", amendmentId);
    expect(deleteAmendment.data ?? [], "amendment DELETE affected rows").toHaveLength(0);
    expect(deleteAmendment.error, "amendment DELETE must be denied").not.toBeNull();
    expect(deleteAmendment.error?.code, "amendment DELETE denial code").toBe("42501");

    const amendmentAfter = await readTable("fellowship_thursday_amendment", "amendment_id", amendmentId);
    expect(amendmentAfter, "denied amendment mutations leave the row unchanged").toEqual(amendmentBefore);
  });

  it("denies amendment reads/writes to an authenticated user with no advisor row (real-row proof)", async () => {
    const { data, error } = await noAdvisorClient
      .from("fellowship_thursday_amendment")
      .select("amendment_id");
    if (error) {
      expect(error.code, "no-advisor amendment read error code").toBe("42501");
    } else {
      expect(data ?? [], "no-advisor amendment read rows").toHaveLength(0);
    }
    const insert = await noAdvisorClient.from("fellowship_thursday_amendment").insert({
      attendance_id: fixtures.attendanceId,
      reason: "Must be denied",
      corrects_source_info: true,
      corrected_source_info: null,
    });
    expect(insert.data ?? [], "no-advisor amendment INSERT affected rows").toHaveLength(0);
    expect(insert.error, "no-advisor amendment INSERT must be denied").not.toBeNull();
    expect(insert.error?.code, "no-advisor amendment INSERT denial code").toBe("42501");
  });
});

describe("Scholarship History append-only Correction/Void (R3)", () => {
  it("corrects the awarded fellowship without mutating the base award", async () => {
    const originalBefore = await readTable("scholarship_history", "history_id", fixtures.historyId);

    const { data, error } = await selfClient
      .from("scholarship_history_amendment")
      .insert({
        history_id: fixtures.historyId,
        amendment_type: "Correction",
        reason: "Awarded program was recorded under the wrong fellowship",
        corrected_fellowship_id: otherFellowshipId,
      })
      .select("amendment_id")
      .single();
    expect(error, "Correction INSERT").toBeNull();
    expect(data).not.toBeNull();

    const originalAfter = await readTable("scholarship_history", "history_id", fixtures.historyId);
    expect(originalAfter, "a Correction must never mutate the base award").toEqual(originalBefore);

    const { data: effective } = await selfClient
      .from("effective_scholarship_history")
      .select("history_id, fellowship_id, base_fellowship_id, has_correction, is_voided")
      .eq("history_id", fixtures.historyId)
      .maybeSingle();
    expect(effective).not.toBeNull();
    expect(effective).toMatchObject({
      history_id: fixtures.historyId,
      fellowship_id: otherFellowshipId,
      base_fellowship_id: fixtures.fellowshipId,
      has_correction: true,
      is_voided: false,
    });
  });

  it("voids an award (terminal): excluded from effective counts, still auditable, no later amendment allowed", async () => {
    const { data: voided, error } = await selfClient
      .from("scholarship_history_amendment")
      .insert({
        history_id: fixtures.historyId,
        amendment_type: "Void",
        reason: "The award was recorded by mistake and is void",
      })
      .select("amendment_id, created_by_advisor_id")
      .single();
    expect(error, "Void INSERT").toBeNull();
    expect(voided).not.toBeNull();

    // The base row survives (auditable) and is still readable through the
    // effective boundary, but is_voided is authoritative for operational use.
    const base = await readTable("scholarship_history", "history_id", fixtures.historyId);
    expect(base).not.toBeNull();
    const { data: effective } = await selfClient
      .from("effective_scholarship_history")
      .select("history_id, is_voided, void_amendment_id, voided_by_advisor_id")
      .eq("history_id", fixtures.historyId)
      .maybeSingle();
    expect(effective).not.toBeNull();
    expect(effective?.is_voided, "voided award must be flagged in the effective boundary").toBe(true);
    expect(effective?.void_amendment_id, "void attribution amendment id").toBe(voided!.amendment_id);
    expect(effective?.voided_by_advisor_id, "void creator").toBe(fixtures.advisorSelfId);

    // Void is TERMINAL: no further amendment (not even another Void) may be
    // appended to this award.
    const late = await selfClient.from("scholarship_history_amendment").insert({
      history_id: fixtures.historyId,
      amendment_type: "Correction",
      reason: "Tries to un-void",
      corrected_fellowship_id: otherFellowshipId,
    });
    expect(late.data ?? [], "post-Void amendment affected rows").toHaveLength(0);
    expect(late.error, "post-Void amendment must be rejected").not.toBeNull();
    expect(late.error?.code, "post-Void amendment rejection code").toBe("42501");
  });

  it("rejects invalid amendment payloads (unknown type, Void-with-correction, blank reason)", async () => {
    // A fresh history row: the Void-terminal trigger fires BEFORE the CHECK
    // constraints are evaluated, so invalid payloads must target a history
    // that has never been voided (otherwise the terminal guard would shadow
    // the CHECK rejection with 42501).
    const { data: freshHistory, error: freshError } = await service
      .from("scholarship_history")
      .insert({ student_id: fixtures.studentId, fellowship_id: fixtures.fellowshipId })
      .select("history_id")
      .single();
    expect(freshError, "fresh history seed").toBeNull();
    const freshHistoryId = freshHistory!.history_id as number;

    const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: "unknown type", payload: { history_id: freshHistoryId, amendment_type: "Rescind", reason: "Bad type" } },
      {
        label: "Void carrying a corrected fellowship",
        payload: { history_id: freshHistoryId, amendment_type: "Void", reason: "Bad void", corrected_fellowship_id: otherFellowshipId },
      },
      { label: "blank reason", payload: { history_id: freshHistoryId, amendment_type: "Correction", reason: "  \t " } },
    ];
    for (const c of cases) {
      const { data, error } = await selfClient.from("scholarship_history_amendment").insert(c.payload);
      expect(data ?? [], `${c.label} must not insert`).toHaveLength(0);
      expect(error, `${c.label} must be rejected`).not.toBeNull();
      expect(error?.code, `${c.label} rejection code`).toBe("23514");
    }
  });

  it("locks the base award row against UPDATE and DELETE", async () => {
    const before = await readTable("scholarship_history", "history_id", fixtures.historyId);

    const update = await selfClient
      .from("scholarship_history")
      .update({ fellowship_id: otherFellowshipId })
      .eq("history_id", fixtures.historyId)
      .select("history_id");
    expect(update.data ?? [], "base award UPDATE affected rows").toHaveLength(0);
    expect(update.error, "base award UPDATE must be denied").not.toBeNull();
    expect(update.error?.code, "base award UPDATE denial code").toBe("42501");

    const deletion = await selfClient
      .from("scholarship_history")
      .delete()
      .eq("history_id", fixtures.historyId);
    expect(deletion.data ?? [], "base award DELETE affected rows").toHaveLength(0);
    expect(deletion.error, "base award DELETE must be denied").not.toBeNull();
    expect(deletion.error?.code, "base award DELETE denial code").toBe("42501");

    const after = await readTable("scholarship_history", "history_id", fixtures.historyId);
    expect(after, "base award preserved after denied mutations").toEqual(before);
  });
});

describe("application DB hardening (R7)", () => {
  it("rejects a stage/flag mismatch at the database boundary (Awarded without both flags)", async () => {
    const { data, error } = await service.from("application").insert({
      student_id: fixtures.studentId,
      fellowship_id: fixtures.fellowshipId,
      stage_of_application: "Awarded",
      is_semi_finalist: true,
      is_finalist: false,
    });
    expect(data ?? [], "mismatched Awarded must not insert").toHaveLength(0);
    expect(error, "mismatched Awarded must be a CHECK violation").not.toBeNull();
    expect(error?.code, "mismatched Awarded rejection code").toBe("23514");
  });
});

describe("authenticated new-meeting advisor guard (R8)", () => {
  it("rejects an authenticated advising-meeting INSERT with a NULL advisor_id but keeps legacy NULL rows", async () => {
    // Authenticated boundary: a new meeting must name the conducting advisor.
    const denied = await selfClient.from("advising_meeting").insert({
      student_id: fixtures.studentId,
      meeting_date: "2026-09-22",
      meeting_mode: "Virtual",
      no_show: false,
    });
    expect(denied.data ?? [], "NULL-advisor authenticated INSERT affected rows").toHaveLength(0);
    expect(denied.error, "NULL-advisor authenticated INSERT must be denied").not.toBeNull();
    expect(denied.error?.code, "NULL-advisor INSERT denial code").toBe("42501");

    // Trusted technical path: a no-JWT/service-row INSERT with a NULL advisor
    // is a legacy-style write and stays allowed (never backfilled).
    const { data: trusted, error: trustedError } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        meeting_date: "2025-05-05",
        meeting_mode: "In-Person",
        no_show: false,
        notes: "Legacy-style imported row without a conducting advisor.",
      })
      .select("meeting_id")
      .single();
    expect(trustedError, "technical NULL-advisor INSERT must succeed").toBeNull();
    const meetingId = trusted!.meeting_id as number;
    const row = await readTable("advising_meeting", "meeting_id", meetingId);
    expect(row).not.toBeNull();
    expect((row as { advisor_id: number | null }).advisor_id, "legacy NULL advisor preserved").toBeNull();

    // The recorders stays distinct: an authenticated meeting with a conductor
    // is attributed to the authenticated advisor.
    const withAdvisor = await selfClient
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorOtherId,
        meeting_date: "2026-09-23",
        meeting_mode: "Virtual",
        no_show: false,
      })
      .select("meeting_id")
      .single();
    expect(withAdvisor.error, "conducted-by-other meeting INSERT").toBeNull();
    const conductedRow = await readTable("advising_meeting", "meeting_id", withAdvisor.data!.meeting_id);
    expect((conductedRow as { advisor_id: number | null }).advisor_id).toBe(fixtures.advisorOtherId);
    expect((conductedRow as { created_by_advisor_id: number | null }).created_by_advisor_id).toBe(
      fixtures.advisorSelfId
    );
  });
});