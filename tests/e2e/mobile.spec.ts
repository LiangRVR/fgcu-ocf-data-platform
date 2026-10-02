/**
 * tests/e2e/mobile.spec.ts
 *
 * Meaningful mobile smoke lane (advising-continuity UI R10 / hardening plan
 * Work 8 / R8). Runs under BOTH Playwright projects:
 *   - "chromium" (Desktop Chrome) — full-lane spec;
 *   - "mobile-chromium" (Pixel 7) — the ONLY spec this project runs
 *     (see playwright.config.ts testMatch), exercising the same flows at a
 *     mobile viewport where the roster/catalog render as card lists.
 *
 * Layout-independent: every locator is semantic and visibility-filtered, with
 * one explicit responsive assertion (the desktop-only table is hidden below
 * the md breakpoint) gated on the mobile project.
 *
 * The advising workflow test proves a key Student Detail + advising flow stays
 * usable at the mobile viewport: the profile, the derived advising-session
 * count, the advising-history filter, and the Log Meeting dialog's essential
 * fields (student, application choices incl. General Advising, date, mode,
 * notes) all remain reachable.
 */
import { test, expect, type Page } from "@playwright/test";

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

test.describe("mobile smoke", () => {
  test.setTimeout(60_000);

  test("signs in and lands on the protected dashboard", async ({ page }) => {
    await signInAsActive(page);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("renders the student roster as cards and opens the seeded student's detail", async ({ page }, testInfo) => {
    await signInAsActive(page);
    await page.goto("/students");

    // On the Pixel 7 profile the roster is a card list; the desktop table is
    // hidden below the md breakpoint. Prove the responsive layout is what the
    // mobile lane actually exercises.
    if (testInfo.project.name.includes("mobile")) {
      await expect(page.locator("table").first()).toBeHidden();
    }

    await page
      .getByRole("link", { name: STUDENT_NAME, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: STUDENT_NAME })).toBeVisible();
    // Scoped to <main> and .first(): the section CardTitle renders its count as
    // a trailing span ("Advising Meetings(1)"), and the shell sidebar's "Advising"
    // nav item must not be picked up.
    await expect(page.locator("main").getByText("Advising Meetings").first()).toBeVisible();
  });

  test("renders the fellowship catalog as cards and opens the seeded fellowship detail", async ({ page }, testInfo) => {
    await signInAsActive(page);
    await page.goto("/fellowships");

    if (testInfo.project.name.includes("mobile")) {
      await expect(page.locator("table").first()).toBeHidden();
    }

    await page
      .getByRole("link", { name: FELLOWSHIP_NAME, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: FELLOWSHIP_NAME })).toBeVisible();
    await expect(page.getByText("Program Detail", { exact: true })).toBeVisible();
  });

  test("a key advising/student-detail workflow reaches its essential fields", async ({ page }) => {
    await signInAsActive(page);

    // ── Student Detail: profile, derived session count, history filter ──────
    await page.goto("/students");
    await page
      .getByRole("link", { name: STUDENT_NAME, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: STUDENT_NAME })).toBeVisible();

    // The profile surface and the advising history filter remain accessible.
    await expect(page.locator("section[aria-label='Student Profile']")).toBeVisible();
    const historyFilter = page.getByLabel("Filter advising history");
    await expect(historyFilter).toBeVisible();

    // Filter to General Advising: the seeded meeting stays reachable.
    await historyFilter.selectOption("general");
    await expect(
      page
        .locator("main")
        .locator("section", { hasText: "Advising history" })
        .locator("article", { hasText: "E2E seeded advising session" }),
    ).toBeVisible();

    // The application-specific advising-session count renders at this size
    // (desktop table cell "0 sessions" or mobile card badge "0 advising
    // sessions", whichever this project surfaces).
    await expect(
      page
        .locator("main")
        .getByText(/0 (advising )?sessions/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // ── Advising: the Log Meeting dialog exposes its essential fields ───────
    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("#student_id")).toBeVisible();
    await expect(dialog.locator("#application_id")).toBeVisible();
    await expect(dialog.locator("#meeting_date")).toBeVisible();
    await expect(dialog.locator("#meeting_mode")).toBeVisible();
    await expect(dialog.locator("#no_show")).toBeVisible();
    await expect(dialog.locator("#notes")).toBeVisible();

    // Selecting a student offers that student's applications plus General
    // Advising — the dependent meeting-selector behavior stays usable.
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await expect(page.getByRole("option", { name: "General Advising", exact: true })).toBeVisible();
    await expect(
      page.getByRole("option", { name: `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`, exact: true }),
    ).toBeVisible();
  });
});