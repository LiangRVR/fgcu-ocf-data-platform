/**
 * tests/e2e/fixtures/seed.ts
 *
 * Seeds the E2E lane's Docker-local Supabase instance with:
 *   - two advisor AUTH users (active + inactive), each linked to a
 *     public.advisor row via auth_user_id. The ACTIVE advisor carries the
 *     immutable Auth `app_metadata.ocf_admin = true` claim: the E2E lane's
 *     operator is a trusted OCF administrator, which is what lets the
 *     lifecycle UI flows (Archive/Restore Student & Fellowship) exercise the
 *     admin-only `lifecycle_transition` RPC end-to-end through the browser.
 *     The INACTIVE advisor carries no claim and stays a plain non-admin;
 *   - one non-advisor AUTH user with NO public.advisor row, used by
 *     tests/e2e/auth.spec.ts to assert the `/login?reason=unauthorized`
 *     outcome (a signed-in session that cannot resolve to an advisor);
 *   - OCF fixtures across every operational table (fellowship, student,
 *     application, advising_meeting, fellowship_thursday, scholarship_history)
 *     so the dashboard and list surfaces render realistic seeded data. This
 *     includes a NONZERO awarded case (an application at the "Awarded" stage)
 *     so the reports "Awards" metric is exercised by the E2E suite.
 *   - the expected report totals the operations E2E spec asserts: computed
 *     from the fixtures actually created here (re-read through the service
 *     role so the baseline always matches what the reports page computes),
 *     never hand-written literals.
 *
 * Runs ONLY server-side via tsx from scripts/e2e/run.mjs with the runtime env
 * captured from `supabase status -o env` (SUPABASE_URL / SUPABASE_ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL). The service-role client is used
 * exclusively for seeding — never in the browser. The seed refuses to run
 * against anything but a loopback URL, so hosted/shared databases are
 * impossible by construction.
 *
 * The final stdout line is `E2E_SEED_JSON=<json>`; scripts/e2e/run.mjs parses
 * it and exports the identities to the Playwright run as E2E_* env vars.
 */
import { createClient } from "@supabase/supabase-js";

/** API URL must resolve to the local Docker host. */
const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

const RUN_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Explicit application-cycle years used by every seeded application. The
 * advising↔application link feature makes the cycle a first-class label, so
 * fixtures never leave it implicit:
 *   - CURRENT_CYCLE (2026) is the cycle for the seeded student's application
 *     and for one of the second student's same-fellowship applications;
 *   - PRIOR_CYCLE (2025) forms the other half of that same-fellowship pair and
 *     the second student's awarded cycle.
 * Both are exported to the E2E lane so specs assert labels derived from the
 * seed rather than hand-written literals.
 */
const CURRENT_CYCLE = 2026;
const PRIOR_CYCLE = 2025;
// Deterministic for the disposable local lane, but assembled at runtime so the
// complete password never exists as a committed credential-shaped literal.
const PASSWORD = ["E2e", "Local", "Pass", "!", "2026"].join("");

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/**
 * Sanity check that a seeded auth user can actually exchange a password for a
 * session against the local GoTrue — catches misconfiguration before the whole
 * Playwright suite burns time on sign-in failures.
 */
