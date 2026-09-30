/**
 * tests/e2e/student-detail.spec.ts
 *
 * Student detail + history navigation against the Docker-local Supabase
 * instance seeded by scripts/e2e/run.mjs (hardening plan Work 6 / R5). UI-first:
 *
 *   - open the seeded student's record from the roster;
 *   - assert the record's stable sections render (applications, advising,
 *     scholarship history);
 *   - confirm the advising history surfaces the immutable meeting record
 *     alongside its provenance while remaining read-only — no Add Correction
 *     affordance is exposed from the student detail surface;
 *   - with synthetic amendments attached to the seeded advising meeting,
 *     verify the student detail view shows each correction's reason, details,
 *     creator, and timestamp under the unchanged original meeting, in
 *     chronological order, without exposing the Add Correction control;
 *   - follow the scholarship-history badge (the "history" surface) into the
 *     linked fellowship's detail page.
 *
 * All interactions use semantic selectors and auto-waiting assertions (no
 * sleeps). The amendment-coverage test inserts its own synthetic amendments
 * via the active-advisor typed client and cleans them up through the service
 * role so the next run starts from the seeded baseline.
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
    await expect(main.getByText("Scholarship History").first()).toBeVisible();
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
});
