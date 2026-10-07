/**
 * tests/contract/list-views.test.ts
 *
 * Contract coverage for the read-only SECURITY INVOKER list views added by
 * migration 20261010000001 (AI-DLC change `server-side-pagination-and-querying`,
 * Plan Work 3):
 *   public.student_list, public.application_list, public.advising_meeting_list,
 *   public.fellowship_thursday_list, public.scholarship_history_list,
 *   public.fellowship_list.
 *
 * Asserted here:
 *   - every view is SECURITY INVOKER (RLS cannot be bypassed by reading it);
 *   - `authenticated` has SELECT, `anon` has no SELECT/INSERT/UPDATE/DELETE;
 *   - each view exposes exactly its documented explicit columns (no
 *     `SELECT *` drift) and never exposes the advisor Auth binding
 *     (`auth_user_id`);
 *   - underlying RLS AND the exact-count path apply THROUGH every one of the
 *     six views: an authenticated active advisor reads the seeded rows with a
 *     matching `count: "exact"`, an authenticated account without an active
 *     advisor row reads zero rows and count zero, and anon is denied outright;
 *   - core historical/operational semantics: corrected Fellowship Thursday and
 *     Scholarship History values (from the shared effective views, never raw
 *     base rows), an explicitly voided award stays auditable but is excluded
 *     from the student prior-award flag, General Advising keeps NULL
 *     application/fellowship context, flattened names resolve, and metrics are
 *     not multiplied by amendments/joins.
 *
 * Run inside the existing isolated Docker-local contract lane
 * (`scripts/contract/run.mjs`) — loopback only, full migration chain applied.
 * Service role is used strictly for local fixture seeding, auth-user creation,
 * admin pre-binding, and unchanged-row re-reads (never asserted as a grant).
 * Direct Postgres reads are read-only catalog/view inspections.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createDbPool, createAnonClient, createServiceRoleClient, getContractEnv } from "./helpers/setup";
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

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await pool.query(sql, params);
  return result.rows as Row[];
}

/**
 * Minimal untyped PostgREST accessor.
 *
 * The six list views are not present in the committed `types/database.ts`
 * (regeneration is blocked in this environment — see the change's evidence), so
 * this test reaches them through an explicitly typed adapter rather than
 * editing generated types or widening assertions to `any`.
 */
interface UntypedResult {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
  count: number | null;
}

interface UntypedQuery extends PromiseLike<UntypedResult> {
  eq(column: string, value: unknown): UntypedQuery;
  in(column: string, values: readonly unknown[]): UntypedQuery;
  order(column: string, options?: { ascending?: boolean }): UntypedQuery;
}

interface UntypedClient {
  from(table: string): {
    select(columns?: string, options?: { count?: "exact" }): UntypedQuery;
  };
}

function untyped(client: SupabaseClient): UntypedClient {
  return client as unknown as UntypedClient;
}

const VIEWS = [
  "student_list",
  "application_list",
  "advising_meeting_list",
  "fellowship_thursday_list",
  "scholarship_history_list",
  "fellowship_list",
] as const;

const EXPECTED_COLUMNS: Record<(typeof VIEWS)[number], string[]> = {
  student_list: [
    "student_id",
    "full_name",
    "is_ch_student",
    "email",
    "major",
    "minor",
    "gpa",
    "class_standing",
    "us_citizen",
    "age",
    "gender",
    "pronouns",
    "race_ethnicity",
    "languages",
    "first_gen",
    "honors_college",
    "archived_at",
    "has_application",
    "has_advising",
    "has_prior_award",
  ],
  application_list: [
    "application_id",
    "student_id",
    "fellowship_id",
    "application_year",
    "destination_country",
    "stage_of_application",
    "is_semi_finalist",
    "is_finalist",
    "student_name",
    "fellowship_name",
  ],
  advising_meeting_list: [
    "meeting_id",
    "student_id",
    "advisor_id",
    "application_id",
    "meeting_date",
    "meeting_mode",
    "no_show",
    "notes",
    "created_at",
    "created_by_advisor_id",
    "student_name",
    "advisor_name",
    "recorded_by_advisor_name",
    "application_year",
    "fellowship_id",
    "fellowship_name",
  ],
  fellowship_thursday_list: [
    "attendance_id",
    "student_id",
    "base_attended",
    "base_source_info",
    "attended",
    "source_info",
    "has_amendments",
    "student_name",
  ],
  scholarship_history_list: [
    "history_id",
    "student_id",
    "base_fellowship_id",
    "fellowship_id",
    "has_correction",
    "is_voided",
    "voided_at",
    "student_name",
    "fellowship_name",
  ],
  fellowship_list: [
    "fellowship_id",
    "fellowship_name",
    "archived_at",
    "total_applications",
    "finalists",
    "awarded_students",
    "has_applications",
  ],
};

