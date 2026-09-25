/**
 * tests/e2e/mobile.spec.ts
 *
 * Meaningful mobile smoke lane (hardening plan Work 8 / R8). Runs under BOTH
 * Playwright projects:
 *   - "chromium" (Desktop Chrome) — full-lane spec;
 *   - "mobile-chromium" (Pixel 7) — the ONLY spec this project runs
 *     (see playwright.config.ts testMatch), exercising the same flows at a
 *     mobile viewport where the roster/catalog render as card lists.
 *
 * Layout-independent: every locator is semantic and visibility-filtered, with
 * one explicit responsive assertion (the desktop-only table is hidden below
 * the md breakpoint) gated on the mobile project.
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
});