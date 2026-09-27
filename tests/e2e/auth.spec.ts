/**
 * tests/e2e/auth.spec.ts
 *
 * Authentication surface against the Docker-local Supabase instance seeded by
 * scripts/e2e/run.mjs. Covers the stable login controls (#email / #password /
 * "Sign in"), the protected-dashboard redirect, and the active vs. inactive
 * advisor sign-in outcomes plus the unauthorized outcome for a signed-in user
 * with no advisor profile.
 *
 * Run ONLY via `pnpm run test:e2e` (scripts/e2e/run.mjs), which exports the
 * seeded identities as E2E_* env vars.
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
const INACTIVE_EMAIL = requireEnv("E2E_INACTIVE_EMAIL");
const INACTIVE_PASSWORD = requireEnv("E2E_INACTIVE_PASSWORD");

/**
 * The non-advisor AUTH user has NO public.advisor row. Its email is a fixed
 * constant shared with tests/e2e/fixtures/seed.ts (the runner only exports the
 * advisor identities as env vars, and this one intentionally has no advisor
 * profile to link).
 */
const NON_ADVISOR_EMAIL = "e2e-non-advisor@example.com";
const NON_ADVISOR_PASSWORD = "E2eLocalPass!2026";

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("auth", () => {
  test.setTimeout(60_000);

  test("login page renders the stable sign-in controls", async ({ page }) => {
    await page.goto("/login");

    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Sign in to OCF", { exact: true })).toBeVisible();
  });

  test("unauthenticated /dashboard access redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("#email")).toBeVisible();
  });

  test("active advisor signs in and lands on the protected dashboard", async ({ page }) => {
    await signIn(page, ACTIVE_EMAIL, ACTIVE_PASSWORD);

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Protected workspace", { exact: true })).toBeVisible();
  });

  test("inactive advisor sign-in is redirected back with the inactive reason", async ({ page }) => {
    await signIn(page, INACTIVE_EMAIL, INACTIVE_PASSWORD);

    await expect(page).toHaveURL(/reason=inactive/);
    await expect(
      page.getByText(
        "Your advisor account is inactive. Contact your OCF administrator.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("a signed-in user without an advisor profile is redirected with the unauthorized reason", async ({ page }) => {
    await signIn(page, NON_ADVISOR_EMAIL, NON_ADVISOR_PASSWORD);

    await expect(page).toHaveURL(/reason=unauthorized/);
    await expect(
      page.getByText(
        "Your account is signed in but is not linked to an active advisor profile.",
        { exact: true },
      ),
    ).toBeVisible();
  });
});