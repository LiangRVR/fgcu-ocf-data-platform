/**
 * tests/contract/advisor-audit.test.ts
 *
 * Contract tests for the `advisor-admin-immutable-history` change (migration to
 * be added after 20261012000001_immutable_audit.sql).
 *
 * Proves, against the fresh isolated Docker-local contract lane, the advisor /
 * administrator audit + lifecycle behaviour promised by the change
 * requirements and design:
 *
 *   - R1/R2  advisor `created` events carry an allowlisted business snapshot
 *            (`advisor_name`, `email`, `role`, `is_active`) and NEVER binding,
 *            authentication, credential, token, claim, service-role, or
 *            login-time data (`auth_user_id`, `last_login_at`, `created_at`,
 *            role-lock state, ...).
 *   - R2     `last_login_at`-only and no-op restatement updates create NO event.
 *   - R3     a meaningful advisor profile update creates exactly one
 *            `advisor/updated` event with allowlisted before/after values; a
 *            self-update is attributed to that advisor, an Admin update of
 *            another advisor is attributed to the Admin.
 *   - R4     an ordinary authenticated profile update cannot change
 *            `advisor.email` (the projection cannot silently diverge from the
 *            Auth identity on the ordinary path).
 *   - R5     a role change requires a non-blank reason, revalidates the trusted
 *            actor, updates the durable Auth claim + display projection in one
 *            transaction, and emits exactly ONE `advisor/role_changed` event
 *            (never also a generic `updated`).
 *   - R6     lifecycle transitions require a non-blank reason and record
 *            exactly one event with that reason; a failed audit write rolls
 *            back the business state and the event together (NFR1).
 *   - R7     a role demotion or advisor deactivation that would leave zero
 *            active, bound, durable (`auth.users.raw_app_meta_data.ocf_admin`)
 *            effective Admins is rejected, allowed non-final reductions
 *            succeed, and competing membership-reducing transactions serialize
 *            (NFR2).
 *   - R9     audit rows remain immutable to product roles (including Admin) and
 *            historical advisor attribution survives deactivation / rename.
 *   - RPC    the production peer-name path (`update_advisor_profile_name`,
 *            migration 20261014000001): an effective Admin renames ANOTHER
 *            advisor through the authenticated-only SECURITY DEFINER RPC with
 *            exactly one attributed `advisor/updated` event and a name-only
 *            diff, email preserved, no-op restatements suppressed, and
 *            non-Admin / self / invalid-input / unauthenticated / technical
 *            (service_role) access denied fail-closed.
 *
 * ## Contract-signature note (parallel-lane integration)
 *
 * The change specifies new `set_advisor_role` (actor + reason) and
 * `lifecycle_transition` (reason) parameters, but the design does not pin the
 * exact SQL parameter identifiers. Rather than hard-code identifiers this suite
 * resolves the live function argument names from `pg_proc` and maps them by
 * semantics, asserting there is exactly ONE overload for each. This keeps the
 * behavioural contract assertions stable while still failing loudly if the
 * signature regresses (missing actor/reason, duplicate legacy overload).
 *
 * Service-role usage is restricted to synthetic fixture seeding/cleanup, Auth
 * user creation, the admin pre-bind, and the persisted-state oracle re-read
 * (service_role bypasses audit RLS for reads only; it is never asserted as an
 * access grant).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createAnonClient,
  createDbPool,
  createServiceRoleClient,
  getContractEnv,
} from "./helpers/setup";
import {
  createAuthUser,
  signInWithPassword,
  syntheticEmail,
  syntheticName,
} from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);
let pool: Pool;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureSeq = 0;
function nextUnique(prefix: string): string {
  fixtureSeq += 1;
  return `${prefix}-${fixtureSeq}`;
}

function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface Actor {
  userId: string;
  email: string;
  advisorName: string;
  client: SupabaseClient;
  advisorId: number;
}

async function insertAdvisor(advisorName: string, email: string, isActive = true): Promise<number> {
  const { data, error } = await service
    .from("advisor")
    .insert({ advisor_name: advisorName, email, is_active: isActive })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`seed advisor ${advisorName}: ${error.message}`);
  return data.advisor_id as number;
}

/** ADMIN PRE-BINDING: the only legitimate way auth_user_id is ever written. */
async function bindAdvisor(advisorId: number, userId: string): Promise<void> {
  const { error } = await service
    .from("advisor")
    .update({ auth_user_id: userId })
    .eq("advisor_id", advisorId)
    .select("advisor_id");
  if (error) throw new Error(`admin pre-bind advisor ${advisorId}: ${error.message}`);
}

async function createBoundActor(label: string, admin = false, isActive = true): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(
    service,
    email,
    admin ? { appMetadata: { ocf_admin: true } } : {}
  );
  const advisorId = await insertAdvisor(advisorName, email, isActive);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

async function seedStudent(label: string): Promise<number> {
  const tag = nextUnique(label);
  const { data, error } = await service
    .from("student")
    .insert({
      full_name: syntheticName(tag),
      email: syntheticEmail(tag),
      us_citizen: true,
    })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student: ${error.message}`);
  return data.student_id as number;
}

// ---------------------------------------------------------------------------
// Audit oracle reads
// ---------------------------------------------------------------------------

interface AuditRow {
  audit_id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_advisor_id: number | null;
  actor_name_snapshot: string;
  occurred_at: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  reason: string | null;
  origin: string;
}

async function readAudit(entityType: string, entityId: number): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT audit_id, entity_type, entity_id, action, actor_advisor_id,
            actor_name_snapshot, occurred_at, old_values, new_values, changes,
            reason, origin
       FROM public.audit_event
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY audit_id`,
    [entityType, entityId]
  );
  return rows;
}

/** The advisor business-field allowlist asserted verbatim (sorted). */
const ADVISOR_KEYS = ["advisor_name", "email", "is_active", "role"].sort();
const ADVISOR_FORBIDDEN_KEYS = [
  "auth_user_id",
  "last_login_at",
  "created_at",
  "holder",
  "lease_expires_at",
  "expires_at",
  "updated_at",
  // Durable Auth claim / role-lock surface must never enter a business payload.
  "ocf_admin",
  "role_lock",
  "advisor_role_lock",
];

function assertAllowlisted(values: Record<string, unknown> | null, label: string): void {
  expect(values, `${label} must be present`).not.toBeNull();
  expect(Object.keys(values ?? {}).sort(), `${label} must be exactly the advisor allowlist`).toEqual(
    ADVISOR_KEYS
  );
  for (const forbidden of ADVISOR_FORBIDDEN_KEYS) {
    expect(values, `${label} must never contain ${forbidden}`).not.toHaveProperty(forbidden);
  }
}

async function readAuthClaim(userId: string): Promise<boolean | null> {
  const { rows } = await pool.query<{ ocf_admin: boolean | null }>(
    `SELECT (raw_app_meta_data -> 'ocf_admin')::boolean AS ocf_admin
       FROM auth.users WHERE id = $1`,
    [userId]
  );
  return rows[0]?.ocf_admin ?? null;
}

// ---------------------------------------------------------------------------
// RPC signature resolution + semantic argument mapping
//
// The design fixes the semantics (actor + reason for set_advisor_role, reason
// for lifecycle_transition) but not the identifier spelling. Resolve the live
// input argument names once from the catalog and map by meaning. Exactly one
// overload is required: a lingering legacy overload would be a contract bug.
// ---------------------------------------------------------------------------

const rpcArgsCache = new Map<string, string[]>();

async function rpcInputArgNames(fnName: string): Promise<string[]> {
  const cached = rpcArgsCache.get(fnName);
  if (cached) return cached;
  const { rows } = await pool.query<{ names: string[] | null }>(
    `SELECT p.proargnames[1:p.pronargs] AS names
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'`,
    [fnName]
  );
  if (rows.length !== 1) {
    throw new Error(
      `contract requires exactly one public.${fnName} overload, found ${rows.length}` +
        " (a legacy overload left by the new migration is a contract bug)"
    );
  }
  const names = (rows[0].names ?? []).filter((n): n is string => typeof n === "string" && n.length > 0);
  rpcArgsCache.set(fnName, names);
  return names;
}

