/**
 * tests/contract/rls.test.ts
 *
 * RLS security contract for the steady state produced by the migration chain
 * through 20260318000001_advisor_self_activation_lockdown.sql:
 *
 *   - anon (unauthenticated) role is denied on every table at the schema
 *     level, asserted against seeded REAL rows (error code 42501, or a
 *     zero-row filter with a service-role re-read proving the target row is
 *     hidden/unchanged — never a nonexistent id); a blocked read is always
 *     proven by a service-role re-read that the seeded real row exists
 *     (R4: 0 rows alone never counts as blocked);
 *   - an advisor row is readable only by its own pre-bound user
 *     (`auth_user_id = auth.uid()`) or by active staff (amendment A1): an
 *     unbound, email-matched account — active or inactive — reads ZERO
 *     advisor rows and no PII (regression row 25), proven by a service-role
 *     re-read that the seeded row still exists; pre-bound active self-read
 *     (26), pre-bound inactive self-read (27), and active-staff reads of any
 *     advisor row (28) are preserved;
 *   - a non-active advisor has NO direct UPDATE path on advisor rows:
 *     authorization-field mutations (`is_active`, `role`, `email`,
 *     `auth_user_id`) are denied against real rows and the row is proven
 *     unchanged by a service-role re-read. The core escalation — a single
 *     UPDATE mixing identity binding with `is_active = true` / `role`
 *     elevation — is rejected in full;
 *   - identity binding is ADMIN-ONLY (R11): an administrator pre-binds
 *     `advisor.auth_user_id` to the invited account's user id before first
 *     sign-in. There is NO self-link RPC (`link_current_advisor` is removed
 *     and never created), so an authenticated account whose email matches an
 *     unlinked `advisor` row can never claim, bind, or take over that identity
 *     (pre-existing-matching-account takeover, row 8);
 *   - pre-bound active advisors retain shared staff CRUD on EVERY operational
 *     table (`student`, `fellowship`, `application`, `advising_meeting`,
 *     `fellowship_thursday`, `scholarship_history`) and on advisor rows
 *     (insert/read/update/delete), unchanged from migration ...004;
 *   - pre-bound inactive advisors and authenticated users with no advisor row
 *     are blocked from operational data;
 *   - advisor email identity is case-normalized (R11, regression row 15): a
 *     case-variant duplicate advisor email is rejected by the unique
 *     `lower(email)` index, and a case-variant account has no claim/bind path;
 *   - the invoker-security `BEFORE INSERT OR UPDATE OF auth_user_id` trigger
 *     (rows 16–24, official research) makes `auth_user_id` a one-time bind: an
 *     unbound advisor row (`auth_user_id` NULL) may be INSERTed by ordinary
 *     active staff (row 22, row re-read proves the created row is unbound);
 *     the trusted `service_role`/DBA NULL→non-NULL bind succeeds once (row 18)
 *     and a trusted bound INSERT succeeds (row 24, row re-read proves the
 *     provisioned uuid); authenticated non-NULL INSERTs are rejected (row 23,
 *     absence re-read proves no row was created); trusted replaces/rebinds and
 *     clears are rejected (rows 19–20); every authenticated
 *     bind/replace/clear — including active-staff rebinding of another
 *     advisor's row (row 16) — is rejected (row 21); and the conditional
 *     provisioning path never re-binds a bound row (row 17). Every denied
 *     transition is proven by a service-role row-intactness re-read or absence
 *     proof, and active-staff updates to other advisor columns stay intact
 *     (incl. a no-op update that carries the current binding unchanged);
 *   - service-role access is never asserted as a feature; it is used only to
 *     seed local synthetic fixtures, create local auth users, re-read rows to
 *     prove "denied + unchanged", and simulate ADMIN PRE-BINDING (the only
 *     legitimate way `auth_user_id` is ever written).
 *
 * Regression proof (R2): the direct self-binding and the mixed
 * self-link+escalation assertions fail on the vulnerable chain (migrations
 * ...000–...004) and pass after the remediation migration. The standalone
 * sensitive-field denials (is_active/role/email without a binding) are
 * green-only — already denied by the vulnerable WITH CHECK — and the
 * red/green obligation is limited to direct binding (row 4), combined
 * binding+escalation (row 5), and the pre-existing-matching-account takeover
 * (row 8). The unbound email-match self-read denial (row 25, amendment A1)
 * is additionally red-capable — the vulnerable email-match SELECT branch
 * returns the row — and passes only after the SELECT-policy replacement. The
 * red run's failure output is recorded as evidence by the parent.
 *
 * Policy: if any assertion fails, this suite fails loudly and the lane still
 * tears down the local instance. Migrations/RLS are NOT modified here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAnonClient, createServiceRoleClient, getContractEnv } from "./helpers/setup";
import {
  createAuthUser,
  seedCoreFixtures,
  signInWithPassword,
  syntheticEmail,
  syntheticName,
  type SeededCore,
} from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);

const TABLES = [
  "advisor",
  "fellowship",
  "student",
  "application",
  "advising_meeting",
  "fellowship_thursday",
  "scholarship_history",
] as const;

const ID_COLUMN: Record<(typeof TABLES)[number], string> = {
  advisor: "advisor_id",
  fellowship: "fellowship_id",
  student: "student_id",
  application: "application_id",
  advising_meeting: "meeting_id",
  fellowship_thursday: "attendance_id",
  scholarship_history: "history_id",
};

/** Minimal plausible payloads; irrelevant once anon is denied at schema level. */
const INSERT_PAYLOADS: Record<(typeof TABLES)[number], Record<string, unknown>> = {
  advisor: { advisor_name: "Contract Anon", email: "contract-anon@example.com", is_active: false },
  fellowship: { fellowship_name: "Contract Anon Fellowship" },
  student: { full_name: "Contract Anon Student", email: "contract-anon-student@example.com", us_citizen: true },
  application: { student_id: 1, fellowship_id: 1, stage_of_application: "Started" },
  advising_meeting: { student_id: 1, meeting_date: "2026-01-01", meeting_mode: "Virtual" },
  fellowship_thursday: { student_id: 1, attended: true },
  scholarship_history: { student_id: 1, fellowship_id: 1 },
};

