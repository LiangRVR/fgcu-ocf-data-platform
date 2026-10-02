/**
 * tests/e2e/student-detail.spec.ts
 *
 * Student detail + history navigation against the Docker-local Supabase
 * instance seeded by scripts/e2e/run.mjs (advising-continuity UI, R1–R5/R8).
 * UI-first:
 *
 *   - open the seeded student's record from the roster;
 *   - assert the record's stable sections render (applications, advising,
 *     fellowship thursday, scholarship history);
 *   - verify the profile surface (Student Profile + Edit Profile action) and
 *     each application's derived advising-session count ("{n} sessions" in the
 *     applications table's Advising column);
 *   - confirm the advising history surfaces the immutable meeting record
 *     alongside its provenance while remaining read-only — no Edit/Delete or
 *     Add Correction affordance is exposed from the student detail surface,
 *     and the history filter offers All / General Advising / each application;
 *   - with synthetic amendments attached to the seeded advising meeting,
 *     verify the student detail view shows each correction's reason, details,
 *     creator, and timestamp under the unchanged original meeting, in
 *     chronological order, without exposing the Add Correction control;
 *   - with a synthetic application-scoped meeting attached to the seeded
 *     student's application, verify the filter (All / General Advising /
 *     application) exposes only its expected records, that the application
 *     context label and derived session count follow, that the history stays
 *     newest-first, and that the desktop table mirrors the application context;
 *   - follow the scholarship-history badge (the "history" surface) into the
 *     linked fellowship's detail page.
 *
 * All interactions use semantic selectors and auto-waiting assertions (no
 * sleeps). The synthetic-data tests insert their own rows (amendments, an
 * application-scoped meeting) via the active-advisor typed client and clean
 * them up through the service role so the next run starts from the seeded
 * baseline and the reports spec's exact totals stay deterministic.
 */
