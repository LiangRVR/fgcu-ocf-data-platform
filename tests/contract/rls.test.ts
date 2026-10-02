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
 *   - pre-bound active advisors retain shared staff CRUD on the operational
 *     rows `fellowship_thursday` and `scholarship_history`, and shared
 *     INSERT/read/UPDATE (never DELETE) on the core historical entities
 *     `student`, `fellowship`, `application`, and `advisor` (migration
 *     ...006 revokes/denies authenticated DELETE of core history), while
 *     `advising_meeting` is append-only: active advisors may SELECT and INSERT
 *     but direct UPDATE and DELETE are denied;
 *   - pre-bound inactive advisors and authenticated users with no advisor row
 *     are blocked from operational data;
 *   - advisor email identity is case-normalized (R11, regression row 15): a
 *     case-variant duplicate advisor email is rejected by the unique
 *     `lower(email)` index, and a case-variant account has no claim/bind path;
 *   - the invoker-security `BEFORE INSERT OR UPDATE OF auth_user_id` trigger
 *     (rows 16–24, official research) makes `auth_user_id` a one-time bind: the
 *     trusted `service_role`/DBA NULL→non-NULL bind succeeds once (row 18)
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
 *   - migration 20261002000001 (review remediation) removes broad
 *     authenticated advisor write access: an ACTIVE, pre-bound advisor may
 *     UPDATE only their OWN bound row (`advisor_update_own_profile`, self-scoped
 *     by `auth_user_id = auth.uid()` + `is_active_advisor()`) and direct
 *     authenticated advisor-row INSERT is denied (`advisor_insert_active_staff`
 *     dropped) — row 22's former "active staff may INSERT an unbound advisor"
 *     is now a denial with an absence proof, and row 10's former peer
 *     non-authorization UPDATE is now a denial. The trusted service-role
 *     provisioning path, E2E seeding, and no-op self restatements pass through;
 *     `role`/`is_active`/`auth_user_id` stay protected by the column-scoped
 *     guards on the self row.
 *   - service-role access is never asserted as a feature; it is used only to
 *     seed local synthetic fixtures, create local auth users, re-read rows to
 *     prove "denied + unchanged", and simulate ADMIN PRE-BINDING (the only
 *     legitimate way `auth_user_id` is ever written).
 *   - migration 20261001000001 (explicit admin/advisor permissions): the
 *     advisor display role is constrained to exactly `Admin`/`Advisor` and is
 *     protected by an invoker-security column-scoped guard trigger — direct
 *     self/peer role writes and the authenticated creation of an `Admin` row
 *     are denied (42501) while the trusted service-role provisioning path and
 *     no-op restatements pass through. The display role never grants
 *     authorization (an `Admin`-display advisor without the claim has ordinary
 *     staff powers and no lifecycle/role authority), immutable meeting and
 *     amendment records stay append-only for BOTH display roles, anon cannot
 *     EXECUTE `is_effective_admin()`, and a deactivated advisor loses
 *     operational access while their historical advisor-linked meetings stay
 *     readable by other active staff through the staff historical views.
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

/** All operational tables covered by the authenticated denial matrices. */
const OPERATIONAL_TABLES = [
  "student",
  "fellowship",
  "application",
  "advising_meeting",
  "fellowship_thursday",
  "scholarship_history",
] as const;
type OperationalTable = (typeof OPERATIONAL_TABLES)[number];

/**
 * Operational rows that remain fully mutable (insert/read/update/delete) by
 * active staff; advising_meeting is append-only.
 */
const ACTIVE_ADVISOR_FULL_CRUD_TABLES = [
  "fellowship_thursday",
  "scholarship_history",
] as const satisfies readonly OperationalTable[];

/**
 * Core historical entities: active staff may insert/read/update, but DELETE
 * is revoked and denied at the database boundary (migration
 * 20260930000006_core_history_delete_lockdown).
 */
const CORE_HISTORY_DELETE_DENIED_TABLES = [
  "student",
  "fellowship",
  "application",
] as const satisfies readonly OperationalTable[];

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
let amendmentNoAdvisorUserId: string;
let selfClient: SupabaseClient;
let inactiveClient: SupabaseClient;
let noAdvisorClient: SupabaseClient;
let amendmentNoAdvisorClient: SupabaseClient;

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

// Admin-display-role advisor (migration 20261001000001): a pre-bound ACTIVE
// advisor whose protected display role was set to 'Admin' through the trusted
// service-role provisioning path, but whose Auth user carries NO ocf_admin
// claim. Proves the display role is presentation-only: this session has the
// same staff powers (and the same role-write denials, append-only history
// denials) as an ordinary Advisor display role, never extra authorization.
let adminDisplayId: number;
let adminDisplayUserId: string;
let adminDisplayClient: SupabaseClient;

// Dedicated denial-target student/fellowship rows for the INSERT denial
// matrices (Work 1 remediation). Each identity gets its OWN target pair so the
// attempted INSERT payloads carry a deterministic, unique-per-payload
// identifier (the target `student_id` for the FK-reference tables; the
// synthetic email/name for student/fellowship) that no real row ever matches.
// These targets are ONLY referenced by DENIED INSERT attempts, so a
// service-role reread filtered on the identifier proves zero matching rows
// were created (absence proof, R4).
let inactiveDenialStudentId: number;
let inactiveDenialFellowshipId: number;
let noAdvisorDenialStudentId: number;
let noAdvisorDenialFellowshipId: number;

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

/**
 * Prove a DELETE is denied against a REAL row: either a 42501 permission
 * error (RLS) or a zero-row RLS filter, and — in every case — a service-role
 * re-read proving the row is byte-for-byte unchanged (R4). `realId` is always
 * a seeded real row's id, never a sentinel like -1.
 */
