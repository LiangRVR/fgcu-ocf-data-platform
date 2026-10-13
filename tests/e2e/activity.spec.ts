/**
 * tests/e2e/activity.spec.ts
 *
 * Audit/history surfaces for the `historical-audit-timeline` change against the
 * Docker-local Supabase instance seeded by scripts/e2e/run.mjs. UI-first:
 *
 *   - the STUDENT detail's unified subject-student timeline
 *     ("Activity & Change History") merges the audited profile, application,
 *     advising, attendance (Fellowship Thursday), and scholarship events for
 *     the student, newest-first with actor attribution and normalized field
 *     changes (a versioned profile write surfaces as the newest "Updated
 *     student" event above the seeded "Created student" event and renders its
 *     Major change as friendly before/after values);
 *   - the application-row "View history" action on /applications opens an
 *     accessible dialog with the application-scoped audit trail and a
 *     "Sensitive values are not shown." guarantee;
 *   - the fellowship and advisor detail histories render normalized rows with
 *     no raw payloads;
 *   - the global /activity log paginates a COMPLETE dataset server-side with
 *     the full filter set (record type, change, actor, student, fellowship,
 *     from, through), finds events beyond the initial page, honors the 25/50/100
 *     page-size contract, and orders deterministically by
 *     occurred_at DESC, audit_id DESC (stable across reloads);
 *   - no raw JSON payload columns (old_values/new_values/changes), immutable
 *     bookkeeping ids, row versions, or Auth material ever reach the rendered
 *     surfaces.
 *
 * Audit rows are immutable, so scenarios that need extra history generate it
 * the SAME way production writes do — through the authenticated active-advisor
 * `update_student_profile` RPC (never direct UPDATE, never a fabricated
 * `audit_event` row). Each write is a real meaningful business mutation that
 * the versioned-writer contract audits once. The seeded student's profile is
 * restored in `finally` so later specs see the seeded baseline; the emitted
 * events are intentionally retained (the disposable lane is reset each run).
 *
 * Selectors are semantic and layout-independent (no sleeps). The service role
 * is used only to resolve seeded ids and names, never in the browser.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
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

/** Service-role client for resolving seeded ids/names (test-support only). */
function serviceClient(): SupabaseClient {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Authenticated active-advisor client. The versioned writer RPCs run as an
 * authenticated active advisor (the lane's trusted Admin), so generated audit
 * events carry the real actor snapshot instead of tripping the trigger's
 * no-active-advisor denial.
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

/** Resolve the seeded student's id (unique per lane run). */
async function findStudentId(): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .select("student_id")
    .eq("full_name", STUDENT_NAME)
    .single();
  if (error) throw new Error(`find seeded student: ${error.message}`);
  return data.student_id as number;
}

/** Resolve the seeded fellowship's id. */
async function findFellowshipId(): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("fellowship")
    .select("fellowship_id")
    .eq("fellowship_name", FELLOWSHIP_NAME)
    .single();
  if (error) throw new Error(`find seeded fellowship: ${error.message}`);
  return data.fellowship_id as number;
}

/** Resolve the seeded active advisor's id (the lane's trusted Admin). */
async function findActiveAdvisorId(): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("advisor")
    .select("advisor_id")
    .eq("email", ACTIVE_EMAIL)
    .single();
  if (error) throw new Error(`find active advisor: ${error.message}`);
  return data.advisor_id as number;
}

/** Read the seeded student's full editable row through the service role. */
async function readStudentRow(studentId: number): Promise<Record<string, unknown>> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .select("*")
    .eq("student_id", studentId)
    .single();
  if (error) throw new Error(`read student row: ${error.message}`);
  return data as Record<string, unknown>;
}

/**
 * Perform one meaningful profile write through the versioned writer RPC.
 * `p_major` must differ from the current value (the audit trigger suppresses
 * no-op updates), so each call supplies a fresh unique major. Returns the
 * writer's returned row (carrying the new `row_version`).
 */
async function writeStudentProfile(
  client: SupabaseClient,
  studentId: number,
  major: string,
): Promise<Record<string, unknown>> {
  const { data: row, error: readError } = await client
    .from("student")
    .select("*")
    .eq("student_id", studentId)
    .single();
  if (readError) throw new Error(`read student for write: ${readError.message}`);

  const { data, error } = await client.rpc("update_student_profile", {
    p_student_id: studentId,
    p_expected_version: row.row_version,
    p_full_name: row.full_name,
    p_email: row.email,
    p_is_ch_student: row.is_ch_student,
    p_major: major,
    p_minor: row.minor,
    p_gpa: row.gpa,
    p_class_standing: row.class_standing,
    p_us_citizen: row.us_citizen,
    p_age: row.age,
    p_gender: row.gender,
    p_pronouns: row.pronouns,
    p_race_ethnicity: row.race_ethnicity,
    p_languages: row.languages,
    p_first_gen: row.first_gen,
    p_honors_college: row.honors_college,
  });
  if (error) {
    throw new Error(`update_student_profile: ${error.code ?? ""} ${error.message}`);
  }
  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) throw new Error("update_student_profile returned no row");
  return updated as Record<string, unknown>;
}