/**
 * One exact-count RLS case per view.
 *
 * Every case is scoped with a PostgREST `in` filter over THIS run's uniquely
 * suffixed seeded ids. The contract suite shares a single isolated database
 * across test files, so an unfiltered global count would be polluted by other
 * files' fixtures; filtering to our own ids keeps the expected rows/count
 * deterministic. `count: "exact"` makes PostgREST run a COUNT over the same
 * RLS-filtered relation as the row request — the exact path the server-side
 * list loaders depend on — so this asserts the count parity, not just the body.
 */
interface ViewCountCase {
  view: (typeof VIEWS)[number];
  /** Unique identity column returned for the rows. */
  idColumn: string;
  /** Column and values that scope the read to this run's seeded rows. */
  filterColumn: string;
  filterValues: number[];
  expected: number;
}

let fixtures: SeededCore;
let selfClient: SupabaseClient;
let noAdvisorClient: SupabaseClient;

let studentFullName: string;
let advisorSelfName: string;
let fellowshipName: string;

let otherFellowshipId: number;
let otherFellowshipName: string;
let emptyFellowshipId: number;
let generalMeetingId: number;
let linkedMeetingId: number;
let voidStudentId: number;
let voidedHistoryId: number;

beforeAll(async () => {
  pool = createDbPool(env);

  fixtures = await seedCoreFixtures(service);

  const createFellowship = async (label: string): Promise<{ id: number; name: string }> => {
    const name = syntheticName(label);
    const { data, error } = await service
      .from("fellowship")
      .insert({ fellowship_name: name })
      .select("fellowship_id")
      .single();
    if (error) throw new Error(`seed ${label}: ${error.message}`);
    return { id: data.fellowship_id as number, name };
  };

  const other = await createFellowship("list-other-fellowship");
  otherFellowshipId = other.id;
  otherFellowshipName = other.name;

  const empty = await createFellowship("list-empty-fellowship");
  emptyFellowshipId = empty.id;

  // A second application on the core fellowship so the aggregate metrics are
  // distinguishable (one Submitted + one Awarded/finalist).
  const { error: awardedError } = await service.from("application").insert({
    student_id: fixtures.studentId,
    fellowship_id: fixtures.fellowshipId,
    destination_country: "Testland",
    stage_of_application: "Awarded",
    is_semi_finalist: true,
    is_finalist: true,
    application_year: 2026,
  });
  if (awardedError) throw new Error(`seed awarded application: ${awardedError.message}`);

  // General Advising (application_id omitted -> NULL) and a linked meeting.
  const { data: general, error: generalError } = await service
    .from("advising_meeting")
    .insert({
      student_id: fixtures.studentId,
      advisor_id: fixtures.advisorSelfId,
      meeting_date: "2026-08-01",
      meeting_mode: "In-Person",
      no_show: true,
    })
    .select("meeting_id")
    .single();
  if (generalError) throw new Error(`seed general advising: ${generalError.message}`);
  generalMeetingId = general.meeting_id as number;

  const { data: linked, error: linkedError } = await service
    .from("advising_meeting")
    .insert({
      student_id: fixtures.studentId,
      advisor_id: fixtures.advisorSelfId,
      application_id: fixtures.applicationId,
      meeting_date: "2026-08-02",
      meeting_mode: "Virtual",
      no_show: false,
    })
    .select("meeting_id")
    .single();
  if (linkedError) throw new Error(`seed linked advising: ${linkedError.message}`);
  linkedMeetingId = linked.meeting_id as number;

  // A student whose only award is VOIDED: proves the operational prior-award
  // flag excludes voids while the voided award stays on the audit surface.
  const { data: voidStudent, error: voidStudentError } = await service
    .from("student")
    .insert({
      full_name: syntheticName("list-void-student"),
      email: syntheticEmail("list-void-student"),
      is_ch_student: false,
      us_citizen: true,
    })
    .select("student_id")
    .single();
  if (voidStudentError) throw new Error(`seed void student: ${voidStudentError.message}`);
  voidStudentId = voidStudent.student_id as number;

  const { data: voidHistory, error: voidHistoryError } = await service
    .from("scholarship_history")
    .insert({ student_id: voidStudentId, fellowship_id: fixtures.fellowshipId })
    .select("history_id")
    .single();
  if (voidHistoryError) throw new Error(`seed void history: ${voidHistoryError.message}`);
  voidedHistoryId = voidHistory.history_id as number;

  // Authenticated active advisor (self) for the amendment write path and the
  // PostgREST view reads.
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

  // Authenticated account with NO advisor row: RLS must hide all rows, proving
  // the view cannot bypass the underlying policies.
  const noAdvisorEmail = syntheticEmail("list-views-no-advisor");
  const noAdvisorUserId = await createAuthUser(service, noAdvisorEmail);
  noAdvisorClient = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const noAdvisorSigned = await signInWithPassword(noAdvisorClient, noAdvisorEmail);
  expect(noAdvisorSigned).toBe(noAdvisorUserId);

  // Corrections are appended through the authenticated active advisor (the
  // metadata trigger rejects trusted technical sessions without a JWT subject).
  const { error: ftCorrectionError } = await selfClient
    .from("fellowship_thursday_amendment")
    .insert({
      attendance_id: fixtures.attendanceId,
      reason: "List-view correction contract fixture",
      corrected_attended: false,
      corrects_source_info: true,
      corrected_source_info: "HC",
    });
  expect(ftCorrectionError, "Fellowship Thursday correction INSERT").toBeNull();

  const { error: shCorrectionError } = await selfClient
    .from("scholarship_history_amendment")
    .insert({
      history_id: fixtures.historyId,
      amendment_type: "Correction",
      reason: "List-view corrected award program",
      corrected_fellowship_id: otherFellowshipId,
    });
  expect(shCorrectionError, "Scholarship History correction INSERT").toBeNull();

  const { error: shVoidError } = await selfClient
    .from("scholarship_history_amendment")
    .insert({
      history_id: voidedHistoryId,
      amendment_type: "Void",
      reason: "List-view void contract fixture",
    });
  expect(shVoidError, "Scholarship History void INSERT").toBeNull();

  // Expected display names for flattened-context assertions.
  const studentRows = await query(
    "SELECT full_name FROM public.student WHERE student_id = $1",
    [fixtures.studentId]
  );
  studentFullName = studentRows[0].full_name as string;
  const advisorRows = await query(
    "SELECT advisor_name FROM public.advisor WHERE advisor_id = $1",
    [fixtures.advisorSelfId]
  );
  advisorSelfName = advisorRows[0].advisor_name as string;
  const fellowshipRows = await query(
    "SELECT fellowship_name FROM public.fellowship WHERE fellowship_id = $1",
    [fixtures.fellowshipId]
  );
  fellowshipName = fellowshipRows[0].fellowship_name as string;
}, 90_000);