async function assertDeleteBlocked(
  client: SupabaseClient,
  table: (typeof TABLES)[number],
  idColumn: string,
  realId: number
): Promise<void> {
  const before = await readRow(table, idColumn, realId);
  expect(before).not.toBeNull();

  const { data, error } = await client.from(table).delete().eq(idColumn, realId);

  if (error) {
    expect(error.code, `${table} delete error code`).toBe("42501");
  } else {
    // RLS-filtered no-op: the row was not visible for deletion.
    expect(data ?? [], `${table} delete affected rows`).toHaveLength(0);
  }

  // Deletion was denied, not silently applied: the real row still exists,
  // byte-for-byte unchanged.
  const after = await readRow(table, idColumn, realId);
  expect(after).toEqual(before);
}

/** Real seeded ids for the six operational tables (lazy: filled in beforeAll). */
function seededOperationalIds(): Record<OperationalTable, number> {
  return {
    student: fixtures.studentId,
    fellowship: fixtures.fellowshipId,
    application: fixtures.applicationId,
    advising_meeting: fixtures.meetingId,
    fellowship_thursday: fixtures.attendanceId,
    scholarship_history: fixtures.historyId,
  };
}

/**
 * Attempted INSERT payload for one denied-insert case. Every payload carries a
 * deterministic, unique-per-payload identifier (`label` is baked into the
 * synthetic email/name and the per-identity target student id) so the absence
 * reread can filter on exactly the attempted row and nothing else.
 */
function deniedInsertPayload(
  table: OperationalTable,
  label: string,
  targetStudentId: number,
  targetFellowshipId: number
): Record<string, unknown> {
  switch (table) {
    case "student":
      return {
        full_name: syntheticName(`denied-${label}`),
        email: syntheticEmail(`denied-${label}`),
        us_citizen: true,
      };
    case "fellowship":
      return { fellowship_name: syntheticName(`denied-${label}`) };
    case "application":
      return {
        student_id: targetStudentId,
        fellowship_id: targetFellowshipId,
        stage_of_application: "Started",
      };
    case "advising_meeting":
      return { student_id: targetStudentId, meeting_date: "2026-09-20", meeting_mode: "Virtual" };
    case "fellowship_thursday":
      return { student_id: targetStudentId, attended: true, source_info: "OCF" };
    case "scholarship_history":
      return { student_id: targetStudentId, fellowship_id: targetFellowshipId };
  }
}

/**
 * The deterministic unique attempted identifier inside a denied INSERT payload
 * and the column it lives in, used for the service-role absence reread.
 * student/fellowship use their unique synthetic email/name; the four
 * FK-reference tables use the per-identity denial-target `student_id`, which
 * no real row ever references.
 */
function deniedInsertIdentifier(
  table: OperationalTable,
  payload: Record<string, unknown>
): { column: string; value: unknown } {
  switch (table) {
    case "student":
      return { column: "email", value: payload.email };
    case "fellowship":
      return { column: "fellowship_name", value: payload.fellowship_name };
    case "application":
    case "advising_meeting":
    case "fellowship_thursday":
    case "scholarship_history":
      return { column: "student_id", value: payload.student_id };
  }
}

/**
 * Prove an INSERT is denied AND that no row was created: 42501 (RLS WITH CHECK
 * denial) and a zero-row result, followed by a service-role reread of the SAME
 * table filtered on the payload's deterministic unique attempted identifier
 * proving zero matching rows exist (absence proof, R4). A denied INSERT is
 * never accepted on the 42501 alone.
 */
async function assertInsertBlocked(
  client: SupabaseClient,
  table: OperationalTable,
  payload: Record<string, unknown>
): Promise<void> {
  const { data, error } = await client.from(table).insert(payload);
  expect(data ?? [], `${table} insert affected rows`).toHaveLength(0);
  expect(error, `${table} insert must be denied`).not.toBeNull();
  expect(error?.code, `${table} insert denial error code`).toBe("42501");

  // Absence proof: the denied INSERT created no row for its unique attempted
  // identifier, even under the service role (RLS bypassed).
  const { column, value } = deniedInsertIdentifier(table, payload);
  const { data: created, error: reReadError } = await service
    .from(table)
    .select("*")
    .eq(column, value);
  expect(reReadError, `service-role absence re-read ${table}.${column}=${String(value)}`).toBeNull();
  expect(
    created ?? [],
    `no ${table} row may exist for the denied insert identifier ${column}=${String(value)}`
  ).toHaveLength(0);
}

