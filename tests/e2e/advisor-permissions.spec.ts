/**
 * tests/e2e/advisor-permissions.spec.ts
 *
 * Admin/Advisor permission boundary (AI-DLC change
 * 2026-10-01-explicit-admin-advisor-permissions, plan Work 6 E2E portion) against
 * the Docker-local Supabase instance seeded by scripts/e2e/run.mjs.
 *
 * Proves, UI-first (semantic locators, auto-waiting assertions, no sleeps):
 *   - a non-admin Advisor never sees the Admin management controls (sidebar
 *     entry, provision form, advisor accounts list) and is rejected by the
 *     protected management API (GET/POST/PATCH all 403) — UI hiding is an
 *     affordance; server/API enforcement is authoritative;
 *   - an effective Admin sees the management surface and provisions an advisor
 *     through the approved flow (the trusted server-only provisioning adapter,
 *     method `invite`, matching Auth claim + protected display role + one-time
 *     bound auth UUID), and the row-level role control round-trips the Auth
 *     `app_metadata.ocf_admin` boolean claim and the protected display role;
 *   - an Admin deactivates an advisor through the management UI (the lifecycle
 *     RPC), and the deactivated advisor loses protected dashboard access
 *     (`/login?reason=inactive`);
 *   - historical attribution survives deactivation: the deactivated advisor's
 *     record page and the shared advising surface keep showing the advisor's
 *     name as recorder of their past meetings.
 *
 * Fixture policy (mirrors lifecycle.spec.ts): each test seeds its OWN synthetic
 * ACTIVE, bound, non-admin advisor (auth user + advisor row) through the
 * service role — the same trusted provisioning authority the server adapter
 * uses — and cleans it up in a `finally` block (meeting rows first, then the
 * advisor row, then the auth user). The lane resets the database before
 * seeding, so the exported report totals and seeded-name assertions in every
 * other spec stay deterministic (workers: 1).
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
const INACTIVE_ADVISOR_NAME = requireEnv("E2E_INACTIVE_ADVISOR_NAME");
const STUDENT_NAME = requireEnv("E2E_STUDENT_NAME");

// Deterministic local-only credential, assembled from harmless fragments so no
// complete password-shaped literal is stored in Git (same convention as the
// seed fixture and auth.spec.ts).
const LOCAL_PASSWORD = ["E2e", "Local", "Pass", "!", "2026"].join("");

let counter = 0;

function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now()}-${counter}`;
}

function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

/** Service-role client for synthetic fixture setup/cleanup only (never the browser). */
function serviceClient(): SupabaseClient {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Fill the login form and submit (no URL assertion — callers assert the outcome). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Sign in as the seeded ACTIVE advisor (the lane's trusted Admin). */
async function signInAsActive(page: Page): Promise<void> {
  await signIn(page, ACTIVE_EMAIL, ACTIVE_PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Drop the browser session (session lives in the cookie jar for @supabase/ssr). */
async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
}

/**
 * Seed a synthetic ACTIVE, bound, non-admin advisor (no `ocf_admin` claim) the
 * same way the trusted provisioning adapter creates accounts: an auth user
 * with a known local password plus an advisor row bound to its exact UUID with
 * the safe default display role. Returns the advisor id and auth user id.
 */
async function seedActiveAdvisor(
  name: string,
  email: string,
): Promise<{ advisorId: number; authUserId: string }> {
  const service = serviceClient();
  const { data: user, error: userError } = await service.auth.admin.createUser({
    email,
    password: LOCAL_PASSWORD,
    email_confirm: true,
  });
  if (userError || !user.user) {
    throw new Error(`seed advisor auth user (${email}): ${userError?.message ?? "no user"}`);
  }
  const { data: advisor, error: advisorError } = await service
    .from("advisor")
    .insert({
      advisor_name: name,
      email,
      auth_user_id: user.user.id,
      is_active: true,
    })
    .select("advisor_id")
    .single();
  if (advisorError) {
    // Best-effort: remove the auth user we just created.
    await service.auth.admin.deleteUser(user.user.id).catch(() => {});
    throw new Error(`seed advisor row (${email}): ${advisorError.message}`);
  }
  return { advisorId: advisor.advisor_id as number, authUserId: user.user.id };
}

/** Delete an advisor row then its auth user (fixture cleanup only). */
async function cleanupAdvisor(advisorId: number, authUserId: string): Promise<void> {
  const service = serviceClient();
  const { error: rowError } = await service
    .from("advisor")
    .delete()
    .eq("advisor_id", advisorId);
  if (rowError) throw new Error(`cleanup advisor row ${advisorId}: ${rowError.message}`);
  const { error: userError } = await service.auth.admin.deleteUser(authUserId);
  if (userError) throw new Error(`cleanup auth user ${authUserId}: ${userError.message}`);
}

/** Read the advisor row for an email (service role). */
async function advisorRowByEmail(email: string) {
  const service = serviceClient();
  const { data, error } = await service
    .from("advisor")
    .select("advisor_id, email, role, is_active, auth_user_id")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`read advisor row (${email}): ${error.message}`);
  return data;
}

/**
 * Scope to the advisor's card on the management page. The heading is nested
 * three divs deep inside the card body (AppCardContent), which also holds the
 * role control and the Deactivate/Activate button.
 */
function advisorCard(page: Page, advisorName: string) {
  return page
    .getByRole("heading", { name: advisorName, exact: true })
    .locator("xpath=../../..");
}

test.describe("advisor permissions", () => {
  test.setTimeout(60_000);

  test("a non-admin Advisor never sees management controls and is denied by the protected management API", async ({ page }) => {
    const name = uniqueName("E2E Advisor Denied");
    const email = uniqueEmail("e2e-denied");
    const seeded = await seedActiveAdvisor(name, email);
    // PATCH target: the seeded ACTIVE advisor (a real bound peer).
    const activeRow = await advisorRowByEmail(ACTIVE_EMAIL);
    if (!activeRow) throw new Error("seeded active advisor row is missing");
    try {
      await signIn(page, email, LOCAL_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/);

      // The sidebar hides the management entry entirely.
      await expect(page.getByRole("link", { name: "Advisor Management" })).toHaveCount(0);

      // Direct navigation shows the access-required gate, never the management UI.
      await page.goto("/advisors");
      await expect(
        page.getByText("Administrator access required", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Provision an advisor", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Create advisor" })).toHaveCount(0);
      await expect(page.getByText("Advisor accounts", { exact: true })).toHaveCount(0);

      // Server/API enforcement is authoritative: list, provision, peer role
      // change, and peer deactivation all return 403 for a non-admin session.
      const list = await page.request.get("/api/advisors");
      expect(list.status()).toBe(403);

      const provision = await page.request.post("/api/advisors", {
        data: {
          email: uniqueEmail("e2e-denied-provision"),
          displayName: "Denied Provision",
        },
      });
      expect(provision.status()).toBe(403);

      const promotePeer = await page.request.patch(`/api/advisors/${activeRow.advisor_id}`, {
        data: { role: "Admin" },
      });
      expect(promotePeer.status()).toBe(403);

      const deactivatePeer = await page.request.patch(`/api/advisors/${activeRow.advisor_id}`, {
        data: { isActive: false },
      });
      expect(deactivatePeer.status()).toBe(403);
    } finally {
      await cleanupAdvisor(seeded.advisorId, seeded.authUserId);
    }
  });

  test("an Admin sees the management surface and provisions an advisor through the approved flow (role changes round-trip)", async ({ page }) => {
    const displayName = uniqueName("E2E Provisioned Advisor");
    const email = uniqueEmail("e2e-provisioned");
    const service = serviceClient();
    let provisionedRow: {
      advisor_id: number;
      role: string;
      is_active: boolean;
      auth_user_id: string | null;
    } | null = null;
    try {
      await signInAsActive(page);
      await expect(page.getByRole("link", { name: "Advisor Management" })).toBeVisible();

      await page.goto("/advisors");
      await expect(page.getByRole("heading", { name: "Advisor Management" })).toBeVisible();
      await expect(page.getByText("Provision an advisor", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create advisor" })).toBeVisible();
      await expect(page.getByText("Advisor accounts", { exact: true })).toBeVisible();
      // The seeded active + inactive advisors are listed.
      await expect(page.getByRole("heading", { name: ACTIVE_ADVISOR_NAME, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: INACTIVE_ADVISOR_NAME, exact: true })).toBeVisible();

      // Provision through the approved UI flow (default role Advisor, invite method).
      await page.locator("#displayName").fill(displayName);
      await page.locator("#advisorEmail").fill(email);
      await page.getByRole("button", { name: "Create advisor" }).click();
      await expect(page.getByText("Advisor provisioned", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: displayName, exact: true })).toBeVisible();

      // Server state: bound once, active, Advisor display role, matching claim.
      provisionedRow = (await advisorRowByEmail(email)) as typeof provisionedRow;
      expect(provisionedRow, "the provisioned advisor row must exist").not.toBeNull();
      expect(provisionedRow!.is_active).toBe(true);
      expect(provisionedRow!.role).toBe("Advisor");
      expect(provisionedRow!.auth_user_id, "the provisioned advisor must be bound").not.toBeNull();
      const authUserId = provisionedRow!.auth_user_id!;
      const authUser = await service.auth.admin.getUserById(authUserId);
      expect(authUser.error).toBeNull();
      expect(authUser.data?.user?.app_metadata?.ocf_admin).toBe(false);

      // Role management control: promote to Admin through the row's role select.
      await page.locator(`#role-${provisionedRow!.advisor_id}`).click();
      await page.getByRole("option", { name: "Admin", exact: true }).click();
      // Wait on server state (the "Advisor updated" toast is shared between
      // promote/demote, so the DB is the deterministic signal).
      await expect
        .poll(async () => (await advisorRowByEmail(email))?.role, { timeout: 10_000 })
        .toBe("Admin");
      const promotedClaim = await service.auth.admin.getUserById(authUserId);
      expect(promotedClaim.data?.user?.app_metadata?.ocf_admin).toBe(true);

      // Demote back to Advisor; claim and display role must both follow.
      await page.locator(`#role-${provisionedRow!.advisor_id}`).click();
      await page.getByRole("option", { name: "Advisor", exact: true }).click();
      await expect
        .poll(async () => (await advisorRowByEmail(email))?.role, { timeout: 10_000 })
        .toBe("Advisor");
      const demotedClaim = await service.auth.admin.getUserById(authUserId);
      expect(demotedClaim.data?.user?.app_metadata?.ocf_admin).toBe(false);
    } finally {
      // Clean up the provisioned advisor (row first, then the auth identity).
      const row = provisionedRow ?? (await advisorRowByEmail(email));
      if (row) {
        try {
          if (row.auth_user_id) {
            await service.auth.admin.deleteUser(row.auth_user_id);
          }
        } catch {
          /* best-effort cleanup */
        }
        try {
          await service.from("advisor").delete().eq("advisor_id", row.advisor_id);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  });

  test("an Admin deactivates an advisor and the deactivated advisor loses protected dashboard access", async ({ page }) => {
    const name = uniqueName("E2E Deactivated Advisor");
    const email = uniqueEmail("e2e-deactivated");
    const seeded = await seedActiveAdvisor(name, email);
    try {
      await signInAsActive(page);
      await page.goto("/advisors");

      const card = advisorCard(page, name);
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Deactivate" }).click();
      // Wait on the lifecycle RPC result (the "Advisor updated" toast is
      // shared with every management action, so the DB is the deterministic
      // signal); then assert the card reflects the deactivated state.
      await expect
        .poll(async () => (await advisorRowByEmail(email))?.is_active, { timeout: 10_000 })
        .toBe(false);
      await expect(card.getByText("Advisor Inactive", { exact: true })).toBeVisible();

      // The lifecycle RPC wrote is_active=false.
      const row = await advisorRowByEmail(email);
      expect(row?.is_active).toBe(false);

      // The deactivated advisor cannot reach the protected dashboard: sign-in
      // lands on the inactive gate, and a direct /dashboard visit stays gated.
      await signOut(page);
      await signIn(page, email, LOCAL_PASSWORD);
      await expect(page).toHaveURL(/reason=inactive/);
      await expect(
        page.getByText(
          "Your advisor account is inactive. Contact your OCF administrator.",
          { exact: true },
        ),
      ).toBeVisible();

      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await cleanupAdvisor(seeded.advisorId, seeded.authUserId);
    }
  });

  test("a deactivated advisor's historical meeting attribution remains visible", async ({ page }) => {
    const name = uniqueName("E2E Historical Advisor");
    const email = uniqueEmail("e2e-historical");
    const seeded = await seedActiveAdvisor(name, email);
    const notesMarker = `E2E attribution ${Date.now()}`;
    const service = serviceClient();
    let meetingId: number | null = null;
    try {
      // The advisor logs a meeting through the real UI: the authenticated
      // insert resolves the ACTIVE advisor and attributes the record to them.
      await signIn(page, email, LOCAL_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/);
      await page.goto("/advising");
      await page.getByRole("button", { name: "Log Meeting" }).click();
      const dialog = page.getByRole("dialog");
      // The student field is a lazy bounded typeahead: type at least two
      // characters, then choose the bounded option.
      await dialog.locator("#student-search").fill(STUDENT_NAME);
      await dialog.getByRole("button", { name: STUDENT_NAME, exact: true }).click();
      await dialog.locator("#meeting_date").fill("2026-09-15");
      await dialog.locator("#notes").fill(notesMarker);
      await dialog.getByRole("button", { name: "Log Meeting" }).click();
      await expect(page.getByText("Meeting recorded successfully.", { exact: true })).toBeVisible();

      // The meeting is attributed to the advisor (conducted AND recorded by them).
      const { data: meeting } = await service
        .from("advising_meeting")
        .select("meeting_id, advisor_id, created_by_advisor_id")
        .eq("notes", notesMarker)
        .maybeSingle();
      expect(meeting, "the seeded meeting must exist").not.toBeNull();
      expect(meeting!.advisor_id).toBe(seeded.advisorId);
      expect(meeting!.created_by_advisor_id).toBe(seeded.advisorId);
      meetingId = meeting!.meeting_id;

      // The Admin sees the historical attribution on the advisor's record page.
      await signOut(page);
      await signInAsActive(page);
      await page.goto(`/advisors/${seeded.advisorId}`);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(
        page.getByText(new RegExp(`Recorded by ${name}`)).filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: STUDENT_NAME, exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();

      // The Admin deactivates the advisor through the management UI.
      await page.goto("/advisors");
      const card = advisorCard(page, name);
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Deactivate" }).click();
      await expect
        .poll(async () => (await advisorRowByEmail(email))?.is_active, { timeout: 10_000 })
        .toBe(false);

      // Historical attribution survives: the record page keeps the meetings
      // attributed to the now-inactive advisor...
      await page.goto(`/advisors/${seeded.advisorId}`);
      await expect(page.getByText("Advisor Inactive", { exact: true })).toBeVisible();
      await expect(
        page.getByText(new RegExp(`Recorded by ${name}`)).filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: STUDENT_NAME, exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();

      // ...and the shared advising surface still shows the advisor's name on
      // the meeting row after deactivation.
      await page.goto("/advising");
      const meetingRow = page.locator("table tbody tr", { hasText: notesMarker });
      await expect(meetingRow).toBeVisible();
      await expect(meetingRow).toContainText(name);
    } finally {
      if (meetingId !== null) {
        try {
          await service.from("advising_meeting").delete().eq("meeting_id", meetingId);
        } catch {
          /* best-effort cleanup */
        }
      }
      await cleanupAdvisor(seeded.advisorId, seeded.authUserId);
    }
  });
});