import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required E2E environment variable "${name}". ` +
        "Run the lane via `pnpm run test:e2e` (scripts/e2e/run.mjs), which seeds " +
        "the Docker-local Supabase instance and exports the seeded identities.",
    );
  }
  return value;
}

const ACTIVE_EMAIL = requireEnv("E2E_ACTIVE_EMAIL");
const ACTIVE_PASSWORD = requireEnv("E2E_ACTIVE_PASSWORD");
const ACTIVE_ADVISOR_NAME = requireEnv("E2E_ACTIVE_ADVISOR_NAME");
const STUDENT_NAME = requireEnv("E2E_STUDENT_NAME");
const FELLOWSHIP_NAME = requireEnv("E2E_FELLOWSHIP_NAME");
const APPLICATION_YEAR = requireEnv("E2E_APPLICATION_YEAR");

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Service-role helper for synthetic-data setup. Mirrors the same pattern
 * `tests/e2e/operations.spec.ts` uses so the two specs share the service
 * client without copying it. Service role bypasses RLS so it can clean up
 * amendment rows that the authenticated lane is forbidden to mutate.
 */
function serviceClient(): SupabaseClient {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Active-advisor typed client used to insert synthetic amendments. The
 * amendment trigger stamps `created_by_advisor_id` and `created_at` from the
 * authenticated session, so inserts must happen as an active advisor — the
 * service role alone would trip the 42501 denial the trigger raises when no
 * active advisor can be resolved from `auth.uid`.
 */
async function activeAdvisorClient(): Promise<SupabaseClient> {
  const apiUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: ACTIVE_EMAIL,
    password: ACTIVE_PASSWORD,
  });
  if (error) {
    throw new Error(`active-advisor sign-in: ${error.message}`);
  }
  return client;
}

/**
 * Locate the seeded advising meeting row for the seeded student. The seed
 * inserts one advising meeting per student with the literal notes marker
 * "E2E seeded advising session"; this helper returns its primary key.
 */
async function findSeededMeetingId(): Promise<number> {
  const service = serviceClient();
  const { data: studentRow, error: studentError } = await service
    .from("student")
    .select("student_id")
    .eq("full_name", STUDENT_NAME)
    .single();
  if (studentError) {
    throw new Error(`find seeded student: ${studentError.message}`);
  }
  const { data: meetingRow, error: meetingError } = await service
    .from("advising_meeting")
    .select("meeting_id")
    .eq("student_id", studentRow.student_id)
    .eq("notes", "E2E seeded advising session")
    .single();
  if (meetingError) {
    throw new Error(`find seeded meeting: ${meetingError.message}`);
  }
  return meetingRow.meeting_id as number;
}

/**
 * Locate the seeded student's application on the seeded fellowship. The seed
 * creates exactly one application for the seeded student on the seeded
 * fellowship, so the (student_id, fellowship_id) pair is unique; the lookup is
 * tolerant of unrelated application rows another E2E spec could leave behind
 * for the same student on other fellowships.
 */
async function findSeededApplicationId(): Promise<number> {
  const service = serviceClient();
  const [studentRow, fellowshipRow] = await Promise.all([
    service
      .from("student")
      .select("student_id")
      .eq("full_name", STUDENT_NAME)
      .single()
      .then(({ data, error }) => {
        if (error) throw new Error(`find seeded student: ${error.message}`);
        return data.student_id as number;
      }),
    service
      .from("fellowship")
      .select("fellowship_id")
      .eq("fellowship_name", FELLOWSHIP_NAME)
      .single()
      .then(({ data, error }) => {
        if (error) throw new Error(`find seeded fellowship: ${error.message}`);
        return data.fellowship_id as number;
      }),
  ]);
  const { data: appRow, error: appError } = await service
    .from("application")
    .select("application_id")
    .eq("student_id", studentRow)
    .eq("fellowship_id", fellowshipRow)
    .maybeSingle();
  if (appError || !appRow) {
    throw new Error(`seeded application for ${FELLOWSHIP_NAME} not found`);
  }
  return appRow.application_id as number;
}

/** Resolve the seeded active advisor's id (the lane's trusted Admin). */
async function findActiveAdvisorId(): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("advisor")
    .select("advisor_id")
    .eq("email", ACTIVE_EMAIL)
    .single();
  if (error) {
    throw new Error(`find active advisor: ${error.message}`);
  }
  return data.advisor_id as number;
}

test.describe("student detail workflow", () => {
  test.setTimeout(60_000);

  test("an advisor can open a student's record and navigate its scholarship history into the fellowship", async ({ page }) => {
    await signInAsActive(page);
    await page.goto("/students");

    // Open the seeded student's record from the roster.
    await page
      .getByRole("link", { name: STUDENT_NAME, exact: true })
      .filter({ visible: true })
      .first()
      .click();

    await expect(page).toHaveURL(/\/students\/\d+$/);
    await expect(page.getByRole("heading", { name: STUDENT_NAME })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Student Record", { exact: true })).toBeVisible();

    // The record's stable sections render with the seeded history. Scoped to
    // <main> (the shell sidebar also contains "Scholarship History" as a nav
    // label) and taken .first() because each CardTitle renders its count as a
    // trailing span ("Advising Meetings(1)"), which would otherwise break an
    // exact-text match on every ancestor containing the section.
    const main = page.locator("main");
    await expect(main.getByText("Advising Meetings").first()).toBeVisible();
    await expect(main.getByText("Fellowship Thursday").first()).toBeVisible();
    await expect(main.getByText("Scholarship History").first()).toBeVisible();

    // R1: the profile surface is explicit with its accessible Edit Profile
    // action (the inline per-section Edit buttons render inside it).
    const profileSection = page.locator("section[aria-label='Student Profile']");
    await expect(profileSection).toBeVisible();
    await expect(profileSection.getByRole("heading", { name: /Student Profile/ })).toBeVisible();
    await expect(profileSection.getByRole("link", { name: "Edit Profile", exact: true })).toBeVisible();

    // R2: the applications table surfaces each application's derived
    // advising-session count. The seeded student's only application has no
    // scoped meeting at baseline, so the Advising column reads "0 sessions".
    const applicationsTable = main.locator("table").filter({ hasText: "Stage" });
    const seededApplicationRow = applicationsTable.locator("tbody tr", {
      hasText: `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`,
    });
    await expect(seededApplicationRow).toContainText("Submitted");
    await expect(seededApplicationRow).toContainText("0 sessions");

    // R4: the advising history exposes the All / General Advising / application
    // filters on the student detail surface. Native <option> elements are
    // collapsed (Playwright reports them hidden), so each option is asserted by
    // presence, not visibility.
    const historyFilter = main.getByLabel("Filter advising history");
    await expect(historyFilter).toBeVisible();
    await expect(historyFilter.locator("option", { hasText: "All" })).toHaveCount(1);
    await expect(historyFilter.locator("option", { hasText: "General Advising" })).toHaveCount(1);
    await expect(
      historyFilter.locator("option", { hasText: `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}` }),
    ).toHaveCount(1);

    // The advising history remains a read-only record with its seeded context
    // and notes intact after the advising lane became append-only.
    const advisingHistory = main.locator("table").filter({ hasText: "E2E seeded advising session" });
    const seededMeeting = advisingHistory.locator("tbody tr", { hasText: "E2E seeded advising session" });
    await expect(seededMeeting.getByText("General Advising", { exact: true })).toBeVisible();
    await expect(seededMeeting.getByText("E2E seeded advising session", { exact: true })).toBeVisible();
    await expect(
      seededMeeting.getByText(/^Recorded by /),
    ).toBeVisible();
    await expect(seededMeeting.getByText(/^Recorded (?!by)/)).toBeVisible();
    // Corrections are an advising-history concern; the student detail surface
    // stays read-only and never offers the Add Correction control.
    await expect(seededMeeting.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
    // R8: historical meetings expose no normal Edit/Delete controls here
    // either (the profile's per-section Edit buttons are the only "Edit" on
    // the page and are not meeting controls, so the meeting-oriented controls
    // are asserted by their exact titles/roles).
    await expect(main.getByTitle("Edit meeting")).toHaveCount(0);
    await expect(main.getByTitle("Delete meeting")).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Delete" })).toHaveCount(0);
    // The seeded application row links the fellowship the student applied to.
    // The link's accessible name is the CYCLE-AWARE label — the seeded
    // application carries an explicit year (E2E_APPLICATION_YEAR), so the bare
    // fellowship name alone no longer matches it.
    await expect(
      page
        .getByRole("link", { name: `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`, exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // History navigation: the scholarship-history badge (the only fellowship
    // link carrying the trophy icon) opens the linked fellowship's detail page.
    // The operations spec can legitimately add a second record for the same
    // seeded fellowship, so more than one badge may exist — they all resolve to
    // the same fellowship, so .first() is unambiguous.
    const historyBadge = page
      .getByRole("link", { name: FELLOWSHIP_NAME, exact: true })
      .filter({ has: page.locator("svg.lucide-trophy") })
      .first();
    await expect(historyBadge).toBeVisible();
    await historyBadge.click();

    await expect(page).toHaveURL(/\/fellowships\/\d+$/);
    await expect(page.getByRole("heading", { name: FELLOWSHIP_NAME })).toBeVisible();
    await expect(page.getByText("Program Detail", { exact: true })).toBeVisible();
  });

  test("attached amendments render under the unchanged original meeting in chronological order with full provenance and no Add Correction control", async ({ page }) => {
    const meetingId = await findSeededMeetingId();
    const advisor = await activeAdvisorClient();

    // Two synthetic corrections on the SAME seeded meeting, with the second
    // inserted AFTER the first so the database-authored `created_at` strictly
    // increases. Unique reason / details keep the assertions stable across
    // re-runs even if a previous run left rows behind.
    const earlierReason = `E2E student-detail earlier ${Date.now()}`;
    const earlierDetails = `E2E student-detail earlier details ${Date.now()}`;
    const laterReason = `E2E student-detail later ${Date.now() + 1}`;
    const laterDetails = `E2E student-detail later details ${Date.now() + 1}`;

    // IDs of amendments THIS spec inserted. Cleanup deletes only these IDs;
    // it never sweeps every correction on the seeded meeting, so unrelated
    // amendments from other lanes or prior runs survive untouched.
    const createdAmendmentIds: number[] = [];

    try {
      const { data: firstInsert, error: firstError } = await advisor
        .from("advising_meeting_amendment")
        .insert({
          meeting_id: meetingId,
          reason: earlierReason,
          details: earlierDetails,
        })
        .select("amendment_id")
        .single();
      if (firstError) throw new Error(`insert earlier amendment: ${firstError.message}`);
      createdAmendmentIds.push(firstInsert.amendment_id as number);

      // The PostgreSQL trigger stamps `created_at = now()`; sleep long enough
      // that the second insert's `created_at` is strictly later than the first.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { data: secondInsert, error: secondError } = await advisor
        .from("advising_meeting_amendment")
        .insert({
          meeting_id: meetingId,
          reason: laterReason,
          details: laterDetails,
        })
        .select("amendment_id")
        .single();
      if (secondError) throw new Error(`insert later amendment: ${secondError.message}`);
      createdAmendmentIds.push(secondInsert.amendment_id as number);

      // Open the student's detail page (the read-only advising history).
      await signInAsActive(page);
      await page.goto("/students");
      await page
        .getByRole("link", { name: STUDENT_NAME, exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await expect(page).toHaveURL(/\/students\/\d+$/);
      await expect(page.getByRole("heading", { name: STUDENT_NAME })).toBeVisible({
        timeout: 15_000,
      });

      const main = page.locator("main");

      // The original meeting row stays untouched: its seeded context
      // (General Advising), notes marker, and provenance render verbatim
      // beneath the meeting row's identifier.
      const advisingSection = main.locator("table").filter({
        hasText: "E2E seeded advising session",
      });
      const seededMeeting = advisingSection
        .locator("tbody tr", { hasText: "E2E seeded advising session" })
        .first();
      await expect(seededMeeting.getByText("General Advising", { exact: true })).toBeVisible();
      await expect(
        seededMeeting.getByText("E2E seeded advising session", { exact: true }),
      ).toBeVisible();
      await expect(seededMeeting.getByText(/^Recorded by /)).toBeVisible();

      // Each correction surfaces its reason, details, creator attribution, and
      // database-authored timestamp. The amber `Corrections` panel is the
      // exact panel the advising lane uses, attached to the unchanged meeting.
      const earlierCorrection = advisingSection.locator("tbody tr", {
        hasText: earlierReason,
      });
      const laterCorrection = advisingSection.locator("tbody tr", {
        hasText: laterReason,
      });
      await expect(earlierCorrection).toBeVisible();
      await expect(earlierCorrection).toContainText(earlierDetails);
      await expect(earlierCorrection).toContainText("Added by");
      await expect(laterCorrection).toBeVisible();
      await expect(laterCorrection).toContainText(laterDetails);
      await expect(laterCorrection).toContainText("Added by");

      // Chronological order: the earlier correction's reason appears in the
      // rendered table HTML BEFORE the later correction's reason. Comparing
      // positions in the table HTML keeps this layout-independent.
      const tableHtml = await advisingSection.first().innerHTML();
      const earlierIndex = tableHtml.indexOf(earlierReason);
      const laterIndex = tableHtml.indexOf(laterReason);
      expect(earlierIndex).toBeGreaterThan(-1);
      expect(laterIndex).toBeGreaterThan(earlierIndex);

      // The student detail surface stays read-only: no Add Correction
      // affordance anywhere on the page, in either the meeting row or the
      // attached corrections.
      await expect(main.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
      await expect(seededMeeting.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
      await expect(earlierCorrection.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
      await expect(laterCorrection.getByRole("button", { name: "Add Correction" })).toHaveCount(0);
    } finally {
      // Service-role cleanup. The amendment trigger raises on UPDATE/DELETE for
      // the authenticated role, but service role bypasses RLS and there is no
      // DELETE trigger. Scope the cleanup to the amendment_ids we just created
      // so unrelated corrections on the seeded meeting (from other lanes or
      // prior runs) are never touched — the seed baseline is preserved across
      // every rerun of this spec.
      await advisor.auth.signOut();
      if (createdAmendmentIds.length > 0) {
        const service = serviceClient();
        const { error: deleteError } = await service
          .from("advising_meeting_amendment")
          .delete()
          .in("amendment_id", createdAmendmentIds);
        if (deleteError) {
          throw new Error(
            `amendment cleanup failed for ids [${createdAmendmentIds.join(", ")}]: ${deleteError.message}`,
          );
        }
      }
    }
  });

  test("the advising history filter shows All, General Advising, and application-scoped records with derived session counts and context", async ({ page }) => {
    const service = serviceClient();
    const advisor = await activeAdvisorClient();

    // Synthetic fixture: one meeting scoped to the seeded student's seeded
    // application, dated AFTER the seeded General Advising meeting so the
    // newest-first history order is observable. The authenticated insert makes
    // the metadata trigger attribute it to the active advisor (the service
    // role alone would leave it unattributed).
    const [studentId, applicationId, advisorId] = await Promise.all([
      service
        .from("student")
        .select("student_id")
        .eq("full_name", STUDENT_NAME)
        .single()
        .then(({ data, error }) => {
          if (error) throw new Error(`find seeded student: ${error.message}`);
          return data.student_id as number;
        }),
      findSeededApplicationId(),
      findActiveAdvisorId(),
    ]);

    const scopedNote = `E2E scoped advising session ${Date.now()}`;
    const appLabel = `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`;

    let createdMeetingId: number | null = null;
    try {
      const { data: inserted, error: insertError } = await advisor
        .from("advising_meeting")
        .insert({
          student_id: studentId,
          application_id: applicationId,
          advisor_id: advisorId,
          meeting_date: "2026-09-10",
          meeting_mode: "Virtual",
          no_show: false,
          notes: scopedNote,
        })
        .select("meeting_id")
        .single();
      if (insertError) {
        throw new Error(`insert scoped meeting: ${insertError.message}`);
      }
      createdMeetingId = inserted.meeting_id as number;

      await signInAsActive(page);
      await page.goto("/students");
      await page
        .getByRole("link", { name: STUDENT_NAME, exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await expect(page).toHaveURL(/\/students\/\d+$/);
      await expect(page.getByRole("heading", { name: STUDENT_NAME })).toBeVisible({
        timeout: 15_000,
      });

      const main = page.locator("main");

      // R2: the seeded application now carries exactly its derived session
      // count (the scoped meeting, and no other).
      const applicationsTable = main.locator("table").filter({ hasText: "Stage" });
      const seededAppRow = applicationsTable.locator("tbody tr", { hasText: appLabel });
      await expect(seededAppRow).toContainText("1 sessions");

      // R3/R4: the advising history section renders both records under All,
      // newest-first (the later scoped meeting above the earlier general one).
      const historySection = main.locator("section").filter({ hasText: "Advising history" });
      await expect(historySection.getByRole("heading", { name: "Advising history" })).toBeVisible();
      const generalArticle = historySection.locator("article", {
        hasText: "E2E seeded advising session",
      });
      const scopedArticle = historySection.locator("article", { hasText: scopedNote });
      await expect(generalArticle).toBeVisible();
      await expect(scopedArticle).toBeVisible();

      const sectionHtml = await historySection.innerHTML();
      const scopedIndex = sectionHtml.indexOf(scopedNote);
      const generalIndex = sectionHtml.indexOf("E2E seeded advising session");
      expect(scopedIndex).toBeGreaterThan(-1);
      expect(generalIndex).toBeGreaterThan(scopedIndex);

      // R3: each meeting carries General Advising / application context plus
      // advisor, mode, attendance, notes, and provenance.
      await expect(generalArticle.getByText("General Advising", { exact: true })).toBeVisible();
      await expect(scopedArticle.getByText(appLabel, { exact: true })).toBeVisible();
      await expect(scopedArticle.getByText("Virtual", { exact: true })).toBeVisible();
      await expect(scopedArticle.getByText("Attended", { exact: true })).toBeVisible();
      await expect(scopedArticle).toContainText(ACTIVE_ADVISOR_NAME);
      await expect(scopedArticle.getByText(/^Recorded by /)).toBeVisible();

      // R4: the filter exposes All / General Advising / the application, and
      // each selection exposes ONLY its expected records. Native <option>
      // elements are collapsed (Playwright reports them hidden), so the
      // presence of each option is asserted by count, not visibility.
      const filter = historySection.getByLabel("Filter advising history");
      await expect(filter.locator("option", { hasText: "All" })).toHaveCount(1);
      await expect(filter.locator("option", { hasText: "General Advising" })).toHaveCount(1);
      await expect(filter.locator("option", { hasText: appLabel })).toHaveCount(1);

      await filter.selectOption("general");
      await expect(generalArticle).toBeVisible();
      await expect(historySection.locator("article", { hasText: scopedNote })).toHaveCount(0);

      await filter.selectOption({ label: appLabel });
      await expect(scopedArticle).toBeVisible();
      await expect(
        historySection.locator("article", { hasText: "E2E seeded advising session" }),
      ).toHaveCount(0);

      // R8: the student-detail history stays immutable — no Edit/Delete and no
      // Add Correction affordance anywhere on the advising surface.
      await expect(historySection.getByRole("button")).toHaveCount(0);
      await expect(main.getByTitle("Edit meeting")).toHaveCount(0);
      await expect(main.getByTitle("Delete meeting")).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Delete" })).toHaveCount(0);

      // R3/R6: the desktop advising table mirrors the scoped meeting with its
      // application context and provenance.
      const desktopTableRow = main
        .locator("table", { hasText: scopedNote })
        .locator("tbody tr", { hasText: scopedNote });
      await expect(desktopTableRow).toContainText(appLabel);
      await expect(desktopTableRow).toContainText("Recorded by");
    } finally {
      // Service-role cleanup of only this test's meeting so the seeded
      // baseline (and the reports spec's exact Advising Meetings total) is
      // preserved across every rerun of this spec.
      await advisor.auth.signOut();
      if (createdMeetingId !== null) {
        const { error: deleteError } = await service
          .from("advising_meeting")
          .delete()
          .eq("meeting_id", createdMeetingId);
        if (deleteError) {
          throw new Error(
            `scoped meeting cleanup failed (${createdMeetingId}): ${deleteError.message}`,
          );
        }
      }
    }
  });
});