/**
 * Restore the seeded student's major after a scenario generated writes. The
 * no-op pass first syncs the loaded version, then a second write restores the
 * original major (emitting one more audit event on the disposable lane).
 */
async function restoreStudentMajor(
  client: SupabaseClient,
  studentId: number,
  originalMajor: string,
): Promise<void> {
  const current = await readStudentRow(studentId);
  await writeStudentProfile(client, studentId, String(current.major ?? "")).catch(
    (err: unknown) => {
      if (err instanceof Error && /PT409/.test(err.message)) return null;
      throw err;
    },
  );
  await writeStudentProfile(client, studentId, originalMajor).catch((err: unknown) => {
    if (err instanceof Error && /PT409/.test(err.message)) return;
    throw err;
  });
}

/**
 * Privacy boundary: only normalized display props may reach the browser.
 * Assert the rendered surface never leaks the raw audit JSON columns
 * (old_values / new_values / changes), the immutable bookkeeping ids
 * (actor_advisor_id / subject_* ids / row_version), or Auth material
 * (auth_user_id / access_token / refresh_token / service_role / password).
 */
async function assertNoRawAuditPayload(scope: Locator): Promise<void> {
  const body = await scope.innerText();
  const leaked = [
    "new_values",
    "old_values",
    'changes":',
    "actor_advisor_id",
    "subject_student_id",
    "subject_application_id",
    "subject_fellowship_id",
    "auth_user_id",
    "access_token",
    "refresh_token",
    "service_role",
    "row_version",
  ].filter((token) => body.includes(token));
  expect(leaked, `raw audit/Auth material leaked: ${leaked.join(", ")}`).toEqual([]);
}

/** Parse the pagination summary "Showing A–B of C" into its numbers. */
function parseShowing(text: string): { start: number; end: number; total: number } {
  const match = text.match(/Showing\s+(\d+)[\u2013-](\d+)\s+of\s+(\d+)/);
  if (!match) throw new Error(`cannot parse pagination summary: "${text}"`);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/**
 * The shared history ITEM LIST on /activity. The page nests two sections with
 * the same "Recent changes" label (the outer wrapper + EntityHistory), so the
 * list is located by its <ol> to stay unambiguous.
 */
function activityList(page: Page) {
  return page.locator("main section[aria-label='Recent changes'] ol");
}

// ─── Multi-advisor cross-role workflow helpers (R8) ──────────────────────────
// The same deterministic local-only password convention used by the seed
// fixture and the other specs: assembled from harmless fragments so no complete
// password-shaped literal is committed.
const WORKFLOW_PASSWORD = ["E2e", "Local", "Pass", "!", "2026"].join("");

let workflowCounter = 0;
function workflowSuffix(): string {
  workflowCounter += 1;
  return `${Date.now()}-${workflowCounter}`;
}

/** Fill the login form and submit (callers assert the outcome). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Drop the browser session (the session lives in the @supabase/ssr cookie jar). */
async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
}

/**
 * Confirm a lifecycle (archive/restore) action from the open AlertDialog. The
 * confirm control stays disabled until the required non-blank reason is entered
 * (shared R8 lifecycle-reason contract).
 */
async function confirmLifecycleReason(
  page: Page,
  actionName: string,
  reason: string,
): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const reasonBox = dialog.locator("#lifecycle-reason");
  await expect(reasonBox, "the lifecycle reason control is shown").toBeVisible();
  await expect(
    dialog.getByRole("button", { name: actionName }),
    "confirm is disabled until a reason is entered",
  ).toBeDisabled();
  await reasonBox.fill(reason);
  await dialog.getByRole("button", { name: actionName }).click();
  await expect(dialog).toBeHidden();
}

/** Scope to an advisor's card on the management page (heading + controls). */
function advisorCard(page: Page, advisorName: string) {
  return page.getByRole("heading", { name: advisorName, exact: true }).locator("xpath=../../..");
}

/** Authenticated local advisor client for an arbitrary seeded account. */
async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const apiUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return client;
}

/**
 * Seed a synthetic ACTIVE, bound, non-admin advisor ("Advisor B") the same way
 * the trusted server-only provisioning adapter does: an Auth user with a known
 * local password is created first, then `provision_advisor` binds it and writes
 * the admin-attributed `advisor/created` audit event in the same transaction.
 * Returns the advisor id and auth user id.
 */