beforeAll(async () => {
  fixtures = await seedCoreFixtures(service);

  selfUserId = await createAuthUser(service, fixtures.advisorSelfEmail);
  inactiveUserId = await createAuthUser(service, fixtures.advisorInactiveEmail);
  const noAdvisorEmail = syntheticEmail("no-advisor");
  noAdvisorUserId = await createAuthUser(service, noAdvisorEmail);

  // Dedicated no-advisor account for the amendment-specific SELECT/INSERT
  // denial coverage: its own auth user (no advisor row) so the amendment
  // assertions never share state with the general no-advisor matrix.
  const amendmentNoAdvisorEmail = syntheticEmail("amendment-no-advisor");
  amendmentNoAdvisorUserId = await createAuthUser(service, amendmentNoAdvisorEmail);

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

  // Admin-display-role fixture (migration 20261001000001): the trusted
  // provisioning path sets the protected display role to 'Admin' on an active,
  // pre-bound advisor row whose Auth user carries NO ocf_admin claim. This is
  // exactly the "display projection, never authorization" state: the session
  // below proves it grants no extra authority.
  const adminDisplayEmail = syntheticEmail("admin-display");
  const { data: adminDisplayRow, error: adminDisplayRowError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("admin-display"),
      email: adminDisplayEmail,
      is_active: true,
    })
    .select("advisor_id")
    .single();
  if (adminDisplayRowError) throw new Error(`seed admin-display advisor: ${adminDisplayRowError.message}`);
  adminDisplayId = adminDisplayRow.advisor_id as number;
  adminDisplayUserId = await createAuthUser(service, adminDisplayEmail);
  const { error: bindAdminDisplayError } = await service
    .from("advisor")
    .update({ auth_user_id: adminDisplayUserId })
    .eq("advisor_id", adminDisplayId)
    .select("advisor_id");
  if (bindAdminDisplayError) throw new Error(`admin pre-bind admin-display advisor: ${bindAdminDisplayError.message}`);
  const { error: adminDisplayRoleError } = await service
    .from("advisor")
    .update({ role: "Admin" })
    .eq("advisor_id", adminDisplayId)
    .select("advisor_id");
  if (adminDisplayRoleError) {
    throw new Error(`trusted role=Admin on admin-display advisor: ${adminDisplayRoleError.message}`);
  }

  // Denial-target student/fellowship pairs for the INSERT denial matrices:
  // one pair per identity, referenced ONLY by denied INSERT attempts, so the
  // service-role absence reread (filtered on the target student_id or the
  // synthetic email/name) can never match any real row.
  const seedDenialTarget = async (label: string): Promise<{ studentId: number; fellowshipId: number }> => {
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({
        full_name: syntheticName(`denial-target-${label}`),
        email: syntheticEmail(`denial-target-${label}`),
        us_citizen: true,
      })
      .select("student_id")
      .single();
    if (studentError) throw new Error(`seed denial-target student ${label}: ${studentError.message}`);
    const { data: fellowship, error: fellowshipError } = await service
      .from("fellowship")
      .insert({ fellowship_name: syntheticName(`denial-target-${label}`) })
      .select("fellowship_id")
      .single();
    if (fellowshipError) throw new Error(`seed denial-target fellowship ${label}: ${fellowshipError.message}`);
    return { studentId: student!.student_id as number, fellowshipId: fellowship!.fellowship_id as number };
  };

  const inactiveTarget = await seedDenialTarget("inactive");
  inactiveDenialStudentId = inactiveTarget.studentId;
  inactiveDenialFellowshipId = inactiveTarget.fellowshipId;
  const noAdvisorTarget = await seedDenialTarget("no-advisor");
  noAdvisorDenialStudentId = noAdvisorTarget.studentId;
  noAdvisorDenialFellowshipId = noAdvisorTarget.fellowshipId;

  selfClient = freshClient();
  inactiveClient = freshClient();
  noAdvisorClient = freshClient();
  amendmentNoAdvisorClient = freshClient();
  escalationInactiveClient = freshClient();
  escalationActiveClient = freshClient();
  escalationInactiveCombinedClient = freshClient();
  adminDisplayClient = freshClient();

  const selfSigned = await signInWithPassword(selfClient, fixtures.advisorSelfEmail);
  const inactiveSigned = await signInWithPassword(inactiveClient, fixtures.advisorInactiveEmail);
  const noAdvisorSigned = await signInWithPassword(noAdvisorClient, noAdvisorEmail);
  const amendmentNoAdvisorSigned = await signInWithPassword(amendmentNoAdvisorClient, amendmentNoAdvisorEmail);
  const escInactiveSigned = await signInWithPassword(escalationInactiveClient, escalationInactiveEmail);
  const escActiveSigned = await signInWithPassword(escalationActiveClient, escalationActiveEmail);
  const escInactiveCombinedSigned = await signInWithPassword(
    escalationInactiveCombinedClient,
    escalationInactiveCombinedEmail
  );
  const adminDisplaySigned = await signInWithPassword(adminDisplayClient, adminDisplayEmail);

  expect(selfSigned).toBe(selfUserId);
  expect(inactiveSigned).toBe(inactiveUserId);
  expect(noAdvisorSigned).toBe(noAdvisorUserId);
  expect(amendmentNoAdvisorSigned).toBe(amendmentNoAdvisorUserId);
  expect(escInactiveSigned).toBe(escalationInactiveUserId);
  expect(escActiveSigned).toBe(escalationActiveUserId);
  expect(escInactiveCombinedSigned).toBe(escalationInactiveCombinedUserId);
  expect(adminDisplaySigned).toBe(adminDisplayUserId);
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
      role: "Admin",
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
      role: "Admin",
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
        role: "Admin",
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

  // Row 22 — REVIEW REMEDIATION (migration 20261002000001): direct
  // authenticated advisor-row creation is DENIED. The former broad
  // `advisor_insert_active_staff` policy is dropped, so RLS rejects the INSERT
  // (42501) before any trigger, and an absence re-read proves no row was
  // created. Advisor rows are created only by the trusted service-role
  // provisioning path (rows 24 / the protected management API).
  it("denies an authenticated active-staff advisor INSERT of an advisor row (row 22, review remediation)", async () => {
    const email = syntheticEmail("staff-unbound-insert-denied");
    const { data, error } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("staff-unbound-insert-denied"),
        email,
        is_active: true,
      })
      .select("advisor_id")
      .single();
    expect(data ?? [], "a denied advisor INSERT must not return a row").toHaveLength(0);
    expect(error, "authenticated advisor INSERT must be denied").not.toBeNull();
    expect(error?.code, "authenticated advisor INSERT denial error code").toBe("42501");

    // Absence proof: no advisor row was created for the attempted email, even
    // under the service role.
    const { data: remaining } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the denied INSERT").toHaveLength(0);
  });

  // Row 23 — authenticated/active staff INSERT of an advisor row carrying a
  // non-NULL `auth_user_id` is rejected by the one-time-bind trigger (P0001:
  // BEFORE triggers fire before RLS is evaluated, so the non-NULL bind guard
  // raises first). Absence proof: no row was created for that email, even
  // under the service role.
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

  it("can select and insert append-only advising_meeting rows", async () => {
    const { data: visible, error: selectError } = await selfClient
      .from("advising_meeting")
      .select("meeting_id")
      .eq("meeting_id", fixtures.meetingId);
    expect(selectError, "active advisor advising_meeting SELECT").toBeNull();
    expect(visible ?? []).toHaveLength(1);

    const { data: inserted, error: insertError } = await selfClient
      .from("advising_meeting")
      .insert(operationalInsertPayload("advising_meeting"))
      .select("meeting_id")
      .single();
    expect(insertError, "active advisor advising_meeting INSERT").toBeNull();
    expect(inserted).not.toBeNull();
  });

  it("denies an active advisor direct advising_meeting UPDATE and leaves the real row unchanged", async () => {
    await assertMutationBlocked(selfClient, "advising_meeting", "meeting_id", fixtures.meetingId, {
      meeting_mode: "In-Person",
    });
  });

  it("denies an active advisor direct advising_meeting DELETE and leaves the real row present", async () => {
    await assertDeleteBlocked(selfClient, "advising_meeting", "meeting_id", fixtures.meetingId);
  });

  // Regression matrix row 11 — CRUD is proven on every operational table that
  // remains fully mutable (insert → read → update → delete), not a sample.
  it.each(ACTIVE_ADVISOR_FULL_CRUD_TABLES)(
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

  // Migration 20260930000006: active staff may insert/read/update core
  // historical entities, but browser DELETE is revoked and denied at both the
  // grant and RLS-policy levels. Each freshly inserted row is UNREFERENCED (no
  // children), so only the ...006 lockdown — never NO ACTION FK semantics — can
  // be blocking the delete; the service-role re-read proves the row survives.
  it.each(CORE_HISTORY_DELETE_DENIED_TABLES)(
    "active staff can insert, read, and update %s rows but cannot DELETE them (row preserved)",
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

      await assertDeleteBlocked(selfClient, table, idColumn, rowId);
    }
  );

  // Regression matrix row 10 — REVIEW REMEDIATION (migration 20261002000001):
  // active staff can NO LONGER update another advisor's row. The broad
  // `advisor_update_active_staff_only` policy is replaced by the self-scoped
  // `advisor_update_own_profile` policy, so a peer row is invisible for UPDATE
  // (RLS denial / zero rows) and the peer's fields stay byte-for-byte
  // unchanged.
  it("denies an active advisor updating another advisor's non-authorization fields (row 10, review remediation)", async () => {
    await assertMutationBlocked(selfClient, "advisor", "advisor_id", fixtures.advisorOtherId, {
      advisor_name: syntheticName("advisor-renamed-by-staff"),
    });
  });

  // REVIEW REMEDIATION (migration 20261002000001): advisor rows are created
  // and managed ONLY through the trusted service-role provisioning path (the
  // protected management API). An authenticated active advisor can READ advisor
  // rows (staff visibility) but cannot INSERT, cannot UPDATE another advisor's
  // row, and cannot DELETE (the ...006 lockdown). Role/active-state changes go
  // through the Admin-only management API / lifecycle RPC.
  it("denies authenticated advisor INSERT and peer UPDATE; preserves staff read and DELETE denial (advisor management, review remediation)", async () => {
    // INSERT is denied (no authenticated advisor-creation path).
    const deniedEmail = syntheticEmail("staff-managed-advisor-denied");
    const { data: insertData, error: insertError } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("staff-managed-advisor-denied"),
        email: deniedEmail,
        is_active: true,
      })
      .select("advisor_id");
    expect(insertData ?? [], "authenticated advisor INSERT must return no row").toHaveLength(0);
    expect(insertError, "authenticated advisor INSERT must be denied").not.toBeNull();
    expect(insertError?.code, "authenticated advisor INSERT denial code").toBe("42501");
    const { data: absent } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("email", deniedEmail);
    expect(absent ?? [], "no advisor row may exist for the denied INSERT").toHaveLength(0);

    // Staff READ of advisor rows is preserved (own + active-staff visibility).
    const { data: read, error: readError } = await selfClient
      .from("advisor")
      .select("advisor_id")
      .eq("advisor_id", fixtures.advisorSelfId)
      .maybeSingle();
    expect(readError).toBeNull();
    expect(read).not.toBeNull();

    // Peer UPDATE is denied (self-scoped policy).
    await assertMutationBlocked(selfClient, "advisor", "advisor_id", fixtures.advisorOtherId, {
      advisor_name: syntheticName("staff-managed-advisor-peer-update"),
    });

    // DELETE of an advisor row stays denied (the ...006 lockdown).
    await assertDeleteBlocked(selfClient, "advisor", "advisor_id", fixtures.advisorSelfId);
  });
});