interface SetRoleSpec {
  advisorId: number;
  role: string;
  actorAdvisorId: number;
  reason: string;
  /** Expected target row_version (migration 20261015000001). Auto-read when omitted. */
  expectedVersion?: number;
}
interface LifecycleSpec {
  entity: string;
  action: string;
  entityId: number;
  reason: string;
  /** Expected target row_version (migration 20261015000001). Auto-read when omitted. */
  expectedVersion?: number;
}

/**
 * Read the CURRENT `row_version` of a current-state row — the expected-version
 * oracle for the versioned writer signatures (migration 20261015000001). Falls
 * back to `1` for a non-current-state entity, a missing row, or an
 * intentionally invalid id (the RPC's own fail-closed checks decide outcomes
 * for those cases).
 */
async function currentRowVersion(entityOrTable: string, id: number): Promise<number> {
  const table =
    entityOrTable === "student" || entityOrTable === "fellowship" || entityOrTable === "advisor"
      ? entityOrTable
      : null;
  if (!table) return 1;
  const idColumn = table === "student" ? "student_id" : table === "fellowship" ? "fellowship_id" : "advisor_id";
  const { rows } = await pool.query<{ row_version: number }>(
    `SELECT row_version FROM public.${table} WHERE ${idColumn} = $1`,
    [id]
  );
  return rows[0]?.row_version ?? 1;
}

function mapSetRoleArgs(names: string[], spec: SetRoleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.includes("expected") || n.includes("version")) out[name] = spec.expectedVersion ?? 1;
    else if (n.includes("reason")) out[name] = spec.reason;
    else if (n.includes("actor")) out[name] = spec.actorAdvisorId;
    else if (n.includes("admin")) out[name] = spec.actorAdvisorId;
    else if (n.includes("role")) out[name] = spec.role;
    else if (n.includes("advisor") || n.endsWith("_id")) out[name] = spec.advisorId;
    else throw new Error(`unmapped set_advisor_role parameter "${name}"`);
  }
  return out;
}

function mapLifecycleArgs(names: string[], spec: LifecycleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.includes("expected") || n.includes("version")) out[name] = spec.expectedVersion ?? 1;
    else if (n.includes("reason")) out[name] = spec.reason;
    else if (n.includes("entity") && n.includes("id")) out[name] = spec.entityId;
    else if (n.includes("entity")) out[name] = spec.entity;
    else if (n.includes("action")) out[name] = spec.action;
    else throw new Error(`unmapped lifecycle_transition parameter "${name}"`);
  }
  return out;
}