afterAll(async () => {
  await pool.end();
});

/**
 * The seeded rows each view must expose to an active advisor (and hide from a
 * non-advisor). Built lazily: the ids are assigned in `beforeAll`.
 */
function seededViewCountCases(): ViewCountCase[] {
  return [
    {
      view: "student_list",
      idColumn: "student_id",
      filterColumn: "student_id",
      filterValues: [fixtures.studentId, voidStudentId],
      expected: 2,
    },
    {
      view: "application_list",
      idColumn: "application_id",
      filterColumn: "student_id",
      filterValues: [fixtures.studentId],
      expected: 2, // one Submitted + one Awarded application on the core student
    },
    {
      view: "advising_meeting_list",
      idColumn: "meeting_id",
      filterColumn: "meeting_id",
      filterValues: [fixtures.meetingId, generalMeetingId, linkedMeetingId],
      expected: 3,
    },
    {
      view: "fellowship_thursday_list",
      idColumn: "attendance_id",
      filterColumn: "attendance_id",
      filterValues: [fixtures.attendanceId],
      expected: 1, // corrections never add attendance rows
    },
    {
      view: "scholarship_history_list",
      idColumn: "history_id",
      filterColumn: "history_id",
      filterValues: [fixtures.historyId, voidedHistoryId],
      expected: 2, // a voided award stays auditable on the list surface
    },
    {
      view: "fellowship_list",
      idColumn: "fellowship_id",
      filterColumn: "fellowship_id",
      filterValues: [fixtures.fellowshipId, otherFellowshipId, emptyFellowshipId],
      expected: 3,
    },
  ];
}