describe("advising_meeting_amendment append-only corrections", () => {
  it("lets an active advisor add and read multiple database-authored corrections without changing the original meeting", async () => {
    const { data: originalBefore, error: originalBeforeError } = await service
      .from("advising_meeting")
      .select("*")
      .eq("meeting_id", fixtures.meetingId)
      .single();
    expect(originalBeforeError).toBeNull();

    const forgedTime = "2000-01-01T00:00:00.000Z";
    const first = await selfClient
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: fixtures.meetingId,
        reason: "Correct meeting summary",
        details: "The original notes omitted the application discussion.",
        created_by_advisor_id: fixtures.advisorOtherId,
        created_at: forgedTime,
      })
      .select("amendment_id")
      .single();
    expect(first.error, "active advisor amendment INSERT").toBeNull();
    expect(first.data).not.toBeNull();

    const second = await selfClient
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: fixtures.meetingId,
        reason: "Add follow-up detail",
        details: "The student later confirmed the revised action item.",
      })
      .select("amendment_id")
      .single();
    expect(second.error, "a second correction for the same meeting").toBeNull();
    expect(second.data).not.toBeNull();
    expect(second.data!.amendment_id).not.toBe(first.data!.amendment_id);

    const { data: visible, error: readError } = await selfClient
      .from("advising_meeting_amendment")
      .select("amendment_id, meeting_id, reason, details, created_by_advisor_id, created_at")
      .in("amendment_id", [first.data!.amendment_id, second.data!.amendment_id])
      .order("amendment_id");
    expect(readError, "active advisor amendment SELECT").toBeNull();
    expect(visible ?? []).toHaveLength(2);
    expect(visible?.[0]).toMatchObject({
      amendment_id: first.data!.amendment_id,
      meeting_id: fixtures.meetingId,
      reason: "Correct meeting summary",
      details: "The original notes omitted the application discussion.",
      created_by_advisor_id: fixtures.advisorSelfId,
    });
    expect(String(visible?.[0]?.created_at)).not.toBe(forgedTime);
    expect(visible?.[1]).toMatchObject({
      amendment_id: second.data!.amendment_id,
      meeting_id: fixtures.meetingId,
      reason: "Add follow-up detail",
      created_by_advisor_id: fixtures.advisorSelfId,
    });

    const { data: originalAfter, error: originalAfterError } = await service
      .from("advising_meeting")
      .select("*")
      .eq("meeting_id", fixtures.meetingId)
      .single();
    expect(originalAfterError).toBeNull();
    // The COMPLETE source row is compared before/after the corrections: no
    // column — including metadata, scoping, notes, or mode — may change.
    expect(originalAfter, "a correction must not mutate its source meeting").toEqual(originalBefore);

    const { data: amendmentBefore } = await service
      .from("advising_meeting_amendment")
      .select("*")
      .eq("amendment_id", first.data!.amendment_id)
      .single();
    const update = await selfClient
      .from("advising_meeting_amendment")
      .update({ details: "This update must not apply." })
      .eq("amendment_id", first.data!.amendment_id)
      .select("amendment_id");
    expect(update.data ?? [], "amendment UPDATE affected rows").toHaveLength(0);
    expect(update.error, "active advisor amendment UPDATE is denied").not.toBeNull();
    expect(update.error?.code).toBe("42501");

    const deletion = await selfClient
      .from("advising_meeting_amendment")
      .delete()
      .eq("amendment_id", first.data!.amendment_id);
    expect(deletion.data ?? [], "amendment DELETE affected rows").toHaveLength(0);
    expect(deletion.error, "active advisor amendment DELETE is denied").not.toBeNull();
    expect(deletion.error?.code).toBe("42501");

    const { data: amendmentAfter } = await service
      .from("advising_meeting_amendment")
      .select("*")
      .eq("amendment_id", first.data!.amendment_id)
      .single();
    expect(amendmentAfter, "denied amendment mutations leave its real row unchanged").toEqual(amendmentBefore);
  });

  it("denies unauthenticated and inactive-advisor amendment creation", async () => {
    for (const [label, client] of [["anon", anon], ["inactive", inactiveClient]] as const) {
      const reason = syntheticName(`denied-amendment-${label}`);
      const { data, error } = await client.from("advising_meeting_amendment").insert({
        meeting_id: fixtures.meetingId,
        reason,
        details: "This correction must not be recorded.",
      });
      expect(data ?? [], `${label} amendment INSERT affected rows`).toHaveLength(0);
      expect(error, `${label} amendment INSERT is denied`).not.toBeNull();
      expect(error?.code, `${label} amendment INSERT denial code`).toBe("42501");

      const { data: created, error: reReadError } = await service
        .from("advising_meeting_amendment")
        .select("amendment_id")
        .eq("reason", reason);
      expect(reReadError).toBeNull();
      expect(created ?? [], `${label} denied amendment is absent`).toHaveLength(0);
    }
  });

  it("rejects direct inserts carrying a blank, whitespace-only, or vertical-tab-only reason or details (23514)", async () => {
    // The whitespace-trimming CHECK constraints reject the value at the
    // database boundary even on a direct authenticated insert that would
    // otherwise pass the trigger (creator resolution) and the RLS INSERT
    // policy. Each case keeps a unique non-blank marker on the other field so
    // the service-role absence re-read can prove no row was created (R4).
    // Vertical tab is built with String.fromCharCode(11) so the test source
    // never relies on an escape sequence.
    const verticalTab = String.fromCharCode(11);
    const cases = [
      { label: "blank reason", blankField: "reason" as const, blankValue: "", marker: syntheticName("amendment-blank-reason") },
      { label: "whitespace-only reason", blankField: "reason" as const, blankValue: "   ", marker: syntheticName("amendment-ws-reason") },
      { label: "vertical-tab-only reason", blankField: "reason" as const, blankValue: verticalTab, marker: syntheticName("amendment-vt-reason") },
      { label: "blank details", blankField: "details" as const, blankValue: "", marker: syntheticName("amendment-blank-details") },
      { label: "whitespace-only details", blankField: "details" as const, blankValue: "\t  \n", marker: syntheticName("amendment-ws-details") },
      { label: "vertical-tab-only details", blankField: "details" as const, blankValue: verticalTab, marker: syntheticName("amendment-vt-details") },
    ];

    for (const c of cases) {
      const payload = {
        meeting_id: fixtures.meetingId,
        reason: c.blankField === "reason" ? c.blankValue : c.marker,
        details: c.blankField === "details" ? c.blankValue : c.marker,
      };
      const { data, error } = await selfClient.from("advising_meeting_amendment").insert(payload);
      expect(data ?? [], `${c.label} affected rows`).toHaveLength(0);
      expect(error, `${c.label} direct insert must be rejected by the CHECK constraint`).not.toBeNull();
      expect(error?.code, `${c.label} rejection code`).toBe("23514");

      const { data: created, error: reReadError } = await service
        .from("advising_meeting_amendment")
        .select("amendment_id")
        .eq(c.blankField === "reason" ? "details" : "reason", c.marker);
      expect(reReadError, `${c.label} absence re-read`).toBeNull();
      expect(created ?? [], `no amendment row may exist for ${c.label}`).toHaveLength(0);
    }
  });

  it("never trims the literal letter v from reason or details", async () => {
    // PostgreSQL has no \v escape in E'' strings, so the constraint must not
    // treat 'v' as a vertical-tab trim character. A value consisting solely of
    // the letter v is legitimate non-blank content and must be stored exactly.
    const { data: inserted, error } = await selfClient
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: fixtures.meetingId,
        reason: "v",
        details: "vvv",
      })
      .select("amendment_id")
      .single();
    expect(error, "a literal-v reason/details must be accepted").toBeNull();
    expect(inserted).not.toBeNull();

    const { data: row, error: reReadError } = await service
      .from("advising_meeting_amendment")
      .select("reason, details")
      .eq("amendment_id", inserted!.amendment_id)
      .single();
    expect(reReadError).toBeNull();
    expect(row?.reason, "literal-v reason stored verbatim").toBe("v");
    expect(row?.details, "literal-v details stored verbatim").toBe("vvv");
  });
});