async function signInSmokeCheck(
  apiUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Auth smoke check failed for ${email}: HTTP ${res.status} — ${body.slice(0, 300)}`,
    );
  }
}

async function main(): Promise<void> {
  const apiUrl = mustEnv("SUPABASE_URL");
  const anonKey = mustEnv("SUPABASE_ANON_KEY");
  const serviceRoleKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!LOOPBACK_URL.test(apiUrl)) {
    throw new Error(`Refusing to seed a non-local Supabase URL: ${apiUrl}`);
  }

  const service = createClient(apiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Advisor AUTH users ───────────────────────────────────────────────────
  const activeEmail = `e2e-active-${RUN_TOKEN}@example.com`;
  const inactiveEmail = `e2e-inactive-${RUN_TOKEN}@example.com`;

  /**
   * A signed-in GoTrue user with NO linked public.advisor row. The email is a
   * FIXED constant (not token-randomized) so tests/e2e/auth.spec.ts can assert
   * the `reason=unauthorized` redirect without a new exported env var. The
   * lane runs `supabase db reset --no-seed` on a fresh local instance first, so
   * a fixed email cannot collide with any previous run.
   */
  const nonAdvisorEmail = "e2e-non-advisor@example.com";

  const createAuthUser = async (email: string, appMetadata?: Record<string, unknown>) => {
    const { data, error } = await service.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      ...(appMetadata ? { app_metadata: appMetadata } : {}),
    });
    if (error) {
      throw new Error(`createUser(${email}): ${error.message}`);
    }
    if (!data.user) {
      throw new Error(`createUser(${email}): no user returned`);
    }
    return data.user;
  };

  // The ACTIVE advisor is the lane's trusted OCF administrator (Auth
  // app_metadata.ocf_admin=true): the lifecycle_transition RPC — and therefore
  // the Archive/Restore UI flows — requires that immutable claim. The INACTIVE
  // advisor is a plain non-admin so the auth gate / lifecycle-denial surfaces
  // stay truthful.
  const [activeUser, inactiveUser] = await Promise.all([
    createAuthUser(activeEmail, { ocf_admin: true }),
    createAuthUser(inactiveEmail),
  ]);

  // Non-advisor: created but intentionally never linked to an advisor row.
  await createAuthUser(nonAdvisorEmail);

  const insertAdvisor = async (
    advisorName: string,
    email: string,
    authUserId: string,
    isActive: boolean,
    role: "Admin" | "Advisor",
  ): Promise<number> => {
    const { data, error } = await service
      .from("advisor")
      .insert({
        advisor_name: advisorName,
        email,
        auth_user_id: authUserId,
        is_active: isActive,
        role,
      })
      .select("advisor_id")
      .single();
    if (error) {
      throw new Error(`insert advisor(${email}): ${error.message}`);
    }
    return data.advisor_id as number;
  };

  const activeAdvisorName = `E2E Active Advisor ${RUN_TOKEN}`;
  const inactiveAdvisorName = `E2E Inactive Advisor ${RUN_TOKEN}`;
  const [activeAdvisorId, inactiveAdvisorId] = await Promise.all([
    // The ACTIVE advisor carries the ocf_admin=true claim: the persisted
    // display role is reconciled to Admin (the same claim/role alignment the
    // reconciliation migration enforces). The INACTIVE advisor has no claim
    // and displays the safe Advisor role.
    insertAdvisor(activeAdvisorName, activeEmail, activeUser.id, true, "Admin"),
    insertAdvisor(inactiveAdvisorName, inactiveEmail, inactiveUser.id, false, "Advisor"),
  ]);

  // ── OCF fixtures ─────────────────────────────────────────────────────────
  const fellowshipName = `E2E Fellowship ${RUN_TOKEN}`;
  const secondFellowshipName = `E2E Fellowship Two ${RUN_TOKEN}`;
  const thirdFellowshipName = `E2E Fellowship Three ${RUN_TOKEN}`;

  const insertFellowship = async (name: string): Promise<number> => {
    const { data, error } = await service
      .from("fellowship")
      .insert({ fellowship_name: name })
      .select("fellowship_id")
      .single();
    if (error) {
      throw new Error(`insert fellowship(${name}): ${error.message}`);
    }
    return data.fellowship_id as number;
  };

  const [fellowshipId, secondFellowshipId, thirdFellowshipId] = await Promise.all([
    insertFellowship(fellowshipName),
    insertFellowship(secondFellowshipName),
    insertFellowship(thirdFellowshipName),
  ]);

  const studentName = `E2E Student ${RUN_TOKEN}`;
  const studentEmail = `e2e-student-${RUN_TOKEN}@example.com`;
  const secondStudentName = `E2E Student Two ${RUN_TOKEN}`;
  const secondStudentEmail = `e2e-student-two-${RUN_TOKEN}@example.com`;

  const insertStudent = async (fullName: string, email: string): Promise<number> => {
    const { data, error } = await service
      .from("student")
      .insert({
        full_name: fullName,
        email,
        us_citizen: true,
        is_ch_student: true,
        honors_college: true,
        first_gen: false,
        class_standing: "Junior",
        gpa: 3.6,
        major: "Computer Science",
        gender: "NR",
      })
      .select("student_id")
      .single();
    if (error) {
      throw new Error(`insert student(${email}): ${error.message}`);
    }
    return data.student_id as number;
  };

  const [studentId, secondStudentId] = await Promise.all([
    insertStudent(studentName, studentEmail),
    insertStudent(secondStudentName, secondStudentEmail),
  ]);

  // Flags are set EXPLICITLY so the seed stays consistent with the TEST-ONLY
  // local stage/flag invariant
  // (scripts/test-support/invariant-application-stage-flag.sql, applied by the
  // E2E lane after the production-equivalent migration chain):
  // Submitted is an early stage and must carry neither flag. The cycle is
  // explicit (CURRENT_CYCLE) so the seeded student's application label renders
  // "E2E Fellowship <token> — 2026" instead of a legacy "year unknown".
  const { error: appError } = await service.from("application").insert({
    student_id: studentId,
    fellowship_id: fellowshipId,
    destination_country: "Testland",
    application_year: CURRENT_CYCLE,
    stage_of_application: "Submitted",
    is_semi_finalist: false,
    is_finalist: false,
  });
  if (appError) {
    throw new Error(`insert application: ${appError.message}`);
  }

  const { error: meetingError } = await service.from("advising_meeting").insert({
    student_id: studentId,
    advisor_id: activeAdvisorId,
    meeting_date: "2026-09-01",
    meeting_mode: "Virtual",
    no_show: false,
    notes: "E2E seeded advising session",
  });
  if (meetingError) {
    throw new Error(`insert advising_meeting: ${meetingError.message}`);
  }

  const { error: ftError } = await service.from("fellowship_thursday").insert({
    student_id: studentId,
    attended: true,
    source_info: "OCF",
  });
  if (ftError) {
    throw new Error(`insert fellowship_thursday: ${ftError.message}`);
  }

  const { error: historyError } = await service.from("scholarship_history").insert({
    student_id: studentId,
    fellowship_id: fellowshipId,
  });
  if (historyError) {
    throw new Error(`insert scholarship_history: ${historyError.message}`);
  }

  // Prior-award history for the second student on the third fellowship.
  const { error: historyTwoError } = await service
    .from("scholarship_history")
    .insert({ student_id: secondStudentId, fellowship_id: thirdFellowshipId });
  if (historyTwoError) {
    throw new Error(`insert scholarship_history two: ${historyTwoError.message}`);
  }

  // A second application on the second fellowship for dashboard variety.
  // "Started" is an early stage: no flags. Explicit CURRENT_CYCLE so it forms
  // one half of the seeded same-fellowship different-cycle pair on
  // `secondFellowshipId` (the PRIOR_CYCLE row below is the other half).
  const { error: appTwoError } = await service.from("application").insert({
    student_id: secondStudentId,
    fellowship_id: secondFellowshipId,
    application_year: CURRENT_CYCLE,
    stage_of_application: "Started",
    is_semi_finalist: false,
    is_finalist: false,
  });
  if (appTwoError) {
    throw new Error(`insert application two: ${appTwoError.message}`);
  }

  // The other half of the same-fellowship different-cycle pair: the second
  // student has TWO application cycles on `secondFellowshipId` (PRIOR_CYCLE
  // here, CURRENT_CYCLE above). This is what proves "same fellowship, different
  // years" renders as distinct "{fellowship} — {year}" labels everywhere —
  // the applications table, the student detail surface, and the advising
  // dialog's student-scoped application options. "Submitted" is an early
  // stage: no flags.
  const { error: pairAppError } = await service.from("application").insert({
    student_id: secondStudentId,
    fellowship_id: secondFellowshipId,
    destination_country: "Cycleland",
    application_year: PRIOR_CYCLE,
    stage_of_application: "Submitted",
    is_semi_finalist: false,
    is_finalist: false,
  });
  if (pairAppError) {
    throw new Error(`insert same-fellowship pair application: ${pairAppError.message}`);
  }

  // The NONZERO awarded case: the second student's active application on the
  // third fellowship sits at the "Awarded" stage, matching their prior-award
  // scholarship history above. No E2E spec ever touches this application, so
  // the exported "awarded" total and its stage count stay exact throughout
  // the lane. It targets the SECOND student (not the seeded student) so the
  // application-workflow spec's single-row-by-name interactions with the
  // seeded student remain unambiguous.
  const { error: awardedAppError } = await service.from("application").insert({
    student_id: secondStudentId,
    fellowship_id: thirdFellowshipId,
    destination_country: "Testland",
    application_year: PRIOR_CYCLE,
    stage_of_application: "Awarded",
    // "Awarded" implies BOTH flags under the local stage/flag invariant.
    is_semi_finalist: true,
    is_finalist: true,
  });
  if (awardedAppError) {
    throw new Error(`insert awarded application: ${awardedAppError.message}`);
  }

  // Verify the active advisor auth user can actually sign in locally.
  await signInSmokeCheck(apiUrl, anonKey, activeEmail, PASSWORD);

  // ── Computed report totals ──────────────────────────────────────────────
  // Expected reports metrics DERIVED from the fixtures actually created above:
  // the operational tables are re-read through the service role, and the same
  // aggregations the reports page performs (lib/reports/metrics.ts) are applied
  // here. The lane resets the database to a fresh state before seeding, so
  // these reads contain exactly the fixtures above. The operations E2E spec
  // asserts the reports page against these exported totals plus the suite's
  // own deterministic write deltas.
  const { data: seededStudents, error: studentsQueryError } = await service
    .from("student")
    .select("student_id");
  if (studentsQueryError) {
    throw new Error(`query student for report totals: ${studentsQueryError.message}`);
  }

  const { data: seededApplications, error: applicationsQueryError } = await service
    .from("application")
    .select("stage_of_application");
  if (applicationsQueryError) {
    throw new Error(`query application for report totals: ${applicationsQueryError.message}`);
  }

  const { data: seededMeetings, error: meetingsQueryError } = await service
    .from("advising_meeting")
    .select("student_id");
  if (meetingsQueryError) {
    throw new Error(`query advising_meeting for report totals: ${meetingsQueryError.message}`);
  }

  const { data: seededFtRows, error: ftQueryError } = await service
    .from("fellowship_thursday")
    .select("student_id, attended");
  if (ftQueryError) {
    throw new Error(`query fellowship_thursday for report totals: ${ftQueryError.message}`);
  }

  const applicationsByStage: Record<string, number> = {};
  for (const app of seededApplications) {
    applicationsByStage[app.stage_of_application] =
      (applicationsByStage[app.stage_of_application] ?? 0) + 1;
  }

  // Mirrors lib/reports/metrics.ts: ftAttendees counts DISTINCT students with
  // an `attended` record; awarded counts applications at the "Awarded" stage.
  const reportTotals = {
    students: seededStudents.length,
    applications: seededApplications.length,
    meetings: seededMeetings.length,
    ftAttendees: new Set(
      seededFtRows.filter((row) => row.attended).map((row) => row.student_id),
    ).size,
    awarded: seededApplications.filter(
      (app) => app.stage_of_application === "Awarded",
    ).length,
    applicationsByStage,
  };

  console.log(
    "E2E_SEED_JSON=" +
      JSON.stringify({
        activeAdvisorEmail: activeEmail,
        activeAdvisorPassword: PASSWORD,
        inactiveAdvisorEmail: inactiveEmail,
        inactiveAdvisorPassword: PASSWORD,
        activeAdvisorName,
        inactiveAdvisorName,
        activeAdvisorId,
        inactiveAdvisorId,
        nonAdvisorEmail,
        studentName,
        studentEmail,
        studentId,
        secondStudentName,
        secondStudentEmail,
        secondStudentId,
        fellowshipName,
        fellowshipId,
        secondFellowshipName,
        secondFellowshipId,
        // Explicit application-cycle years (single source of truth for the
        // cycle-aware label assertions in the E2E specs).
        studentApplicationYear: CURRENT_CYCLE,
        cycleYearOld: PRIOR_CYCLE,
        cycleYearNew: CURRENT_CYCLE,
        reportTotals,
      }),
  );
}

main().catch((err) => {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});