describe("list views: read-only SECURITY INVOKER surfaces", () => {
  it("creates every list view as a SECURITY INVOKER view", async () => {
    const rows = await query(
      `SELECT c.relname AS name, c.relkind AS kind, c.reloptions AS options
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [VIEWS]
    );
    expect(rows.map((row) => row.name).sort()).toEqual([...VIEWS].sort());
    for (const row of rows) {
      expect(row.kind, `${row.name} relkind`).toBe("v");
      expect(String(row.options ?? ""), `${row.name} must be SECURITY INVOKER`).toContain(
        "security_invoker"
      );
    }
  });

  it("grants SELECT only to authenticated and revokes anon access", async () => {
    for (const view of VIEWS) {
      const rows = await query(
        `SELECT has_table_privilege('authenticated', 'public.${view}', 'SELECT') AS auth_select,
                has_table_privilege('authenticated', 'public.${view}', 'INSERT') AS auth_insert,
                has_table_privilege('anon', 'public.${view}', 'SELECT') AS anon_select,
                has_table_privilege('anon', 'public.${view}', 'INSERT') AS anon_insert,
                has_table_privilege('anon', 'public.${view}', 'UPDATE') AS anon_update,
                has_table_privilege('anon', 'public.${view}', 'DELETE') AS anon_delete`
      );
      expect(rows[0].auth_select, `${view} authenticated SELECT`).toBe(true);
      expect(rows[0].auth_insert, `${view} authenticated INSERT must not be granted`).toBe(false);
      expect(rows[0].anon_select, `${view} anon SELECT revoked`).toBe(false);
      expect(rows[0].anon_insert, `${view} anon INSERT revoked`).toBe(false);
      expect(rows[0].anon_update, `${view} anon UPDATE revoked`).toBe(false);
      expect(rows[0].anon_delete, `${view} anon DELETE revoked`).toBe(false);
    }
  });

  it("exposes exactly the documented explicit columns", async () => {
    for (const view of VIEWS) {
      const rows = await query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [view]
      );
      expect(rows.map((row) => row.column_name), `${view} columns`).toEqual(
        EXPECTED_COLUMNS[view]
      );
    }
  });

  it("never exposes the advisor Auth binding (auth_user_id)", async () => {
    const rows = await query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND column_name = 'auth_user_id'`,
      [VIEWS]
    );
    expect(rows, "no view may expose advisor.auth_user_id").toHaveLength(0);
  });

  it("returns the seeded rows and exact count for every view to an active advisor", async () => {
    for (const testCase of seededViewCountCases()) {
      const result = await untyped(selfClient)
        .from(testCase.view)
        .select(testCase.idColumn, { count: "exact" })
        .in(testCase.filterColumn, testCase.filterValues);
      expect(result.error, `${testCase.view} active-advisor view read`).toBeNull();
      expect(result.count, `${testCase.view} active-advisor exact count`).toBe(
        testCase.expected
      );
      expect(result.data ?? [], `${testCase.view} active-advisor rows`).toHaveLength(
        testCase.expected
      );
    }
  });

  it("returns zero rows and count zero for every view to a non-advisor (RLS applies through the view)", async () => {
    for (const testCase of seededViewCountCases()) {
      const result = await untyped(noAdvisorClient)
        .from(testCase.view)
        .select(testCase.idColumn, { count: "exact" })
        .in(testCase.filterColumn, testCase.filterValues);
      expect(
        result.error,
        `${testCase.view} non-advisor view read must succeed with zero rows`
      ).toBeNull();
      expect(result.count, `${testCase.view} non-advisor exact count`).toBe(0);
      expect(result.data ?? [], `${testCase.view} non-advisor rows hidden by RLS`).toHaveLength(0);
    }
  });

  it("denies every list view to anon", async () => {
    for (const testCase of seededViewCountCases()) {
      const result = await untyped(anon)
        .from(testCase.view)
        .select(testCase.idColumn, { count: "exact" })
        .in(testCase.filterColumn, testCase.filterValues);
      expect(result.error, `${testCase.view} anon read must be denied`).not.toBeNull();
    }
  });
});