describe("amendment-specific authenticated user with no advisor row is blocked", () => {
  it("cannot read amendment rows (real-row proof)", async () => {
    // Seed a REAL amendment row as an active advisor, then prove the
    // no-advisor account reads ZERO amendment rows while the seeded row still
    // exists under the service role (R4: 0 rows alone never counts as blocked).
    const { data: seeded, error: seedError } = await selfClient
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: fixtures.meetingId,
        reason: syntheticName("no-advisor-amendment-read-target"),
        details: "Real amendment row used as the SELECT-denial proof target.",
      })
      .select("amendment_id")
      .single();
    expect(seedError).toBeNull();
    expect(seeded).not.toBeNull();

    const { data, error } = await amendmentNoAdvisorClient
      .from("advising_meeting_amendment")
      .select("*");
    if (error) {
      expect(error.code, "amendment read error code").toBe("42501");
    } else {
      expect(data ?? [], "amendment read rows").toHaveLength(0);
    }

    // The hidden target is REAL: the seeded amendment row still exists.
    const { data: real, error: reReadError } = await service
      .from("advising_meeting_amendment")
      .select("amendment_id")
      .eq("amendment_id", seeded!.amendment_id)
      .maybeSingle();
    expect(reReadError).toBeNull();
    expect(real).not.toBeNull();
  });

  it("cannot insert an amendment (no row created)", async () => {
    const reason = syntheticName("no-advisor-amendment-insert");
    const { data, error } = await amendmentNoAdvisorClient
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: fixtures.meetingId,
        reason,
        details: "This amendment must not be recorded.",
      });
    expect(data ?? [], "amendment insert affected rows").toHaveLength(0);
    expect(error, "amendment insert is denied").not.toBeNull();
    expect(error?.code, "amendment insert denial code").toBe("42501");

    // Absence proof: no amendment row exists for the attempted reason, even
    // under the service role.
    const { data: created, error: reReadError } = await service
      .from("advising_meeting_amendment")
      .select("amendment_id")
      .eq("reason", reason);
    expect(reReadError).toBeNull();
    expect(created ?? [], "no amendment row may exist for the denied insert").toHaveLength(0);
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