async function seedWorkflowAdvisor(
  name: string,
  email: string,
): Promise<{ advisorId: number; authUserId: string }> {
  const service = serviceClient();
  const adminAdvisorId = await findActiveAdvisorId();
  const { data: user, error: userError } = await service.auth.admin.createUser({
    email,
    password: WORKFLOW_PASSWORD,
    email_confirm: true,
  });
  if (userError || !user.user) {
    throw new Error(`seed workflow advisor auth user (${email}): ${userError?.message ?? "no user"}`);
  }
  const { data, error } = await service.rpc("provision_advisor", {
    p_actor_id: adminAdvisorId,
    p_advisor_name: name,
    p_email: email,
    p_auth_user_id: user.user.id,
    p_role: "Advisor",
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.advisor_id) {
    await service.auth.admin.deleteUser(user.user.id).catch(() => undefined);
    throw new Error(
      `provision workflow advisor (${email}): ${error?.message ?? "no advisor id returned"}`,
    );
  }
  return { advisorId: row.advisor_id as number, authUserId: user.user.id };
}

/** Remove the synthetic workflow advisor (lock row first, then row, then auth user). */
async function cleanupWorkflowAdvisor(advisorId: number, authUserId: string): Promise<void> {
  const service = serviceClient();
  // A completed role change releases its lock, but clear any lingering lease so
  // the advisor_role_lock FK can never block fixture teardown.
  try {
    await service.from("advisor_role_lock").delete().eq("advisor_id", advisorId);
  } catch {
    /* best-effort: a lingering lock row must never mask the real failure */
  }
  const { error: rowError } = await service.from("advisor").delete().eq("advisor_id", advisorId);
  if (rowError) throw new Error(`cleanup workflow advisor row ${advisorId}: ${rowError.message}`);
  const { error: userError } = await service.auth.admin.deleteUser(authUserId);
  if (userError) throw new Error(`cleanup workflow advisor auth ${authUserId}: ${userError.message}`);
}

/** Seed an isolated synthetic subject student; returns its id. */
async function seedWorkflowStudent(name: string, email: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .insert({
      full_name: name,
      email,
      us_citizen: true,
      is_ch_student: true,
      honors_college: true,
      first_gen: false,
      class_standing: "Junior",
      gpa: 3.4,
      major: "Undeclared",
      gender: "NR",
    })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed workflow student(${email}): ${error.message}`);
  return data.student_id as number;
}

async function deleteWorkflowStudent(studentId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("student").delete().eq("student_id", studentId);
  if (error) throw new Error(`cleanup workflow student ${studentId}: ${error.message}`);
}

async function deleteAdvisingMeeting(meetingId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("advising_meeting").delete().eq("meeting_id", meetingId);
  if (error) throw new Error(`cleanup advising meeting ${meetingId}: ${error.message}`);
}

test.describe("audit history and activity surfaces", () => {
  test.setTimeout(120_000);

  test("a student's unified Activity & Change History merges profile, application, advising, attendance, and scholarship events newest-first", async ({ page }) => {
    const advisor = await activeAdvisorClient();
    const studentId = await findStudentId();
    const original = await readStudentRow(studentId);
    const originalMajor = String(original.major ?? "");
    const uniqueMajor = `${originalMajor} · E2E profile ${Date.now()}`;

    try {
      // One real profile write: the versioned writer audits it and names the
      // active advisor as the actor, with a normalized Major change.
      await writeStudentProfile(advisor, studentId, uniqueMajor);

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

      // ── Unified subject-student timeline (profile + application + advising
      //    + attendance + scholarship all audited to subject_student_id) ──────
      const history = main.locator("section[aria-label='Activity & Change History']");
      await expect(history.getByRole("heading", { name: "Activity & Change History" })).toBeVisible();

      // Every audited category for the seeded student is present with the
      // student's name as the subject.
      const categoryRows: [string, RegExp][] = [
        ["profile", /Created student/],
        ["application", /Created application/],
        ["advising", /Created advising meeting/],
        ["attendance", /Created fellowship thursday/],
        ["scholarship", /Created scholarship history/],
      ];
      for (const [category, pattern] of categoryRows) {
        const row = history.locator("li", { hasText: pattern });
        await expect(row, `${category} history row`).toHaveCount(1);
        await expect(row).toContainText(STUDENT_NAME);
      }

      // The newest event is the advisor-authored profile update, above the
      // seeded creation, with friendly (not raw) field changes.
      const updatedRow = history.locator("li", { hasText: /Updated student/ });
      await expect(updatedRow).toContainText(STUDENT_NAME);
      await expect(updatedRow).toContainText(`By ${ACTIVE_ADVISOR_NAME}`);
      await expect(updatedRow).toContainText("Major");
      await expect(updatedRow).toContainText(originalMajor);
      await expect(updatedRow).toContainText(uniqueMajor);

      // Newest-first chronology (comparing rendered TEXT keeps markup-tag
      // splitting between the action label and the entity label out of scope).
      const items = await history.locator("li").allTextContents();
      const updatedIndex = items.findIndex((text) => text.includes("Updated student:"));
      const createdIndex = items.findIndex((text) => text.includes("Created student:"));
      expect(updatedIndex).toBeGreaterThan(-1);
      expect(createdIndex).toBeGreaterThan(updatedIndex);

      // ── Dedicated operational sections remain beside the unified history ───
      await expect(main.getByText("Advising Meetings").first()).toBeVisible();
      const advisingSection = main.locator("section", { hasText: "Advising history" });
      await expect(
        advisingSection.locator("article", { hasText: "E2E seeded advising session" }),
      ).toBeVisible();
      await expect(main.getByText("Fellowship Thursday").first()).toBeVisible();
      await expect(main.getByText("Scholarship History").first()).toBeVisible();

      // ── The Recent Activity timeline still merges application + advising ──
      const timeline = main
        .getByText("Recent Activity", { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'app-panel')][1]");
      await expect(timeline).toBeVisible();
      await expect(timeline.getByText("Advising meeting", { exact: true })).toBeVisible();
      await expect(
        timeline.getByText(`${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`, { exact: true }),
      ).toBeVisible();

      // ── Privacy: no raw audit JSON, bookkeeping ids, or Auth material ──────
      await assertNoRawAuditPayload(main);
    } finally {
      await restoreStudentMajor(advisor, studentId, originalMajor).catch((err: unknown) => {
        // Cleanup must never mask the test's real failure.
        console.warn(`activity.spec profile restore failed: ${String(err)}`);
      });
      await advisor.auth.signOut();
    }
  });

  test("the global activity log paginates a complete dataset, filters precisely, and orders deterministically", async ({ page }) => {
    const advisor = await activeAdvisorClient();
    const studentId = await findStudentId();
    // Push the audit volume past the 25-row first page with real versioned
    // profile writes (each audited once, acted by the active advisor). 25
    // writes over the seed's ~15 events guarantee a second page.
    const PAGE_OVERFLOW_WRITES = 25;
    const original = await readStudentRow(studentId);
    const originalMajor = String(original.major ?? "");
    const today = new Date().toISOString().slice(0, 10);

    try {
      for (let i = 0; i < PAGE_OVERFLOW_WRITES; i += 1) {
        await writeStudentProfile(
          advisor,
          studentId,
          `${originalMajor} · E2E activity ${Date.now()}-${i}`,
        );
      }

      await signInAsActive(page);
      await page.goto("/activity");

      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Recent changes" })).toBeVisible();

      // ── The complete filter surface is exposed with accessible labels ──────
      await expect(page.getByLabel(/^Record type/)).toBeVisible();
      await expect(page.getByLabel(/^Change/)).toBeVisible();
      await expect(page.getByLabel(/^Actor/)).toBeVisible();
      await expect(page.getByLabel(/^Student/)).toBeVisible();
      await expect(page.getByLabel(/^Fellowship/)).toBeVisible();
      await expect(page.getByLabel(/^From/)).toBeVisible();
      await expect(page.getByLabel(/^Through/)).toBeVisible();

      // ── Page 1: the newest 25 events, fully server-rendered ────────────────
      const pagination = page.locator("nav[aria-label='Pagination']");
      const showing = parseShowing(await pagination.getByText(/Showing/).innerText());
      expect(showing.total).toBeGreaterThan(25);
      await expect(activityList(page).locator("li")).toHaveCount(Math.min(showing.total, 25));
      await expect(page.getByText(/Page 1 of [2-9]\d*/)).toBeVisible();

      // Newest first: the generated "Updated student" writes top the page.
      await expect(activityList(page).locator("li").first()).toContainText("Updated student");

      // The seeded fellowship's creation is OLD (advisors, then fellowships),
      // so it sits beyond the initial page.
      await expect(activityList(page).locator("li", { hasText: FELLOWSHIP_NAME })).toHaveCount(0);

      // ── Deterministic order: reloading yields the identical sequence ───────
      const pageOneText = await activityList(page).locator("li").allTextContents();
      await page.reload();
      await expect(activityList(page).locator("li")).toHaveCount(Math.min(showing.total, 25));
      expect(await activityList(page).locator("li").allTextContents()).toEqual(pageOneText);

      // ── Page 2: reaches the seeded fellowship's creation event ─────────────
      const next = page.getByRole("link", { name: "Next" });
      await expect(next).toBeVisible();
      await next.click();
      await expect(page).toHaveURL(/page=2/);
      await expect(page.getByText(/Page 2 of \d+/)).toBeVisible();
      await expect(activityList(page).locator("li", { hasText: FELLOWSHIP_NAME })).toHaveCount(1);
      const pageTwoText = await activityList(page).locator("li").allTextContents();
      await page.reload();
      expect(await activityList(page).locator("li").allTextContents()).toEqual(pageTwoText);

      // ── Page-size contract: 100 rows per page renders the bounded range ────
      await page.goto("/activity?page=1&pageSize=100");
      await expect(page.getByLabel("Rows per page", { exact: true })).toHaveValue("100");
      const wideShowing = parseShowing(
        await page.locator("nav[aria-label='Pagination']").getByText(/Showing/).innerText(),
      );
      await expect(activityList(page).locator("li")).toHaveCount(
        Math.min(wideShowing.total, 100),
      );

      // ── Complete filters ───────────────────────────────────────────────────
      // Record type: proves filtering finds events beyond the initial page.
      await page.goto("/activity");
      await page.getByLabel(/^Record type/).selectOption({ label: "Fellowship" });
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/entity=fellowship/);
      await expect(activityList(page).locator("li", { hasText: FELLOWSHIP_NAME })).toHaveCount(1);
      await expect(activityList(page).locator("li", { hasText: /student:/ })).toHaveCount(0);
      const entityShowing = parseShowing(await pagination.getByText(/Showing/).innerText());
      expect(entityShowing.total).toBeLessThan(25);

      // Change: every visible row reflects ONLY the selected action.
      await page.getByRole("link", { name: "Clear" }).click();
      await expect(page).toHaveURL(/\/activity$/);
      await page.getByLabel(/^Change/).selectOption({ label: "Updated" });
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/action=updated/);
      const actionRows = activityList(page).locator("li");
      await expect(actionRows.first()).toBeVisible();
      for (const row of await actionRows.all()) {
        await expect(row).toContainText("Updated");
      }

      // Actor: only the active advisor's own audited writes remain.
      await page.getByRole("link", { name: "Clear" }).click();
      await page.getByLabel(/^Actor/).fill(ACTIVE_ADVISOR_NAME);
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/actor=/);
      const actorRows = activityList(page).locator("li");
      for (const row of await actorRows.all()) {
        await expect(row).toContainText(`By ${ACTIVE_ADVISOR_NAME}`);
      }

      // Student: subject-student rows only, all naming the seeded student.
      await page.getByRole("link", { name: "Clear" }).click();
      await page.getByLabel(/^Student/).fill(STUDENT_NAME);
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/student=/);
      const studentRows = activityList(page).locator("li");
      for (const row of await studentRows.all()) {
        await expect(row).toContainText(STUDENT_NAME);
      }

      // Date range: today's events (all generated writes) are included.
      await page.getByRole("link", { name: "Clear" }).click();
      await page.getByLabel(/^From/).fill(today);
      await page.getByLabel(/^Through/).fill(today);
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/from=/);
      await expect(page).toHaveURL(/to=/);
      await expect(activityList(page).locator("li").first()).toContainText("Updated student");

      // ── Privacy: raw JSON / secrets never reach the rendered page ──────────
      // The /activity page renders its own <main> inside the dashboard shell's
      // <main>, so the page's content main is the LAST one in DOM order.
      await assertNoRawAuditPayload(page.locator("main").last());
    } finally {
      await restoreStudentMajor(advisor, studentId, originalMajor).catch((err: unknown) => {
        console.warn(`activity.spec profile restore failed: ${String(err)}`);
      });
      await advisor.auth.signOut();
    }
  });

  test("an application row exposes a View history action with an accessible, privacy-guarded dialog", async ({ page }) => {
    await signInAsActive(page);
    await page.goto("/applications");

    // The seeded application row (student ↔ fellowship, explicit cycle).
    const appRow = page
      .locator("table tbody tr", { hasText: STUDENT_NAME })
      .filter({ hasText: FELLOWSHIP_NAME })
      .first();
    await expect(appRow).toBeVisible();

    const viewHistoryButton = appRow.getByRole("button", {
      name: "View application history",
    });
    await expect(viewHistoryButton).toBeVisible();
    await viewHistoryButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Application history" })).toBeVisible();
    await expect(dialog).toContainText("Sensitive values are not shown.");
    await expect(dialog.getByRole("heading", { name: "Changes" })).toBeVisible();

    // The application-scoped trail shows the seeded creation for this
    // application, newest-first, attributed to the System seed write.
    const createdAppRow = dialog.locator("li", { hasText: /Created application/ });
    await expect(createdAppRow).toContainText(STUDENT_NAME);
    await expect(createdAppRow).toContainText("By System");

    // Privacy: the dialog payload stays normalized (no raw JSON / secrets).
    await assertNoRawAuditPayload(dialog);

    // Close and reopen remains stable (the dialog caches its loaded trail).
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await viewHistoryButton.click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Changes" })).toBeVisible();
  });

  test("fellowship and advisor records expose normalized change history with no raw payloads", async ({ page }) => {
    const [fellowshipId, advisorId] = await Promise.all([findFellowshipId(), findActiveAdvisorId()]);

    await signInAsActive(page);

    // ── Fellowship change history ────────────────────────────────────────────
    await page.goto(`/fellowships/${fellowshipId}`);
    await expect(page.getByText("Program Detail", { exact: true })).toBeVisible();
    const fellowshipHistory = page.locator("main section[aria-label='Fellowship change history']");
    await expect(
      fellowshipHistory.getByRole("heading", { name: "Fellowship change history" }),
    ).toBeVisible();
    await expect(fellowshipHistory.locator("li", { hasText: "Created fellowship" })).toContainText(
      FELLOWSHIP_NAME,
    );
    await expect(fellowshipHistory.locator("li").first()).toContainText("By");

    // ── Advisor change history ───────────────────────────────────────────────
    await page.goto(`/advisors/${advisorId}`);
    await expect(page.getByText("Advisor Record", { exact: true })).toBeVisible();
    const advisorHistory = page.locator("main section[aria-label='Advisor change history']");
    await expect(
      advisorHistory.getByRole("heading", { name: "Advisor change history" }),
    ).toBeVisible();
    await expect(advisorHistory.locator("li", { hasText: "Created advisor" })).toHaveCount(1);

    // ── Privacy: the seeded advisor record never leaks its Auth binding or the
    //    raw audit bookkeeping, even on the advisor detail page. ─────────────
    await assertNoRawAuditPayload(page.locator("main"));
  });

  test("a multi-advisor workflow keeps attributed, ordered history with lifecycle and promotion reasons, and rejects direct audit deletion", async ({ page }) => {
    test.setTimeout(180_000);

    const suffix = workflowSuffix();
    const advisorBName = `E2E Advisor B ${suffix}`;
    const advisorBEmail = `e2e-advisor-b-${suffix}@example.com`;
    const studentName = `E2E Workflow Student ${suffix}`;
    const studentEmail = `e2e-workflow-student-${suffix}@example.com`;
    const meetingNote = `E2E workflow advising ${suffix}`;
    const correctionReason = `E2E workflow correction ${suffix}`;
    const correctionDetails = `E2E workflow correction details ${suffix}`;
    const archiveReason = `E2E workflow archive ${suffix}`;
    const restoreReason = `E2E workflow restore ${suffix}`;
    const promotionReason = `E2E workflow promotion ${suffix}`;
    // Distinct majors prove the two advisors' updates carry different, friendly
    // before/after snapshots on the shared student timeline.
    const majorB = `Workflow B ${suffix}`;
    const majorA = `Workflow A ${suffix}`;

    const service = serviceClient();
    const adminClient = await activeAdvisorClient();
    const advisorB = await seedWorkflowAdvisor(advisorBName, advisorBEmail);
    const advisorBClient = await signedInClient(advisorBEmail, WORKFLOW_PASSWORD);
    const studentId = await seedWorkflowStudent(studentName, studentEmail);
    let meetingId: number | null = null;

    try {
      // ── Advisor B creates history: an advising meeting logged via the UI ────
      await signIn(page, advisorBEmail, WORKFLOW_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/);
      await page.goto("/advising");
      await page.getByRole("button", { name: "Log Meeting" }).click();
      const meetingDialog = page.getByRole("dialog");
      await meetingDialog.locator("#student-search").fill(studentName);
      await meetingDialog.getByRole("button", { name: studentName, exact: true }).click();
      await meetingDialog.locator("#meeting_date").fill("2026-09-02");
      await meetingDialog.locator("#meeting_mode").click();
      await page.getByRole("option", { name: "In-Person", exact: true }).click();
      await meetingDialog.locator("#notes").fill(meetingNote);
      await meetingDialog.getByRole("button", { name: "Log Meeting" }).click();
      await expect(page.getByText("Meeting recorded successfully.", { exact: true })).toBeVisible();

      // The meeting is conducted AND recorded by Advisor B (audit attribution).
      const { data: meeting, error: meetingError } = await service
        .from("advising_meeting")
        .select("meeting_id, advisor_id, created_by_advisor_id")
        .eq("notes", meetingNote)
        .single();
      if (meetingError) throw new Error(`read workflow meeting: ${meetingError.message}`);
      meetingId = meeting.meeting_id as number;
      expect(meeting.advisor_id).toBe(advisorB.advisorId);
      expect(meeting.created_by_advisor_id).toBe(advisorB.advisorId);

      // ── Advisor B corrects history: Add Correction on the meeting via UI ────
      await page.goto(`/students/${studentId}`);
      await expect(page.getByRole("heading", { name: studentName })).toBeVisible({
        timeout: 15_000,
      });
      const meetingArticle = page
        .locator("main section", { hasText: "Advising history" })
        .locator("article", { hasText: meetingNote });
      await expect(meetingArticle).toBeVisible();
      await meetingArticle.getByRole("button", { name: "Add Correction" }).click();
      const correctionDialog = page.getByRole("dialog");
      await correctionDialog.locator('input[id^="correction-reason-"]').fill(correctionReason);
      await correctionDialog.locator('textarea[id^="correction-details-"]').fill(correctionDetails);
      await correctionDialog.getByRole("button", { name: "Add Correction" }).click();
      await expect(correctionDialog).toBeHidden();

      // ── Both advisors update the same student through the versioned writer ──
      // Advisor B's update lands first; the Admin's update is the newest.
      await writeStudentProfile(advisorBClient, studentId, majorB);
      await writeStudentProfile(adminClient, studentId, majorA);

      // ── The Admin archives and restores the student through the UI, with a
      //    required reason for each transition ─────────────────────────────────
      await signOut(page);
      await signIn(page, ACTIVE_EMAIL, ACTIVE_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/);

      await page.goto("/students");
      const activeRow = page.locator("table tbody tr", { hasText: studentName });
      await expect(activeRow).toBeVisible();
      await activeRow.getByRole("button", { name: "Archive Student" }).click();
      await confirmLifecycleReason(page, "Archive Student", archiveReason);

      await page.goto("/students?view=archived");
      const archivedRow = page.locator("table tbody tr", { hasText: studentName });
      await expect(archivedRow).toBeVisible();
      await archivedRow.getByRole("button", { name: "Restore Student" }).click();
      await confirmLifecycleReason(page, "Restore Student", restoreReason);

      // ── The Admin promotes Advisor B through the UI, with a reason ─────────
      await page.goto("/advisors");
      const card = advisorCard(page, advisorBName);
      await expect(card).toBeVisible();
      await page.locator(`#role-${advisorB.advisorId}`).click();
      await page.getByRole("option", { name: "Admin", exact: true }).click();
      const roleDialog = page.getByRole("alertdialog");
      const roleConfirm = roleDialog.getByRole("button", { name: "Change to Admin" });
      await expect(roleConfirm).toBeDisabled();
      await roleDialog.locator("#advisor-role-reason").fill(promotionReason);
      await expect(roleConfirm).toBeEnabled();
      await roleConfirm.click();
      await expect
        .poll(
          async () => {
            const { data } = await service
              .from("advisor")
              .select("role")
              .eq("advisor_id", advisorB.advisorId)
              .maybeSingle();
            return data?.role;
          },
          { timeout: 10_000 },
        )
        .toBe("Admin");

      // ── Role history: the promotion reason is attributed to the Admin ──────
      await page.goto(`/advisors/${advisorB.advisorId}`);
      const advisorHistory = page.locator("main section[aria-label='Advisor change history']");
      await expect(
        advisorHistory.getByRole("heading", { name: "Advisor change history" }),
      ).toBeVisible();
      const roleRow = advisorHistory.locator("li", { hasText: /Role Changed/ });
      await expect(roleRow).toContainText(promotionReason);
      await expect(roleRow).toContainText(`By ${ACTIVE_ADVISOR_NAME}`);
      // Provisioning was performed by the Admin (admin-attributed creation).
      await expect(
        advisorHistory.locator("li", { hasText: /Created advisor/ }).filter({
          hasText: `By ${ACTIVE_ADVISOR_NAME}`,
        }),
      ).toHaveCount(1);

      // ── The unified subject-student timeline merges every category with
      //    actor attribution and newest-first ordering ─────────────────────────
      await page.goto(`/students/${studentId}`);
      await expect(page.getByRole("heading", { name: studentName })).toBeVisible({
        timeout: 15_000,
      });
      const history = page.locator("main section[aria-label='Activity & Change History']");
      await expect(
        history.getByRole("heading", { name: "Activity & Change History" }),
      ).toBeVisible();

      // Advisor B authored an advising creation and a correction.
      await expect(
        history
          .locator("li", { hasText: /Created advising meeting/ })
          .filter({ hasText: `By ${advisorBName}` }),
      ).toHaveCount(1);
      await expect(
        history
          .locator("li", { hasText: /Correction Added advising meeting amendment/ })
          .filter({ hasText: `By ${advisorBName}` }),
      ).toHaveCount(1);

      // Both advisors updated the SAME student; each update keeps its own actor
      // and friendly Major before/after values.
      const updatedByB = history
        .locator("li", { hasText: /Updated student/ })
        .filter({ hasText: `By ${advisorBName}` });
      await expect(updatedByB).toHaveCount(1);
      await expect(updatedByB).toContainText("Major");
      await expect(updatedByB).toContainText(majorB);
      const updatedByAdmin = history
        .locator("li", { hasText: /Updated student/ })
        .filter({ hasText: `By ${ACTIVE_ADVISOR_NAME}` });
      await expect(updatedByAdmin).toHaveCount(1);
      await expect(updatedByAdmin).toContainText(majorB);
      await expect(updatedByAdmin).toContainText(majorA);

      // Lifecycle transitions keep their required reasons and Admin attribution.
      const archivedEvent = history.locator("li", { hasText: /Archived student/ });
      await expect(archivedEvent).toContainText(archiveReason);
      await expect(archivedEvent).toContainText(`By ${ACTIVE_ADVISOR_NAME}`);
      const restoredEvent = history.locator("li", { hasText: /Restored student/ });
      await expect(restoredEvent).toContainText(restoreReason);
      await expect(restoredEvent).toContainText(`By ${ACTIVE_ADVISOR_NAME}`);

      // Newest-first chronology across the whole merged timeline.
      const timelineItems = await history.locator("li").allTextContents();
      const at = (needle: string) => timelineItems.findIndex((text) => text.includes(needle));
      expect(at("Restored student")).toBeGreaterThan(-1);
      expect(at("Restored student")).toBeLessThan(at("Archived student"));
      expect(at("Archived student")).toBeLessThan(at("Correction Added"));
      expect(at("Correction Added")).toBeLessThan(at("Created advising meeting"));
      expect(at("Created advising meeting")).toBeLessThan(at("Created student"));

      // Privacy: the merged timeline never renders raw payloads or Auth material.
      await assertNoRawAuditPayload(page.locator("main"));

      // ── Activity: the same history is server-paginated, filtered and ordered ─
      await page.goto("/activity");
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await page.getByLabel(/^Student/).fill(studentName);
      await page.getByRole("button", { name: "Apply filters" }).click();
      // The filter form submits its empty companion fields, so the first
      // response is "dirty" and the server canonicalizes with an explicit
      // page/pageSize redirect. Wait for that FINAL URL before reading the list.
      await expect(page).toHaveURL(/student=/);
      await expect(page).toHaveURL(/pageSize=25/);

      const list = activityList(page);
      await expect(list.locator("li").first()).toBeVisible();
      const ordered = await list.locator("li").allTextContents();
      const oAt = (needle: string) => ordered.findIndex((text) => text.includes(needle));
      expect(oAt("Restored student")).toBeGreaterThan(-1);
      expect(oAt("Restored student")).toBeLessThan(oAt("Archived student"));
      expect(oAt("Archived student")).toBeLessThan(oAt("Updated student"));
      expect(oAt("Correction Added")).toBeLessThan(oAt("Created advising meeting"));
      expect(oAt("Created student")).toBeGreaterThan(oAt("Updated student"));
      await expect(list.locator("li", { hasText: /Archived student/ })).toContainText(archiveReason);
      await expect(list.locator("li", { hasText: /Restored student/ })).toContainText(restoreReason);

      // Actor filter: every remaining row is Advisor B's own audited write.
      await page.getByRole("link", { name: "Clear" }).click();
      await expect(page).toHaveURL(/\/activity$/);
      await page.getByLabel(/^Actor/).fill(advisorBName);
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/actor=/);
      await expect(page).toHaveURL(/pageSize=25/);
      const actorRows = list.locator("li");
      await expect(actorRows.first()).toBeVisible();
      for (const row of await actorRows.all()) {
        await expect(row).toContainText(`By ${advisorBName}`);
      }

      // Privacy: the Activity page payload stays normalized end-to-end.
      await assertNoRawAuditPayload(page.locator("main").last());

      // ── Direct authenticated audit deletion is rejected and removes nothing ─
      const { data: target, error: targetError } = await service
        .from("audit_event")
        .select("audit_id")
        .eq("entity_type", "advising_meeting")
        .eq("entity_id", meetingId)
        .eq("action", "created")
        .single();
      if (targetError) throw new Error(`read audit target: ${targetError.message}`);

      // The authenticated session CAN read its own audit history (proving it is
      // a real, permitted client rather than a broken/anon one)...
      const { data: visible, error: visibleError } = await adminClient
        .from("audit_event")
        .select("audit_id")
        .eq("audit_id", target.audit_id)
        .single();
      expect(visibleError).toBeNull();
      expect(visible?.audit_id).toBe(target.audit_id);

      // ...but the direct DELETE is refused at the grant boundary (no DELETE
      // grant) and the immutable row survives.
      const { error: deleteError } = await adminClient
        .from("audit_event")
        .delete()
        .eq("audit_id", target.audit_id);
      expect(deleteError?.code, "authenticated audit DELETE denial code").toBe("42501");

      const { data: survived, error: survivedError } = await service
        .from("audit_event")
        .select("audit_id")
        .eq("audit_id", target.audit_id)
        .single();
      expect(survivedError).toBeNull();
      expect(survived?.audit_id).toBe(target.audit_id);
    } finally {
      // Fixture teardown is service-role only and never touches the seeded
      // baseline. Child rows first, then the subject student, then the advisor.
      if (meetingId !== null) {
        try {
          await service
            .from("advising_meeting_amendment")
            .delete()
            .eq("meeting_id", meetingId)
            .in("reason", [correctionReason]);
        } catch (err) {
          console.warn(`workflow amendment cleanup: ${String(err)}`);
        }
        await deleteAdvisingMeeting(meetingId).catch((err: unknown) =>
          console.warn(`workflow meeting cleanup: ${String(err)}`),
        );
      }
      // Never leave the synthetic student archived for later specs.
      try {
        await service
          .from("student")
          .update({ archived_at: null })
          .eq("student_id", studentId);
      } catch (err) {
        console.warn(`workflow archive reset: ${String(err)}`);
      }
      await deleteWorkflowStudent(studentId).catch((err: unknown) =>
        console.warn(`workflow student cleanup: ${String(err)}`),
      );
      await cleanupWorkflowAdvisor(advisorB.advisorId, advisorB.authUserId).catch((err: unknown) =>
        console.warn(`workflow advisor cleanup: ${String(err)}`),
      );
      await advisorBClient.auth.signOut().catch(() => undefined);
      await adminClient.auth.signOut().catch(() => undefined);
    }
  });

  test("an authenticated advisor session cannot directly delete audit history", async () => {
    const advisor = await activeAdvisorClient();
    const service = serviceClient();
    try {
      // A real, recent audit row exists and is readable by the authenticated
      // staff read model.
      const { data: target, error: readError } = await service
        .from("audit_event")
        .select("audit_id")
        .order("audit_id", { ascending: false })
        .limit(1)
        .single();
      if (readError) throw new Error(`read audit target: ${readError.message}`);

      const { error: visibleError } = await advisor
        .from("audit_event")
        .select("audit_id")
        .eq("audit_id", target.audit_id)
        .single();
      expect(visibleError).toBeNull();

      const { error: deleteError } = await advisor
        .from("audit_event")
        .delete()
        .eq("audit_id", target.audit_id);
      expect(deleteError?.code, "authenticated audit DELETE denial code").toBe("42501");

      const { data: survived, error: survivedError } = await service
        .from("audit_event")
        .select("audit_id")
        .eq("audit_id", target.audit_id)
        .single();
      expect(survivedError).toBeNull();
      expect(survived?.audit_id).toBe(target.audit_id);
    } finally {
      await advisor.auth.signOut().catch(() => undefined);
    }
  });
});