describe("student_list derived state and history semantics", () => {
  it("derives application/advising/prior-award flags for an active student", async () => {
    const rows = await query(
      `SELECT has_application, has_advising, has_prior_award, full_name
         FROM public.student_list
        WHERE student_id = $1`,
      [fixtures.studentId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      has_application: true,
      has_advising: true,
      has_prior_award: true,
    });
    expect(rows[0].full_name).toBe(studentFullName);
  });

  it("excludes a voided award from the operational prior-award flag", async () => {
    const rows = await query(
      `SELECT has_application, has_advising, has_prior_award
         FROM public.student_list
        WHERE student_id = $1`,
      [voidStudentId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      has_application: false,
      has_advising: false,
      // The student's only award is Voided, so the operational flag is false.
      has_prior_award: false,
    });
  });
});

describe("application_list flattened context", () => {
  it("resolves the student and fellowship display names", async () => {
    const rows = await query(
      `SELECT application_id, student_id, fellowship_id, application_year,
              destination_country, stage_of_application, student_name, fellowship_name
         FROM public.application_list
        WHERE application_id = $1`,
      [fixtures.applicationId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      application_id: fixtures.applicationId,
      student_id: fixtures.studentId,
      fellowship_id: fixtures.fellowshipId,
      application_year: fixtures.applicationYear,
      destination_country: "Testland",
      stage_of_application: "Submitted",
      student_name: studentFullName,
      fellowship_name: fellowshipName,
    });
  });
});

describe("advising_meeting_list preserves General Advising", () => {
  it("resolves student/advisor/application context without row multiplication", async () => {
    const rows = await query(
      `SELECT meeting_id, student_id, advisor_id, application_id, application_year,
              fellowship_id, fellowship_name, student_name, advisor_name
         FROM public.advising_meeting_list
        WHERE student_id = $1`,
      [fixtures.studentId]
    );
    // Exactly the three meetings seeded for this student (one from the shared
    // core fixtures plus the General and linked meetings) — no join fan-out.
    expect(rows.map((row) => row.meeting_id).sort()).toEqual(
      [fixtures.meetingId, generalMeetingId, linkedMeetingId].sort()
    );
  });

  it("keeps NULL application/fellowship context for General Advising", async () => {
    const rows = await query(
      `SELECT * FROM public.advising_meeting_list WHERE meeting_id = $1`,
      [generalMeetingId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      meeting_id: generalMeetingId,
      student_id: fixtures.studentId,
      advisor_id: fixtures.advisorSelfId,
      application_id: null,
      application_year: null,
      fellowship_id: null,
      fellowship_name: null,
      student_name: studentFullName,
      advisor_name: advisorSelfName,
    });
  });

  it("resolves the linked application's cycle and fellowship", async () => {
    const rows = await query(
      `SELECT application_id, application_year, fellowship_id, fellowship_name
         FROM public.advising_meeting_list
        WHERE meeting_id = $1`,
      [linkedMeetingId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      application_id: fixtures.applicationId,
      application_year: fixtures.applicationYear,
      fellowship_id: fixtures.fellowshipId,
      fellowship_name: fellowshipName,
    });
  });
});