// Hardening Work 1 / R1–R2: table-driven CRUD denial matrices for the two
// authenticated-but-not-staff identities — the pre-bound INACTIVE advisor and
// the authenticated user with NO advisor row. Every assertion targets a real
// seeded row (`seededOperationalIds()`) and every denial is proven by a
// service-role re-read that the row still exists and is unchanged (R4);
// denied INSERTs additionally carry a deterministic unique identifier and are
// proven absent by a service-role re-read (no matching row exists).
describe("pre-bound inactive advisor CRUD denial matrix on every operational table (Work 1)", () => {
  it.each(OPERATIONAL_TABLES)("cannot read %s rows", async (table) => {
    await assertReadBlocked(inactiveClient, table, ID_COLUMN[table], seededOperationalIds()[table]);
  });

  it.each(OPERATIONAL_TABLES)("cannot insert into %s (no row created)", async (table) => {
    await assertInsertBlocked(
      inactiveClient,
      table,
      deniedInsertPayload(table, "inactive", inactiveDenialStudentId, inactiveDenialFellowshipId)
    );
  });

  it.each(OPERATIONAL_TABLES)("cannot update %s rows", async (table) => {
    await assertMutationBlocked(
      inactiveClient,
      table,
      ID_COLUMN[table],
      seededOperationalIds()[table],
      operationalUpdatePayload(table)
    );
  });

  it.each(OPERATIONAL_TABLES)("cannot delete %s rows", async (table) => {
    await assertDeleteBlocked(inactiveClient, table, ID_COLUMN[table], seededOperationalIds()[table]);
  });
});

describe("no-advisor authenticated user CRUD denial matrix on every operational table (Work 1)", () => {
  it.each(OPERATIONAL_TABLES)("cannot read %s rows", async (table) => {
    await assertReadBlocked(noAdvisorClient, table, ID_COLUMN[table], seededOperationalIds()[table]);
  });

  it.each(OPERATIONAL_TABLES)("cannot insert into %s (no row created)", async (table) => {
    await assertInsertBlocked(
      noAdvisorClient,
      table,
      deniedInsertPayload(table, "no-advisor", noAdvisorDenialStudentId, noAdvisorDenialFellowshipId)
    );
  });

  it.each(OPERATIONAL_TABLES)("cannot update %s rows", async (table) => {
    await assertMutationBlocked(
      noAdvisorClient,
      table,
      ID_COLUMN[table],
      seededOperationalIds()[table],
      operationalUpdatePayload(table)
    );
  });

  it.each(OPERATIONAL_TABLES)("cannot delete %s rows", async (table) => {
    await assertDeleteBlocked(noAdvisorClient, table, ID_COLUMN[table], seededOperationalIds()[table]);
  });
});

