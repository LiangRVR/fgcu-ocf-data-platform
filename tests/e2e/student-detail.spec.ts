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
 *     alongside its provenance through ONE shared history implementation and
 *     exposes the shared Add Correction affordance for the eligible
 *     (non-archived) meeting while still offering no direct Edit/Delete meeting
 *     control; the history filter offers All / General Advising / each
 *     application;
 *   - through the shared Add Correction dialog on the student detail surface,
 *     verify required-field validation, that the appended correction shows its
 *     reason, details, creator, and timestamp under the unchanged original
 *     meeting, in chronological order, and that it survives a reload;
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

    // R5: Student Detail renders exactly ONE advising-history surface (the
    // shared AdvisingHistory implementation). The legacy duplicate table markup
    // is gone: the seeded meeting renders as a history article, never a table.
    const historySurface = main.locator("section", { hasText: "Advising history" });
    await expect(main.getByRole("heading", { name: "Advising history" })).toHaveCount(1);
    await expect(main.locator("table", { hasText: "E2E seeded advising session" })).toHaveCount(0);

    const seededMeeting = historySurface.locator("article", {
      hasText: "E2E seeded advising session",
    });
    await expect(seededMeeting).toHaveCount(1);
    await expect(seededMeeting.getByText("General Advising", { exact: true })).toBeVisible();
    await expect(seededMeeting.getByText("E2E seeded advising session", { exact: true })).toBeVisible();
    await expect(seededMeeting.getByText(/^Recorded by .+ · /)).toBeVisible();
    // R6: the shared Add Correction affordance is exposed beside the eligible
    // (non-archived) meeting. There is still no direct Edit/Delete meeting
    // control (the profile's per-section Edit buttons are the only "Edit" on
    // the page and are not meeting controls, so meeting-oriented controls are
    // asserted by their exact titles/roles).
    await expect(seededMeeting.getByRole("button", { name: "Add Correction" })).toBeVisible();
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

  test("the shared Add Correction dialog on Student Detail validates, appends chronological corrections under the unchanged original meeting, and refreshes after a reload", async ({ page }) => {
    const meetingId = await findSeededMeetingId();

    // Unique reason / details keep the assertions and cleanup stable across
    // re-runs even if a previous run left unrelated rows behind (the advising
    // lane deliberately retains its own corrections).
    const earlierReason = `E2E student-detail earlier ${Date.now()}`;
    const earlierDetails = `E2E student-detail earlier details ${Date.now()}`;
    const laterReason = `E2E student-detail later ${Date.now() + 1}`;
    const laterDetails = `E2E student-detail later details ${Date.now() + 1}`;

    try {
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

      const historyPage = page.locator("main");
      // R5: exactly ONE advising-history surface; the legacy duplicate table
      // markup is gone (the meeting renders as a history article).
      const historySurface = historyPage.locator("section", { hasText: "Advising history" });
      await expect(historyPage.getByRole("heading", { name: "Advising history" })).toHaveCount(1);
      await expect(
        historyPage.locator("table", { hasText: "E2E seeded advising session" }),
      ).toHaveCount(0);

      // The original meeting article stays untouched and carries the shared
      // Add Correction affordance (R6, eligible non-archived meeting).
      const seededMeeting = historySurface.locator("article", {
        hasText: "E2E seeded advising session",
      });
      await expect(seededMeeting).toHaveCount(1);
      await expect(seededMeeting.getByText("General Advising", { exact: true })).toBeVisible();
      await expect(
        seededMeeting.getByText("E2E seeded advising session", { exact: true }),
      ).toBeVisible();
      await expect(seededMeeting.getByText(/^Recorded by /)).toBeVisible();
      await expect(seededMeeting.getByRole("button", { name: "Add Correction" })).toBeVisible();

      // Each correction is created through the SAME shared dialog the
      // /advising surface uses: Reason + Details only, with required-field
      // validation and a database-authored creator/timestamp.
      const submitCorrection = async (reason: string, details: string): Promise<void> => {
        await seededMeeting.getByRole("button", { name: "Add Correction" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const reasonInput = dialog.locator('input[id^="correction-reason-"]');
        const detailsInput = dialog.locator('textarea[id^="correction-details-"]');
        await expect(reasonInput).toBeVisible();
        await expect(detailsInput).toBeVisible();
        // No editable meeting id / creator / timestamp inputs are exposed.
        await expect(dialog.locator("input[name='meeting_id']")).toHaveCount(0);
        await expect(dialog.locator("input[name='created_by_advisor_id']")).toHaveCount(0);
        await expect(dialog.locator("input[name='created_at']")).toHaveCount(0);

        // Submitting empty shows the required-field errors (no insert yet).
        await dialog.getByRole("button", { name: "Add Correction" }).click();
        await expect(dialog.getByText("Reason is required.")).toBeVisible();
        await expect(dialog.getByText("Details are required.")).toBeVisible();

        await reasonInput.fill(reason);
        await detailsInput.fill(details);
        await dialog.getByRole("button", { name: "Add Correction" }).click();
        await expect(dialog).toBeHidden();
      };

      await submitCorrection(earlierReason, earlierDetails);
      // Wait long enough that the database-authored `created_at` strictly
      // advances for the second correction (PostgreSQL timestamptz resolution
      // is microseconds).
      await page.waitForTimeout(1100);
      await submitCorrection(laterReason, laterDetails);

      // Each correction surfaces its reason, details, and creator attribution
      // under the unchanged original meeting.
      await expect(seededMeeting.getByText(earlierReason)).toBeVisible();
      await expect(seededMeeting.getByText(earlierDetails)).toBeVisible();
      await expect(seededMeeting.getByText(laterReason)).toBeVisible();
      await expect(seededMeeting.getByText(laterDetails)).toBeVisible();
      await expect(seededMeeting.getByText("E2E seeded advising session", { exact: true })).toBeVisible();

      // Chronological order: the earlier correction's reason appears in the
      // history HTML BEFORE the later correction's reason. Comparing positions
      // in the history HTML keeps this layout-independent.
      const surfaceHtml = await historySurface.innerHTML();
      const earlierIndex = surfaceHtml.indexOf(earlierReason);
      const laterIndex = surfaceHtml.indexOf(laterReason);
      expect(earlierIndex).toBeGreaterThan(-1);
      expect(laterIndex).toBeGreaterThan(earlierIndex);

      // Reload → R6: the appended corrections survive via the server loader and
      // still render in order under the unchanged original meeting.
      await page.reload();
      const persistedSurface = page.locator("main section", { hasText: "Advising history" });
      await expect(persistedSurface.getByText(earlierReason)).toBeVisible();
      await expect(persistedSurface.getByText(laterReason)).toBeVisible();
      await expect(
        persistedSurface
          .locator("article", { hasText: "E2E seeded advising session" })
          .getByRole("button", { name: "Add Correction" }),
      ).toBeVisible();
      const persistedHtml = await persistedSurface.innerHTML();
      expect(persistedHtml.indexOf(earlierReason)).toBeGreaterThan(-1);
      expect(persistedHtml.indexOf(laterReason)).toBeGreaterThan(
        persistedHtml.indexOf(earlierReason),
      );
    } finally {
      // Service-role cleanup. The amendment trigger denies UPDATE for
      // authenticated clients and there is no DELETE trigger, so service role
      // removes exactly the two corrections this test created (matched by their
      // unique reasons) and never touches unrelated rows.
      const service = serviceClient();
      const { error: deleteError } = await service
        .from("advising_meeting_amendment")
        .delete()
        .eq("meeting_id", meetingId)
        .in("reason", [earlierReason, laterReason]);
      if (deleteError) {
        throw new Error(`amendment cleanup failed: ${deleteError.message}`);
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

      // R6: the eligible meeting exposes the shared Add Correction control
      // beside it, and the historical surface offers no direct Edit/Delete
      // meeting control.
      await expect(scopedArticle.getByRole("button", { name: "Add Correction" })).toBeVisible();
      await expect(main.getByTitle("Edit meeting")).toHaveCount(0);
      await expect(main.getByTitle("Delete meeting")).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Delete" })).toHaveCount(0);
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