describe("fellowship_thursday_list corrected effective values", () => {
  it("reflects corrections once (no extra rows) and keeps base audit values", async () => {
    const rows = await query(
      `SELECT * FROM public.fellowship_thursday_list WHERE attendance_id = $1`,
      [fixtures.attendanceId]
    );
    expect(rows, "one row per attendance, never one per amendment").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attendance_id: fixtures.attendanceId,
      student_id: fixtures.studentId,
      base_attended: true,
      base_source_info: "OCF",
      attended: false,
      source_info: "HC",
      has_amendments: true,
      student_name: studentFullName,
    });
  });
});

describe("scholarship_history_list corrected/void semantics", () => {
  it("exposes the corrected effective award program with audit base values", async () => {
    const rows = await query(
      `SELECT * FROM public.scholarship_history_list WHERE history_id = $1`,
      [fixtures.historyId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      history_id: fixtures.historyId,
      student_id: fixtures.studentId,
      base_fellowship_id: fixtures.fellowshipId,
      fellowship_id: otherFellowshipId,
      has_correction: true,
      is_voided: false,
      student_name: studentFullName,
      fellowship_name: otherFellowshipName,
    });
  });

  it("keeps a voided award auditable on the list surface", async () => {
    const rows = await query(
      `SELECT history_id, is_voided, voided_at FROM public.scholarship_history_list WHERE history_id = $1`,
      [voidedHistoryId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].history_id).toBe(voidedHistoryId);
    expect(rows[0].is_voided).toBe(true);
    expect(rows[0].voided_at).not.toBeNull();
  });
});

describe("fellowship_list application metrics", () => {
  it("counts applications/finalists/awards without multiplying the parent row", async () => {
    const rows = await query(
      `SELECT * FROM public.fellowship_list WHERE fellowship_id = $1`,
      [fixtures.fellowshipId]
    );
    expect(rows, "one row per fellowship").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fellowship_id: fixtures.fellowshipId,
      fellowship_name: fellowshipName,
      total_applications: 2,
      finalists: 1,
      awarded_students: 1,
      has_applications: true,
    });
  });

  it("reports zero metrics for a fellowship with no applications", async () => {
    const rows = await query(
      `SELECT * FROM public.fellowship_list WHERE fellowship_id = $1`,
      [emptyFellowshipId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fellowship_id: emptyFellowshipId,
      total_applications: 0,
      finalists: 0,
      awarded_students: 0,
      has_applications: false,
    });
  });
});