describe("advisor.role display vocabulary and role-write guard (migration 20261001000001)", () => {
  it("stores only the exact display values Admin/Advisor in every advisor row", async () => {
    const { data, error } = await selfClient.from("advisor").select("advisor_id, role");
    expect(error, "active staff advisor role read").toBeNull();
    expect((data ?? []).length, "active staff reads every advisor row").toBeGreaterThan(0);
    const roles = new Set((data ?? []).map((row: { role: string }) => row.role));
    for (const role of roles) {
      expect(["Admin", "Advisor"], `stored display role ${role}`).toContain(role);
    }
    // The admin-display fixture row carries the trusted Admin projection.
    const { data: displayRow } = await service
      .from("advisor")
      .select("role")
      .eq("advisor_id", adminDisplayId)
      .maybeSingle();
    expect(displayRow?.role, "admin-display fixture role").toBe("Admin");
  });

  it("lets the trusted service_role set the Admin display role through the provisioning path", async () => {
    const email = syntheticEmail("provisioned-admin-role");
    const { data: inserted, error: insertError } = await service
      .from("advisor")
      .insert({ advisor_name: syntheticName("provisioned-admin-role"), email, is_active: true })
      .select("advisor_id")
      .single();
    expect(insertError, "provisioned advisor insert").toBeNull();

    const { data: updated, error: updateError } = await service
      .from("advisor")
      .update({ role: "Admin" })
      .eq("advisor_id", inserted!.advisor_id)
      .select("advisor_id, role, auth_user_id")
      .single();
    expect(updateError, "trusted role=Admin update").toBeNull();
    expect(updated?.role, "trusted role update stored value").toBe("Admin");
    // The one-time bind is untouched: an unbound row stays unbound.
    expect(updated?.auth_user_id, "role update must never touch the bind").toBeNull();
  });

  it("lets an authenticated active advisor pass a no-op restatement of their current display role", async () => {
    const { data, error } = await selfClient
      .from("advisor")
      .update({ role: "Advisor" })
      .eq("advisor_id", fixtures.advisorSelfId)
      .select("advisor_id");
    expect(error, "no-op role restatement must pass through").toBeNull();
    expect(data ?? [], "no-op role restatement affects one row").toHaveLength(1);
  });

  it("denies an active advisor elevating their OWN role to Admin (42501, row unchanged)", async () => {
    await assertMutationBlocked(selfClient, "advisor", "advisor_id", fixtures.advisorSelfId, {
      role: "Admin",
    });
  });

  it("denies an active advisor changing a PEER's role to Admin (42501, row unchanged)", async () => {
    await assertMutationBlocked(selfClient, "advisor", "advisor_id", fixtures.advisorOtherId, {
      role: "Admin",
    });
  });

  it("lets an active advisor update their OWN bound row's allowed profile fields (self-scoped, review remediation)", async () => {
    // The self-scoped `advisor_update_own_profile` policy keeps the own-row
    // profile path (advisor_name / email) working for an active, pre-bound
    // advisor, while the column-scoped guards still protect role/is_active/
    // auth_user_id on the same row.
    const renamed = syntheticName("advisor-self-renamed");
    const { data, error } = await selfClient
      .from("advisor")
      .update({ advisor_name: renamed })
      .eq("advisor_id", fixtures.advisorSelfId)
      .select("advisor_id");
    expect(error, "own-profile UPDATE must succeed through the self-scoped policy").toBeNull();
    expect(data ?? [], "own-profile UPDATE must affect one row").toHaveLength(1);

    const row = await readRow("advisor", "advisor_id", fixtures.advisorSelfId);
    expect(row?.advisor_name, "own advisor_name updated").toBe(renamed);
    // The protected display role, lifecycle state, and binding are untouched.
    expect(row?.role, "own display role unchanged").toBe("Advisor");
    expect(row?.is_active, "own lifecycle state unchanged").toBe(true);
    expect(row?.auth_user_id, "own binding unchanged").toBe(selfUserId);
  });

  it("denies the admin-display advisor (no claim) changing a peer's role to Admin (42501, row unchanged)", async () => {
    // The Admin display projection grants no role-management authority: even
    // the trusted display value is rejected for a non-trusted session.
    await assertMutationBlocked(adminDisplayClient, "advisor", "advisor_id", fixtures.advisorOtherId, {
      role: "Admin",
    });
  });
});

