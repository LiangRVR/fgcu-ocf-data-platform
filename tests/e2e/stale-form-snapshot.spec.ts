/**
 * tests/e2e/stale-form-snapshot.spec.ts
 *
 * Regression cover for the stale-page form snapshot invariant on the three
 * expected-version editor surfaces (Student profile, Application, Fellowship)
 * against the Docker-local Supabase instance seeded by scripts/e2e/run.mjs.
 *
 * The invariant under test (optimistic concurrency, migration
 * `20261015000001_protected_current_state_writers.sql`): when an editor opens,
 * the rendered business fields AND the carried `row_version` must come from
 * ONE loaded row snapshot. A page that has been open long enough for another
 * session to change the record must NOT be able to save: the writer rejects the
 * stale `p_expected_version` with `SQLSTATE 'PT409'`, and the editor surfaces
 * the refresh-and-review guidance instead of retrying or overwriting.
 *
 * The failure this catches is subtle: if an editor paired OLD business fields
 * (loaded when the form opened) with a FRESH version (re-read at save time),
 * then session A's stale submit would silently succeed and clobber the
 * concurrent session B. To prove the coupling, every test drives TWO real
 * signed-in browser sessions through the real UI:
 *
 *   1. session A loads the record's edit form (fields + version from one
 *      snapshot), and the loaded snapshot is asserted before the race;
 *   2. session B (a second signed-in context) changes the same record's
 *      business value through the same UI — bumping `row_version` server-side;
 *   3. session A submits its now-stale snapshot with a fresh edit;
 *   4. the save is rejected (guidance shown, editor stays open) and, after a
 *      reload, session B's value persists while session A's stale value never
 *      reached the database.
 *
 * Direct authenticated UPDATE on student/fellowship/application is revoked, so
 * session B's write can ONLY travel through the same expected-version writer
 * the UI uses; the race is real, not simulated with a privileged write.
 *
 * Fixture policy: each test seeds its own synthetic student/fellowship/
 * application through the service role (setup/cleanup only, never the browser
 * under test) and removes it in a `finally` block, so the seeded-name
 * assertions and the reports spec's exact totals stay deterministic (the lane
 * runs with `workers: 1`, `retries: 0`).
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
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

// The lane always sets APP_URL to the isolated app instance; fall back to the
// Playwright default only when running the spec outside the lane.
const BASE_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";

/**
 * Required refresh-and-review guidance (R4) surfaced by every expected-version
 * editor on a `PT409` conflict. Asserted as user-visible copy — the editors
 * never auto-retry or merge.
 */
const STALE_VERSION_GUIDANCE =
  "This record was changed by another session. Refresh and review the latest information before saving.";

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * A second, independent signed-in browser session (its own cookie jar). The
 * raw `browser` fixture does not inherit the project's `use` options, so the
 * app origin is passed explicitly.
 */
async function openSignedInSession(
  browser: Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await signInAsActive(page);
  return { page, close: () => context.close() };
}