describe("scholarship_history_operational_summary aggregate (migration 20261011000001)", () => {
  const summaryRpc = "scholarship_history_operational_summary";

  it("is a STABLE SECURITY INVOKER function with empty search_path and authenticated-only EXECUTE", async () => {
    const rows = await query(
      `SELECT p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('authenticated', 'public.${summaryRpc}(text, integer)', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'public.${summaryRpc}(text, integer)', 'EXECUTE') AS anon_exec,
              has_function_privilege('service_role', 'public.${summaryRpc}(text, integer)', 'EXECUTE') AS sr_exec,
              p.proacl::text[] AS acl
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1`,
      [summaryRpc]
    );
    expect(rows).toHaveLength(1);
    // false ⇒ SECURITY INVOKER: executes as the requesting role, so underlying
    // RLS applies and the function can never bypass it.
    expect(rows[0].prosecdef, "aggregate must be SECURITY INVOKER").toBe(false);
    expect(rows[0].provolatile, "aggregate must be STABLE").toBe("s");
    expect(rows[0].proconfig, "aggregate must set an empty search_path").toEqual([
      'search_path=""',
    ]);
    expect(rows[0].auth_exec, "authenticated EXECUTE").toBe(true);
    expect(rows[0].anon_exec, "no anon EXECUTE").toBe(false);
    // Supabase's default privileges also grant service_role EXECUTE; the
    // application never uses service_role for list reads (the loader's
    // authenticated client is proven below), so this is a pinned default, not
    // an access path.
    expect(rows[0].sr_exec, "service_role retains the Supabase default grant").toBe(true);
    // No PUBLIC EXECUTE survives the migration's REVOKE ALL FROM PUBLIC.
    const publicEntries = (rows[0].acl as string[]).filter((entry) => entry.startsWith("="));
    expect(publicEntries, "no PUBLIC EXECUTE on the aggregate").toHaveLength(0);
  });

  it("applies the list's non-void, corrected-effective, and search-scoped filters", async () => {
    // The award seeded for the core fellowship was CORRECTED to another program
    // and the second award was VOIDED. Under the original base fellowship the
    // non-void count is therefore zero — proving both the effective correction
    // and void exclusion the list loader relies on.
    const original = await selfClient.rpc(summaryRpc, {
      p_search: null,
      p_fellowship_id: fixtures.fellowshipId,
    });
    expect(original.error, "original-fellowship aggregate").toBeNull();
    const originalRow = (original.data ?? [])[0] as
      | { total_records: number; distinct_students: number }
      | undefined;
    expect(originalRow?.total_records).toBe(0);
    expect(originalRow?.distinct_students).toBe(0);

    // Exactly the corrected award under its effective program.
    const corrected = await selfClient.rpc(summaryRpc, {
      p_search: null,
      p_fellowship_id: otherFellowshipId,
    });
    expect(corrected.error, "corrected-fellowship aggregate").toBeNull();
    const correctedRow = (corrected.data ?? [])[0] as
      | { total_records: number; distinct_students: number }
      | undefined;
    expect(correctedRow?.total_records).toBe(1);
    expect(correctedRow?.distinct_students).toBe(1);

    // Search scoping uses the same escaped ILIKE pattern as the list page: a
    // matching pattern keeps the row and a non-matching one drops it.
    const fragment = studentFullName.slice(0, 6).replace(/[%_\\]/g, "\\$&");
    const hit = await selfClient.rpc(summaryRpc, {
      p_search: `%${fragment}%`,
      p_fellowship_id: otherFellowshipId,
    });
    expect(hit.error, "matching-search aggregate").toBeNull();
    expect(
      ((hit.data ?? [])[0] as { total_records: number } | undefined)?.total_records
    ).toBe(1);

    const miss = await selfClient.rpc(summaryRpc, {
      p_search: "%no-such-student-xyz%",
      p_fellowship_id: otherFellowshipId,
    });
    expect(miss.error, "non-matching-search aggregate").toBeNull();
    expect(
      ((miss.data ?? [])[0] as { total_records: number } | undefined)?.total_records
    ).toBe(0);
  });

  it("cannot bypass RLS: a non-advisor authenticated account reads zero totals and anon is denied", async () => {
    const noAdvisor = await noAdvisorClient.rpc(summaryRpc, {
      p_search: null,
      p_fellowship_id: otherFellowshipId,
    });
    expect(noAdvisor.error, "non-advisor aggregate call must succeed with zero totals").toBeNull();
    const row = (noAdvisor.data ?? [])[0] as
      | { total_records: number; distinct_students: number }
      | undefined;
    expect(row?.total_records, "RLS hides rows from the aggregate").toBe(0);
    expect(row?.distinct_students, "RLS hides rows from the aggregate").toBe(0);

    const anonResult = await anon.rpc(summaryRpc, {
      p_search: null,
      p_fellowship_id: otherFellowshipId,
    });
    expect(anonResult.error, "anon must not execute the aggregate").not.toBeNull();
  });
});