async function callSetAdvisorRole(spec: SetRoleSpec): Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}> {
  const names = await rpcInputArgNames("set_advisor_role");
  const args = mapSetRoleArgs(names, {
    ...spec,
    expectedVersion: spec.expectedVersion ?? (await currentRowVersion("advisor", spec.advisorId)),
  });
  const { data, error } = await service.rpc("set_advisor_role", args);
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

async function callLifecycle(
  client: SupabaseClient,
  spec: LifecycleSpec
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  const names = await rpcInputArgNames("lifecycle_transition");
  const args = mapLifecycleArgs(names, {
    ...spec,
    expectedVersion:
      spec.expectedVersion ??
      (spec.entityId == null ? 1 : await currentRowVersion(spec.entity, spec.entityId)),
  });
  const { data, error } = await client.rpc("lifecycle_transition", args);
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

/**
 * Promote an actor to the display `Admin` projection through the trusted RPC.
 * Durable membership is driven by the Auth claim, but the tests keep the
 * display projection consistent so a later demotion is never a display no-op.
 */
async function promoteToAdmin(target: Actor): Promise<void> {
  const result = await callSetAdvisorRole({
    advisorId: target.advisorId,
    role: "Admin",
    actorAdvisorId: adminActor.advisorId,
    reason: `contract setup: promote ${target.advisorId}`,
  });
  if (result.error) {
    throw new Error(`promote advisor ${target.advisorId}: ${result.error.message}`);
  }
}

/** Direct SQL call (positional) for transaction-scoped / concurrency tests. */
async function directSetAdvisorRole(client: PoolClient, spec: SetRoleSpec): Promise<void> {
  const names = await rpcInputArgNames("set_advisor_role");
  const mapped = mapSetRoleArgs(names, {
    ...spec,
    expectedVersion: spec.expectedVersion ?? (await currentRowVersion("advisor", spec.advisorId)),
  });
  const values = names.map((n) => mapped[n]);
  const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");
  await client.query(`SELECT public.set_advisor_role(${placeholders})`, values);
}

/**
 * Self-service expected-version writer (migration 20261015000001 replaces the
 * revoked self-scoped table UPDATE): the authenticated caller updates ONLY
 * their own `advisor_name` through `public.update_my_advisor_profile`.
 */
async function callSelfProfileName(
  client: SupabaseClient,
  expectedVersion: number,
  advisorName: string
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  const { data, error } = await client.rpc("update_my_advisor_profile", {
    p_expected_version: expectedVersion,
    p_advisor_name: advisorName,
  });
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

/**
 * Temporarily neutralize every durable Admin except the given auth user ids,
 * inside the caller's transaction. Never committed by this suite; used to make
 * the global last-Admin invariant deterministic without corrupting shared
 * state.
 */
async function neutralizeOtherAdmins(client: PoolClient, keepUserIds: string[]): Promise<void> {
  await client.query(
    `UPDATE auth.users u
        SET raw_app_meta_data = jsonb_set(
              coalesce(u.raw_app_meta_data, '{}'::jsonb), '{ocf_admin}', 'false'::jsonb)
      WHERE u.id IN (
              SELECT a.auth_user_id FROM public.advisor a
               WHERE a.is_active = true AND a.auth_user_id IS NOT NULL)
        AND u.id <> ALL($1::uuid[])`,
    [keepUserIds]
  );
}

/**
 * Take the same fixed transaction advisory lock the migration uses for
 * durable-Admin membership. This serializes the test's neutralization with any
 * other set_advisor_role/lifecycle transition in the (possibly parallel)
 * contract lane, so the global last-Admin membership stays deterministic for
 * the duration of the transaction.
 */
async function lockMembership(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('ocf.advisor_admin_membership', 0))`
  );
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let adminActor: Actor; // active bound advisor + ocf_admin durable claim (actor)
let staffActor: Actor; // active bound advisor, no claim
let targetAdvisor: Actor; // active bound advisor, no claim (update/role target)

beforeAll(async () => {
  pool = createDbPool(env);
  staffActor = await createBoundActor("staff");
  adminActor = await createBoundActor("admin", true);
  // Establish the display projection consistently for the primary actor so the
  // last-Admin scenarios demote a real display Admin (never a display no-op).
  await promoteToAdmin(adminActor);
  targetAdvisor = await createBoundActor("target");
});

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// R1/R2: created event + actor attribution + allowlist / exclusions
// ---------------------------------------------------------------------------

describe("advisor audit: created events, actor attribution, and JSON exclusions (R1/R2)", () => {
  it("denies authenticated advisor-row creation (provisioning is the only creator) instead of a client INSERT event", async () => {
    const tag = nextUnique("created-advisor");
    const email = syntheticEmail(tag);
    const name = syntheticName(tag);

    // Migration 20261002000001 dropped `advisor_insert_active_staff`: advisor
    // rows are created ONLY through the trusted service-role provisioning
    // path (`provision_advisor`). An authenticated active advisor cannot
    // fabricate a row, so there is no client INSERT and no forged `created`
    // event path. The R1 created-event attribution is proven below through
    // `provision_advisor` (the trusted creator).
    const { data, error } = await staffActor.client
      .from("advisor")
      .insert({ advisor_name: name, email })
      .select("advisor_id")
      .single();
    expect(error, "authenticated advisor INSERT must be denied").not.toBeNull();
    expect(error?.code, "authenticated advisor INSERT denial code").toBe("42501");
    expect(data ?? [], "denied advisor INSERT returns no row").toHaveLength(0);

    // Absence proof: no advisor row was created for the attempted email.
    const { data: remaining } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("email", email);
    expect(remaining ?? [], "no advisor row may exist for the denied INSERT").toHaveLength(0);
  });

  it("never leaks binding/auth/login columns into an advisor snapshot", async () => {
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("exclusion")),
      syntheticEmail(nextUnique("exclusion"))
    );
    const events = await readAudit("advisor", advisorId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      assertAllowlisted(event.new_values, `created new_values for ${advisorId}`);
      if (event.old_values) assertAllowlisted(event.old_values, `updated old_values for ${advisorId}`);
      if (event.changes) {
        for (const key of Object.keys(event.changes)) {
          expect(ADVISOR_KEYS, `changes key ${key} must be allowlisted`).toContain(key);
        }
      }
    }
  });

  it("does not treat the technical (service-role) fixture insert as a forged human actor", async () => {
    // A service-role INSERT has no browser actor. Whatever the migration's
    // trusted-context contract is, it must never attribute the event to the
    // newly inserted advisor itself (no self-attribution from payload data).
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("system")),
      syntheticEmail(nextUnique("system"))
    );
    const events = await readAudit("advisor", advisorId);
    expect(events).toHaveLength(1);
    expect(events[0].actor_advisor_id, "an advisor is never its own creation actor").not.toBe(
      advisorId
    );
  });

  it("provision_advisor attributes the created event to the initiating durable Admin, not System (R1)", async () => {
    const tag = nextUnique("provisioned");
    const email = syntheticEmail(tag);
    const name = syntheticName(tag);
    const authUserId = await createAuthUser(service, email, { appMetadata: { ocf_admin: false } });

    const { data, error } = await service.rpc("provision_advisor", {
      p_actor_id: adminActor.advisorId,
      p_advisor_name: name,
      p_auth_user_id: authUserId,
      p_email: email,
      p_role: "Advisor",
    });
    expect(error, "provision_advisor success").toBeNull();
    const row = (data as { advisor_id: number; auth_user_id: string; role: string }[] | null)?.[0];
    expect(row, "provision_advisor returns the created row").toBeDefined();
    expect(row!.auth_user_id, "identity bound in the same transaction").toBe(authUserId);
    expect(row!.role).toBe("Advisor");

    const events = await readAudit("advisor", row!.advisor_id);
    expect(events, "exactly one created event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "created",
      origin: "user",
      actor_advisor_id: adminActor.advisorId,
      actor_name_snapshot: adminActor.advisorName,
    });
    expect(events[0].actor_name_snapshot, "not attributed to System").not.toBe("System");
    assertAllowlisted(events[0].new_values, "provisioned new_values");
    expect(events[0].new_values).toMatchObject({ advisor_name: name, email, role: "Advisor" });
  });

  it("provision_advisor rejects a non-effective-Admin actor and creates nothing", async () => {
    const tag = nextUnique("provision-denied");
    const email = syntheticEmail(tag);
    const authUserId = await createAuthUser(service, email);

    const { error } = await service.rpc("provision_advisor", {
      p_actor_id: staffActor.advisorId, // no ocf_admin durable claim
      p_advisor_name: syntheticName(tag),
      p_auth_user_id: authUserId,
      p_email: email,
      p_role: "Advisor",
    });
    expect(error, "non-Admin actor must be rejected").not.toBeNull();
    expect(error?.code).toBe("42501");

    const { data: created } = await service
      .from("advisor")
      .select("advisor_id")
      .eq("email", email);
    expect(created ?? [], "no partial advisor row").toHaveLength(0);
  });

  it("denies the browser (authenticated) role any provision_advisor execute path", async () => {
    const denied = await adminActor.client.rpc("provision_advisor", {
      p_actor_id: adminActor.advisorId,
      p_advisor_name: syntheticName(nextUnique("provision-client")),
      p_auth_user_id: adminActor.userId,
      p_email: syntheticEmail(nextUnique("provision-client")),
      p_role: "Advisor",
    });
    expect(denied.error, "authenticated provision_advisor must be denied").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R2: noise suppression (last_login_at, no-op, technical-only)
// ---------------------------------------------------------------------------

describe("advisor audit: no-op and technical-only suppression (R2)", () => {
  it("creates no event for a last_login_at-only update", async () => {
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("login-only")),
      syntheticEmail(nextUnique("login-only"))
    );
    const before = (await readAudit("advisor", advisorId)).length;

    // `last_login_at` is technical/client-session metadata, never a writable
    // business field. Direct authenticated UPDATE on advisor is revoked
    // (migration 20261015000001), so the write is exercised through the
    // trusted technical session (service role), which still resolves an actor
    // for the audit helper; the no-audit contract (technical-only columns are
    // not in the allowlist) is unchanged.
    const { error } = await service
      .from("advisor")
      .update({ last_login_at: new Date().toISOString() })
      .eq("advisor_id", advisorId)
      .select("advisor_id");
    expect(error, "last_login_at update must be permitted").toBeNull();

    const after = await readAudit("advisor", advisorId);
    expect(after.length, "last_login_at is not an audited business field").toBe(before);
  });

  it("creates no event for a no-op restatement of allowlisted values", async () => {
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("noop")),
      syntheticEmail(nextUnique("noop"))
    );
    const { rows } = await pool.query<{ advisor_name: string; email: string }>(
      "SELECT advisor_name, email FROM public.advisor WHERE advisor_id = $1",
      [advisorId]
    );
    const before = (await readAudit("advisor", advisorId)).length;

    // A no-op restatement of the exact same business values (trusted lane
    // superuser write, the same shape a client would have submitted before the
    // authenticated UPDATE revoke) produces no diff and therefore no event.
    const { rowCount } = await pool.query(
      "UPDATE public.advisor SET advisor_name = $1, email = $2 WHERE advisor_id = $3",
      [rows[0].advisor_name, rows[0].email, advisorId]
    );
    expect(rowCount).toBe(1);

    expect((await readAudit("advisor", advisorId)).length, "no-op creates no event").toBe(before);
  });

  it("creates no event when only auth_user_id is bound (technical binding write)", async () => {
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("bind-only")),
      syntheticEmail(nextUnique("bind-only"))
    );
    const before = (await readAudit("advisor", advisorId)).length;
    const userId = await createAuthUser(service, syntheticEmail(nextUnique("bind-user")));
    await bindAdvisor(advisorId, userId);
    expect(
      (await readAudit("advisor", advisorId)).length,
      "the technical auth_user_id bind is not an audited business change"
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// R3: updated events + actor attribution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R7: advisor role-lock state / durable claim never enter an audit payload
// ---------------------------------------------------------------------------

describe("advisor role-lock state is excluded from every audit payload (R7)", () => {
  it("keeps role-lock table state and the durable claim out of an advisor snapshot while a live lock exists", async () => {
    const actor = await createBoundActor("role-lock-exclusion");
    const holder = nextUnique("role-lock-holder");

    const acquired = await service.rpc("acquire_advisor_role_lock", {
      p_advisor_id: actor.advisorId,
      p_holder: holder,
      p_lease_seconds: 60,
    });
    expect(acquired.error, "acquire a live role lock for the exclusion proof").toBeNull();

    try {
      const renamed = syntheticName(nextUnique("role-lock-rename"));
      const result = await callSelfProfileName(actor.client, 1, renamed);
      expect(result.error, "profile write while a role lock row exists").toBeNull();

      const events = await readAudit("advisor", actor.advisorId);
      const update = events.find((e) => e.action === "updated");
      expect(update, "the lock-era profile event exists").toBeDefined();

      // Exactly the four business fields — never a role-lock column or claim.
      assertAllowlisted(update!.old_values, "role-lock-era old_values");
      assertAllowlisted(update!.new_values, "role-lock-era new_values");
      for (const leaked of [
        "holder",
        "lease_expires_at",
        "ocf_admin",
        "role_lock",
        "advisor_role_lock",
        "auth_user_id",
      ]) {
        expect(update!.new_values, `new_values must not leak role-lock/claim key ${leaked}`).not.toHaveProperty(
          leaked
        );
        expect(update!.old_values, `old_values must not leak role-lock/claim key ${leaked}`).not.toHaveProperty(
          leaked
        );
      }

      // The lock table is not a client-readable surface at all.
      const lockRead = await actor.client.from("advisor_role_lock").select("advisor_id");
      expect(lockRead.error, "authenticated role-lock read must be denied").not.toBeNull();
    } finally {
      await service.rpc("release_advisor_role_lock", {
        p_advisor_id: actor.advisorId,
        p_holder: holder,
      });
    }
  });
});

describe("advisor audit: updated events and actor attribution (R3)", () => {
  it("attributes a self profile-name update to that advisor with a single diff event", async () => {
    const actor = await createBoundActor("self-update");
    const next = `${actor.advisorName} (Self)`;

    // The self-scoped table UPDATE was replaced by the expected-version
    // self-service writer (migration 20261015000001); the fresh row starts at
    // version 1. The audit attribution shape is unchanged.
    const result = await callSelfProfileName(actor.client, 1, next);
    expect(result.error).toBeNull();

    const events = await readAudit("advisor", actor.advisorId);
    const updates = events.filter((e) => e.action === "updated");
    expect(updates, "exactly one updated event").toHaveLength(1);
    expect(updates[0].origin).toBe("user");
    expect(updates[0].actor_advisor_id).toBe(actor.advisorId);
    // The snapshot freezes the actor's CURRENT display name at event time; a
    // self-rename therefore records the post-rename name.
    expect(updates[0].actor_name_snapshot).toBe(next);
    expect(updates[0].changes).toEqual({ advisor_name: { old: actor.advisorName, new: next } });
    assertAllowlisted(updates[0].old_values, "self-update old_values");
    assertAllowlisted(updates[0].new_values, "self-update new_values");
  });

  it("attributes a trusted Admin edit of another advisor to the Admin (the authenticated table path is self-scoped)", async () => {
    const target = await createBoundActor("admin-edit-target");
    const next = `${target.advisorName} (Admin trusted edit)`;

    // The authenticated table API is deliberately self-scoped
    // (`advisor_update_own_profile`, migration 20261002000001): an Admin can
    // never silently rewrite a peer advisor's profile row by hand. The peer
    // is invisible to the authenticated UPDATE policy, so a direct attempt
    // yields no row (RLS filter) — and, when reached, the column-scoped
    // guards reject the write. Either way a peer is untouched by a browser
    // session.
    const denied = await adminActor.client
      .from("advisor")
      .update({ advisor_name: next })
      .eq("advisor_id", target.advisorId)
      .select("advisor_id");
    if (denied.error) {
      expect(denied.error.code, "authenticated peer update denial code").toBe("42501");
    } else {
      expect(denied.data ?? [], "RLS filters an authenticated peer update to zero rows").toHaveLength(0);
    }

    // The only supported path for an Admin editing another advisor's permitted
    // profile field is the trusted server adapter: a technical session
    // verifies the durable Admin actor through the DB-local trusted-actor
    // context and then writes the row, so the audit trigger attributes the
    // single `updated` event to that Admin (R3).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT private.set_audit_actor($1)", [adminActor.advisorId]);
      await client.query(
        "UPDATE public.advisor SET advisor_name = $1 WHERE advisor_id = $2",
        [next, target.advisorId]
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const updates = (await readAudit("advisor", target.advisorId)).filter(
      (e) => e.action === "updated"
    );
    expect(updates, "one updated event from the trusted Admin edit").toHaveLength(1);
    expect(updates[0].actor_advisor_id, "Admin attribution").toBe(adminActor.advisorId);
    expect(updates[0].actor_name_snapshot).toBe(adminActor.advisorName);
    expect(updates[0].changes).toEqual({
      advisor_name: { old: target.advisorName, new: next },
    });
  });
});

// ---------------------------------------------------------------------------
// RPC: effective-Admin peer profile-name production path
// (`public.update_advisor_profile_name`, migration 20261014000001, extended by
// the versioned expected-version signature of migration 20261015000001)
//
// The ONLY production server path for an effective Admin to change another
// advisor's permitted profile data: an authenticated-only SECURITY DEFINER RPC
// that derives the actor from `auth.uid()` (never a parameter), validates the
// existing effective-Admin boundary, rejects the caller's own row, writes ONLY
// `advisor_name`, and lets the existing advisor audit trigger emit exactly one
// attributed `updated` event (or none for a no-op). Migration 20261015000001
// drops the legacy 2-arg overload and REQUIRES `p_expected_version` (PT409 on
// a stale target, 22023 when malformed), so a browser session can never bypass
// the optimistic-concurrency precondition through a legacy arity. `email` is
// unreachable, no reason is required (R8: ordinary profile edit), and
// technical/service-role sessions are revoked.
// ---------------------------------------------------------------------------

describe("update_advisor_profile_name: effective-Admin peer-name production path", () => {
  interface RpcRow {
    advisor_id: number;
    advisor_name: string;
    row_version: number;
  }

  async function callProfileNameRpc(
    client: SupabaseClient,
    advisorId: number | null,
    advisorName: string | null,
    expectedVersion: number | null = 1
  ): Promise<{ data: RpcRow[] | null; error: { code?: string; message?: string } | null }> {
    const { data, error } = await client.rpc("update_advisor_profile_name", {
      p_advisor_id: advisorId,
      p_advisor_name: advisorName,
      p_expected_version: expectedVersion,
    });
    return {
      data: (data as RpcRow[] | null) ?? null,
      error: (error as { code?: string; message?: string } | null) ?? null,
    };
  }

  async function readProfile(advisorId: number): Promise<{ advisor_name: string; email: string }> {
    const { rows } = await pool.query<{ advisor_name: string; email: string }>(
      "SELECT advisor_name, email FROM public.advisor WHERE advisor_id = $1",
      [advisorId]
    );
    return rows[0];
  }

  it("lets an effective Admin update a peer name: exactly one attributed updated event, correct diff, preserved email", async () => {
    const target = await createBoundActor("profile-rpc-target");
    const next = `${target.advisorName} (Effective Admin)`;

    const result = await callProfileNameRpc(adminActor.client, target.advisorId, next, 1);
    expect(result.error, "effective-Admin peer rename succeeds").toBeNull();
    expect(result.data, "RPC returns the updated row").toHaveLength(1);
    expect(result.data![0]).toMatchObject({
      advisor_id: target.advisorId,
      advisor_name: next,
      row_version: 2,
    });

    // Only advisor_name changed; email is unreachable through the RPC and stays
    // identical to the Auth identity (R4 projection invariant).
    expect(await readProfile(target.advisorId)).toEqual({ advisor_name: next, email: target.email });

    // Exactly one `updated` event, attributed to the acting Admin (origin user
    // via auth.uid()), with the correct name-only diff and a preserved email.
    const events = await readAudit("advisor", target.advisorId);
    const updates = events.filter((e) => e.action === "updated");
    expect(updates, "exactly one updated event").toHaveLength(1);
    expect(updates[0].origin).toBe("user");
    expect(updates[0].actor_advisor_id, "attributed to the acting Admin").toBe(adminActor.advisorId);
    expect(updates[0].actor_name_snapshot, "frozen Admin display-name snapshot").toBe(
      adminActor.advisorName
    );
    expect(updates[0].changes, "name-only diff").toEqual({
      advisor_name: { old: target.advisorName, new: next },
    });
    assertAllowlisted(updates[0].old_values, "peer old_values");
    assertAllowlisted(updates[0].new_values, "peer new_values");
    expect(updates[0].new_values).toMatchObject({ advisor_name: next, email: target.email });
    expect(
      events.filter((e) => e.action !== "created" && e.action !== "updated"),
      "no fabricated extra event (role_changed / deactivated / ...)"
    ).toHaveLength(0);
  });

  it("trims the submitted name before writing, diffing, and returning it", async () => {
    const target = await createBoundActor("profile-rpc-trim");
    const next = `  ${target.advisorName} (Padded)  `;
    const trimmed = next.trim();

    const result = await callProfileNameRpc(adminActor.client, target.advisorId, next, 1);
    expect(result.error).toBeNull();
    expect(result.data![0]).toMatchObject({
      advisor_id: target.advisorId,
      advisor_name: trimmed,
      row_version: 2,
    });
    expect((await readProfile(target.advisorId)).advisor_name).toBe(trimmed);

    const updates = (await readAudit("advisor", target.advisorId)).filter(
      (e) => e.action === "updated"
    );
    expect(updates, "exactly one updated event").toHaveLength(1);
    expect(updates[0].changes).toEqual({
      advisor_name: { old: target.advisorName, new: trimmed },
    });
  });

  it("suppresses a no-op restatement: no event, row untouched", async () => {
    const target = await createBoundActor("profile-rpc-noop");
    const updatesBefore = (await readAudit("advisor", target.advisorId)).filter(
      (e) => e.action === "updated"
    );

    const result = await callProfileNameRpc(adminActor.client, target.advisorId, target.advisorName, 1);
    expect(result.error, "no-op restatement succeeds").toBeNull();
    expect(result.data![0]).toMatchObject({
      advisor_id: target.advisorId,
      advisor_name: target.advisorName,
      row_version: 1,
    });

    const updatesAfter = (await readAudit("advisor", target.advisorId)).filter(
      (e) => e.action === "updated"
    );
    expect(updatesAfter, "no-op records no new updated event").toHaveLength(updatesBefore.length);
    expect(await readProfile(target.advisorId)).toEqual({
      advisor_name: target.advisorName,
      email: target.email,
    });
  });

  it("denies a non-effective-Admin actor (claimless, inactive, or anonymous) and changes nothing", async () => {
    const target = await createBoundActor("profile-rpc-denied");
    const inactiveAdmin = await createBoundActor("profile-rpc-inactive-admin", true, false);
    const before = (await readAudit("advisor", target.advisorId)).length;

    // A bound, active advisor WITHOUT the durable ocf_admin claim: not an
    // effective Admin.
    const claimless = await callProfileNameRpc(staffActor.client, target.advisorId, "Sneak", 1);
    expect(claimless.error, "claimless advisor must be denied").not.toBeNull();
    expect(claimless.error?.code, "claimless denial code").toBe("42501");

    // A bound advisor WITH the durable claim but an INACTIVE advisor row:
    // fail-closed on the effective-Admin boundary even though the JWT still
    // claims admin (the claim alone is never authorization).
    const inactive = await callProfileNameRpc(inactiveAdmin.client, target.advisorId, "Sneak", 1);
    expect(inactive.error, "inactive advisor must be denied").not.toBeNull();
    expect(inactive.error?.code, "inactive denial code").toBe("42501");

    expect(await readProfile(target.advisorId)).toEqual({
      advisor_name: target.advisorName,
      email: target.email,
    });
    expect(
      (await readAudit("advisor", target.advisorId)).length,
      "no event from a denied rename"
    ).toBe(before);
  });

  it("refuses the caller's own row (self-service stays on the ordinary profile path)", async () => {
    const updatesBefore = (await readAudit("advisor", adminActor.advisorId)).filter(
      (e) => e.action === "updated"
    );
    const result = await callProfileNameRpc(
      adminActor.client,
      adminActor.advisorId,
      `${adminActor.advisorName} (Self via admin)`,
      1
    );
    expect(result.error, "self-update through the Admin route must be refused").not.toBeNull();
    expect(result.error?.code, "self-update denial code").toBe("22023");

    expect((await readProfile(adminActor.advisorId)).advisor_name).toBe(adminActor.advisorName);
    expect(
      (await readAudit("advisor", adminActor.advisorId)).filter((e) => e.action === "updated"),
      "no event from the refused self-update"
    ).toHaveLength(updatesBefore.length);
  });

  it("rejects invalid input fail-closed before any write (22023 / P0002)", async () => {
    const target = await createBoundActor("profile-rpc-invalid");
    const before = (await readAudit("advisor", target.advisorId)).length;
    const cases: Array<{ id: number | null; name: string | null; code: string }> = [
      { id: null, name: "Some Name", code: "22023" }, // missing target id
      { id: target.advisorId, name: "", code: "22023" }, // blank name
      { id: target.advisorId, name: "   ", code: "22023" }, // whitespace-only name
      { id: target.advisorId, name: "X".repeat(121), code: "22023" }, // over 120 chars
      { id: 99999999, name: "Ghost", code: "P0002" }, // nonexistent target
    ];
    for (const c of cases) {
      const result = await callProfileNameRpc(adminActor.client, c.id, c.name, 1);
      expect(
        result.error,
        `case id=${c.id} name=${JSON.stringify(c.name)} must be rejected`
      ).not.toBeNull();
      expect(result.error?.code, `denial code for id=${c.id}`).toBe(c.code);
    }
    expect(
      (await readAudit("advisor", target.advisorId)).length,
      "rejected inputs record no event"
    ).toBe(before);
  });

  it("rejects a name that would collide with another advisor's unique name (23505)", async () => {
    const target = await createBoundActor("profile-rpc-collision");
    // staffActor already owns its unique advisor_name: the friendly duplicate
    // check (with the UNIQUE(advisor_name) constraint as the authoritative
    // backstop) must reject the collision.
    const result = await callProfileNameRpc(adminActor.client, target.advisorId, staffActor.advisorName, 1);
    expect(result.error, "duplicate-name collision must be rejected").not.toBeNull();
    expect(result.error?.code, "collision denial code").toBe("23505");
    expect(await readProfile(target.advisorId)).toEqual({
      advisor_name: target.advisorName,
      email: target.email,
    });
  });

  it("exposes exactly one update_advisor_profile_name overload with the pinned advisor-id/name/expected-version parameters", async () => {
    const names = await rpcInputArgNames("update_advisor_profile_name");
    // Migration 20261015000001 drops the legacy 2-arg overload and pins the
    // versioned 3-arg signature; exactly one overload must remain.
    expect(names).toEqual(["p_advisor_id", "p_advisor_name", "p_expected_version"]);
  });

  it("hardens update_advisor_profile_name (SECURITY DEFINER, empty search_path, authenticated EXECUTE only)", async () => {
    const { rows } = await pool.query(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'update_advisor_profile_name'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].auth).toBe(true);
    expect(rows[0].anon).toBe(false);
    // Technical/service-role sessions are revoked: the actor must always be an
    // authenticated auth.uid() (an unattributable session is rejected fail-closed).
    expect(rows[0].sr).toBe(false);
  });

  it("denies anon and service_role execution at the database boundary", async () => {
    const anonDenied = await anon.rpc("update_advisor_profile_name", {
      p_advisor_id: targetAdvisor.advisorId,
      p_advisor_name: "Anon edit",
      p_expected_version: 1,
    });
    expect(anonDenied.error, "anon must not execute the RPC").not.toBeNull();

    // The service role is NOT a caller of this RPC (a technical session has no
    // auth.uid(), so it could never be an attributed actor anyway) — the
    // migration revokes EXECUTE from service_role and anon.
    const serviceDenied = await service.rpc("update_advisor_profile_name", {
      p_advisor_id: targetAdvisor.advisorId,
      p_advisor_name: "Service edit",
      p_expected_version: 1,
    });
    expect(
      serviceDenied.error,
      "service_role must not execute the RPC (authenticated actor required)"
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R4: ordinary email divergence prevention at the DB boundary
//
// The ordinary advisor profile path must not be able to silently change
// `advisor.email` (which would diverge the business projection from the Auth
// identity). The final migration must enforce this at the database boundary,
// not only in the API/UI: an authenticated session (including an effective
// Admin acting on another advisor) has no UPDATE path to `email`, and a denied
// change must not fabricate an audit event.
// ---------------------------------------------------------------------------

describe("advisor audit: ordinary email changes are rejected at the DB boundary (R4)", () => {
  it("denies an ordinary authenticated self email change and records no event", async () => {
    const actor = await createBoundActor("email-guard");
    const nextEmail = syntheticEmail(nextUnique("email-guard-new"));
    const before = (await readAudit("advisor", actor.advisorId)).length;

    const { error } = await actor.client
      .from("advisor")
      .update({ email: nextEmail })
      .eq("advisor_id", actor.advisorId)
      .select("advisor_id");

    expect(error, "ordinary authenticated email change must be denied").not.toBeNull();
    expect(error?.code, "ordinary email denial code").toBe("42501");

    const { rows } = await pool.query<{ email: string }>(
      "SELECT email FROM public.advisor WHERE advisor_id = $1",
      [actor.advisorId]
    );
    expect(rows[0].email, "the stored email must be unchanged").toBe(actor.email);
    expect(
      (await readAudit("advisor", actor.advisorId)).length,
      "a denied email change records no audit event"
    ).toBe(before);
  });

  it("denies an effective Admin changing another advisor's email (self-scoped boundary, no divergence path)", async () => {
    const target = await createBoundActor("email-guard-peer");
    const nextEmail = syntheticEmail(nextUnique("email-guard-peer-new"));
    const before = (await readAudit("advisor", target.advisorId)).length;

    const { data, error } = await adminActor.client
      .from("advisor")
      .update({ email: nextEmail })
      .eq("advisor_id", target.advisorId)
      .select("advisor_id");

    // A peer advisor row is invisible to the authenticated UPDATE policy (the
    // self-scoped `advisor_update_own_profile` RLS filter drops it to zero
    // rows), and even on a reachable row the column-scoped email guard
    // (`trg_advisor_email_direct_write`, migration 20261013000001) rejects
    // every non-trusted email change fail-closed. Either denial shape means
    // the browser session has NO path that can diverge `advisor.email` from
    // the Auth identity.
    if (error) {
      expect(error.code, "authenticated peer email denial code").toBe("42501");
    } else {
      expect(data ?? [], "RLS filters an authenticated peer email write to zero rows").toHaveLength(0);
    }

    const { rows } = await pool.query<{ email: string }>(
      "SELECT email FROM public.advisor WHERE advisor_id = $1",
      [target.advisorId]
    );
    expect(rows[0].email, "the target email must be unchanged").toBe(target.email);
    expect(
      (await readAudit("advisor", target.advisorId)).length,
      "a denied Admin email change records no audit event"
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// R5: role change — reason + one atomic role_changed event
// ---------------------------------------------------------------------------

describe("advisor role change: trusted actor, reason, one atomic role_changed event (R5)", () => {
  it("promotes a bound advisor atomically and writes exactly one role_changed event with no duplicate", async () => {
    const actor = await createBoundActor("role-target");
    const reason = `contract promote ${nextUnique("role")}`;

    const result = await callSetAdvisorRole({
      advisorId: actor.advisorId,
      role: "Admin",
      actorAdvisorId: adminActor.advisorId,
      reason,
    });
    expect(result.error, "set_advisor_role success").toBeNull();

    // Durable Auth claim + display projection are consistent after commit.
    expect(await readAuthClaim(actor.userId), "durable Auth claim").toBe(true);
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM public.advisor WHERE advisor_id = $1",
      [actor.advisorId]
    );
    expect(rows[0].role, "display role projection").toBe("Admin");

    const events = await readAudit("advisor", actor.advisorId);
    const roleEvents = events.filter((e) => e.action === "role_changed");
    expect(roleEvents, "exactly one role_changed event").toHaveLength(1);
    expect(roleEvents[0].actor_advisor_id, "trusted actor attribution").toBe(
      adminActor.advisorId
    );
    expect(roleEvents[0].actor_name_snapshot).toBe(adminActor.advisorName);
    expect(roleEvents[0].reason, "reason recorded once").toBe(reason);
    expect(roleEvents[0].changes, "role-only diff").toEqual({
      role: { old: "Advisor", new: "Admin" },
    });
    // The explicit role event's snapshots are intentionally role-only (the
    // surrounding business fields are unchanged and never asserted here).
    expect(Object.keys(roleEvents[0].old_values ?? {}).sort()).toEqual(["role"]);
    expect(Object.keys(roleEvents[0].new_values ?? {}).sort()).toEqual(["role"]);
    expect(roleEvents[0].new_values).toMatchObject({ role: "Admin" });
    // The trusted role RPC must suppress the trigger's own role write.
    expect(
      events.filter((e) => e.action === "updated"),
      "no duplicate generic updated event from the role write"
    ).toHaveLength(0);
  });

  it("rejects a blank or whitespace-only reason and changes nothing", async () => {
    const actor = await createBoundActor("role-blank-reason");
    for (const reason of ["", "   "]) {
      const before = await readAudit("advisor", actor.advisorId);
      const result = await callSetAdvisorRole({
        advisorId: actor.advisorId,
        role: "Admin",
        actorAdvisorId: adminActor.advisorId,
        reason,
      });
      expect(result.error, `blank reason "${reason}" must be rejected`).not.toBeNull();
      expect(String(result.error?.message ?? "").toLowerCase()).toContain("reason");

      expect(await readAuthClaim(actor.userId), "claim unchanged after rejection").not.toBe(true);
      const { rows } = await pool.query<{ role: string }>(
        "SELECT role FROM public.advisor WHERE advisor_id = $1",
        [actor.advisorId]
      );
      expect(rows[0].role).toBe("Advisor");
      expect((await readAudit("advisor", actor.advisorId)).length, "no event on rejection").toBe(
        before.length
      );
    }
  });

  it("rejects an actor that is not a current active bound durable effective Admin", async () => {
    const actor = await createBoundActor("role-bad-actor");
    const result = await callSetAdvisorRole({
      advisorId: actor.advisorId,
      role: "Admin",
      // staffActor has no ocf_admin durable claim: not an effective Admin.
      actorAdvisorId: staffActor.advisorId,
      reason: "forged actor",
    });
    expect(result.error, "non-Admin actor must be rejected").not.toBeNull();
    expect(result.error?.code).toBe("42501");
    expect(await readAuthClaim(actor.userId), "no claim change on actor rejection").not.toBe(true);
  });

  it("pins set_advisor_role to service_role EXECUTE only (authenticated/anon denied)", async () => {
    const deniedAuth = await adminActor.client.rpc(
      "set_advisor_role",
      mapSetRoleArgs(await rpcInputArgNames("set_advisor_role"), {
        advisorId: targetAdvisor.advisorId,
        role: "Admin",
        actorAdvisorId: adminActor.advisorId,
        reason: "client attempt",
      })
    );
    expect(deniedAuth.error, "authenticated client must not execute set_advisor_role").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R6 / NFR1: lifecycle reason + single event + atomic rollback
// ---------------------------------------------------------------------------

describe("lifecycle transitions: required reason and single event (R6)", () => {
  it("requires a non-blank reason for a student archive and records it once", async () => {
    const reason = `contract archive ${nextUnique("reason")}`;

    const blank = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: await (async () => seedStudent("blank-reason"))(),
      reason: "   ",
    });
    expect(blank.error, "whitespace reason must be rejected").not.toBeNull();

    const studentId = await seedStudent("reasoned-archive");
    const result = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: studentId,
      reason,
    });
    expect(result.error, "reasoned archive").toBeNull();

    const archived = (await readAudit("student", studentId)).filter(
      (e) => e.action === "archived"
    );
    expect(archived, "exactly one archived event").toHaveLength(1);
    expect(archived[0].reason).toBe(reason);
    expect(archived[0].actor_advisor_id).toBe(adminActor.advisorId);

    // Restore with a reason records its own single reasoned event.
    const restoreReason = `contract restore ${nextUnique("reason")}`;
    const restored = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "restore",
      entityId: studentId,
      reason: restoreReason,
    });
    expect(restored.error).toBeNull();
    const restoreEvents = (await readAudit("student", studentId)).filter(
      (e) => e.action === "restored"
    );
    expect(restoreEvents, "exactly one restored event").toHaveLength(1);
    expect(restoreEvents[0].reason).toBe(restoreReason);
  });

  it("records advisor deactivate/reactivate with the supplied reason and single classified events", async () => {
    const target = await createBoundActor("lifecycle-advisor");
    const deactivateReason = `contract deactivate ${nextUnique("reason")}`;

    const blank = await callLifecycle(adminActor.client, {
      entity: "advisor",
      action: "deactivate",
      entityId: target.advisorId,
      reason: "",
    });
    expect(blank.error, "empty reason must be rejected").not.toBeNull();

    const deactivated = await callLifecycle(adminActor.client, {
      entity: "advisor",
      action: "deactivate",
      entityId: target.advisorId,
      reason: deactivateReason,
    });
    expect(deactivated.error).toBeNull();

    let events = await readAudit("advisor", target.advisorId);
    const deact = events.filter((e) => e.action === "deactivated");
    expect(deact, "exactly one deactivated event").toHaveLength(1);
    expect(deact[0].reason).toBe(deactivateReason);
    expect(deact[0].actor_advisor_id).toBe(adminActor.advisorId);
    expect(events.filter((e) => e.action === "updated"), "no generic duplicate").toHaveLength(0);

    const reactivateReason = `contract reactivate ${nextUnique("reason")}`;
    const reactivated = await callLifecycle(adminActor.client, {
      entity: "advisor",
      action: "reactivate",
      entityId: target.advisorId,
      reason: reactivateReason,
    });
    expect(reactivated.error).toBeNull();
    events = await readAudit("advisor", target.advisorId);
    const react = events.filter((e) => e.action === "reactivated");
    expect(react, "exactly one reactivated event").toHaveLength(1);
    expect(react[0].reason).toBe(reactivateReason);
  });

  it("rolls back the business state and the event together when the audit insert fails (NFR1)", async () => {
    const studentId = await seedStudent("atomic-rollback");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A transaction-local forced audit failure: the BEFORE INSERT trigger
      // (and the lock it takes) is confined to this transaction and rolled
      // back below.
      await client.query(
        `CREATE OR REPLACE FUNCTION public._test_advisor_audit_fail()
           RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN
             RAISE EXCEPTION 'forced audit failure' USING ERRCODE = 'P0001';
           END;
         $fn$`
      );
      await client.query(
        `CREATE TRIGGER _test_advisor_audit_fail
           BEFORE INSERT ON public.audit_event
           FOR EACH ROW EXECUTE FUNCTION public._test_advisor_audit_fail()`
      );
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [
        adminActor.userId,
      ]);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ app_metadata: { ocf_admin: true }, email: adminActor.email }),
      ]);

      const names = await rpcInputArgNames("lifecycle_transition");
      const args = names.map((n) => {
        const spec: LifecycleSpec = {
          entity: "student",
          action: "archive",
          entityId: studentId,
          // Fresh row: version 1 is the current expected version.
          expectedVersion: 1,
          reason: "atomic rollback proof",
        };
        return mapLifecycleArgs(names, spec)[n];
      });
      const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");
      await expect(
        client.query(`SELECT public.lifecycle_transition(${placeholders})`, args)
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // Neither the source mutation nor the audit row survives.
    const { rows } = await pool.query<{ archived_at: string | null }>(
      "SELECT archived_at FROM public.student WHERE student_id = $1",
      [studentId]
    );
    expect(rows[0].archived_at, "student archive rolled back").toBeNull();
    expect(
      (await readAudit("student", studentId)).filter((e) => e.action === "archived"),
      "no archived event survives"
    ).toHaveLength(0);
  });

  it("rolls back the Auth claim, advisor role, and event together when the role-change audit insert fails (R5/NFR1)", async () => {
    const target = await createBoundActor("role-atomic");
    expect(await readAuthClaim(target.userId), "target starts without the Admin claim").not.toBe(true);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Transaction-local forced audit failure. The explicit role_changed INSERT
      // (and the Auth claim + display-role writes it aborts) all roll back.
      await client.query(
        `CREATE OR REPLACE FUNCTION public._test_advisor_role_audit_fail()
           RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN
             RAISE EXCEPTION 'forced role audit failure' USING ERRCODE = 'P0001';
           END;
         $fn$`
      );
      await client.query(
        `CREATE TRIGGER _test_advisor_role_audit_fail
           BEFORE INSERT ON public.audit_event
           FOR EACH ROW EXECUTE FUNCTION public._test_advisor_role_audit_fail()`
      );
      await expect(
        directSetAdvisorRole(client, {
          advisorId: target.advisorId,
          role: "Admin",
          actorAdvisorId: adminActor.advisorId,
          reason: "atomic role rollback proof",
          expectedVersion: 1,
        })
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    // Auth claim + advisor row + audit event all rolled back together.
    expect(await readAuthClaim(target.userId), "Auth claim rolled back").not.toBe(true);
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM public.advisor WHERE advisor_id = $1",
      [target.advisorId]
    );
    expect(rows[0].role, "display role rolled back").toBe("Advisor");
    expect(
      (await readAudit("advisor", target.advisorId)).filter((e) => e.action === "role_changed"),
      "no role_changed event survives"
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R7 / NFR2: last active durable Admin invariant + concurrency
// ---------------------------------------------------------------------------

describe("last active durable Admin invariant (R7/NFR2)", () => {
  it("allows a non-final reduction but rejects the reduction that would leave zero durable Admins", async () => {
    const target = await createBoundActor("last-admin-target", true);
    await promoteToAdmin(target);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Deterministic membership: only the actor and the target remain durable
      // Admins for the duration of this transaction.
      await lockMembership(client);
      await neutralizeOtherAdmins(client, [adminActor.userId, target.userId]);

      // Non-final reduction: with two members, demoting one is allowed.
      await directSetAdvisorRole(client, {
        advisorId: target.advisorId,
        role: "Advisor",
        actorAdvisorId: adminActor.advisorId,
        reason: "allowed non-final demotion",
      });
      const afterFirst = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM public.advisor a JOIN auth.users u ON u.id = a.auth_user_id
          WHERE a.is_active = true
            AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb`
      );
      expect(afterFirst.rows[0].n, "one member remains after the non-final reduction").toBe(1);

      // Final reduction: demoting the last durable Admin must be rejected. The
      // rejection is caught inside a SAVEPOINT so the (otherwise aborted)
      // transaction can keep validating afterwards.
      await client.query("SAVEPOINT final_demotion");
      let finalDemotionError: { code?: string } | null = null;
      try {
        await directSetAdvisorRole(client, {
          advisorId: adminActor.advisorId,
          role: "Advisor",
          actorAdvisorId: adminActor.advisorId,
          reason: "final demotion must fail",
        });
      } catch (caught) {
        finalDemotionError = (caught as { code?: string }) ?? null;
      }
      await client.query("ROLLBACK TO SAVEPOINT final_demotion");
      expect(finalDemotionError, "the final reduction must be rejected").not.toBeNull();
      expect(finalDemotionError!.code, "final reduction denial code").toBe("42501");

      const afterSecond = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM public.advisor a JOIN auth.users u ON u.id = a.auth_user_id
          WHERE a.is_active = true
            AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb`
      );
      expect(afterSecond.rows[0].n, "the last Admin is preserved").toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("serializes competing membership-reducing transactions so they cannot both observe the other as remaining", async () => {
    const raceTarget = await createBoundActor("race-target", true);
    await promoteToAdmin(raceTarget);
    const keep = [adminActor.userId, raceTarget.userId];
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      // T1 reduces the membership to {actor} and holds the transaction-scoped
      // advisory lock. The complementary reduction on T2 must NOT be able to
      // neutralize the same rows first, so only T1 neutralizes.
      await lockMembership(c1);
      await neutralizeOtherAdmins(c1, keep);

      // T1 reduces the membership and holds the transaction lock.
      await directSetAdvisorRole(c1, {
        advisorId: raceTarget.advisorId,
        role: "Advisor",
        actorAdvisorId: adminActor.advisorId,
        reason: "race: first reduction",
      });

      // T2 concurrently attempts the complementary reduction. If reductions
      // were not serialized, T2 would still see the target as a member and
      // both transactions could remove everyone. The shared advisory lock must
      // hold T2 back while T1 is uncommitted.
      const t2 = directSetAdvisorRole(c2, {
        advisorId: adminActor.advisorId,
        role: "Advisor",
        actorAdvisorId: raceTarget.advisorId,
        reason: "race: second reduction",
      });
      const settled = await Promise.race([
        t2.then(
          () => "settled",
          () => "settled"
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 400)),
      ]);
      expect(settled, "the competing reduction must wait for the held transaction").toBe("blocked");

      // Release and drain so the pool is clean.
      await c1.query("ROLLBACK");
      await t2.catch(() => undefined);
    } finally {
      try {
        await c1.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      try {
        await c2.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      c1.release();
      c2.release();
    }
  });

  it("rejects an advisor deactivation that would leave zero durable Admins", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The sole DURABLE Admin is `adminActor`. The acting session is a
      // different active bound advisor carrying only a (stale) JWT claim, so
      // it passes the lifecycle auth gate but is NOT a durable member. This
      // isolates the last-admin invariant from the self-deactivation guard.
      await lockMembership(client);
      await neutralizeOtherAdmins(client, [adminActor.userId]);
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [
        staffActor.userId,
      ]);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ app_metadata: { ocf_admin: true }, email: staffActor.email }),
      ]);

      const names = await rpcInputArgNames("lifecycle_transition");
      const spec: LifecycleSpec = {
        entity: "advisor",
        action: "deactivate",
        entityId: adminActor.advisorId,
        expectedVersion: await currentRowVersion("advisor", adminActor.advisorId),
        reason: "last admin deactivation",
      };
      const args = names.map((n) => mapLifecycleArgs(names, spec)[n]);
      const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");

      let denied = false;
      try {
        await client.query(`SELECT public.lifecycle_transition(${placeholders})`, args);
      } catch {
        denied = true;
      }
      expect(denied, "deactivating the last durable Admin must be denied").toBe(true);

      const { rows } = await pool.query<{ is_active: boolean }>(
        "SELECT is_active FROM public.advisor WHERE advisor_id = $1",
        [adminActor.advisorId]
      );
      expect(rows[0].is_active, "the last Admin's state is preserved").toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// R9: audit immutability + historical advisor attribution
// ---------------------------------------------------------------------------

describe("audit immutability and historical attribution (R9)", () => {
  it("denies Admin direct mutation of advisor audit rows (42501)", async () => {
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("immutable")),
      syntheticEmail(nextUnique("immutable"))
    );
    const events = await readAudit("advisor", advisorId);
    expect(events.length).toBeGreaterThan(0);
    const target = events[0].audit_id;

    const insertResult = await adminActor.client.from("audit_event").insert({
      entity_type: "advisor",
      entity_id: advisorId,
      action: "created",
      actor_name_snapshot: "Forged",
      origin: "user",
    });
    expect(insertResult.error, "Admin audit INSERT must be denied").not.toBeNull();
    expect(insertResult.error?.code).toBe("42501");

    const updateResult = await adminActor.client
      .from("audit_event")
      .update({ reason: "tampered" })
      .eq("audit_id", target);
    expect(updateResult.error, "Admin audit UPDATE must be denied").not.toBeNull();
    expect(updateResult.error?.code).toBe("42501");

    const deleteResult = await adminActor.client.from("audit_event").delete().eq("audit_id", target);
    expect(deleteResult.error, "Admin audit DELETE must be denied").not.toBeNull();
    expect(deleteResult.error?.code).toBe("42501");

    const { rows } = await pool.query<{ n: number; reason: string | null }>(
      "SELECT count(*)::int AS n, max(reason)::text AS reason FROM public.audit_event WHERE audit_id = $1",
      [target]
    );
    expect(rows[0].n, "audit row still present").toBe(1);
    expect(rows[0].reason, "audit row unchanged").toBeNull();
  });

  it("keeps prior events' actor-name snapshots and historical meetings after deactivation and rename", async () => {
    const actor = await createBoundActor("historical");
    const originalName = actor.advisorName;
    const selfRenamed = `${originalName} (Self)`;

    // A user-attributed event recorded BEFORE any later rename/deactivation:
    // the actor updates their own display name through the expected-version
    // self-service writer (the fresh row starts at version 1).
    const selfResult = await callSelfProfileName(actor.client, 1, selfRenamed);
    expect(selfResult.error).toBeNull();

    // A meeting attributed to this advisor (trusted technical write).
    const studentId = await seedStudent("historical-meeting");
    const { data: meeting, error: meetingError } = await service
      .from("advising_meeting")
      .insert({
        student_id: studentId,
        advisor_id: actor.advisorId,
        meeting_date: "2026-09-10",
        meeting_mode: "Virtual",
        no_show: false,
      })
      .select("meeting_id")
      .single();
    expect(meetingError).toBeNull();
    const meetingId = meeting!.meeting_id as number;

    // A later Admin rename (through the only supported path: the trusted
    // server adapter, which freezes the Admin actor) must not rewrite the
    // prior event's name snapshot — the historical join resolves the new name
    // but the earlier event keeps the actor name as it was at event time.
    const renamed = `${originalName} (Renamed)`;
    const renameClient = await pool.connect();
    try {
      await renameClient.query("BEGIN");
      await renameClient.query("SELECT private.set_audit_actor($1)", [adminActor.advisorId]);
      await renameClient.query(
        "UPDATE public.advisor SET advisor_name = $1 WHERE advisor_id = $2",
        [renamed, actor.advisorId]
      );
      await renameClient.query("COMMIT");
    } finally {
      await renameClient.query("ROLLBACK").catch(() => undefined);
      renameClient.release();
    }

    // Deactivate through the lifecycle RPC.
    const deactivated = await callLifecycle(adminActor.client, {
      entity: "advisor",
      action: "deactivate",
      entityId: actor.advisorId,
      reason: "historical attribution",
    });
    expect(deactivated.error).toBeNull();

    const events = await readAudit("advisor", actor.advisorId);
    const selfEvent = events.find(
      (e) =>
        e.action === "updated" &&
        e.actor_advisor_id === actor.advisorId &&
        (e.changes?.advisor_name?.new as string | undefined) === selfRenamed
    );
    expect(selfEvent, "the pre-rename self-update event exists").toBeDefined();
    // The event recorded at self-rename time freezes the CURRENT (post-rename)
    // display name; the LATER Admin rename to `renamed` — which happened after
    // this event — must NOT rewrite this earlier snapshot.
    expect(selfEvent!.actor_name_snapshot, "prior event name snapshot is immutable").toBe(
      selfRenamed
    );
    expect(selfEvent!.actor_advisor_id).toBe(actor.advisorId);

    // The historical meeting survives and still resolves the (renamed) advisor.
    const { rows } = await pool.query<{ advisor_id: number | null; advisor_name: string | null }>(
      `SELECT m.advisor_id, a.advisor_name
         FROM public.advising_meeting m
         LEFT JOIN public.advisor a ON a.advisor_id = m.advisor_id
        WHERE m.meeting_id = $1`,
      [meetingId]
    );
    expect(rows[0].advisor_id, "historical meeting attribution preserved").toBe(actor.advisorId);
    expect(rows[0].advisor_name, "historical join still resolves").toBe(renamed);
  });
});

// ---------------------------------------------------------------------------
// RPC signature / ACL contract
// ---------------------------------------------------------------------------

describe("advisor RPC signature and ACL contract", () => {
  it("exposes exactly one set_advisor_role overload with actor + reason parameters", async () => {
    const names = await rpcInputArgNames("set_advisor_role");
    const lower = names.map((n) => n.toLowerCase());
    expect(lower.some((n) => n.includes("actor") || n.includes("admin")), "actor parameter").toBe(
      true
    );
    expect(lower.some((n) => n.includes("reason")), "reason parameter").toBe(true);
  });

  it("exposes exactly one lifecycle_transition overload with a reason parameter", async () => {
    const names = await rpcInputArgNames("lifecycle_transition");
    expect(names.map((n) => n.toLowerCase()).some((n) => n.includes("reason"))).toBe(true);
  });

  it("hardens set_advisor_role (SECURITY DEFINER, empty search_path, service_role only)", async () => {
    const { rows } = await pool.query(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'set_advisor_role'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].sr).toBe(true);
    expect(rows[0].auth).toBe(false);
    expect(rows[0].anon).toBe(false);
  });

  it("hardens lifecycle_transition (SECURITY DEFINER, empty search_path, authenticated only)", async () => {
    const { rows } = await pool.query(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'lifecycle_transition'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].auth).toBe(true);
    expect(rows[0].anon).toBe(false);
  });

  it("hardens provision_advisor (SECURITY DEFINER, empty search_path, service_role only)", async () => {
    const { rows } = await pool.query(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'provision_advisor'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].sr).toBe(true);
    expect(rows[0].auth).toBe(false);
    expect(rows[0].anon).toBe(false);
  });

  it("denies anon RPC execution at the database boundary", async () => {
    const denied = await anon.rpc(
      "set_advisor_role",
      mapSetRoleArgs(await rpcInputArgNames("set_advisor_role"), {
        advisorId: 1,
        role: "Admin",
        actorAdvisorId: 1,
        reason: "anon attempt",
      })
    );
    expect(denied.error, "anon set_advisor_role must be denied").not.toBeNull();
  });
});