describe("Advisor cannot promote, self-activate, or provision (display role is never authority)", () => {
  it("denies an active advisor INSERTing an advisor row already displaying Admin (provisioning, 42501, no row created)", async () => {
    const email = syntheticEmail("advisor-provision-denied");
    const { data, error } = await selfClient
      .from("advisor")
      .insert({
        advisor_name: syntheticName("advisor-provision-denied"),
        email,
        is_active: true,
        role: "Admin",
      })
      .select("advisor_id");
    expect(data ?? [], "a denied Admin-role INSERT must not return a row").toHaveLength(0);
    expect(error, "Admin-role advisor INSERT must be denied").not.toBeNull();
    expect(error?.code, "Admin-role advisor INSERT denial code").toBe("42501");

    // Absence proof: no row was created for the attempted email.
    const { data: remaining } = await service.from("advisor").select("advisor_id").eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the denied Admin-role INSERT").toHaveLength(0);
  });

  it("denies a pre-bound inactive advisor self-activation and role elevation on their own row", async () => {
    // The pre-bound inactive advisor has NO UPDATE path (not active staff), so
    // the lifecycle-guard / role-guard denials close the residual paths.
    await assertMutationBlocked(inactiveClient, "advisor", "advisor_id", fixtures.advisorInactiveId, {
      is_active: true,
    });
    await assertMutationBlocked(inactiveClient, "advisor", "advisor_id", fixtures.advisorInactiveId, {
      role: "Admin",
    });
  });

  it("keeps the Admin-display advisor within ordinary staff powers and denies every Admin-only action", async () => {
    // Display role 'Admin' + no claim: normal staff read, but no lifecycle
    // authority, no role writes, and no direct lifecycle-field writes.
    const { data: students, error: readError } = await adminDisplayClient.from("student").select("student_id");
    expect(readError, "admin-display advisor student read").toBeNull();
    expect((students ?? []).length, "admin-display advisor is ordinary active staff").toBeGreaterThan(0);

    const { data: transitionData, error: transitionError } = await adminDisplayClient.rpc(
      "lifecycle_transition",
      { p_entity: "student", p_action: "archive", p_entity_id: fixtures.studentId }
    );
    expect(transitionData, "no-claim lifecycle transition must return no row").toBeNull();
    expect(transitionError, "no-claim lifecycle transition must be denied").not.toBeNull();
    expect(transitionError?.code, "no-claim lifecycle transition denial code").toBe("42501");

    await assertMutationBlocked(adminDisplayClient, "student", "student_id", fixtures.studentId, {
      archived_at: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("immutable meeting/amendment direct mutation is denied for BOTH display roles (migration 20261001000001)", () => {
  it.each(["Advisor display role", "Admin display role"] as const)(
    "denies direct advising_meeting UPDATE and DELETE for the %s",
    async (label) => {
      const client = label === "Admin display role" ? adminDisplayClient : selfClient;
      await assertMutationBlocked(client, "advising_meeting", "meeting_id", fixtures.meetingId, {
        meeting_mode: "In-Person",
      });
      await assertDeleteBlocked(client, "advising_meeting", "meeting_id", fixtures.meetingId);
    }
  );

  it.each(["Advisor display role", "Admin display role"] as const)(
    "denies direct advising_meeting_amendment UPDATE and DELETE for the %s",
    async (label) => {
      // Seed a real amendment as an active advisor (append-only INSERT path).
      const { data: seeded, error: seedError } = await selfClient
        .from("advising_meeting_amendment")
        .insert({
          meeting_id: fixtures.meetingId,
          reason: syntheticName("role-immutability-amendment"),
          details: "Immutable amendment used as the direct-write denial target.",
        })
        .select("amendment_id")
        .single();
      expect(seedError, "amendment INSERT for the denial target").toBeNull();

      const client = label === "Admin display role" ? adminDisplayClient : selfClient;
      const { data: updated, error: updateError } = await client
        .from("advising_meeting_amendment")
        .update({ details: "This update must not apply." })
        .eq("amendment_id", seeded!.amendment_id)
        .select("amendment_id");
      expect(updated ?? [], `${label} amendment UPDATE affected rows`).toHaveLength(0);
      expect(updateError, `${label} amendment UPDATE must be denied`).not.toBeNull();
      expect(updateError?.code, `${label} amendment UPDATE denial code`).toBe("42501");

      const { data: deleted, error: deleteError } = await client
        .from("advising_meeting_amendment")
        .delete()
        .eq("amendment_id", seeded!.amendment_id);
      expect(deleted ?? [], `${label} amendment DELETE affected rows`).toHaveLength(0);
      expect(deleteError, `${label} amendment DELETE must be denied`).not.toBeNull();
      expect(deleteError?.code, `${label} amendment DELETE denial code`).toBe("42501");

      // The immutable amendment row still exists under the service role.
      const { data: stillThere } = await service
        .from("advising_meeting_amendment")
        .select("amendment_id")
        .eq("amendment_id", seeded!.amendment_id)
        .maybeSingle();
      expect(stillThere, "immutable amendment row preserved").not.toBeNull();
    }
  );
});

describe("deactivated advisor loses operational data while historical advisor-linked records stay readable (migration 20261001000001)", () => {
  it("keeps the deactivated advisor's historical meeting readable by OTHER active staff but hides it from the deactivated advisor", async () => {
    // Historical advisor-linked data: a meeting conducted by the pre-bound
    // INACTIVE (deactivated) advisor, seeded through the trusted path.
    const { data: historical, error: seedError } = await service
      .from("advising_meeting")
      .insert({
        student_id: fixtures.studentId,
        advisor_id: fixtures.advisorInactiveId,
        meeting_date: "2026-08-15",
        meeting_mode: "Virtual",
        notes: "Historical meeting conducted by a now-deactivated advisor.",
      })
      .select("meeting_id")
      .single();
    expect(seedError, "historical advisor-linked meeting seed").toBeNull();
    const meetingId = historical!.meeting_id as number;

    // Operational denial: the deactivated advisor cannot read operational data.
    await assertReadBlocked(inactiveClient, "student", "student_id", fixtures.studentId);

    // Staff historical view: OTHER active staff still read the meeting that
    // references the deactivated advisor, and attribution is intact.
    const { data: visible, error: readError } = await selfClient
      .from("advising_meeting")
      .select("meeting_id, advisor_id")
      .eq("meeting_id", meetingId)
      .maybeSingle();
    expect(readError, "active-staff historical meeting read").toBeNull();
    expect(visible, "historical meeting readable through the staff view").not.toBeNull();
    expect(visible?.advisor_id, "historical advisor attribution intact").toBe(fixtures.advisorInactiveId);

    // The deactivated advisor's own session is NOT active staff: the meeting is
    // hidden from them (zero rows), while the real row still exists (R4).
    const { data: hidden, error: hiddenError } = await inactiveClient
      .from("advising_meeting")
      .select("meeting_id")
      .eq("meeting_id", meetingId);
    if (hiddenError) {
      expect(hiddenError.code, "deactivated advisor historical read error code").toBe("42501");
    } else {
      expect(hidden ?? [], "deactivated advisor must read zero historical meetings").toHaveLength(0);
    }
    const { data: real } = await service
      .from("advising_meeting")
      .select("meeting_id")
      .eq("meeting_id", meetingId)
      .maybeSingle();
    expect(real, "the hidden historical meeting must still exist (real-row proof)").not.toBeNull();
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

  it("anon cannot EXECUTE the is_effective_admin predicate", async () => {
    const { data, error } = await anon.rpc("is_effective_admin");
    expect(data, "anon is_effective_admin must yield no data").toBeNull();
    expect(error, "anon is_effective_admin must be denied").not.toBeNull();
    expect(error?.code, "anon is_effective_admin denial code").toBe("42501");
  });
});
