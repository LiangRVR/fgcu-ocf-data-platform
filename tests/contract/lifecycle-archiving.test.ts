/**
 * tests/contract/lifecycle-archiving.test.ts
 *
 * Contract tests for migration 20260930000005_entity_lifecycle_archiving
 * (plan Work 5, acceptance criteria R1/R2/R6/R7 + NFR1).
 *
 * The migration replaces destructive deletes with a secure, reversible
 * lifecycle model: nullable `student.archived_at`/`fellowship.archived_at`,
 * the trusted `is_ocf_admin()` JWT-claim predicate, the migration-owned
 * SECURITY DEFINER `lifecycle_transition(entity, action, entity_id)` RPC, and
 * invoker-security column-scoped triggers guarding the lifecycle fields.
 *
 * This suite proves, against the isolated Docker-local contract lane:
 *
 *   - ADMIN AUTHORITY: the ONLY administrator authority is the immutable Auth
 *     `app_metadata.ocf_admin = true` claim. The mutable `advisor.role` column
 *     is never authorization (an advisor with `role = 'Admin'` but no claim is
 *     denied). `is_ocf_admin()` resolves true only for the claim-bearing
 *     session.
 *   - RPC WHITELIST + IDEMPOTENCE: archive|restore for student/fellowship and
 *     deactivate|reactivate for advisor only; the second application of a
 *     state is a no-op (`applied = false`) returning the unchanged state;
 *     invalid entity/action pairs and missing rows fail closed (22023/P0002).
 *   - ACTOR DERIVATION: the actor is derived from `auth.uid()` only. anon and
 *     a non-admin active advisor are denied at the database boundary; an
 *     authenticated user with no advisor row is denied; and a service_role
 *     technical session — even though Supabase default privileges leave it
 *     function EXECUTE — has no JWT subject, so `auth.uid()` is NULL and the
 *     RPC fails closed (42501). Every transition is therefore attributable to
 *     a specific signed-in administrator.
 *   - ACTIVE-BOUND-ADVISOR REQUIREMENT (review remediation, migration
 *     ...007): the immutable admin claim ALONE is not authorization — the RPC
 *     also requires a CURRENT, ACTIVE, pre-bound advisor identity
 *     (`advisor.auth_user_id = auth.uid()` AND `is_active = true`). A
 *     claim-bearing user with no advisor row, and a DEACTIVATED administrator
 *     whose bound advisor row is inactive, are both denied EVERY transition
 *     (42501) — so a deactivated administrator can never self-reactivate and
 *     defeat deactivation. There is no email linking and no self binding: the
 *     check only reads the admin-provisioned binding.
 *   - STRICT BOOLEAN CLAIM + EFFECTIVE-ADMIN PREDICATE (migration ...001):
 *     `is_ocf_admin()` compares a JSON BOOLEAN (a string `"true"` claim is
 *     never accepted), and `is_effective_admin()` additionally requires an
 *     ACTIVE pre-bound advisor row — the claim alone, a deactivated binding,
 *     and a string claim all resolve false.
 *   - SELF-DEACTIVATION GUARD: an ACTIVE administrator cannot deactivate their
 *     own advisor row (it would instantly strand their session); a second
 *     administrator can. Reactivation of the caller's own row is possible ONLY
 *     while the caller is an active bound advisor — never after deactivation.
 *   - ARCHIVE-PARENT CHILD BOUNDARY (review remediation, migration ...007):
 *     the database boundary rejects new operational child records (application,
 *     advising_meeting, fellowship_thursday, scholarship_history) that
 *     reference archived students/fellowships — INSERT of a child referencing
 *     an archived parent and UPDATE re-linking a child to an archived parent
 *     are denied (42501) for authenticated sessions, while historical reads of
 *     those children, non-reference updates to them, re-links to ACTIVE
 *     parents, and all active-parent workflows pass through. Trusted
 *     service_role/DBA sessions remain exempt for fixture seeding/fixes.
 *   - DIRECT-WRITE GUARDS (NFR1): browser-level writes to the lifecycle fields
 *     are enforced at the database boundary, not just by UI filters: direct
 *     UPDATE/INSERT forgery of `student.archived_at`,
 *     `fellowship.archived_at`, and `advisor.is_active` (including peer
 *     deactivation through the broad active-staff UPDATE policy) is rejected
 *     with 42501 and proven unchanged/absent by a service-role re-read, while
 *     ordinary writes to non-lifecycle columns and no-op restatements of the
 *     current lifecycle value pass through.
 *   - IMMEDIATE ACCESS DENIAL (R1): deactivating an advisor instantly blocks
 *     that advisor's existing session from operational data (the active-advisor
 *     RLS gate flips) while their historical meeting attribution is preserved;
 *     reactivation restores access.
 *   - HISTORY PRESERVATION (R2/R7): archiving a student or fellowship keeps
 *     every application, advising meeting, attendance, and scholarship-history
 *     row referencing it (NO ACTION FKs untouched), historical joins still
 *     resolve the archived name, and deleting an archived parent still fails
 *     with the FK violation.
 *
 * Service-role usage is restricted to seeding synthetic fixtures, creating
 * local auth users, performing the admin pre-bind, and re-reading rows to
 * prove "denied + unchanged/absent" (the R4 proof). Service-role access is
 * never asserted as a feature.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createAnonClient,
  createDbPool,
  createServiceRoleClient,
  getContractEnv,
} from "./helpers/setup";
import {
  createAuthUser,
  seedCoreFixtures,
  signInWithPassword,
  syntheticEmail,
  syntheticName,
} from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);
let pool: Pool;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** A signed-in synthetic account bound to an `advisor` row (or standalone). */
interface BoundActor {
  userId: string;
  email: string;
  advisorName: string;
  client: SupabaseClient;
  advisorId?: number;
}

let fixtureSeq = 0;
function nextUnique(prefix: string): string {
  // syntheticName/syntheticEmail share one RUN_TOKEN per process; a per-call
  // sequence makes every fixture row unique within the run.
  fixtureSeq += 1;
  return `${prefix}-${fixtureSeq}`;
}

function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function insertAdvisor(advisorName: string, email: string, isActive: boolean): Promise<number> {
  const { data, error } = await service
    .from("advisor")
    .insert({ advisor_name: advisorName, email, is_active: isActive })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`seed advisor ${advisorName}: ${error.message}`);
  return data.advisor_id as number;
}

/** ADMIN PRE-BINDING: the only legitimate way `auth_user_id` is ever written. */
async function bindAdvisor(advisorId: number, userId: string): Promise<void> {
  const { error } = await service
    .from("advisor")
    .update({ auth_user_id: userId })
    .eq("advisor_id", advisorId)
    .select("advisor_id");
  if (error) throw new Error(`admin pre-bind advisor ${advisorId}: ${error.message}`);
}

/** Signed-in administrator: Auth `app_metadata.ocf_admin = true` claim, bound to an advisor row. */
async function createAdmin(label: string, isActive = true): Promise<BoundActor> {
  const tag = nextUnique(`admin-${label}`);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(service, email, { appMetadata: { ocf_admin: true } });
  const advisorId = await insertAdvisor(advisorName, email, isActive);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`admin ${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

/** Signed-in authenticated advisor WITHOUT the ocf_admin claim. */
async function createBoundAdvisor(label: string, isActive = true): Promise<BoundActor> {
  const tag = nextUnique(`actor-${label}`);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(service, email);
  const advisorId = await insertAdvisor(advisorName, email, isActive);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`advisor ${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

/** Signed-in authenticated user with NO advisor row at all. */
async function createNoAdvisorUser(label: string): Promise<BoundActor> {
  const tag = nextUnique(`no-advisor-${label}`);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`no-advisor ${label} sign-in returned a different user`);
  return { userId, email, advisorName: "", client };
}

/**
 * Signed-in authenticated user carrying the trusted `ocf_admin` JWT claim but
 * with NO advisor row at all. Proves the claim alone is insufficient: the
 * review-remediation RPC requires an active bound advisor in addition.
 */
async function createClaimNoAdvisor(label: string): Promise<BoundActor> {
  const tag = nextUnique(`claim-no-advisor-${label}`);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email, { appMetadata: { ocf_admin: true } });
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`claim-no-advisor ${label} sign-in returned a different user`);
  return { userId, email, advisorName: "", client };
}