/** Service-role client for synthetic fixture setup/cleanup only. */
function serviceClient(): SupabaseClient {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Seed a fresh active student; returns its id. */
async function seedStudent(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .insert({
      full_name: name,
      email: `e2e-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      us_citizen: true,
    })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student ${name}: ${error.message}`);
  return data.student_id as number;
}

/** Seed a fresh active fellowship; returns its id. */
async function seedFellowship(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: name })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship ${name}: ${error.message}`);
  return data.fellowship_id as number;
}

/**
 * Seed one application for the pair at an early, flag-free stage (consistent
 * with the test-only stage/flag invariant the lane applies). `destination` is a
 * unique marker so the race assertions can name the exact business value.
 */
async function seedApplication(
  studentId: number,
  fellowshipId: number,
  destination: string,
): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("application")
    .insert({
      student_id: studentId,
      fellowship_id: fellowshipId,
      application_year: 2026,
      destination_country: destination,
      stage_of_application: "Submitted",
      is_semi_finalist: false,
      is_finalist: false,
    })
    .select("application_id")
    .single();
  if (error) throw new Error(`seed application for student ${studentId}: ${error.message}`);
  return data.application_id as number;
}

async function deleteApplication(applicationId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("application").delete().eq("application_id", applicationId);
  if (error) throw new Error(`cleanup application ${applicationId}: ${error.message}`);
}

async function deleteStudent(studentId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("student").delete().eq("student_id", studentId);
  if (error) throw new Error(`cleanup student ${studentId}: ${error.message}`);
}

async function deleteFellowship(fellowshipId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("fellowship").delete().eq("fellowship_id", fellowshipId);
  if (error) throw new Error(`cleanup fellowship ${fellowshipId}: ${error.message}`);
}

test.describe("stale form snapshot (optimistic concurrency)", () => {
  test.setTimeout(90_000);

  test("a stale Student profile form is rejected instead of overwriting a concurrent session's change", async ({ page, browser }) => {
    const originalName = `E2E Snapshot Student ${Date.now()}`;
    const studentId = await seedStudent(originalName);
    let sessionB: Awaited<ReturnType<typeof openSignedInSession>> | null = null;
    try {
      sessionB = await openSignedInSession(browser);
      await signInAsActive(page);

      // Session A loads the profile — the server-rendered snapshot supplies
      // BOTH the editable fields and the carried row_version — then opens the
      // Basic Information editor.
      await page.goto(`/students/${studentId}`);
      await expect(page.getByRole("heading", { name: originalName })).toBeVisible();
      const editorA = page.getByRole("region", { name: "Student Profile" });
      await editorA.getByRole("button", { name: "Edit", exact: true }).first().click();
      await expect(page.locator("#b_full_name")).toHaveValue(originalName);

      // Session B (a second signed-in session) renames the same student through
      // the same UI, bumping row_version server-side.
      const pageB = sessionB.page;
      await pageB.goto(`/students/${studentId}`);
      await expect(pageB.getByRole("heading", { name: originalName })).toBeVisible();
      const editorB = pageB.getByRole("region", { name: "Student Profile" });
      await editorB.getByRole("button", { name: "Edit", exact: true }).first().click();
      await expect(pageB.locator("#b_full_name")).toHaveValue(originalName);
      const nameB = `${originalName} B ${Date.now()}`;
      await pageB.locator("#b_full_name").fill(nameB);
      await editorB.getByRole("button", { name: "Save", exact: true }).click();
      await expect(pageB.getByText("Student updated.")).toBeVisible();

      // Session A's open editor still shows the snapshot it loaded BEFORE B's
      // change — it is not silently re-syncing to the newer row (nor to a
      // fresher version).
      await expect(page.locator("#b_full_name")).toHaveValue(originalName);

      // Session A submits its stale snapshot with a fresh business edit.
      const nameA = `${originalName} A ${Date.now()}`;
      await page.locator("#b_full_name").fill(nameA);
      await editorA.getByRole("button", { name: "Save", exact: true }).click();

      // Rejected: the carried version is stale. Guidance is shown and the
      // editor stays open (no overwrite, no retry).
      await expect(page.getByText(STALE_VERSION_GUIDANCE)).toBeVisible();
      await expect(page.locator("#b_full_name")).toHaveValue(nameA);

      // Reload proves B's write persisted and A's old fields were never paired
      // with a fresh version.
      await page.reload();
      await expect(page.getByRole("heading", { name: nameB })).toBeVisible();
      await expect(page.getByText(nameA, { exact: true })).toHaveCount(0);
    } finally {
      if (sessionB) await sessionB.close();
      await deleteStudent(studentId);
    }
  });

  test("a stale Application edit form cannot pair old business fields with a fresh version", async ({ page, browser }) => {
    const studentName = `E2E Snapshot App Student ${Date.now()}`;
    const fellowshipName = `E2E Snapshot App Fellowship ${Date.now()}`;
    const studentId = await seedStudent(studentName);
    const fellowshipId = await seedFellowship(fellowshipName);
    const originalDestination = `Snapshot Origin ${Date.now()}`;
    const applicationId = await seedApplication(studentId, fellowshipId, originalDestination);
    let sessionB: Awaited<ReturnType<typeof openSignedInSession>> | null = null;
    try {
      sessionB = await openSignedInSession(browser);
      await signInAsActive(page);

      // Session A opens the edit dialog: one fresh row snapshot supplies both
      // the rendered fields and the carried row_version.
      await page.goto("/applications");
      const rowA = page.locator("table tbody tr", { hasText: studentName });
      await expect(rowA).toContainText("Submitted");
      await rowA.getByTitle("Edit application").click();
      const dialogA = page.getByRole("dialog");
      await expect(dialogA.getByRole("heading", { name: "Edit Application" })).toBeVisible();
      await expect(page.locator("#app-country")).toHaveValue(originalDestination);

      // Session B advances the same application to a different stage AND a
      // distinct destination, bumping row_version server-side.
      const pageB = sessionB.page;
      await pageB.goto("/applications");
      const rowB = pageB.locator("table tbody tr", { hasText: studentName });
      await expect(rowB).toContainText("Submitted");
      await rowB.getByTitle("Edit application").click();
      await expect(
        pageB.getByRole("dialog").getByRole("heading", { name: "Edit Application" }),
      ).toBeVisible();
      await pageB.locator("#app-stage").click();
      await pageB.getByRole("option", { name: "Under Review", exact: true }).click();
      const bDestination = `Snapshot B ${Date.now()}`;
      await pageB.locator("#app-country").fill(bDestination);
      await pageB.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
      await expect(rowB).toContainText("Under Review");
      await expect(pageB.getByRole("dialog")).toBeHidden();

      // Session A's form still carries the pre-B snapshot.
      await expect(page.locator("#app-country")).toHaveValue(originalDestination);

      // Session A submits the stale snapshot with fresh business edits.
      await page.locator("#app-stage").click();
      await page.getByRole("option", { name: "Finalist", exact: true }).click();
      const aDestination = `Snapshot A ${Date.now()}`;
      await page.locator("#app-country").fill(aDestination);
      await dialogA.getByRole("button", { name: "Save Changes" }).click();

      await expect(page.getByText(STALE_VERSION_GUIDANCE)).toBeVisible();
      await expect(dialogA).toBeVisible();

      // Reload proves B's stage/destination persisted and A's stale values
      // (Finalist / aDestination) never landed.
      await page.reload();
      const rowAfter = page.locator("table tbody tr", { hasText: studentName });
      await expect(rowAfter).toContainText("Under Review");
      await expect(rowAfter).toContainText(bDestination);
      await expect(rowAfter).not.toContainText("Finalist");
      await expect(page.getByText(aDestination, { exact: true })).toHaveCount(0);
    } finally {
      if (sessionB) await sessionB.close();
      await deleteApplication(applicationId);
      await deleteStudent(studentId);
      await deleteFellowship(fellowshipId);
    }
  });

  test("a stale Fellowship edit form cannot pair an old name with a fresh version", async ({ page, browser }) => {
    const originalName = `E2E Snapshot Fellowship ${Date.now()}`;
    const fellowshipId = await seedFellowship(originalName);
    let sessionB: Awaited<ReturnType<typeof openSignedInSession>> | null = null;
    try {
      sessionB = await openSignedInSession(browser);
      await signInAsActive(page);

      // Session A opens the edit dialog: the displayed name and the carried
      // row_version come from one database snapshot.
      await page.goto("/fellowships");
      const rowA = page.locator("table tbody tr", { hasText: originalName });
      await expect(rowA).toBeVisible();
      await rowA.getByTitle("Edit fellowship").click();
      await expect(
        page.getByRole("dialog").getByRole("heading", { name: "Edit Fellowship" }),
      ).toBeVisible();
      await expect(page.locator("#fellowship-name")).toHaveValue(originalName);

      // Session B renames the same fellowship through the same UI.
      const pageB = sessionB.page;
      await pageB.goto("/fellowships");
      const rowB = pageB.locator("table tbody tr", { hasText: originalName });
      await expect(rowB).toBeVisible();
      await rowB.getByTitle("Edit fellowship").click();
      await expect(pageB.locator("#fellowship-name")).toHaveValue(originalName);
      const nameB = `${originalName} B ${Date.now()}`;
      await pageB.locator("#fellowship-name").fill(nameB);
      await pageB.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      await expect(pageB.getByText("Fellowship updated")).toBeVisible();

      // Session A's dialog still shows the loaded snapshot.
      await expect(page.locator("#fellowship-name")).toHaveValue(originalName);

      // Session A submits the stale snapshot with a fresh rename.
      const nameA = `${originalName} A ${Date.now()}`;
      await page.locator("#fellowship-name").fill(nameA);
      await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();

      await expect(page.getByText(STALE_VERSION_GUIDANCE)).toBeVisible();
      await expect(page.locator("#fellowship-name")).toHaveValue(nameA);

      // Reload proves B's rename persisted and A's never did.
      await page.reload();
      await expect(page.locator("table tbody tr", { hasText: nameB })).toBeVisible();
      await expect(page.getByText(nameA, { exact: true })).toHaveCount(0);
    } finally {
      if (sessionB) await sessionB.close();
      await deleteFellowship(fellowshipId);
    }
  });
});