const UPDATE_PAYLOADS: Record<(typeof TABLES)[number], Record<string, unknown>> = {
  advisor: { advisor_name: "Contract Anon Renamed" },
  fellowship: { fellowship_name: "Contract Anon Renamed" },
  student: { full_name: "Contract Anon Renamed" },
  application: { stage_of_application: "Submitted" },
  advising_meeting: { meeting_mode: "In-Person" },
  fellowship_thursday: { attended: false },
  scholarship_history: { student_id: 1 },
};

/** The six operational tables shared by active staff (row 11). */
const OPERATIONAL_TABLES = [
  "student",
  "fellowship",
  "application",
  "advising_meeting",
  "fellowship_thursday",
  "scholarship_history",
] as const;
type OperationalTable = (typeof OPERATIONAL_TABLES)[number];

/** Insert payload for one active-staff CRUD cycle on an operational table. */
function operationalInsertPayload(table: OperationalTable): Record<string, unknown> {
  switch (table) {
    case "student":
      return { full_name: syntheticName("crud-student"), email: syntheticEmail("crud-student"), us_citizen: true };
    case "fellowship":
      return { fellowship_name: syntheticName("crud-fellowship") };
    case "application":
      return {
        student_id: fixtures.studentId,
        fellowship_id: fixtures.fellowshipId,
        stage_of_application: "Started",
      };
    case "advising_meeting":
      return { student_id: fixtures.studentId, meeting_date: "2026-09-20", meeting_mode: "Virtual" };
    case "fellowship_thursday":
      return { student_id: fixtures.studentId, attended: true, source_info: "OCF" };
    case "scholarship_history":
      return { student_id: fixtures.studentId, fellowship_id: fixtures.fellowshipId };
  }
}

/** Update payload for one active-staff CRUD cycle on an operational table. */
function operationalUpdatePayload(table: OperationalTable): Record<string, unknown> {
  switch (table) {
    case "student":
      return { major: "Chemistry" };
    case "fellowship":
      return { fellowship_name: syntheticName("crud-fellowship-renamed") };
    case "application":
      return { stage_of_application: "Under Review" };
    case "advising_meeting":
      return { meeting_mode: "In-Person" };
    case "fellowship_thursday":
      return { attended: false };
    case "scholarship_history":
      return { student_id: fixtures.studentId };
  }
}

let fixtures: SeededCore;
let selfUserId: string;
let inactiveUserId: string;
let noAdvisorUserId: string;
let selfClient: SupabaseClient;
let inactiveClient: SupabaseClient;
let noAdvisorClient: SupabaseClient;

// Dedicated rows for the escalation-denial matrix (rows 1–5). Each has its own
// auth user so a red-run mutation of one row never cascades into another test.
// These rows are ADMIN-UNLINKED (auth_user_id NULL) — the email-matched account
// must never be able to bind them (rows 4, 5, 8).
let escalationInactiveId: number;
let escalationInactiveUserId: string;
let escalationInactiveClient: SupabaseClient;
let escalationActiveId: number;
let escalationActiveUserId: string;
let escalationActiveClient: SupabaseClient;

// Independent inactive-unlinked row for the combined bind/is_active/role
// regression: deliberately separate from `escalationInactiveId` so the mixed
// single-UPDATE escalation (row 5) is proven against a pristine row even after
// a red-run mutation of the rows used by rows 1–4.
let escalationInactiveCombinedId: number;
let escalationInactiveCombinedUserId: string;
let escalationInactiveCombinedClient: SupabaseClient;

// One-time-bind trigger matrix (rows 17–21): a dedicated unbound advisor row
// plus its synthetic auth account, so the trusted initial bind (row 18) and
// the rebind/clear denials (rows 19–20) run against a row no other assertion
// touches.
let triggerUnboundId: number;
let triggerUserId: string;

