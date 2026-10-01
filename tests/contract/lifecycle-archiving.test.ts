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
 *     is never authorization (an advisor with `role = 'admin'` but no claim is
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
 *   - SELF-DEACTIVATION GUARD: an administrator cannot deactivate their own
 *     active advisor row (it would instantly strand their session); a second
 *     administrator can.
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
  table: "student" | "fellowship" | "advisor",
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
let staffActive: BoundActor; // active advisor, role='admin' but NO ocf_admin claim
let noAdvisor: BoundActor; // authenticated user with no advisor row

beforeAll(async () => {
  pool = createDbPool(env);

  // Core operational rows (student, fellowship, application, meeting,
  // attendance, history) for the cross-entity read assertions.
  await seedCoreFixtures(service);

  adminOne = await createAdmin("one");
  adminTwo = await createAdmin("two");
  staffActive = await createBoundAdvisor("staff-active");
  noAdvisor = await createNoAdvisorUser("user");

  // The mutable advisor.role column is NEVER authorization (design §Security):
  // give the non-claim active advisor the most privileged-looking role so the
  // suite proves lifecycle decisions ignore it entirely.
  const { error: roleError } = await service
    .from("advisor")
    .update({ role: "admin" })
    .eq("advisor_id", staffActive.advisorId!)
    .select("advisor_id");
  if (roleError) throw new Error(`set staff-active role=admin: ${roleError.message}`);
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

  it("resolves false for an authenticated advisor without the claim, even with advisor.role='admin'", async () => {
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
  it("denies a non-admin active advisor (42501) even with advisor.role='admin'", async () => {
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

  it("lets a SECOND administrator deactivate an administrator's advisor, and lets the owner reactivate it", async () => {
    // The deliberate path: another administrator performs the deactivation.
    const { data: deactivated, error } = await transition(adminTwo.client, "advisor", "deactivate", adminOne.advisorId!);
    expect(error, "second-admin deactivation").toBeNull();
    expect(deactivated![0]).toMatchObject({ action: "deactivate", applied: true, is_active: false });

    // The deactivated administrator's claim is intact, so they may reactivate
    // their own row (the guard permits self-reactivation).
    const { data: reactivated, error: reactError } = await transition(adminOne.client, "advisor", "reactivate", adminOne.advisorId!);
    expect(reactError, "self-reactivation").toBeNull();
    expect(reactivated![0]).toMatchObject({ action: "reactivate", applied: true, is_active: true });

    const row = await readRow("advisor", "advisor_id", adminOne.advisorId!);
    expect(row?.is_active).toBe(true);
  });

  it("allows the idempotent no-op deactivation of an administrator's own already-inactive row", async () => {
    // The guard only blocks the transition that would FLIP the caller's own
    // ACTIVE row to inactive. An administrator whose own advisor row is already
    // inactive may re-issue deactivate: it is a no-op (applied=false) that
    // never touches the row, and reactivating the own row remains allowed.
    const alreadyInactiveAdmin = await createAdmin("own-inactive", false);
    expect(alreadyInactiveAdmin.advisorId).toBeDefined();

    const { data: deactivated, error } = await transition(alreadyInactiveAdmin.client, "advisor", "deactivate", alreadyInactiveAdmin.advisorId!);
    expect(error, "no-op deactivation of own already-inactive row").toBeNull();
    expect(deactivated![0]).toMatchObject({ action: "deactivate", applied: false, is_active: false });

    const { data: reactivated, error: reactError } = await transition(alreadyInactiveAdmin.client, "advisor", "reactivate", alreadyInactiveAdmin.advisorId!);
    expect(reactError, "self-reactivation of an already-inactive own row").toBeNull();
    expect(reactivated![0]).toMatchObject({ action: "reactivate", applied: true, is_active: true });

    const row = await readRow("advisor", "advisor_id", alreadyInactiveAdmin.advisorId!);
    expect(row?.is_active).toBe(true);
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

    // The broad active-staff UPDATE policy would permit this UPDATE; the
    // invoker-security guard closes the peer-deactivation path fail-closed.
    const { data, error } = await staffActive.client
      .from("advisor")
      .update({ is_active: false })
      .eq("advisor_id", peer.advisorId!)
      .select("advisor_id");
    expect(error, "direct peer deactivation must be denied").not.toBeNull();
    expect(error?.code, "direct peer deactivation denial code").toBe("42501");
    expect(data ?? [], "denied update must not return a row").toHaveLength(0);

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

  it("lets an active advisor create an advisor in the active lifecycle state (is_active = true)", async () => {
    const email = syntheticEmail(nextUnique("ordinary-advisor-insert"));
    const { data, error } = await staffActive.client
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("ordinary-advisor-insert")),
        email,
        is_active: true,
      })
      .select("advisor_id")
      .single();
    expect(error, "ordinary advisor INSERT must succeed").toBeNull();
    expect(data).not.toBeNull();

    const row = await readRow("advisor", "advisor_id", data!.advisor_id as number);
    expect(row?.is_active).toBe(true);
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