/**
 * Signed-in authenticated user bound to an ACTIVE advisor row whose Auth
 * `app_metadata.ocf_admin` claim is the STRING `"true"` (not the JSON boolean
 * `true`). Proves the strict JSON-boolean comparison in the hardened
 * `is_ocf_admin()`: a string claim is never accepted, so neither the predicate
 * nor the effective-Admin authority can be satisfied by type coercion.
 */
async function createStringClaimAdmin(label: string): Promise<BoundActor> {
  const tag = nextUnique(`string-claim-${label}`);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(service, email, { appMetadata: { ocf_admin: "true" } });
  const advisorId = await insertAdvisor(advisorName, email, true);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`string-claim ${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

/**
 * One self-contained archive scenario: a fresh student + fellowship with the
 * full dependent-child set (application linking both, advising meeting,
 * fellowship-thursday attendance, scholarship history) so a parent archive has
 * every relationship to preserve. Returns the created ids.
 */
async function seedArchivePair(
  label: string,
  advisorId: number
): Promise<{ studentId: number; fellowshipId: number; applicationId: number }> {
  const tag = nextUnique(`archive-${label}`);
  const { data: student, error: studentError } = await service
    .from("student")
    .insert({
      full_name: syntheticName(tag),
      email: syntheticEmail(tag),
      us_citizen: true,
    })
    .select("student_id")
    .single();
  if (studentError) throw new Error(`seed archive student ${label}: ${studentError.message}`);

  const { data: fellowship, error: fellowshipError } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(`${tag}-fellowship`) })
    .select("fellowship_id")
    .single();
  if (fellowshipError) throw new Error(`seed archive fellowship ${label}: ${fellowshipError.message}`);

  const { data: application, error: applicationError } = await service
    .from("application")
    .insert({
      student_id: student!.student_id,
      fellowship_id: fellowship!.fellowship_id,
      stage_of_application: "Submitted",
      destination_country: "Testland",
    })
    .select("application_id")
    .single();
  if (applicationError) throw new Error(`seed archive application ${label}: ${applicationError.message}`);

  const { error: meetingError } = await service.from("advising_meeting").insert({
    student_id: student!.student_id,
    advisor_id: advisorId,
    meeting_date: "2026-09-01",
    meeting_mode: "Virtual",
    notes: `Lifecycle contract meeting ${label}`,
  });
  if (meetingError) throw new Error(`seed archive meeting ${label}: ${meetingError.message}`);

  const { error: attendanceError } = await service.from("fellowship_thursday").insert({
    student_id: student!.student_id,
    attended: true,
    source_info: "OCF",
  });
  if (attendanceError) throw new Error(`seed archive attendance ${label}: ${attendanceError.message}`);

  const { error: historyError } = await service.from("scholarship_history").insert({
    student_id: student!.student_id,
    fellowship_id: fellowship!.fellowship_id,
  });
  if (historyError) throw new Error(`seed archive history ${label}: ${historyError.message}`);

  return {
    studentId: student!.student_id as number,
    fellowshipId: fellowship!.fellowship_id as number,
    applicationId: application!.application_id as number,
  };
}

interface LifecycleResult {
  entity: string;
  entity_id: number;
  action: string;
  applied: boolean;
  archived_at: string | null;
  is_active: boolean | null;
}

async function transition(
  client: SupabaseClient,
  entity: string,
  action: string,
  entityId: number | null | undefined
): Promise<{ data: LifecycleResult[] | null; error: { code?: string; message?: string } | null }> {
  const { data, error } = await client.rpc("lifecycle_transition", {
    p_entity: entity,
    p_action: action,
    p_entity_id: entityId ?? null,
  });
  return { data: data as LifecycleResult[] | null, error };
}

/** Service-role re-read of a row; used to prove "denied + unchanged". */
async function readRow(
  table:
    | "student"
    | "fellowship"
    | "advisor"
    | "application"
    | "fellowship_thursday"
    | "scholarship_history",
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

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let adminOne: BoundActor; // primary acting administrator (own advisor: admin-1)
let adminTwo: BoundActor; // second administrator (own advisor: admin-2)
let staffActive: BoundActor; // active advisor, role='Admin' but NO ocf_admin claim
let noAdvisor: BoundActor; // authenticated user with no advisor row
let claimNoAdvisor: BoundActor; // ocf_admin claim but NO advisor row (review remediation)
let deactivatedAdmin: BoundActor; // ocf_admin claim, bound to an INACTIVE advisor (review remediation)
let stringClaimAdmin: BoundActor; // STRING "true" ocf_admin claim, bound to an ACTIVE advisor (migration ...001)

beforeAll(async () => {
  pool = createDbPool(env);

  // Core operational rows (student, fellowship, application, meeting,
  // attendance, history) for the cross-entity read assertions.
  await seedCoreFixtures(service);

  adminOne = await createAdmin("one");
  adminTwo = await createAdmin("two");
  staffActive = await createBoundAdvisor("staff-active");
  noAdvisor = await createNoAdvisorUser("user");
  claimNoAdvisor = await createClaimNoAdvisor("user");
  deactivatedAdmin = await createAdmin("deactivated", false);
  stringClaimAdmin = await createStringClaimAdmin("user");

  // The mutable advisor.role column is NEVER authorization (design §Security):
  // give the non-claim active advisor the most privileged-looking display role
  // so the suite proves lifecycle decisions ignore it entirely.
  const { error: roleError } = await service
    .from("advisor")
    .update({ role: "Admin" })
    .eq("advisor_id", staffActive.advisorId!)
    .select("advisor_id");
  if (roleError) throw new Error(`set staff-active role=Admin: ${roleError.message}`);
});

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// RPC behavior: trusted administrator authority
// ---------------------------------------------------------------------------

describe("is_ocf_admin trusted predicate (R6)", () => {
  it("resolves true for an administrator carrying the ocf_admin app_metadata claim", async () => {
    const { data, error } = await adminOne.client.rpc("is_ocf_admin");
    expect(error, "admin is_ocf_admin call").toBeNull();
    expect(data, "admin is_ocf_admin() must be true").toBe(true);
  });

  it("resolves false for an authenticated advisor without the claim, even with advisor.role='Admin'", async () => {
    const { data, error } = await staffActive.client.rpc("is_ocf_admin");
    expect(error, "non-admin is_ocf_admin call").toBeNull();
    expect(data, "non-admin is_ocf_admin() must be false").toBe(false);
  });

  it("denies anon the predicate (no EXECUTE)", async () => {
    const { data, error } = await anon.rpc("is_ocf_admin");
    expect(data, "anon is_ocf_admin must yield no data").toBeNull();
    expect(error, "anon is_ocf_admin must be denied").not.toBeNull();
    expect(error?.code, "anon is_ocf_admin denial code").toBe("42501");
  });
});

describe("is_effective_admin predicate: active bound advisor + strict boolean claim (migration 20261001000001)", () => {
  it("resolves true for an ACTIVE, pre-bound advisor carrying the boolean ocf_admin claim", async () => {
    const { data, error } = await adminOne.client.rpc("is_effective_admin");
    expect(error, "effective admin call").toBeNull();
    expect(data, "effective Admin must resolve true").toBe(true);
  });

  it("resolves false for an active advisor without the claim, even with the Admin display role", async () => {
    const { data, error } = await staffActive.client.rpc("is_effective_admin");
    expect(error, "non-claim staff effective-admin call").toBeNull();
    expect(data, "a claim-less active advisor is never an effective Admin").toBe(false);
  });

  it("resolves false for a claim-bearing user with NO advisor row (no binding)", async () => {
    const { data, error } = await claimNoAdvisor.client.rpc("is_effective_admin");
    expect(error, "claim-no-advisor effective-admin call").toBeNull();
    expect(data, "the claim alone (no active bound advisor) is never effective").toBe(false);
  });

  it("resolves false for a claim-bearing user bound to an INACTIVE advisor (deactivated admin)", async () => {
    const { data, error } = await deactivatedAdmin.client.rpc("is_effective_admin");
    expect(error, "deactivated admin effective-admin call").toBeNull();
    expect(data, "a deactivated bound advisor is never an effective Admin").toBe(false);
  });

  it("resolves false for an active bound advisor whose claim is the STRING 'true' (strict JSON boolean)", async () => {
    expect(stringClaimAdmin.advisorId).toBeDefined();
    const { data, error } = await stringClaimAdmin.client.rpc("is_effective_admin");
    expect(error, "string-claim effective-admin call").toBeNull();
    expect(data, "a string claim must never satisfy the strict boolean predicate").toBe(false);
  });

  it("denies anon the predicate (no EXECUTE)", async () => {
    const { data, error } = await anon.rpc("is_effective_admin");
    expect(data, "anon is_effective_admin must yield no data").toBeNull();
    expect(error, "anon is_effective_admin must be denied").not.toBeNull();
    expect(error?.code, "anon is_effective_admin denial code").toBe("42501");
  });
});

describe("strict JSON-boolean admin claim (migration 20261001000001)", () => {
  it("rejects the string 'true' claim in is_ocf_admin even for an active bound advisor", async () => {
    const { data, error } = await stringClaimAdmin.client.rpc("is_ocf_admin");
    expect(error, "string-claim is_ocf_admin call").toBeNull();
    expect(data, "a string 'true' claim must resolve is_ocf_admin() = false").toBe(false);
  });

  it("denies an active bound string-claim advisor EVERY lifecycle transition (42501, no row changed)", async () => {
    const { studentId } = await seedArchivePair("string-claim", adminOne.advisorId!);
    const { data, error } = await transition(stringClaimAdmin.client, "student", "archive", studentId);
    expect(data, "string-claim archive must return no row").toBeNull();
    expect(error, "string-claim archive must be denied").not.toBeNull();
    expect(error?.code, "string-claim archive denial code").toBe("42501");
    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at, "denied string-claim archive leaves the row active").toBeNull();
  });
});

describe("lifecycle_transition: student archive/restore idempotence (R2)", () => {
  it("archives, re-archives (no-op), restores, and re-restores (no-op) a student, returning the resulting state", async () => {
    const { studentId } = await seedArchivePair("student-idem", adminOne.advisorId!);

    const first = await transition(adminOne.client, "student", "archive", studentId);
    expect(first.error, "first student archive").toBeNull();
    expect(first.data).toHaveLength(1);
    expect(first.data![0]).toMatchObject({
      entity: "student",
      entity_id: studentId,
      action: "archive",
      applied: true,
      is_active: null,
    });
    const archivedAt = first.data![0].archived_at;
    expect(archivedAt, "archive must stamp a database-authored timestamp").not.toBeNull();

    // Idempotent no-op: the same transition is applied=false and the stored
    // timestamp is unchanged.
    const second = await transition(adminOne.client, "student", "archive", studentId);
    expect(second.error, "second student archive").toBeNull();
    expect(second.data![0]).toMatchObject({
      entity: "student",
      entity_id: studentId,
      action: "archive",
      applied: false,
    });
    expect(second.data![0].archived_at, "idempotent archive keeps the same timestamp").toBe(archivedAt);

    const restored = await transition(adminOne.client, "student", "restore", studentId);
    expect(restored.error, "student restore").toBeNull();
    expect(restored.data![0]).toMatchObject({
      entity: "student",
      entity_id: studentId,
      action: "restore",
      applied: true,
    });
    expect(restored.data![0].archived_at, "restore must clear the archive timestamp").toBeNull();

    const reRestored = await transition(adminOne.client, "student", "restore", studentId);
    expect(reRestored.error, "second student restore").toBeNull();
    expect(reRestored.data![0]).toMatchObject({
      entity: "student",
      entity_id: studentId,
      action: "restore",
      applied: false,
    });
    expect(reRestored.data![0].archived_at, "idempotent restore stays active").toBeNull();

    // Database proof: the lifecycle field reflects the final restored state.
    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at).toBeNull();
  });
});

describe("lifecycle_transition: fellowship archive/restore idempotence (R2)", () => {
  it("archives, re-archives (no-op), restores, and re-restores (no-op) a fellowship", async () => {
    const { fellowshipId } = await seedArchivePair("fellowship-idem", adminOne.advisorId!);

    const first = await transition(adminOne.client, "fellowship", "archive", fellowshipId);
    expect(first.error, "first fellowship archive").toBeNull();
    expect(first.data![0]).toMatchObject({ entity: "fellowship", action: "archive", applied: true });
    const archivedAt = first.data![0].archived_at;
    expect(archivedAt).not.toBeNull();

    const second = await transition(adminOne.client, "fellowship", "archive", fellowshipId);
    expect(second.data![0]).toMatchObject({ entity: "fellowship", action: "archive", applied: false });
    expect(second.data![0].archived_at).toBe(archivedAt);

    const restored = await transition(adminOne.client, "fellowship", "restore", fellowshipId);
    expect(restored.data![0]).toMatchObject({ entity: "fellowship", action: "restore", applied: true });
    expect(restored.data![0].archived_at).toBeNull();

    const reRestored = await transition(adminOne.client, "fellowship", "restore", fellowshipId);
    expect(reRestored.data![0]).toMatchObject({ entity: "fellowship", action: "restore", applied: false });
    expect(reRestored.data![0].archived_at).toBeNull();

    const row = await readRow("fellowship", "fellowship_id", fellowshipId);
    expect(row?.archived_at).toBeNull();
  });
});

describe("lifecycle_transition: advisor deactivate/reactivate idempotence (R1)", () => {
  it("deactivates, re-deactivates (no-op), reactivates, and re-reactivates (no-op) an advisor", async () => {
    // A dedicated advisor bound to its own user; the acting admin is a DIFFERENT
    // administrator, so the self-deactivation guard cannot interfere.
    const target = await createBoundAdvisor("deactivate-idem");

    const first = await transition(adminOne.client, "advisor", "deactivate", target.advisorId!);
    expect(first.error, "first advisor deactivate").toBeNull();
    expect(first.data![0]).toMatchObject({
      entity: "advisor",
      entity_id: target.advisorId,
      action: "deactivate",
      applied: true,
      is_active: false,
      archived_at: null,
    });

    const second = await transition(adminOne.client, "advisor", "deactivate", target.advisorId);
    expect(second.data![0]).toMatchObject({ entity: "advisor", action: "deactivate", applied: false });
    expect(second.data![0].is_active, "idempotent deactivate stays inactive").toBe(false);

    const reactivated = await transition(adminOne.client, "advisor", "reactivate", target.advisorId);
    expect(reactivated.data![0]).toMatchObject({ entity: "advisor", action: "reactivate", applied: true });
    expect(reactivated.data![0].is_active, "reactivate restores active").toBe(true);

    const reReactivated = await transition(adminOne.client, "advisor", "reactivate", target.advisorId);
    expect(reReactivated.data![0]).toMatchObject({ entity: "advisor", action: "reactivate", applied: false });
    expect(reReactivated.data![0].is_active).toBe(true);

    const row = await readRow("advisor", "advisor_id", target.advisorId!);
    expect(row?.is_active).toBe(true);
  });
});

describe("lifecycle_transition: whitelist and fail-closed input (R6)", () => {
  it("rejects invalid entity/action pairs with 22023", async () => {
    const { studentId, fellowshipId } = await seedArchivePair("whitelist", adminOne.advisorId!);
    const advisorTarget = await createBoundAdvisor("whitelist-advisor");

    const cases: Array<[string, string, number | null]> = [
      ["student", "deactivate", studentId], // student whitelist is archive|restore
      ["fellowship", "deactivate", fellowshipId],
      ["advisor", "archive", advisorTarget.advisorId!], // advisor whitelist is deactivate|reactivate
      ["program", "archive", studentId], // unknown entity
      ["student", "explode", studentId], // unknown action
    ];
    for (const [entity, action, id] of cases) {
      const { data, error } = await transition(adminOne.client, entity, action, id);
      expect(data, `transition ${entity}.${action} must return no row`).toBeNull();
      expect(error, `transition ${entity}.${action} must fail`).not.toBeNull();
      expect(error?.code, `transition ${entity}.${action} error code`).toBe("22023");
    }
  });

  it("rejects a missing entity id with 22023", async () => {
    const { data, error } = await transition(adminOne.client, "student", "archive", null);
    expect(data, "null entity_id must return no row").toBeNull();
    expect(error, "null entity_id must fail").not.toBeNull();
    expect(error?.code, "null entity_id error code").toBe("22023");
  });

  it("rejects a nonexistent target with P0002", async () => {
    for (const [entity, action] of [
      ["student", "archive"],
      ["fellowship", "archive"],
      ["advisor", "deactivate"],
    ] as const) {
      const { data, error } = await transition(adminOne.client, entity, action, 999_999_999);
      expect(data, `transition ${entity}.${action} on a missing id must return no row`).toBeNull();
      expect(error, `transition ${entity}.${action} on a missing id must fail`).not.toBeNull();
      expect(error?.code, `transition ${entity}.${action} on a missing id error code`).toBe("P0002");
    }
  });
});

describe("lifecycle_transition: authorization denials (R6)", () => {
  it("denies a non-admin active advisor (42501) even with advisor.role='Admin'", async () => {
    const { studentId } = await seedArchivePair("non-admin", adminOne.advisorId!);
    const { data, error } = await transition(staffActive.client, "student", "archive", studentId);
    expect(data, "non-admin archive must return no row").toBeNull();
    expect(error, "non-admin archive must be denied").not.toBeNull();
    expect(error?.code, "non-admin archive denial code").toBe("42501");
    // Fail closed: nothing changed.
    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at).toBeNull();
  });

  it("denies an authenticated user with no advisor row (42501)", async () => {
    const { studentId } = await seedArchivePair("no-advisor-denial", adminOne.advisorId!);
    const { data, error } = await transition(noAdvisor.client, "student", "archive", studentId);
    expect(data, "no-advisor archive must return no row").toBeNull();
    expect(error, "no-advisor archive must be denied").not.toBeNull();
    expect(error?.code, "no-advisor archive denial code").toBe("42501");
    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at).toBeNull();
  });

  it("denies anon (no EXECUTE on the RPC)", async () => {
    const { data, error } = await transition(anon, "student", "archive", 1);
    expect(data, "anon transition must return no row").toBeNull();
    expect(error, "anon transition must be denied").not.toBeNull();
    expect(error?.code, "anon transition denial code").toBe("42501");
  });

  it("denies the service_role technical session (no auth.uid() actor, so no attributable transition)", async () => {
    // A technical session has no JWT subject: `auth.uid()` is NULL, so the RPC
    // raises 42501 before touching any row. Every transition must be
    // attributable to a specific signed-in administrator.
    const { data, error } = await transition(service, "student", "archive", 1);
    expect(data, "service_role transition must return no row").toBeNull();
    expect(error, "service_role transition must be denied").not.toBeNull();
    expect(error?.code, "service_role transition denial code").toBe("42501");
  });
});

describe("self-deactivation guard (R6)", () => {
  it("rejects an administrator deactivating their own active advisor row (42501)", async () => {
    const { data, error } = await transition(adminOne.client, "advisor", "deactivate", adminOne.advisorId!);
    expect(data, "self-deactivation must return no row").toBeNull();
    expect(error, "self-deactivation must be denied").not.toBeNull();
    expect(error?.code, "self-deactivation denial code").toBe("42501");
    expect(String(error?.message).toLowerCase(), "self-deactivation message").toContain("own");

    // The acting administrator's session is untouched.
    const row = await readRow("advisor", "advisor_id", adminOne.advisorId!);
    expect(row?.is_active).toBe(true);
  });

  it("lets a SECOND administrator deactivate an administrator's advisor, and prevents the deactivated administrator from self-reactivation until a second administrator reactivates them (review remediation)", async () => {
    // The deliberate path: another administrator performs the deactivation.
    const { data: deactivated, error } = await transition(adminTwo.client, "advisor", "deactivate", adminOne.advisorId!);
    expect(error, "second-admin deactivation").toBeNull();
    expect(deactivated![0]).toMatchObject({ action: "deactivate", applied: true, is_active: false });

    // REVIEW REMEDIATION: the deactivated administrator's JWT claim is intact,
    // but their bound advisor row is now INACTIVE, so the RPC requires an
    // active bound advisor and DENIES every transition — including reactivating
    // their own row. Deactivation can no longer be defeated by self-reactivation.
    const { data: deniedSelf, error: deniedSelfError } = await transition(
      adminOne.client,
      "advisor",
      "reactivate",
      adminOne.advisorId!
    );
    expect(deniedSelf, "self-reactivation by a deactivated administrator must return no row").toBeNull();
    expect(deniedSelfError, "self-reactivation by a deactivated administrator must be denied").not.toBeNull();
    expect(deniedSelfError?.code, "self-reactivation denial code").toBe("42501");

    // The deactivated administrator is also denied non-advisor transitions
    // (they are not an active bound advisor, so no lifecycle authority at all).
    const { studentId } = await seedArchivePair("deactivated-admin", adminOne.advisorId!);
    const { data: deniedArchive, error: deniedArchiveError } = await transition(
      adminOne.client,
      "student",
      "archive",
      studentId
    );
    expect(deniedArchive, "deactivated administrator archive must return no row").toBeNull();
    expect(deniedArchiveError, "deactivated administrator archive must be denied").not.toBeNull();
    expect(deniedArchiveError?.code, "deactivated administrator archive denial code").toBe("42501");
    const rowAfter = await readRow("student", "student_id", studentId);
    expect(rowAfter?.archived_at).toBeNull();

    // A second (active, bound) administrator performs the reactivation.
    const { data: reactivated, error: reactError } = await transition(adminTwo.client, "advisor", "reactivate", adminOne.advisorId!);
    expect(reactError, "second-admin reactivation").toBeNull();
    expect(reactivated![0]).toMatchObject({ action: "reactivate", applied: true, is_active: true });

    const row = await readRow("advisor", "advisor_id", adminOne.advisorId!);
    expect(row?.is_active).toBe(true);

    // Restored to ACTIVE, adminOne regains full lifecycle authority.
    const { data: restored, error: restoredError } = await transition(adminOne.client, "student", "archive", studentId);
    expect(restoredError, "restored administrator archive").toBeNull();
    expect(restored![0]).toMatchObject({ action: "archive", applied: true });
  });

  it("denies a deactivated (inactive, bound) administrator EVERY lifecycle transition, including the idempotent no-op deactivation of their own row (review remediation)", async () => {
    // `deactivatedAdmin` carries the ocf_admin JWT claim and is pre-bound to an
    // INACTIVE advisor row. Under the review-remediation RPC the active-bound-
    // advisor gate runs before the idempotence/whitelist logic, so even the
    // "no-op" deactivation of their own already-inactive row — which would
    // leave the row untouched — is rejected. There is no transition path at all
    // for a deactivated administrator.
    expect(deactivatedAdmin.advisorId).toBeDefined();

    for (const [entity, action] of [
      ["advisor", "deactivate"],
      ["advisor", "reactivate"],
      ["student", "archive"],
      ["fellowship", "restore"],
    ] as const) {
      const { data, error } = await transition(
        deactivatedAdmin.client,
        entity,
        action,
        deactivatedAdmin.advisorId!
      );
      expect(data, `deactivated admin ${entity}.${action} must return no row`).toBeNull();
      expect(error, `deactivated admin ${entity}.${action} must be denied`).not.toBeNull();
      expect(error?.code, `deactivated admin ${entity}.${action} denial code`).toBe("42501");
    }

    const row = await readRow("advisor", "advisor_id", deactivatedAdmin.advisorId!);
    expect(row?.is_active).toBe(false);
  });
});

describe("lifecycle_transition requires an ACTIVE bound advisor in addition to the admin claim (review remediation, R6)", () => {
  it("denies a claim-bearing authenticated user with NO advisor row (42501) even though is_ocf_admin() is true", async () => {
    // The user carries the immutable ocf_admin claim (so is_ocf_admin() is
    // true), but there is no `advisor.auth_user_id = auth.uid()` binding to
    // read. The claim alone is never authorization: the RPC fails closed.
    const { data: isAdmin, error: isAdminError } = await claimNoAdvisor.client.rpc("is_ocf_admin");
    expect(isAdminError).toBeNull();
    expect(isAdmin, "claim-bearing no-advisor user must still resolve is_ocf_admin() = true").toBe(true);

    const { data, error } = await transition(claimNoAdvisor.client, "student", "archive", 1);
    expect(data, "claim-only transition must return no row").toBeNull();
    expect(error, "claim-only transition must be denied").not.toBeNull();
    expect(error?.code, "claim-only transition denial code").toBe("42501");
    expect(String(error?.message).toLowerCase(), "claim-only denial message").toContain("bound");
  });

  it("denies a claim-bearing user bound to an inactive advisor every transition (the deactivated-admin case)", async () => {
    const { studentId } = await seedArchivePair("inactive-bound", adminOne.advisorId!);
    const { data, error } = await transition(deactivatedAdmin.client, "student", "archive", studentId);
    expect(data, "inactive-bound archive must return no row").toBeNull();
    expect(error, "inactive-bound archive must be denied").not.toBeNull();
    expect(error?.code, "inactive-bound archive denial code").toBe("42501");
    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at).toBeNull();
  });

  it("does not introduce email linking or self binding: the check only reads the admin-provisioned auth_user_id binding", async () => {
    // An active, claim-bearing admin whose advisor row is bound works — the
    // legitimate path. There is no RPC parameter that accepts a caller identity
    // (the actor comes from auth.uid() only), so no transition can bind or
    // link by email. Pinning the RPC signature's actor-derivation contract:
    // the transition helper only ever passes entity/action/entity_id.
    const { data, error } = await transition(adminOne.client, "advisor", "reactivate", adminOne.advisorId!);
    expect(error, "active admin idempotent self-reactivation").toBeNull();
    expect(data![0]).toMatchObject({ action: "reactivate", applied: false, is_active: true });
  });
});

// ---------------------------------------------------------------------------
// Direct-write guards on lifecycle fields (NFR1)
// ---------------------------------------------------------------------------

describe("direct lifecycle-field writes are rejected (R6/NFR1)", () => {
  it("denies an active advisor directly writing student.archived_at and leaves the row unchanged", async () => {
    const { studentId } = await seedArchivePair("forged-student", adminOne.advisorId!);
    const before = await readRow("student", "student_id", studentId);
    expect(before?.archived_at).toBeNull();

    const { data, error } = await staffActive.client
      .from("student")
      .update({ archived_at: "2026-01-01T00:00:00.000Z" })
      .eq("student_id", studentId)
      .select("*");
    expect(error, "direct student.archived_at write must be denied").not.toBeNull();
    expect(error?.code, "direct student.archived_at write denial code").toBe("42501");
    expect(data ?? [], "denied update must not return a row").toHaveLength(0);

    const after = await readRow("student", "student_id", studentId);
    expect(after, "student row must be unchanged").toEqual(before);
  });

  it("denies an active advisor directly writing fellowship.archived_at and leaves the row unchanged", async () => {
    const { fellowshipId } = await seedArchivePair("forged-fellowship", adminOne.advisorId!);
    const before = await readRow("fellowship", "fellowship_id", fellowshipId);

    const { data, error } = await staffActive.client
      .from("fellowship")
      .update({ archived_at: "2026-01-01T00:00:00.000Z" })
      .eq("fellowship_id", fellowshipId)
      .select("*");
    expect(error, "direct fellowship.archived_at write must be denied").not.toBeNull();
    expect(error?.code, "direct fellowship.archived_at write denial code").toBe("42501");
    expect(data ?? [], "denied update must not return a row").toHaveLength(0);

    const after = await readRow("fellowship", "fellowship_id", fellowshipId);
    expect(after, "fellowship row must be unchanged").toEqual(before);
  });

  it("denies an active advisor deactivating a peer directly (advisor.is_active is RPC-only)", async () => {
    const peer = await createBoundAdvisor("peer-deactivate-target");
    const before = await readRow("advisor", "advisor_id", peer.advisorId!);
    expect(before?.is_active).toBe(true);

    // The self-scoped advisor UPDATE policy (migration 20261002000001) hides
    // the PEER row for UPDATE (RLS-filtered 0 rows), so the peer cannot be
    // deactivated directly through the table API — the lifecycle RPC is the
    // only path. A 42501 RLS denial and a zero-row RLS filter are both
    // accepted; either way the peer row is byte-for-byte unchanged.
    const { data, error } = await staffActive.client
      .from("advisor")
      .update({ is_active: false })
      .eq("advisor_id", peer.advisorId!)
      .select("advisor_id");
    if (error) {
      expect(error.code, "direct peer deactivation denial code").toBe("42501");
    } else {
      expect(data ?? [], "denied peer update must not return a row").toHaveLength(0);
    }

    const after = await readRow("advisor", "advisor_id", peer.advisorId!);
    expect(after, "peer advisor row must be unchanged").toEqual(before);
  });

  it("denies INSERT forgery of an already-archived student (42501, no row created)", async () => {
    const email = syntheticEmail(nextUnique("forged-student-insert"));
    const { data, error } = await staffActive.client.from("student").insert({
      full_name: syntheticName(nextUnique("forged-student-insert")),
      email,
      us_citizen: true,
      archived_at: "2026-01-01T00:00:00.000Z",
    });
    expect(error, "archived-student INSERT must be denied").not.toBeNull();
    expect(error?.code, "archived-student INSERT denial code").toBe("42501");
    expect(data ?? [], "denied INSERT must not return a row").toHaveLength(0);

    // Absence proof: no row was created for the attempted email.
    const { data: remaining } = await service.from("student").select("student_id").eq("email", email);
    expect(remaining ?? [], "no student row may exist for the forged archived INSERT").toHaveLength(0);
  });

  it("denies INSERT forgery of an already-archived fellowship (42501, no row created)", async () => {
    const name = syntheticName(nextUnique("forged-fellowship-insert"));
    const { data, error } = await staffActive.client.from("fellowship").insert({
      fellowship_name: name,
      archived_at: "2026-01-01T00:00:00.000Z",
    });
    expect(error, "archived-fellowship INSERT must be denied").not.toBeNull();
    expect(error?.code, "archived-fellowship INSERT denial code").toBe("42501");
    expect(data ?? [], "denied INSERT must not return a row").toHaveLength(0);

    const { data: remaining } = await service.from("fellowship").select("fellowship_id").eq("fellowship_name", name);
    expect(remaining ?? [], "no fellowship row may exist for the forged archived INSERT").toHaveLength(0);
  });

  it("denies INSERT forgery of an already-inactive advisor (42501, no row created)", async () => {
    const email = syntheticEmail(nextUnique("forged-inactive-insert"));
    const { data, error } = await staffActive.client.from("advisor").insert({
      advisor_name: syntheticName(nextUnique("forged-inactive-insert")),
      email,
      is_active: false,
    });
    expect(error, "inactive-advisor INSERT must be denied").not.toBeNull();
    expect(error?.code, "inactive-advisor INSERT denial code").toBe("42501");
    expect(data ?? [], "denied INSERT must not return a row").toHaveLength(0);

    const { data: remaining } = await service.from("advisor").select("advisor_id").eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the forged inactive INSERT").toHaveLength(0);
  });

  it("denies a direct forged restore (clearing archived_at) and keeps the row archived", async () => {
    const { studentId } = await seedArchivePair("forged-restore", adminOne.advisorId!);
    // Archive through the ONLY legitimate path first.
    const archived = await transition(adminOne.client, "student", "archive", studentId);
    expect(archived.error).toBeNull();
    expect(archived.data![0].applied).toBe(true);

    const before = await readRow("student", "student_id", studentId);
    expect(before?.archived_at).not.toBeNull();

    const { data, error } = await staffActive.client
      .from("student")
      .update({ archived_at: null })
      .eq("student_id", studentId)
      .select("*");
    expect(error, "direct forged restore must be denied").not.toBeNull();
    expect(error?.code, "direct forged restore denial code").toBe("42501");
    expect(data ?? [], "denied restore must not return a row").toHaveLength(0);

    const after = await readRow("student", "student_id", studentId);
    expect(after, "archived row must stay archived").toEqual(before);
  });
});

describe("ordinary non-lifecycle writes and no-op restatements pass through", () => {
  it("lets an active advisor create a student in the active lifecycle state (archived_at NULL)", async () => {
    const email = syntheticEmail(nextUnique("ordinary-student-insert"));
    const { data, error } = await staffActive.client
      .from("student")
      .insert({ full_name: syntheticName(nextUnique("ordinary-student-insert")), email, us_citizen: true })
      .select("student_id")
      .single();
    expect(error, "ordinary student INSERT must succeed").toBeNull();
    expect(data).not.toBeNull();

    const row = await readRow("student", "student_id", data!.student_id as number);
    expect(row?.archived_at, "ordinary student INSERT must create an active row").toBeNull();
  });

  it("lets an active advisor update non-lifecycle student columns without touching archived_at", async () => {
    const { studentId } = await seedArchivePair("ordinary-update", adminOne.advisorId!);
    const { data, error } = await staffActive.client
      .from("student")
      .update({ major: "Chemistry" })
      .eq("student_id", studentId)
      .select("student_id");
    expect(error, "ordinary student UPDATE must succeed").toBeNull();
    expect(data ?? []).toHaveLength(1);

    const row = await readRow("student", "student_id", studentId);
    expect(row?.major).toBe("Chemistry");
    expect(row?.archived_at).toBeNull();
  });

  it("lets an active advisor pass a no-op UPDATE that restates the current archived_at NULL", async () => {
    const { studentId } = await seedArchivePair("noop-restate", adminOne.advisorId!);
    const { data, error } = await staffActive.client
      .from("student")
      .update({ archived_at: null, major: "Biology" })
      .eq("student_id", studentId)
      .select("student_id");
    expect(error, "no-op lifecycle restatement must pass through").toBeNull();
    expect(data ?? []).toHaveLength(1);

    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at, "no-op restatement keeps active state").toBeNull();
    expect(row?.major).toBe("Biology");
  });

  it("denies authenticated advisor-row creation (review remediation: advisor INSERT is trusted-provisioning-only)", async () => {
    const email = syntheticEmail(nextUnique("ordinary-advisor-insert-denied"));
    const { data, error } = await staffActive.client
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("ordinary-advisor-insert-denied")),
        email,
        is_active: true,
      })
      .select("advisor_id");
    expect(data ?? [], "a denied advisor INSERT must not return a row").toHaveLength(0);
    expect(error, "authenticated advisor INSERT must be denied").not.toBeNull();
    expect(error?.code, "authenticated advisor INSERT denial code").toBe("42501");

    // Absence proof: no advisor row exists for the attempted email.
    const { data: remaining } = await service.from("advisor").select("advisor_id").eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the denied INSERT").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Advisor deactivation blocks an existing session (R1)
// ---------------------------------------------------------------------------

describe("advisor deactivation immediately blocks existing auth access (R1)", () => {
  it("deactivates an advisor, proves their live session loses operational access (real-row proof), and restores it", async () => {
    const target = await createBoundAdvisor("access-block");

    // Seed one historical meeting attributed to the target advisor so
    // attribution is provable after deactivation.
    const { studentId } = await seedArchivePair("access-block-history", target.advisorId!);

    // The live session has staff access before deactivation.
    const beforeRead = await target.client.from("student").select("student_id");
    expect(beforeRead.error, "target pre-deactivation student read").toBeNull();
    expect((beforeRead.data ?? []).length, "target pre-deactivation can read students").toBeGreaterThan(0);

    const deactivated = await transition(adminOne.client, "advisor", "deactivate", target.advisorId!);
    expect(deactivated.error).toBeNull();
    expect(deactivated.data![0].applied).toBe(true);

    // The existing session is instantly denied: is_active_advisor() is false,
    // so the active-advisor SELECT policy hides every student row. The hidden
    // target is REAL — the service-role re-read proves the row still exists
    // (0 rows alone never counts as blocked).
    const blocked = await target.client.from("student").select("student_id");
    if (blocked.error) {
      expect(blocked.error.code, "deactivated advisor student read error code").toBe("42501");
    } else {
      expect(blocked.data ?? [], "deactivated advisor must read zero student rows").toHaveLength(0);
    }
    const { data: real, error: realError } = await service
      .from("student")
      .select("student_id")
      .eq("student_id", studentId)
      .maybeSingle();
    expect(realError).toBeNull();
    expect(real, "the hidden student row must still exist (real-row proof)").not.toBeNull();

    // The pre-bound INACTIVE advisor still reads their OWN advisor row
    // (`auth_user_id = auth.uid()`), exactly like the pre-bound inactive
    // advisor in the RLS contract.
    const ownRow = await target.client
      .from("advisor")
      .select("advisor_id, auth_user_id, is_active")
      .eq("advisor_id", target.advisorId!)
      .maybeSingle();
    expect(ownRow.error, "deactivated advisor own-row read").toBeNull();
    expect(ownRow.data, "deactivated advisor can still read their own row").not.toBeNull();
    expect(ownRow.data?.is_active).toBe(false);

    // Historical attribution survives: the meeting still references the
    // deactivated advisor and its name still resolves via the join.
    const attribution = await pool.query<{ meeting_id: number; advisor_name: string }>(
      `SELECT m.meeting_id, a.advisor_name
         FROM public.advising_meeting m
         JOIN public.advisor a ON a.advisor_id = m.advisor_id
        WHERE m.student_id = $1 AND m.advisor_id = $2`,
      [studentId, target.advisorId]
    );
    expect(attribution.rows).toHaveLength(1);
    expect(attribution.rows[0].advisor_name, "deactivated advisor's name still resolves").toBe(target.advisorName);

    // Reactivate: the same live session regains operational access.
    const reactivated = await transition(adminOne.client, "advisor", "reactivate", target.advisorId!);
    expect(reactivated.error).toBeNull();
    expect(reactivated.data![0].applied).toBe(true);

    const afterRead = await target.client.from("student").select("student_id");
    expect(afterRead.error, "target post-reactivation student read").toBeNull();
    expect((afterRead.data ?? []).length, "target post-reactivation can read students").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Archived parents preserve history and NO ACTION FKs (R2/R7)
// ---------------------------------------------------------------------------

describe("archived students/fellowships preserve historical relationships (R2/R7)", () => {
  it("archives a student and preserves applications, meetings, attendance, and scholarship history", async () => {
    const { studentId, applicationId } = await seedArchivePair("history-student", adminOne.advisorId!);

    const archived = await transition(adminOne.client, "student", "archive", studentId);
    expect(archived.error).toBeNull();
    expect(archived.data![0].applied).toBe(true);

    // Every dependent relationship still references the archived student.
    for (const table of [
      "application",
      "advising_meeting",
      "fellowship_thursday",
      "scholarship_history",
    ] as const) {
      const { data, error } = await service
        .from(table)
        .select("student_id")
        .eq("student_id", studentId);
      expect(error, `${table} child re-read`).toBeNull();
      expect(data ?? [], `${table} preserved after student archive`).toHaveLength(1);
    }

    // Historical join: the archived student's name still resolves.
    const join = await pool.query<{ application_id: number; full_name: string }>(
      `SELECT a.application_id, s.full_name
         FROM public.application a
         JOIN public.student s ON s.student_id = a.student_id
        WHERE a.application_id = $1`,
      [applicationId]
    );
    expect(join.rows).toHaveLength(1);
    expect(String(join.rows[0].full_name)).toContain("Contract");
  });

  it("archives a fellowship and preserves applications and scholarship history", async () => {
    const { fellowshipId, applicationId } = await seedArchivePair("history-fellowship", adminOne.advisorId!);

    const archived = await transition(adminOne.client, "fellowship", "archive", fellowshipId);
    expect(archived.error).toBeNull();
    expect(archived.data![0].applied).toBe(true);

    for (const table of ["application", "scholarship_history"] as const) {
      const { data, error } = await service
        .from(table)
        .select("fellowship_id")
        .eq("fellowship_id", fellowshipId);
      expect(error, `${table} child re-read`).toBeNull();
      expect(data ?? [], `${table} preserved after fellowship archive`).toHaveLength(1);
    }

    const join = await pool.query<{ application_id: number; fellowship_name: string }>(
      `SELECT a.application_id, f.fellowship_name
         FROM public.application a
         JOIN public.fellowship f ON f.fellowship_id = a.fellowship_id
        WHERE a.application_id = $1`,
      [applicationId]
    );
    expect(join.rows).toHaveLength(1);
    expect(String(join.rows[0].fellowship_name)).toContain("Contract");
  });

  it("keeps NO ACTION FK semantics: deleting an archived student still fails and preserves every child", async () => {
    const { studentId } = await seedArchivePair("noaction-archive", adminOne.advisorId!);
    await transition(adminOne.client, "student", "archive", studentId);

    const { data, error } = await service.from("student").delete().eq("student_id", studentId);
    expect(error, "NO ACTION delete of an archived parent must fail").not.toBeNull();
    expect(error?.code, "archived parent delete FK violation code").toBe("23503");
    expect(data).toBeNull();

    for (const table of ["application", "advising_meeting", "fellowship_thursday", "scholarship_history"] as const) {
      const { data: children } = await service
        .from(table)
        .select("student_id")
        .eq("student_id", studentId);
      expect(children ?? [], `${table} child preserved after blocked archived delete`).toHaveLength(1);
    }
    const { data: parent } = await service.from("student").select("student_id").eq("student_id", studentId);
    expect(parent ?? [], "archived parent student preserved").toHaveLength(1);
  });

  it("restores an archived student and keeps all relationships intact", async () => {
    const { studentId } = await seedArchivePair("restore-history", adminOne.advisorId!);

    await transition(adminOne.client, "student", "archive", studentId);
    const restored = await transition(adminOne.client, "student", "restore", studentId);
    expect(restored.error).toBeNull();
    expect(restored.data![0].applied).toBe(true);

    const row = await readRow("student", "student_id", studentId);
    expect(row?.archived_at).toBeNull();

    const { data: children } = await service
      .from("application")
      .select("application_id")
      .eq("student_id", studentId);
    expect(children ?? [], "application preserved across archive+restore").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Archive-parent child boundary (review remediation, migration ...007)
// ---------------------------------------------------------------------------

describe("archived students/fellowships reject new and re-linked operational child records (review remediation, NFR1)", () => {
  /**
   * One self-contained boundary scenario: a fresh student + fellowship (both
   * seeded with the full dependent-child set), BOTH archived through the only
   * legitimate path, plus a second ACTIVE student and ACTIVE fellowship used as
   * the legal re-link/insertion targets. Returns all four ids.
   */
  async function seedArchivedParents(): Promise<{
    archivedStudentId: number;
    archivedFellowshipId: number;
    activeStudentId: number;
    activeFellowshipId: number;
  }> {
    const { studentId, fellowshipId } = await seedArchivePair("child-boundary", adminOne.advisorId!);
    const archivedStudent = await transition(adminOne.client, "student", "archive", studentId);
    expect(archivedStudent.error).toBeNull();
    expect(archivedStudent.data![0].applied).toBe(true);
    const archivedFellowship = await transition(adminOne.client, "fellowship", "archive", fellowshipId);
    expect(archivedFellowship.error).toBeNull();
    expect(archivedFellowship.data![0].applied).toBe(true);

    const { data: activeStudent, error: studentError } = await service
      .from("student")
      .insert({
        full_name: syntheticName(nextUnique("child-boundary-active-student")),
        email: syntheticEmail(nextUnique("child-boundary-active-student")),
        us_citizen: true,
      })
      .select("student_id")
      .single();
    if (studentError) throw new Error(`seed active student for child boundary: ${studentError.message}`);

    const { data: activeFellowship, error: fellowshipError } = await service
      .from("fellowship")
      .insert({ fellowship_name: syntheticName(nextUnique("child-boundary-active-fellowship")) })
      .select("fellowship_id")
      .single();
    if (fellowshipError) throw new Error(`seed active fellowship for child boundary: ${fellowshipError.message}`);

    return {
      archivedStudentId: studentId,
      archivedFellowshipId: fellowshipId,
      activeStudentId: activeStudent!.student_id as number,
      activeFellowshipId: activeFellowship!.fellowship_id as number,
    };
  }

  it("denies INSERT of an application referencing an archived student or fellowship (42501, no row created)", async () => {
    const { archivedStudentId, archivedFellowshipId, activeStudentId, activeFellowshipId } =
      await seedArchivedParents();

    const cases: Array<{ label: string; payload: Record<string, unknown>; absent: { column: string; value: unknown } }> = [
      {
        label: "archived student",
        payload: { student_id: archivedStudentId, fellowship_id: activeFellowshipId, stage_of_application: "Submitted" },
        absent: { column: "student_id", value: archivedStudentId },
      },
      {
        label: "archived fellowship",
        payload: { student_id: activeStudentId, fellowship_id: archivedFellowshipId, stage_of_application: "Submitted" },
        absent: { column: "fellowship_id", value: archivedFellowshipId },
      },
    ];
    for (const c of cases) {
      const { data, error } = await staffActive.client.from("application").insert(c.payload).select("application_id");
      expect(data ?? [], `application INSERT (${c.label}) must return no row`).toHaveLength(0);
      expect(error, `application INSERT (${c.label}) must be denied`).not.toBeNull();
      expect(error?.code, `application INSERT (${c.label}) denial code`).toBe("42501");
      // Absence proof: only the seeded child remains under service role.
      const { data: remaining } = await service
        .from("application")
        .select("application_id")
        .eq(c.absent.column, c.absent.value as number);
      expect(remaining ?? [], `application ${c.label} row count unchanged`).toHaveLength(1);
    }
  });

  it("denies INSERT of an advising meeting referencing an archived student (42501, no row created)", async () => {
    const { archivedStudentId } = await seedArchivedParents();

    const { data, error } = await staffActive.client.from("advising_meeting").insert({
      student_id: archivedStudentId,
      meeting_date: "2026-09-01",
      meeting_mode: "Virtual",
      notes: `Boundary denial ${nextUnique("meeting-archived")}`,
    });
    expect(data ?? [], "archived-student meeting INSERT must return no row").toHaveLength(0);
    expect(error, "archived-student meeting INSERT must be denied").not.toBeNull();
    expect(error?.code, "archived-student meeting INSERT denial code").toBe("42501");
    // Absence proof: only the seeded meeting remains.
    const { data: remaining } = await service
      .from("advising_meeting")
      .select("meeting_id")
      .eq("student_id", archivedStudentId);
    expect(remaining ?? [], "archived-student meeting count unchanged").toHaveLength(1);
  });

  it("denies INSERT of fellowship-thursday attendance referencing an archived student (42501, no row created)", async () => {
    const { archivedStudentId } = await seedArchivedParents();

    const { data, error } = await staffActive.client.from("fellowship_thursday").insert({
      student_id: archivedStudentId,
      attended: true,
      source_info: "OCF",
    });
    expect(data ?? [], "archived-student attendance INSERT must return no row").toHaveLength(0);
    expect(error, "archived-student attendance INSERT must be denied").not.toBeNull();
    expect(error?.code, "archived-student attendance INSERT denial code").toBe("42501");
    const { data: remaining } = await service
      .from("fellowship_thursday")
      .select("attendance_id")
      .eq("student_id", archivedStudentId);
    expect(remaining ?? [], "archived-student attendance count unchanged").toHaveLength(1);
  });

  it("denies INSERT of scholarship history referencing an archived student or fellowship (42501, no row created)", async () => {
    const { archivedStudentId, archivedFellowshipId, activeStudentId, activeFellowshipId } =
      await seedArchivedParents();

    const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: "archived student", payload: { student_id: archivedStudentId, fellowship_id: activeFellowshipId } },
      { label: "archived fellowship", payload: { student_id: activeStudentId, fellowship_id: archivedFellowshipId } },
    ];
    for (const c of cases) {
      const { data, error } = await staffActive.client.from("scholarship_history").insert(c.payload);
      expect(data ?? [], `history INSERT (${c.label}) must return no row`).toHaveLength(0);
      expect(error, `history INSERT (${c.label}) must be denied`).not.toBeNull();
      expect(error?.code, `history INSERT (${c.label}) denial code`).toBe("42501");
    }
    const { data: remaining } = await service
      .from("scholarship_history")
      .select("history_id")
      .eq("student_id", archivedStudentId);
    expect(remaining ?? [], "archived-student history count unchanged").toHaveLength(1);
  });

  it("denies UPDATE re-linking an application to an archived student or fellowship (42501, row unchanged)", async () => {
    const { archivedStudentId, archivedFellowshipId, activeStudentId, activeFellowshipId } =
      await seedArchivedParents();

    // A legal active-reference application created by an authenticated advisor.
    const { data: application, error: insertError } = await staffActive.client
      .from("application")
      .insert({
        student_id: activeStudentId,
        fellowship_id: activeFellowshipId,
        stage_of_application: "Submitted",
      })
      .select("application_id")
      .single();
    expect(insertError, "active-reference application INSERT must succeed").toBeNull();
    const applicationId = application!.application_id as number;

    const before = await readRow("application", "application_id", applicationId);
    expect(before).not.toBeNull();

    const reLinks: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: "student", payload: { student_id: archivedStudentId } },
      { label: "fellowship", payload: { fellowship_id: archivedFellowshipId } },
    ];
    for (const c of reLinks) {
      const { data, error } = await staffActive.client
        .from("application")
        .update(c.payload)
        .eq("application_id", applicationId)
        .select("application_id");
      expect(error, `re-link to archived ${c.label} must be denied`).not.toBeNull();
      expect(error?.code, `re-link to archived ${c.label} denial code`).toBe("42501");
      expect(data ?? [], "denied re-link must not return a row").toHaveLength(0);
      const after = await readRow("application", "application_id", applicationId);
      expect(after, "application must be unchanged after denied re-link").toEqual(before);
    }
  });

  it("denies UPDATE re-linking fellowship-thursday attendance or scholarship history to an archived parent (42501, row unchanged)", async () => {
    const { archivedStudentId, archivedFellowshipId, activeStudentId, activeFellowshipId } =
      await seedArchivedParents();

    // Attendance: active reference first, then a denied re-link to the archived student.
    const { data: attendance, error: attendanceInsertError } = await staffActive.client
      .from("fellowship_thursday")
      .insert({ student_id: activeStudentId, attended: true, source_info: "OCF" })
      .select("attendance_id")
      .single();
    expect(attendanceInsertError, "active-reference attendance INSERT").toBeNull();
    const attendanceId = attendance!.attendance_id as number;
    const attendanceBefore = await readRow("fellowship_thursday", "attendance_id", attendanceId);
    const { data: deniedAttendance, error: attendanceError } = await staffActive.client
      .from("fellowship_thursday")
      .update({ student_id: archivedStudentId })
      .eq("attendance_id", attendanceId)
      .select("attendance_id");
    expect(deniedAttendance ?? [], "attendance re-link must return no row").toHaveLength(0);
    expect(attendanceError, "attendance re-link to archived student must be denied").not.toBeNull();
    expect(attendanceError?.code, "attendance re-link denial code").toBe("42501");
    const attendanceAfter = await readRow("fellowship_thursday", "attendance_id", attendanceId);
    expect(attendanceAfter, "attendance row unchanged").toEqual(attendanceBefore);

    // Scholarship history: active reference first, then a denied re-link of the
    // fellowship to the archived fellowship.
    const { data: history, error: historyInsertError } = await staffActive.client
      .from("scholarship_history")
      .insert({ student_id: activeStudentId, fellowship_id: activeFellowshipId })
      .select("history_id")
      .single();
    expect(historyInsertError, "active-reference history INSERT").toBeNull();
    const historyId = history!.history_id as number;
    const historyBefore = await readRow("scholarship_history", "history_id", historyId);
    const { data: deniedHistory, error: historyError } = await staffActive.client
      .from("scholarship_history")
      .update({ fellowship_id: archivedFellowshipId })
      .eq("history_id", historyId)
      .select("history_id");
    expect(deniedHistory ?? [], "history re-link must return no row").toHaveLength(0);
    expect(historyError, "history re-link to archived fellowship must be denied").not.toBeNull();
    expect(historyError?.code, "history re-link denial code").toBe("42501");
    const historyAfter = await readRow("scholarship_history", "history_id", historyId);
    expect(historyAfter, "history row unchanged").toEqual(historyBefore);
  });

  it("preserves historical READS of child records referencing archived parents (active advisor still sees them)", async () => {
    const { archivedStudentId, archivedFellowshipId } = await seedArchivedParents();

    // The authenticated ACTIVE advisor can still read every child row that
    // references the archived parent — archive never hides established history.
    for (const table of ["application", "advising_meeting", "fellowship_thursday", "scholarship_history"] as const) {
      const { data, error } = await staffActive.client
        .from(table)
        .select("student_id")
        .eq("student_id", archivedStudentId);
      expect(error, `${table} historical read`).toBeNull();
      expect(data ?? [], `${table} archived-student child still readable`).toHaveLength(1);
    }
    // And the seeded application and award-history rows that reference the
    // ARCHIVED fellowship.
    for (const table of ["application", "scholarship_history"] as const) {
      const { data, error } = await staffActive.client
        .from(table)
        .select("fellowship_id")
        .eq("fellowship_id", archivedFellowshipId);
      expect(error, `${table} archived-fellowship historical read`).toBeNull();
      expect(data ?? [], `${table} archived-fellowship child still readable`).toHaveLength(1);
    }
  });

  it("lets non-reference updates on child records of archived parents pass through (only re-links are guarded)", async () => {
    const { archivedStudentId } = await seedArchivedParents();

    // The seeded application references the archived student; updating a
    // non-reference column (stage) does not fire the FK-scoped guard.
    const { data: seeded, error: selectError } = await service
      .from("application")
      .select("application_id")
      .eq("student_id", archivedStudentId)
      .maybeSingle();
    expect(selectError).toBeNull();
    expect(seeded).not.toBeNull();

    const { data, error } = await staffActive.client
      .from("application")
      .update({ stage_of_application: "Under Review" })
      .eq("application_id", seeded!.application_id as number)
      .select("application_id");
    expect(error, "non-reference application UPDATE must succeed").toBeNull();
    expect(data ?? [], "non-reference application UPDATE must affect one row").toHaveLength(1);

    const row = await readRow("application", "application_id", seeded!.application_id as number);
    expect(row?.stage_of_application).toBe("Under Review");
    expect(row?.student_id).toBe(archivedStudentId);
  });

  it("lets a child re-link AWAY from an archived parent to an ACTIVE parent (the guard only blocks archived targets)", async () => {
    const { archivedStudentId, activeStudentId } = await seedArchivedParents();

    const { data: seeded, error: selectError } = await service
      .from("application")
      .select("application_id")
      .eq("student_id", archivedStudentId)
      .maybeSingle();
    expect(selectError).toBeNull();
    expect(seeded).not.toBeNull();

    const { data, error } = await staffActive.client
      .from("application")
      .update({ student_id: activeStudentId })
      .eq("application_id", seeded!.application_id as number)
      .select("application_id");
    expect(error, "re-link to an ACTIVE parent must succeed").toBeNull();
    expect(data ?? [], "re-link to an ACTIVE parent must affect one row").toHaveLength(1);

    const row = await readRow("application", "application_id", seeded!.application_id as number);
    expect(row?.student_id).toBe(activeStudentId);
  });

  it("preserves every non-archived workflow: children referencing ACTIVE parents insert normally", async () => {
    const { activeStudentId, activeFellowshipId } = await seedArchivedParents();

    const { data: application, error: applicationError } = await staffActive.client
      .from("application")
      .insert({ student_id: activeStudentId, fellowship_id: activeFellowshipId, stage_of_application: "Submitted" })
      .select("application_id")
      .single();
    expect(applicationError, "active-reference application INSERT").toBeNull();
    expect(application).not.toBeNull();

    const { data: meeting, error: meetingError } = await staffActive.client
      .from("advising_meeting")
      .insert({
        student_id: activeStudentId,
        // R8 (migration 20261008000001): authenticated new meetings must name
        // the conducting advisor; inactive-advisor conduct is allowed for
        // historical attribution, but NULL advisor is a legacy-only state.
        advisor_id: staffActive.advisorId!,
        meeting_date: "2026-09-01",
        meeting_mode: "Virtual",
      })
      .select("meeting_id")
      .single();
    expect(meetingError, "active-reference meeting INSERT").toBeNull();
    expect(meeting).not.toBeNull();

    const { data: attendance, error: attendanceError } = await staffActive.client
      .from("fellowship_thursday")
      .insert({ student_id: activeStudentId, attended: true, source_info: "OCF" })
      .select("attendance_id")
      .single();
    expect(attendanceError, "active-reference attendance INSERT").toBeNull();
    expect(attendance).not.toBeNull();

    const { data: history, error: historyError } = await staffActive.client
      .from("scholarship_history")
      .insert({ student_id: activeStudentId, fellowship_id: activeFellowshipId })
      .select("history_id")
      .single();
    expect(historyError, "active-reference history INSERT").toBeNull();
    expect(history).not.toBeNull();
  });

  it("exempts trusted service_role/DBA sessions (fixture seeding and trusted fixes keep working)", async () => {
    const { archivedStudentId, archivedFellowshipId } = await seedArchivedParents();

    // The boundary targets browser/authenticated sessions. Trusted technical
    // sessions may still create children of archived parents for fixture
    // seeding and data fixes — the same exemption as the lifecycle guards.
    const { data, error } = await service
      .from("application")
      .insert({
        student_id: archivedStudentId,
        fellowship_id: archivedFellowshipId,
        stage_of_application: "Submitted",
        destination_country: "Boundary Trusted Seed",
      })
      .select("application_id")
      .single();
    expect(error, "trusted service_role application INSERT").toBeNull();
    expect(data).not.toBeNull();
  });
});