function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Service-role re-read of a row; used to prove "denied + unchanged". */
async function readRow(
  table: (typeof TABLES)[number],
  idColumn: string,
  id: number
): Promise<Record<string, unknown> | null> {
  const { data, error } = await service
    .from(table)
    .select("*")
    .eq(idColumn, id)
    .maybeSingle();
  if (error) throw new Error(`service re-read ${table}.${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

/**
 * Prove a mutation is denied against a REAL row: either a 42501 permission
 * error (RLS) or a P0001 raise_exception (the invoker-security trigger's
 * fail-closed denial), or a zero-row RLS filter, and — in every case — a
 * service-role re-read proving the row is byte-for-byte unchanged (R4).
 * `realId` is always a seeded real row's id, never a sentinel like -1.
 * `allowedErrorCodes` defaults to `["42501"]`; trigger-backed denials pass
 * `["42501", "P0001"]`.
 */
async function assertMutationBlocked(
  client: SupabaseClient,
  table: (typeof TABLES)[number],
  idColumn: string,
  realId: number,
  payload: Record<string, unknown>,
  allowedErrorCodes: string[] = ["42501"]
): Promise<void> {
  const before = await readRow(table, idColumn, realId);
  expect(before).not.toBeNull();

  const { data, error } = await client
    .from(table)
    .update(payload)
    .eq(idColumn, realId)
    .select("*");

  if (error) {
    expect(allowedErrorCodes, `${table} update error code`).toContain(error.code);
  } else {
    // RLS-filtered no-op: the row was not visible for update.
    expect(data ?? [], `${table} update affected rows`).toHaveLength(0);
  }

  const after = await readRow(table, idColumn, realId);
  expect(after).toEqual(before);
}

/**
 * Prove a read is blocked: 42501, or zero rows (real data hidden). A blocked
 * read is NEVER accepted on 0 rows alone — a service-role re-read of the
 * seeded real row must prove the row exists, i.e. the filter hid real data,
 * not absence (R4). `realId` is always a seeded real row's id, never a
 * sentinel like -1.
 */
async function assertReadBlocked(
  client: SupabaseClient,
  table: (typeof TABLES)[number],
  idColumn: string,
  realId: number
): Promise<void> {
  const { data, error } = await client.from(table).select("*");
  if (error) {
    expect(error.code, `${table} read error code`).toBe("42501");
  } else {
    expect(data ?? [], `${table} read rows`).toHaveLength(0);
  }

  // Prove the hidden target is REAL: the seeded row must still exist under
  // service role (RLS bypassed). 0 rows alone never counts as blocked.
  const { data: real, error: reReadError } = await service
    .from(table)
    .select(idColumn)
    .eq(idColumn, realId)
    .maybeSingle();
  expect(reReadError, `service-role re-read ${table}.${idColumn}=${realId}`).toBeNull();
  expect(real, `service-role re-read proves ${table}.${idColumn}=${realId} exists`).not.toBeNull();
}

beforeAll(async () => {
  fixtures = await seedCoreFixtures(service);

  selfUserId = await createAuthUser(service, fixtures.advisorSelfEmail);
  inactiveUserId = await createAuthUser(service, fixtures.advisorInactiveEmail);
  const noAdvisorEmail = syntheticEmail("no-advisor");
  noAdvisorUserId = await createAuthUser(service, noAdvisorEmail);

  // ADMIN PRE-BINDING (the only legitimate way auth_user_id is written, R11):
  // the active and inactive advisor rows are pre-bound to their auth users
  // BEFORE first sign-in. After this, selfClient is a pre-bound ACTIVE staff
  // advisor (rows 6/10/11) and inactiveClient is a pre-bound INACTIVE advisor
  // (rows 7/12) that stays blocked.
  const { error: bindSelfError } = await service
    .from("advisor")
    .update({ auth_user_id: selfUserId })
    .eq("advisor_id", fixtures.advisorSelfId)
    .select("advisor_id");
  if (bindSelfError) throw new Error(`admin pre-bind self advisor: ${bindSelfError.message}`);

  const { error: bindInactiveError } = await service
    .from("advisor")
    .update({ auth_user_id: inactiveUserId })
    .eq("advisor_id", fixtures.advisorInactiveId)
    .select("advisor_id");
  if (bindInactiveError) throw new Error(`admin pre-bind inactive advisor: ${bindInactiveError.message}`);

  // Escalation-denial matrix rows: one inactive-unlinked advisor (rows 1–4)
  // and one active-unlinked advisor (row 5, the staff-escalation path). These
  // are NEVER pre-bound: the email-matched auth account must not be able to
  // bind them (rows 4, 5, 8).
  const escalationInactiveEmail = syntheticEmail("escalation-inactive");
  const { data: escInactive, error: escInactiveError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("escalation-inactive"),
      email: escalationInactiveEmail,
      is_active: false,
    })
    .select("advisor_id")
    .single();
  if (escInactiveError) throw new Error(`seed escalation-inactive advisor: ${escInactiveError.message}`);
  escalationInactiveId = escInactive.advisor_id as number;
  escalationInactiveUserId = await createAuthUser(service, escalationInactiveEmail);

  const escalationActiveEmail = syntheticEmail("escalation-active");
  const { data: escActive, error: escActiveError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("escalation-active"),
      email: escalationActiveEmail,
      is_active: true,
    })
    .select("advisor_id")
    .single();
  if (escActiveError) throw new Error(`seed escalation-active advisor: ${escActiveError.message}`);
  escalationActiveId = escActive.advisor_id as number;
  escalationActiveUserId = await createAuthUser(service, escalationActiveEmail);

  // Independent row for the combined inactive-unlinked regression. This row is
  // never touched by any other assertion, so the combined bind/is_active/role
  // UPDATE is always attempted against a pristine inactive-unlinked advisor.
  const escalationInactiveCombinedEmail = syntheticEmail("escalation-inactive-combined");
  const { data: escInactiveCombined, error: escInactiveCombinedError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("escalation-inactive-combined"),
      email: escalationInactiveCombinedEmail,
      is_active: false,
    })
    .select("advisor_id")
    .single();
  if (escInactiveCombinedError) {
    throw new Error(`seed escalation-inactive-combined advisor: ${escInactiveCombinedError.message}`);
  }
  escalationInactiveCombinedId = escInactiveCombined.advisor_id as number;
  escalationInactiveCombinedUserId = await createAuthUser(service, escalationInactiveCombinedEmail);

  // One-time-bind trigger fixture (rows 17–21): an independent unbound row
  // that is NEVER pre-bound here. Row 18 performs the one trusted
  // service_role NULL→non-NULL bind on it; rows 19–20 prove that bind is
  // final (replace/clear rejected). Nothing else touches it.
  const triggerEmail = syntheticEmail("trigger-bind");
  const { data: trigRow, error: trigRowError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("trigger-bind"),
      email: triggerEmail,
      is_active: false,
    })
    .select("advisor_id")
    .single();
  if (trigRowError) throw new Error(`seed trigger-bind advisor: ${trigRowError.message}`);
  triggerUnboundId = trigRow.advisor_id as number;
  triggerUserId = await createAuthUser(service, triggerEmail);

  selfClient = freshClient();
  inactiveClient = freshClient();
  noAdvisorClient = freshClient();
  escalationInactiveClient = freshClient();
  escalationActiveClient = freshClient();
  escalationInactiveCombinedClient = freshClient();

  const selfSigned = await signInWithPassword(selfClient, fixtures.advisorSelfEmail);
  const inactiveSigned = await signInWithPassword(inactiveClient, fixtures.advisorInactiveEmail);
  const noAdvisorSigned = await signInWithPassword(noAdvisorClient, noAdvisorEmail);
  const escInactiveSigned = await signInWithPassword(escalationInactiveClient, escalationInactiveEmail);
  const escActiveSigned = await signInWithPassword(escalationActiveClient, escalationActiveEmail);
  const escInactiveCombinedSigned = await signInWithPassword(
    escalationInactiveCombinedClient,
    escalationInactiveCombinedEmail
  );

  expect(selfSigned).toBe(selfUserId);
  expect(inactiveSigned).toBe(inactiveUserId);
  expect(noAdvisorSigned).toBe(noAdvisorUserId);
  expect(escInactiveSigned).toBe(escalationInactiveUserId);
  expect(escActiveSigned).toBe(escalationActiveUserId);
  expect(escInactiveCombinedSigned).toBe(escalationInactiveCombinedUserId);
});

describe("unbound email-matched account cannot read advisor rows (row 25, amendment A1)", () => {
  // The escalation-active advisor is active and email-matched but UNLINKED
  // (auth_user_id NULL). Amendment A1 removed the SELECT email-match branch,
  // so this account now reads ZERO advisor rows: it is neither a pre-bound
  // self-reader (`auth_user_id = auth.uid()`) nor active staff
  // (`is_active_advisor()` requires a pre-bound active row).
  it("denies an unbound, email-matched account the self-read of their own row (row 25)", async () => {
    // Real seeded-row proof (R4): 0 rows alone never counts as blocked — the
    // service-role re-read proves the seeded row still exists, i.e. the
    // filter hid real data, not absence. Red-capable on the vulnerable
    // chain, where the email-match branch returns the row.
    await assertReadBlocked(escalationActiveClient, "advisor", "advisor_id", escalationActiveId);
  });

  it("denies an unbound, email-matched INACTIVE account the self-read of their own row", async () => {
    // Amendment A1 removes the email-match branch for every unbound account —
    // active or inactive. The escalation-inactive row is is_active=false and
    // auth_user_id NULL: the email-matched account reads zero advisor rows,
    // proven against the still-existing seeded row (R4).
    await assertReadBlocked(escalationInactiveClient, "advisor", "advisor_id", escalationInactiveId);
  });

  it("cannot read another advisor's row", async () => {
    const { data } = await escalationActiveClient
      .from("advisor")
      .select("advisor_id")
      .eq("advisor_id", fixtures.advisorOtherId);
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot update another advisor's row", async () => {
    await assertMutationBlocked(escalationActiveClient, "advisor", "advisor_id", fixtures.advisorOtherId, {
      advisor_name: syntheticName("should-not-apply"),
    });
  });

  it("cannot insert a new advisor (not yet active staff)", async () => {
    const { error } = await escalationActiveClient.from("advisor").insert({
      advisor_name: syntheticName("unauthorized"),
      email: syntheticEmail("unauthorized"),
      is_active: false,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("unlinked advisors cannot change authorization fields (self-activation closed)", () => {
  it("denies an inactive advisor setting is_active=true on their own row", async () => {
    await assertMutationBlocked(escalationInactiveClient, "advisor", "advisor_id", escalationInactiveId, {
      is_active: true,
    });
  });

  it("denies an inactive advisor elevating role on their own row", async () => {
    await assertMutationBlocked(escalationInactiveClient, "advisor", "advisor_id", escalationInactiveId, {
      role: "admin",
    });
  });

  it("denies an inactive advisor changing email on their own row", async () => {
    await assertMutationBlocked(escalationInactiveClient, "advisor", "advisor_id", escalationInactiveId, {
      email: syntheticEmail("escalation-email-hijack"),
    });
  });

  // Regression matrix row 4 — FAILS on the vulnerable chain (direct bind
  // succeeds), PASSES after the remediation migration.
  it("denies binding auth_user_id directly via UPDATE on their own row", async () => {
    await assertMutationBlocked(escalationInactiveClient, "advisor", "advisor_id", escalationInactiveId, {
      auth_user_id: escalationInactiveUserId,
    });
  });

  // Regression matrix row 5 — the core escalation: one UPDATE mixing identity
  // binding with is_active=true and role elevation. FAILS on the vulnerable
  // chain (binds and activates), PASSES after the remediation migration.
  it("denies a single UPDATE mixing self-link with is_active=true and role elevation", async () => {
    await assertMutationBlocked(escalationActiveClient, "advisor", "advisor_id", escalationActiveId, {
      auth_user_id: escalationActiveUserId,
      is_active: true,
      role: "admin",
    });
  });

  // The true inactive-unlinked combined regression: an INACTIVE advisor mixing
  // identity binding with is_active=true and role elevation in a single UPDATE.
  // Attempted against an independent pristine row that no other assertion
  // touches, so the denial is proven in isolation even on a red run where rows
  // 1–4 were already mutated. FAILS on the vulnerable chain, PASSES after the
  // remediation migration.
  it("denies an inactive-unlinked advisor a single UPDATE mixing self-link with is_active=true and role elevation (independent row)", async () => {
    await assertMutationBlocked(
      escalationInactiveCombinedClient,
      "advisor",
      "advisor_id",
      escalationInactiveCombinedId,
      {
        auth_user_id: escalationInactiveCombinedUserId,
        is_active: true,
        role: "admin",
      }
    );
  });
});

describe("no self-link RPC exists; identity binding is admin-only (rows 6-9)", () => {
  // Regression matrix row 9 / design §1.2: the superseded `link_current_advisor`
  // email self-link RPC is REMOVED and never created. Calling it from any role
  // fails — there is no binding path through an RPC at all.
  it("authenticated users get a function-not-found error calling link_current_advisor", async () => {
    const { data, error } = await escalationActiveClient.rpc("link_current_advisor");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    expect(error?.message.toLowerCase()).toContain("could not find the function");
  });

  it("anon gets a function-not-found error calling link_current_advisor", async () => {
    const { data, error } = await anon.rpc("link_current_advisor");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    expect(error?.message.toLowerCase()).toContain("could not find the function");
  });

  it("service_role gets a function-not-found error calling link_current_advisor", async () => {
    const { data, error } = await service.rpc("link_current_advisor");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    expect(error?.message.toLowerCase()).toContain("could not find the function");
  });

  // Row 8 — pre-existing-matching-account takeover: an authenticated account
  // whose email matches an UNLINKED advisor row attempts to claim/bind that
  // identity via every available API path. FAILS red on the vulnerable chain
  // (the matching account self-binds); after the fix every path is denied and
  // the row stays unbound.
  it("rejects every binding path for a pre-existing matching account (row 8)", async () => {
    // (a) Direct UPDATE binding of the email-matched unlinked active row.
    await assertMutationBlocked(escalationActiveClient, "advisor", "advisor_id", escalationActiveId, {
      auth_user_id: escalationActiveUserId,
    });
    // (b) The only other legacy path (the RPC) does not exist.
    const { data, error } = await escalationActiveClient.rpc("link_current_advisor");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    // (c) The matching account has NO staff access: it cannot read student rows.
    await assertReadBlocked(escalationActiveClient, "student", "student_id", fixtures.studentId);
  });

  it("admin pre-binding stays the ONLY way auth_user_id is written (row 6 pre-bound active)", async () => {
    // The pre-bound active advisor (selfClient) is staff: reads own row and
    // students. This is the admin-pre-bound state — the session (unit-tested
    // separately) resolves it by auth_user_id. Also pins amendment A1 row 26:
    // the pre-bound ACTIVE advisor still reads its own row via
    // `auth_user_id = auth.uid()`.
    const { data: ownRow } = await selfClient
      .from("advisor")
      .select("advisor_id, auth_user_id")
      .eq("advisor_id", fixtures.advisorSelfId)
      .maybeSingle();
    expect(ownRow).not.toBeNull();
    expect(ownRow?.auth_user_id).toBe(selfUserId);

    const { data: students, error } = await selfClient.from("student").select("student_id");
    expect(error).toBeNull();
    const ids = (students ?? []).map((row: { student_id: number }) => row.student_id);
    expect(ids).toContain(fixtures.studentId);
  });

  it("admin pre-bound inactive advisor stays inactive and blocked (row 7)", async () => {
    const { data: ownRow } = await inactiveClient
      .from("advisor")
      .select("advisor_id, auth_user_id, is_active")
      .eq("advisor_id", fixtures.advisorInactiveId)
      .maybeSingle();
    expect(ownRow).not.toBeNull();
    expect(ownRow?.auth_user_id).toBe(inactiveUserId);
    expect(ownRow?.is_active).toBe(false);

    // Blocked from operational data despite being pre-bound.
    await assertReadBlocked(inactiveClient, "student", "student_id", fixtures.studentId);
  });
});

// Regression matrix row 15 — case-insensitive advisor-email identity (R11).
// The forward-only unique index on lower(email) rejects a case-variant
// duplicate advisor email, and a case-variant account has NO claim/bind path
// (no RPC, no UPDATE self-link). Green-only: these pin the fixed schema's
// case-normalized identity and never served as red evidence.
describe("case-insensitive advisor email identity (row 15)", () => {
  it("rejects a second advisor row whose email differs only by case (unique lower(email))", async () => {
    const email = syntheticEmail("case-unique");
    const caseVariant = email.replace(/^contract/, "CONTRACT");
    expect(caseVariant.toLowerCase()).toBe(email.toLowerCase());

    const { data: first, error: firstError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("case-unique"),
        email,
        is_active: false,
      })
      .select("advisor_id")
      .single();
    expect(firstError).toBeNull();
    expect(first).not.toBeNull();

    const { data: dup, error: dupError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("case-unique-dup"),
        email: caseVariant,
        is_active: false,
      });
    expect(dup).toBeNull();
    expect(dupError).not.toBeNull();
    expect(dupError?.code).toBe("23505"); // unique_violation on lower(email)
  });

  it("gives a case-variant account no claim path to a mixed-case stored advisor row", async () => {
    // The stored advisor email is deliberately mixed-case; the auth identity
    // uses its lowercase form. Under the final model the session resolves by
    // auth_user_id only and there is NO RPC, so the case-variant account has
    // no way to claim or bind the row.
    const storedEmail = syntheticEmail("case-session").replace(/^contract/, "Contract");
    const { data: row, error: insertError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("case-session"),
        email: storedEmail,
        is_active: true,
      })
      .select("advisor_id")
      .single();
    expect(insertError).toBeNull();
    expect(row).not.toBeNull();

    const userId = await createAuthUser(service, storedEmail.toLowerCase());
    const caseClient = freshClient();
    const signed = await signInWithPassword(caseClient, storedEmail.toLowerCase());
    expect(signed).toBe(userId);

    // (a) Direct UPDATE binding of the case-variant match is denied.
    await assertMutationBlocked(caseClient, "advisor", "advisor_id", row!.advisor_id, {
      auth_user_id: userId,
    });
    // (b) No RPC exists to link by email.
    const { data, error } = await caseClient.rpc("link_current_advisor");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    // (c) The row is still unbound and its stored email case is unchanged.
    const { data: stored } = await service
      .from("advisor")
      .select("email, auth_user_id")
      .eq("advisor_id", row!.advisor_id)
      .maybeSingle();
    expect(stored?.email).toBe(storedEmail);
    expect(stored?.auth_user_id).toBeNull();
  });
});

// One-time-bind trigger matrix (rows 16–24, official research). The
// invoker-security `BEFORE INSERT OR UPDATE OF auth_user_id` trigger makes
// `advisor.auth_user_id` immutable after a single trusted NULL→non-NULL bind:
// ordinary active staff may INSERT unbound rows (`auth_user_id` NULL); only a
// trusted `service_role`/DBA session may create (INSERT) or set (UPDATE) a
// non-NULL value; and every other write — authenticated non-NULL INSERTs,
// trusted replaces/rebinds, clears — is rejected fail-closed. These
// assertions are green-only (they pin the fixed schema's trigger semantics)
// and every denial is proven by a service-role row-intactness re-read or an
// absence proof (R4).
describe("invoker-security one-time-bind trigger on advisor.auth_user_id (rows 16-24)", () => {
  // Row 18 — the trusted service_role one-time NULL→non-NULL bind succeeds
  // exactly once (the server-only provisioning path).
  it("lets the trusted service_role perform the one-time NULL→non-NULL bind (row 18)", async () => {
    const before = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(before?.auth_user_id).toBeNull();

    const { data, error } = await service
      .from("advisor")
      .update({ auth_user_id: triggerUserId })
      .eq("advisor_id", triggerUnboundId)
      .select("auth_user_id");
    expect(error, "trusted service_role bind must succeed").toBeNull();
    expect(data ?? [], "trusted bind must affect one row").toHaveLength(1);

    // Row-intactness re-read: the bind was applied exactly once.
    const after = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(after?.auth_user_id).toBe(triggerUserId);
  });

  // Row 19 — a trusted service_role replace/rebind (non-NULL → different
  // non-NULL) is rejected: one-time bind only. Row proven unchanged.
  it("rejects a trusted service_role replace/rebind; original uuid intact (row 19)", async () => {
    const before = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(before?.auth_user_id).toBe(triggerUserId);

    const { data, error } = await service
      .from("advisor")
      .update({ auth_user_id: "00000000-0000-4000-8000-000000000001" })
      .eq("advisor_id", triggerUnboundId)
      .select("auth_user_id");
    if (error) {
      expect(["42501", "P0001"], "rebind denial error code").toContain(error.code);
    } else {
      expect(data ?? [], "rebind must not affect any row").toHaveLength(0);
    }

    const after = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(after).toEqual(before);
  });

  // Row 20 — a trusted service_role clear (non-NULL → NULL) is rejected; the
  // row stays bound. Row proven unchanged.
  it("rejects a trusted service_role clear; row stays bound (row 20)", async () => {
    const before = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(before?.auth_user_id).toBe(triggerUserId);

    const { data, error } = await service
      .from("advisor")
      .update({ auth_user_id: null })
      .eq("advisor_id", triggerUnboundId)
      .select("auth_user_id");
    if (error) {
      expect(["42501", "P0001"], "clear denial error code").toContain(error.code);
    } else {
      expect(data ?? [], "clear must not affect any row").toHaveLength(0);
    }

    const after = await readRow("advisor", "advisor_id", triggerUnboundId);
    expect(after).toEqual(before);
  });

  // Row 17 — the conditional provisioning path (WHERE auth_user_id IS NULL)
  // never re-binds an already-bound row: 0 rows matched, uuid unchanged.
  it("never re-binds an already-bound row via the conditional provisioning path (row 17)", async () => {
    const before = await readRow("advisor", "advisor_id", fixtures.advisorSelfId);
    expect(before?.auth_user_id).toBe(selfUserId);

    const { data, error } = await service
      .from("advisor")
      .update({ auth_user_id: selfUserId })
      .eq("advisor_id", fixtures.advisorSelfId)
      .is("auth_user_id", null)
      .select("advisor_id");
    expect(error).toBeNull();
    expect(data ?? [], "conditional update matches no bound row").toHaveLength(0);

    const after = await readRow("advisor", "advisor_id", fixtures.advisorSelfId);
    expect(after).toEqual(before);
  });

  // Row 16 — active-advisor rebinding of another advisor's row (genuine red on
  // the vulnerable chain, where the active-staff UPDATE policy permits it). On
  // the fixed schema the invoker-security trigger denies it; row proven
  // unchanged.
  it("denies an active advisor setting auth_user_id on another advisor row (row 16)", async () => {
    await assertMutationBlocked(
      selfClient,
      "advisor",
      "advisor_id",
      fixtures.advisorOtherId,
      { auth_user_id: selfUserId },
      ["42501", "P0001"]
    );
  });

  // Row 21 — every authenticated bind/replace/clear attempt is rejected, and
  // each target row is proven unchanged by a service-role re-read.
  it("denies an authenticated active-staff bind on an unbound advisor row (row 21)", async () => {
    await assertMutationBlocked(
      selfClient,
      "advisor",
      "advisor_id",
      escalationActiveId,
      { auth_user_id: selfUserId },
      ["42501", "P0001"]
    );
  });

  it("denies an authenticated active-staff replace on a bound advisor row (row 21)", async () => {
    await assertMutationBlocked(
      selfClient,
      "advisor",
      "advisor_id",
      fixtures.advisorSelfId,
      { auth_user_id: "00000000-0000-4000-8000-000000000002" },
      ["42501", "P0001"]
    );
  });

  it("denies an authenticated active-staff clear of auth_user_id (row 21)", async () => {
    await assertMutationBlocked(
      selfClient,
      "advisor",
      "advisor_id",
      fixtures.advisorSelfId,
      { auth_user_id: null },
      ["42501", "P0001"]
    );
  });

  // Active-staff updates to other advisor columns stay intact (design §1.3):
  // an update that happens to carry the current binding unchanged is a no-op
  // for the trigger and passes through.
  it("passes through an authenticated no-op update that keeps auth_user_id unchanged", async () => {
    const { data, error } = await selfClient
      .from("advisor")
      .update({
        advisor_name: syntheticName("advisor-noop-auth-unchanged"),
        auth_user_id: selfUserId,
      })
      .eq("advisor_id", fixtures.advisorSelfId)
      .select("advisor_id");
    expect(error).toBeNull();
    expect(data ?? [], "no-op update must affect one row").toHaveLength(1);

    const row = await readRow("advisor", "advisor_id", fixtures.advisorSelfId);
    expect(row?.auth_user_id).toBe(selfUserId);
  });

  // Row 22 — authenticated/active staff may INSERT an UNBOUND advisor row
  // (`auth_user_id` NULL): the preserved active-staff INSERT path. Row re-read
  // proves the created row exists with auth_user_id NULL.
  it("lets an authenticated active-staff advisor INSERT an unbound advisor row (row 22)", async () => {
    const { data: inserted, error } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("staff-unbound-insert"),
        email: syntheticEmail("staff-unbound-insert"),
        is_active: false,
      })
      .select("advisor_id")
      .single();
    expect(error, "active-staff unbound INSERT must succeed").toBeNull();
    expect(inserted).not.toBeNull();

    // Row proof: the created row exists and is UNBOUND.
    const row = await readRow("advisor", "advisor_id", inserted!.advisor_id);
    expect(row).not.toBeNull();
    expect(row?.auth_user_id).toBeNull();
  });

  // Row 23 — authenticated/active staff INSERT of an advisor row carrying a
  // non-NULL `auth_user_id` is rejected by the trigger (P0001; RLS would have
  // allowed the insert). Absence proof: no row was created for that email,
  // even under the service role.
  it("denies an authenticated active-staff INSERT carrying a non-NULL auth_user_id (row 23)", async () => {
    const email = syntheticEmail("auth-bound-insert");
    const { data, error } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("auth-bound-insert"),
        email,
        is_active: false,
        auth_user_id: "00000000-0000-4000-8000-0000000000aa",
      })
      .select("advisor_id");
    expect(data ?? [], "a denied bound INSERT must not return a row").toHaveLength(0);
    expect(error, "authenticated bound INSERT must be rejected").not.toBeNull();
    expect(error?.code, "authenticated bound INSERT denial error code").toBe("P0001");

    // Absence proof: the row was never created, even under the service role.
    const { data: remaining } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the denied bound INSERT").toHaveLength(0);
  });

  // Row 24 — the trusted service_role may INSERT an advisor row already bound
  // to a non-NULL `auth_user_id` (bound-row creation via the provisioning
  // path). Row re-read proves the provisioned uuid is stored.
  it("lets the trusted service_role INSERT an advisor row with a non-NULL auth_user_id (row 24)", async () => {
    const { data: inserted, error } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("trusted-bound-insert"),
        email: syntheticEmail("trusted-bound-insert"),
        is_active: false,
        auth_user_id: "00000000-0000-4000-8000-0000000000bb",
      })
      .select("advisor_id")
      .single();
    expect(error, "trusted bound INSERT must succeed").toBeNull();
    expect(inserted).not.toBeNull();

    // Row proof: the created row exists and carries the provisioned uuid.
    const row = await readRow("advisor", "advisor_id", inserted!.advisor_id);
    expect(row).not.toBeNull();
    expect(row?.auth_user_id).toBe("00000000-0000-4000-8000-0000000000bb");
  });
});

describe("pre-bound active advisor has staff access", () => {
  it("can read student rows", async () => {
    const { data, error } = await selfClient.from("student").select("student_id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((row: { student_id: number }) => row.student_id);
    expect(ids).toContain(fixtures.studentId);
  });

  it("can read advisor rows including other advisors", async () => {
    // Amendment A1 row 28: active staff retain full advisor read access —
    // they can read ANY advisor row, not just their own.
    const { data, error } = await selfClient.from("advisor").select("advisor_id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((row: { advisor_id: number }) => row.advisor_id);
    expect(ids).toContain(fixtures.advisorSelfId);
    expect(ids).toContain(fixtures.advisorOtherId);
  });

  // Regression matrix row 11 — full active-staff coverage: CRUD is proven on
  // EVERY operational table (insert → read → update → delete), not a sample.
  it.each(OPERATIONAL_TABLES)(
    "active staff can insert, read, update, and delete %s rows",
    async (table) => {
      const idColumn = ID_COLUMN[table];

      const { data: inserted, error: insertError } = await selfClient
        .from(table)
        .insert(operationalInsertPayload(table))
        .select(idColumn)
        .single();
      expect(insertError, `${table} insert`).toBeNull();
      expect(inserted).not.toBeNull();
      const rowId = (inserted as unknown as Record<string, number>)[idColumn];

      const { data: read, error: readError } = await selfClient
        .from(table)
        .select("*")
        .eq(idColumn, rowId)
        .maybeSingle();
      expect(readError, `${table} read`).toBeNull();
      expect(read).not.toBeNull();

      const { data: updated, error: updateError } = await selfClient
        .from(table)
        .update(operationalUpdatePayload(table))
        .eq(idColumn, rowId)
        .select(idColumn);
      expect(updateError, `${table} update`).toBeNull();
      expect(updated ?? [], `${table} update affected rows`).toHaveLength(1);

      const { error: deleteError } = await selfClient
        .from(table)
        .delete()
        .eq(idColumn, rowId);
      expect(deleteError, `${table} delete`).toBeNull();

      // Deleted for real: the row is gone even under service role.
      const { data: remaining } = await service
        .from(table)
        .select(idColumn)
        .eq(idColumn, rowId);
      expect(remaining ?? [], `${table} post-delete rows`).toHaveLength(0);
    }
  );

  // Regression matrix row 10 — active-staff advisor-row management preserved.
  it("can update another advisor's non-authorization fields", async () => {
    const { data, error } = await selfClient
      .from("advisor")
      .update({ advisor_name: syntheticName("advisor-renamed-by-staff") })
      .eq("advisor_id", fixtures.advisorOtherId)
      .select("advisor_id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  // Active-staff advisor-row management: insert, read, and delete an advisor
  // row (row 11 covers advisor management alongside the operational tables).
  it("can insert, read, and delete advisor rows as staff (advisor management)", async () => {
    const { data: inserted, error: insertError } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("staff-managed-advisor"),
        email: syntheticEmail("staff-managed-advisor"),
        is_active: false,
      })
      .select("advisor_id")
      .single();
    expect(insertError).toBeNull();
    expect(inserted).not.toBeNull();

    const { data: read, error: readError } = await selfClient
      .from("advisor")
      .select("advisor_id")
      .eq("advisor_id", inserted!.advisor_id)
      .maybeSingle();
    expect(readError).toBeNull();
    expect(read).not.toBeNull();

    const { error: deleteError } = await selfClient
      .from("advisor")
      .delete()
      .eq("advisor_id", inserted!.advisor_id);
    expect(deleteError).toBeNull();

    const { data: remaining } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("advisor_id", inserted!.advisor_id);
    expect(remaining ?? []).toHaveLength(0);
  });
});

describe("pre-bound inactive advisor is blocked", () => {
  it("can still read their own advisor row", async () => {
    // Amendment A1 row 27: the pre-bound INACTIVE advisor still reads ONLY
    // their own row via `auth_user_id = auth.uid()` (operational tables
    // below stay blocked).
    const { data } = await inactiveClient
      .from("advisor")
      .select("advisor_id, email, auth_user_id")
      .eq("advisor_id", fixtures.advisorInactiveId);
    expect(data ?? []).toHaveLength(1);
    expect(data?.[0]?.email).toBe(fixtures.advisorInactiveEmail);
    expect(data?.[0]?.auth_user_id).toBe(inactiveUserId);
  });

  it("cannot update their own row (no UPDATE path for a non-active advisor)", async () => {
    await assertMutationBlocked(inactiveClient, "advisor", "advisor_id", fixtures.advisorInactiveId, {
      advisor_name: syntheticName("inactive-should-not-apply"),
    });
  });

  it("cannot read student rows", async () => {
    await assertReadBlocked(inactiveClient, "student", "student_id", fixtures.studentId);
  });

  it("cannot insert a student", async () => {
    const { error } = await inactiveClient.from("student").insert({
      full_name: syntheticName("inactive"),
      email: syntheticEmail("inactive"),
      us_citizen: true,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("authenticated user with no advisor row is blocked", () => {
  it("sees no advisor rows", async () => {
    await assertReadBlocked(noAdvisorClient, "advisor", "advisor_id", fixtures.advisorSelfId);
  });

  it("cannot read student rows", async () => {
    await assertReadBlocked(noAdvisorClient, "student", "student_id", fixtures.studentId);
  });

  it("cannot insert a student", async () => {
    const { error } = await noAdvisorClient.from("student").insert({
      full_name: syntheticName("no-advisor"),
      email: syntheticEmail("no-advisor-insert"),
      us_citizen: true,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("cannot insert an advisor", async () => {
    const { error } = await noAdvisorClient.from("advisor").insert({
      advisor_name: syntheticName("no-advisor"),
      email: syntheticEmail("no-advisor-insert"),
      is_active: false,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("anon (unauthenticated) role is denied on every table", () => {
  // One real seeded row per table so denials target real data (R4). Resolved
  // lazily: `fixtures` is only populated in beforeAll.
  const realIds = (): Record<(typeof TABLES)[number], number> => ({
    advisor: fixtures.advisorOtherId,
    fellowship: fixtures.fellowshipId,
    student: fixtures.studentId,
    application: fixtures.applicationId,
    advising_meeting: fixtures.meetingId,
    fellowship_thursday: fixtures.attendanceId,
    scholarship_history: fixtures.historyId,
  });

  it.each(TABLES)("anon cannot read %s", async (table) => {
    // Blocked reads are proven: the helper asserts 42501 (or zero rows) AND a
    // service-role re-read proving the seeded real row exists (R4).
    await assertReadBlocked(anon, table, ID_COLUMN[table], realIds()[table]);
  });

  it.each(TABLES)("anon cannot insert into %s", async (table) => {
    const { error } = await anon.from(table).insert(INSERT_PAYLOADS[table]);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it.each(TABLES)("anon cannot update %s", async (table) => {
    await assertMutationBlocked(anon, table, ID_COLUMN[table], realIds()[table], UPDATE_PAYLOADS[table]);
  });

  it.each(TABLES)("anon cannot delete %s", async (table) => {
    const { data, error } = await anon.from(table).delete().eq(ID_COLUMN[table], realIds()[table]);
    if (error) {
      expect(error.code).toBe("42501");
    } else {
      expect(data ?? []).toHaveLength(0);
    }
    // The real row still exists: deletion was denied, not silently applied.
    const { data: stillThere } = await service
      .from(table)
      .select(ID_COLUMN[table])
      .eq(ID_COLUMN[table], realIds()[table])
      .maybeSingle();
    expect(stillThere).not.toBeNull();
  });
});