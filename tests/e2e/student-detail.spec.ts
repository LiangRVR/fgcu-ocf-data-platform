/**
 * tests/e2e/student-detail.spec.ts
 *
 * Student detail + history navigation against the Docker-local Supabase
 * instance seeded by scripts/e2e/run.mjs (hardening plan Work 6 / R5). UI-first:
 *
 *   - open the seeded student's record from the roster;
 *   - assert the record's stable sections render (applications, advising,
 *     scholarship history);
 *   - follow the scholarship-history badge (the "history" surface) into the
 *     linked fellowship's detail page.
 *
 * All interactions use semantic selectors and auto-waiting assertions (no
 * sleeps). Read-only: leaves the seeded fixtures untouched.
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

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
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
    // The seeded application row links the fellowship the student applied to.
    await expect(
      page.getByRole("link", { name: FELLOWSHIP_NAME, exact: true }).filter({ visible: true }).first(),
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
});
