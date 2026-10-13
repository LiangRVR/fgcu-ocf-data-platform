/**
 * tests/contract/advisor-role-lock.test.ts
 *
 * Contract proof for migration 20261003000001 (review blocker): concurrent
 * trusted role changes must be serialized per-advisor with a DURABLE,
 * database-backed lock/lease (no in-process mutex) across the full Auth
 * metadata + protected display-role operation.
 *
 * Exercised against the isolated Docker-local lane through the SERVICE-ROLE
 * client (the same trusted authority the provisioning adapter uses):
 *
 *   - MUTUAL EXCLUSION: a second holder cannot acquire an ACTIVE lease (the
 *     contender must fail safely without mutation), while the SAME holder
 *     re-acquires idempotently (refresh);
 *   - HOLDER-SCOPED RELEASE: only the holder releases; a non-holder release is
 *     a no-op and the lease stays held; after the holder releases, a NEW
 *     holder acquires;
 *   - BOUNDED STALE RECOVERY: an EXPIRED lease (short lease + wait) is taken
 *     over by a new holder, so a crashed operation can never block forever;
 *   - SERVER-ONLY SURFACE: anon has no EXECUTE on the lock RPCs, and
 *     `authenticated` has no table privilege on `advisor_role_lock` (RLS
 *     enabled with no policies) — the lock is never reachable by a browser
 *     session;
 *   - CATALOG: the lock RPCs are SECURITY DEFINER with empty search_path and
 *     service_role-pinned EXECUTE.
 *   - LEGACY WRITER RETIREMENT (review remediation for migrations
 *     20261004000001 / 20261006000001): the legacy direct display-role writer
 *     RPCs `fenced_write_advisor_role_display` and
 *     `reconcile_advisor_role_display` are NO LONGER a writable path. The
 *     suite no longer exercises them; it asserts each is ABSENT from the
 *     schema or, if retained, NOT service_role-executable — so the only normal
 *     writer of `advisor.role` is the atomic `set_advisor_role` transaction.
 *     The read-only `verify_advisor_role_lock` ownership check and the
 *     fence/read primitives remain part of the retained lease infrastructure.
 *
 * Service-role usage is restricted to seeding the synthetic advisor row and to
 * exercising the trusted lock surface (the same role the adapter uses); it is
 * never asserted as a feature.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createAnonClient,
  createDbPool,
  createServiceRoleClient,
  getContractEnv,
} from "./helpers/setup";
import { syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);
let pool: Pool;

let advisorId: number;

beforeAll(async () => {
  pool = createDbPool(env);
  // The advisor row the lock references (its FK is the default NO ACTION, so
  // cleanup releases the lock before deleting the row).
  const { data: advisor, error } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("lock-target"),
      email: syntheticEmail("lock-target"),
      is_active: true,
    })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`seed lock-target advisor: ${error.message}`);
  advisorId = advisor.advisor_id as number;
}, 30_000);

beforeEach(async () => {
  // Reset the shared advisor row to its baseline display role and clear any
  // leftover lease so each fenced-write test is self-contained.
  await service.from("advisor").update({ role: "Advisor" }).eq("advisor_id", advisorId);
  await service.from("advisor_role_lock").delete().eq("advisor_id", advisorId);
});

afterAll(async () => {
  // Release any leftover lease before deleting the advisor (the lock FK is
  // NO ACTION), then drop the row.
  try {
    await service.rpc("release_advisor_role_lock", {
      p_advisor_id: advisorId,
      p_holder: "%any%",
    });
  } catch {
    /* best-effort */
  }
  await service.from("advisor").delete().eq("advisor_id", advisorId);
  if (pool) await pool.end();
}, 30_000);

const acquire = (holder: string, leaseSeconds: number) =>
  service.rpc("acquire_advisor_role_lock", {
    p_advisor_id: advisorId,
    p_holder: holder,
    p_lease_seconds: leaseSeconds,
  });

const release = (holder: string) =>
  service.rpc("release_advisor_role_lock", {
    p_advisor_id: advisorId,
    p_holder: holder,
  });

describe("per-advisor role-change lease (migration 20261003000001)", () => {
  it("mutual exclusion: an ACTIVE lease blocks a different holder and same-holder re-acquire refreshes", async () => {
    const first = await acquire("holder-a", 60);
    expect(first.error, "first acquire").toBeNull();
    expect(first.data, "first holder must acquire").toBe(true);

    const contender = await acquire("holder-b", 60);
    expect(contender.error, "contender acquire").toBeNull();
    expect(contender.data, "contender must NOT acquire an active lease").toBe(false);

    const refresh = await acquire("holder-a", 60);
    expect(refresh.error, "same-holder re-acquire").toBeNull();
    expect(refresh.data, "same-holder re-acquire must refresh the lease").toBe(true);

    // Still held: a new holder is still blocked.
    const blocked = await acquire("holder-c", 60);
    expect(blocked.data, "active lease still excludes a new holder").toBe(false);
  });

  it("holder-scoped release: only the holder releases, then a new holder acquires", async () => {
    // Ensure the lease is held by holder-a for this scenario.
    await service
      .from("advisor_role_lock")
      .delete()
      .eq("advisor_id", advisorId)
      .select("advisor_id");
    const held = await acquire("holder-a", 60);
    expect(held.data).toBe(true);

    const wrongRelease = await release("holder-b");
    expect(wrongRelease.error, "non-holder release").toBeNull();
    expect(wrongRelease.data, "non-holder release must be a no-op").toBe(false);

    const stillBlocked = await acquire("holder-c", 60);
    expect(stillBlocked.data, "non-holder release must NOT free the lease").toBe(false);

    const rightRelease = await release("holder-a");
    expect(rightRelease.error, "holder release").toBeNull();
    expect(rightRelease.data, "holder release must free the lease").toBe(true);

    const newHolder = await acquire("holder-c", 60);
    expect(newHolder.error).toBeNull();
    expect(newHolder.data, "released lease must be acquirable by a new holder").toBe(true);
  });

  it("bounded stale recovery: an EXPIRED lease is taken over by a new holder", async () => {
    // Clear any lease and take a SHORT lease (1s).
    await service.from("advisor_role_lock").delete().eq("advisor_id", advisorId);
    const short = await acquire("holder-d", 1);
    expect(short.error).toBeNull();
    expect(short.data, "short-lease holder must acquire").toBe(true);

    // Before expiry, a contender is blocked.
    const early = await acquire("holder-e", 60);
    expect(early.data, "contender blocked before expiry").toBe(false);

    // Wait for the lease to expire (bounded stale recovery window).
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const takeover = await acquire("holder-e", 60);
    expect(takeover.error, "takeover acquire").toBeNull();
    expect(takeover.data, "expired lease must be taken over by a new holder").toBe(true);

    // The lock row now belongs to the new holder.
    const { data: row } = await service
      .from("advisor_role_lock")
      .select("advisor_id, holder")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    expect(row, "lock row present after takeover").not.toBeNull();
    expect(row!.holder, "lock holder after takeover").toBe("holder-e");

    // Clean up for the next scenario.
    await release("holder-e");
  });

  it("is a server-only surface: anon has no EXECUTE and authenticated has no table privilege", async () => {
    const anonCall = await anon.rpc("acquire_advisor_role_lock", {
      p_advisor_id: advisorId,
      p_holder: "anon",
      p_lease_seconds: 60,
    });
    expect(anonCall.data, "anon acquire must return no data").toBeNull();
    expect(anonCall.error, "anon acquire must be denied").not.toBeNull();

    const rows = await pool.query<{ auth_ok: boolean; anon_ok: boolean }>(
      `SELECT
         has_table_privilege('authenticated', 'public.advisor_role_lock', 'SELECT') AS auth_ok,
         has_function_privilege('anon', 'public.acquire_advisor_role_lock(integer, text, integer)', 'EXECUTE') AS anon_ok`
    );
    expect(rows.rows[0].auth_ok, "authenticated must have NO SELECT on the lock table").toBe(false);
    expect(rows.rows[0].anon_ok, "anon must have NO EXECUTE on the acquire RPC").toBe(false);
  });

  it("audit: advisor_role_lock has RLS ENABLED with zero policies (fully locked down)", async () => {
    const rows = await pool.query<{ rls_enabled: boolean; policy_count: number }>(
      `SELECT c.relrowsecurity AS rls_enabled,
              (SELECT count(*)::int
                 FROM pg_policies p
                WHERE p.schemaname = 'public'
                  AND p.tablename = 'advisor_role_lock') AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'advisor_role_lock'`
    );
    expect(rows.rows, "advisor_role_lock catalog row").toHaveLength(1);
    expect(rows.rows[0].rls_enabled, "advisor_role_lock must have RLS enabled").toBe(true);
    expect(rows.rows[0].policy_count, "advisor_role_lock must have ZERO policies").toBe(0);
  });

  it("catalog: the lock RPCs are SECURITY DEFINER with empty search_path and service_role-pinned EXECUTE", async () => {
    const rows = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; sr: boolean }>(
      `SELECT p.proname,
              p.prosecdef,
              p.proconfig,
              CASE p.proname
                WHEN 'acquire_advisor_role_lock' THEN
                  has_function_privilege('service_role', 'public.acquire_advisor_role_lock(integer, text, integer)', 'EXECUTE')
                WHEN 'release_advisor_role_lock' THEN
                  has_function_privilege('service_role', 'public.release_advisor_role_lock(integer, text)', 'EXECUTE')
                ELSE false
              END AS sr
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('acquire_advisor_role_lock', 'release_advisor_role_lock')
        ORDER BY p.proname`
    );
    expect(rows.rows.map((r) => r.proname).sort()).toEqual([
      "acquire_advisor_role_lock",
      "release_advisor_role_lock",
    ]);
    for (const row of rows.rows) {
      expect(row.prosecdef, `${row.proname} must be SECURITY DEFINER`).toBe(true);
      expect(row.proconfig, `${row.proname} must set an empty search_path`).toEqual(["search_path=\"\""]);
      expect(row.sr, `service_role EXECUTE on ${row.proname}`).toBe(true);
    }
  });
});
describe("legacy direct display-role writers are retired (review remediation)", () => {
  // The review finding requires removing the alternate role-write bypass: the
  // legacy RPCs must be either dropped, or retained with no write-capable
  // EXECUTE. Assert the durable catalog state (not a call shape) so the proof
  // holds whether the remediation chose DROP or REVOKE.
  const LEGACY_WRITERS = [
    "public.fenced_write_advisor_role_display(integer, text, text)",
    "public.reconcile_advisor_role_display(integer, text)",
  ] as const;

  it("catalog: each legacy writer is ABSENT or retained but NOT service_role/anon-executable", async () => {
    const rows = await pool.query<{
      name: string;
      present: boolean;
      service_exec: boolean;
      anon_exec: boolean;
    }>(
      `SELECT n.name,
              (to_regprocedure(n.name) IS NOT NULL) AS present,
              CASE WHEN to_regprocedure(n.name) IS NULL THEN false
                   ELSE has_function_privilege('service_role', to_regprocedure(n.name)::oid, 'EXECUTE')
              END AS service_exec,
              CASE WHEN to_regprocedure(n.name) IS NULL THEN false
                   ELSE has_function_privilege('anon', to_regprocedure(n.name)::oid, 'EXECUTE')
              END AS anon_exec
         FROM unnest($1::text[]) AS n(name)`,
      [LEGACY_WRITERS],
    );
    expect(rows.rows, "one catalog row per legacy writer").toHaveLength(LEGACY_WRITERS.length);
    for (const row of rows.rows) {
      expect(
        row.service_exec,
        `${row.name} must NOT be service_role-executable (absent=${!row.present})`,
      ).toBe(false);
      expect(row.anon_exec, `${row.name} must NOT be anon-executable`).toBe(false);
    }
  });

  it("surface: the trusted service role can no longer invoke the legacy writers", async () => {
    const retiredFencedWrite = await service.rpc("fenced_write_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: "retired-writer",
      p_role: "Admin",
    });
    expect(retiredFencedWrite.error, "fenced_write must be unexecutable").not.toBeNull();
    expect(retiredFencedWrite.data, "fenced_write must not write").toBeNull();

    const retiredReconcile = await service.rpc("reconcile_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: "retired-writer",
    });
    expect(retiredReconcile.error, "reconcile must be unexecutable").not.toBeNull();
    expect(retiredReconcile.data, "reconcile must not run").toBeNull();

    // The protected display role is untouched by either retired call.
    const { data: row } = await service
      .from("advisor")
      .select("role")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    expect(row?.role, "display role untouched by retired writers").toBe("Advisor");
  });
});

describe("retained role-lock infrastructure: verify_advisor_role_lock ownership check (migration 20261004000001)", () => {
  const verify = (holder: string) =>
    service.rpc("verify_advisor_role_lock", { p_advisor_id: advisorId, p_holder: holder });

  it("returns true ONLY for the holder of a NON-EXPIRED lease, and is denied to anon", async () => {
    const acquired = await acquire("holder-verify", 1);
    expect(acquired.data, "verify holder must acquire").toBe(true);

    // The current holder is verified; a non-holder is not.
    expect((await verify("holder-verify")).data, "holder owns the lease").toBe(true);
    expect((await verify("holder-intruder")).data, "non-holder does not own").toBe(false);

    // After expiry the same holder no longer verifies.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await verify("holder-verify")).data, "expired holder no longer owns").toBe(false);

    // Server-only: anon is denied the verify RPC at the API surface.
    const anonCall = await anon.rpc("verify_advisor_role_lock", {
      p_advisor_id: advisorId,
      p_holder: "anon",
    });
    expect(anonCall.data).toBeNull();
    expect(anonCall.error, "anon must be denied the verify RPC").not.toBeNull();
  });

  it("catalog: verify_advisor_role_lock is SECURITY DEFINER with empty search_path and service_role-pinned EXECUTE", async () => {
    const rows = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean }>(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('service_role', 'public.verify_advisor_role_lock(integer, text)', 'EXECUTE') AS sr,
              has_function_privilege('anon', 'public.verify_advisor_role_lock(integer, text)', 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'verify_advisor_role_lock'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].prosecdef, "verify must be SECURITY DEFINER").toBe(true);
    expect(rows.rows[0].proconfig, "verify must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows.rows[0].sr, "service_role EXECUTE on verify").toBe(true);
    expect(rows.rows[0].anon, "no anon EXECUTE on verify").toBe(false);
  });
});

describe("fenced display-role read-back (migration 20261005000001, retained read-only primitive)", () => {
  const fencedRead = (holder: string) =>
    service.rpc("fenced_read_advisor_role_display", { p_advisor_id: advisorId, p_holder: holder });

  it("returns the CURRENT display role ONLY while the same holder owns a NON-EXPIRED lease; NULL otherwise", async () => {
    const acquired = await acquire("holder-reader", 60);
    expect(acquired.data, "reader must acquire the lease").toBe(true);

    // Owner reads back the role (baseline Advisor).
    const owned = await fencedRead("holder-reader");
    expect(owned.error, "owner read-back").toBeNull();
    expect(owned.data, "owner read-back returns the current role").toBe("Advisor");

    // A NON-holder read-back is fenced to NULL.
    const intruder = await fencedRead("holder-intruder");
    expect(intruder.error, "non-holder read-back").toBeNull();
    expect(intruder.data, "non-holder read-back must be NULL").toBeNull();

    // The read-back reflects the CURRENT protected display role. The role is
    // seeded directly here (the atomic set_advisor_role writer owns the change
    // path; the retired legacy writer is never exercised).
    await service.from("advisor").update({ role: "Admin" }).eq("advisor_id", advisorId);
    expect((await fencedRead("holder-reader")).data, "read-back reflects the current role").toBe("Admin");
  });

  it("returns NULL for an EXPIRED lease and after a SUPERSEDED takeover", async () => {
    const aAcquired = await acquire("holder-a-expire", 1);
    expect(aAcquired.data, "A must acquire").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Expired: A's read-back is NULL.
    expect((await fencedRead("holder-a-expire")).data, "expired holder read-back must be NULL").toBeNull();

    // B takes over and can read; A stays fenced to NULL.
    const bTakeover = await acquire("holder-b-takeover", 60);
    expect(bTakeover.data, "B must take over").toBe(true);
    expect((await fencedRead("holder-b-takeover")).data, "B read-back returns the current role").toBe("Advisor");
    expect((await fencedRead("holder-a-expire")).data, "superseded A read-back must be NULL").toBeNull();
  });

  it("catalog: fenced read-back is SECURITY DEFINER with empty search_path and service_role-pinned EXECUTE", async () => {
    const rows = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean }>(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('service_role', 'public.fenced_read_advisor_role_display(integer, text)', 'EXECUTE') AS sr,
              has_function_privilege('anon', 'public.fenced_read_advisor_role_display(integer, text)', 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fenced_read_advisor_role_display'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].prosecdef, "fenced read-back must be SECURITY DEFINER").toBe(true);
    expect(rows.rows[0].proconfig, "fenced read-back must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows.rows[0].sr, "service_role EXECUTE on fenced read-back").toBe(true);
    expect(rows.rows[0].anon, "no anon EXECUTE on fenced read-back").toBe(false);
  });
});

describe("compensation lease re-securing (latest P1 compensation race)", () => {
  it("the atomic renew/reacquire with the SAME holder re-secures a live lease; a competitor's ACTIVE lease denies it (fencing a delayed rollback)", async () => {
    // Acquire a normal lease.
    const first = await acquire("holder-recoverer", 60);
    expect(first.data, "first acquire").toBe(true);

    // ATOMIC RENEW (same holder): re-secures the live lease across the
    // compensation window (returns true — the compensation may proceed).
    const renew = await acquire("holder-recoverer", 60);
    expect(renew.error, "same-holder renew").toBeNull();
    expect(renew.data, "same-holder renew must re-secure the lease").toBe(true);

    // A COMPETITOR cannot acquire while the (renewed) lease is ACTIVE — so a
    // delayed rollback that loses its renew is fenced out.
    const competitor = await acquire("holder-competitor", 60);
    expect(competitor.data, "competitor must NOT acquire the active renewed lease").toBe(false);

    await release("holder-recoverer");

    // EXPIRY WITHOUT TAKEOVER: the renew/reacquire succeeds after the lease
    // expires (nobody took it), which is exactly the compensation window where
    // the rollback is still safe.
    const short = await acquire("holder-recoverer", 1);
    expect(short.data, "short-lease acquire").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const renewAfterExpiry = await acquire("holder-recoverer", 60);
    expect(renewAfterExpiry.data, "re-acquire after expiry (no takeover) must succeed").toBe(true);
    await release("holder-recoverer");
  });
});

describe("atomic advisor role change (migration 20261007000001, final P1)", () => {
  let atomicAdvisorId: number;
  let atomicAuthUserId: string;
  // The final set_advisor_role signature (migration 20261015000001 replaces
  // the 20261013000001 arity) is (p_advisor_id, p_role, p_reason, p_actor_id,
  // p_expected_version): the service-supplied actor must be a CURRENT, ACTIVE,
  // BOUND advisor whose durable Auth metadata carries the strict boolean
  // ocf_admin=true claim, and the target row's CURRENT `row_version` must be
  // supplied. These atomicity tests therefore drive the RPC through a seeded
  // durable effective-Admin actor and the persisted-state version oracle.
  let roleActorId: number;
  let roleActorAuthUserId: string;

  const actorEmail = syntheticEmail("role-actor");

  const seedRoleActor = async (): Promise<void> => {
    const { data: actorUser, error: actorUserError } = await service.auth.admin.createUser({
      email: actorEmail,
      password: "AtomicPass!2026",
      email_confirm: true,
      app_metadata: { ocf_admin: true },
    });
    if (actorUserError || !actorUser.user)
      throw new Error(`seed role actor auth user: ${actorUserError?.message ?? "none"}`);
    roleActorAuthUserId = actorUser.user.id;
    const { data: actorAdvisor, error: actorAdvisorError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName("role-actor"),
        email: actorEmail,
        auth_user_id: actorUser.user.id,
        is_active: true,
        role: "Admin",
      })
      .select("advisor_id")
      .single();
    if (actorAdvisorError) throw new Error(`seed role actor advisor: ${actorAdvisorError.message}`);
    roleActorId = actorAdvisor.advisor_id as number;
  };

  const cleanupRoleActor = async (): Promise<void> => {
    try {
      await service.from("advisor_role_lock").delete().eq("advisor_id", roleActorId ?? -1);
      await service.from("advisor").delete().eq("advisor_id", roleActorId ?? -1);
    } catch {
      /* best-effort */
    }
    if (roleActorAuthUserId) await service.auth.admin.deleteUser(roleActorAuthUserId).catch(() => {});
  };

  const seedAtomicAdvisor = async (claim = false): Promise<void> => {
    const email = syntheticEmail("atomic-role");
    const { data: user, error: userError } = await service.auth.admin.createUser({
      email,
      password: "AtomicPass!2026",
      email_confirm: true,
      app_metadata: { ocf_admin: claim },
    });
    if (userError || !user.user) throw new Error(`seed atomic auth user: ${userError?.message ?? "none"}`);
    atomicAuthUserId = user.user.id;
    const { data: advisor, error: advisorError } = await service
      .from("advisor")
      .insert({ advisor_name: syntheticName("atomic-role"), email, auth_user_id: user.user.id, is_active: true })
      .select("advisor_id")
      .single();
    if (advisorError) throw new Error(`seed atomic advisor: ${advisorError.message}`);
    atomicAdvisorId = advisor.advisor_id as number;
  };

  const cleanupAtomicAdvisor = async (): Promise<void> => {
    try {
      await service.from("advisor").delete().eq("advisor_id", atomicAdvisorId ?? -1);
    } catch {
      /* best-effort */
    }
    if (atomicAuthUserId) await service.auth.admin.deleteUser(atomicAuthUserId).catch(() => {});
  };

  beforeAll(async () => {
    await seedRoleActor();
  }, 30_000);

  afterAll(async () => {
    await cleanupRoleActor();
  }, 30_000);

  const setRole = async (advisorId: number, role: string, expectedVersion?: number) => {
    // The atomic role RPC requires the target's CURRENT row_version
    // (migration 20261015000001). Read it from the persisted state unless the
    // caller pinned one (e.g. the missing-advisor case, where the RPC's own
    // P0002 check decides the outcome).
    let version = expectedVersion;
    if (version === undefined) {
      const { rows } = await pool.query<{ row_version: number }>(
        "SELECT row_version FROM public.advisor WHERE advisor_id = $1",
        [advisorId]
      );
      version = rows[0]?.row_version ?? 1;
    }
    return service.rpc("set_advisor_role", {
      p_advisor_id: advisorId,
      p_role: role,
      p_reason: "contract atomic role change",
      p_actor_id: roleActorId,
      p_expected_version: version,
    });
  };

  const advisorRow = async (advisorId: number) => {
    const { data, error } = await service
      .from("advisor")
      .select("advisor_id, role, auth_user_id")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    if (error) throw new Error(`read atomic advisor: ${error.message}`);
    return data;
  };

  const authClaim = async (authUserId: string): Promise<boolean | null> => {
    const { data, error } = await service.auth.admin.getUserById(authUserId);
    if (error) throw new Error(`read atomic auth user: ${error.message}`);
    return data?.user?.app_metadata?.ocf_admin ?? null;
  };

  it("sets the claim AND the display projection in ONE atomic transaction (both directions)", async () => {
    await seedAtomicAdvisor(false);
    try {
      const promoted = await setRole(atomicAdvisorId, "Admin");
      expect(promoted.error, "atomic promote").toBeNull();
      expect(promoted.data, "atomic promote result row").toMatchObject([
        { advisor_id: atomicAdvisorId, role: "Admin" },
      ]);
      expect((await advisorRow(atomicAdvisorId))?.role, "display = Admin").toBe("Admin");
      expect(await authClaim(atomicAuthUserId), "claim = true").toBe(true);

      const demoted = await setRole(atomicAdvisorId, "Advisor");
      expect(demoted.error, "atomic demote").toBeNull();
      expect((await advisorRow(atomicAdvisorId))?.role, "display = Advisor").toBe("Advisor");
      expect(await authClaim(atomicAuthUserId), "claim = false").toBe(false);
    } finally {
      await cleanupAtomicAdvisor();
    }
  });

  it("is ATOMIC on failure: a rejected call leaves BOTH the claim and the display unchanged", async () => {
    await seedAtomicAdvisor(false);
    try {
      // Set a known baseline (Admin) first.
      expect((await setRole(atomicAdvisorId, "Admin")).error).toBeNull();

      const invalid = await setRole(atomicAdvisorId, "boss");
      expect(invalid.data, "invalid role must return no row").toBeNull();
      expect(invalid.error, "invalid role must be rejected").not.toBeNull();
      expect(invalid.error?.code, "invalid role error code").toBe("22023");
      // NOTHING changed: the transaction aborted atomically.
      expect((await advisorRow(atomicAdvisorId))?.role, "display unchanged on failure").toBe("Admin");
      expect(await authClaim(atomicAuthUserId), "claim unchanged on failure").toBe(true);
    } finally {
      await cleanupAtomicAdvisor();
    }
  });

  it("rejects a missing advisor (P0002) and an unbound advisor (42501) with no side effects", async () => {
    const missing = await setRole(999_999_999, "Admin");
    expect(missing.error?.code, "missing advisor error code").toBe("P0002");

    const { data: unbound, error: unboundError } = await service
      .from("advisor")
      .insert({ advisor_name: syntheticName("atomic-unbound"), email: syntheticEmail("atomic-unbound"), is_active: true })
      .select("advisor_id")
      .single();
    if (unboundError) throw new Error(`seed unbound advisor: ${unboundError.message}`);
    try {
      const unboundRole = await setRole(unbound.advisor_id as number, "Admin");
      expect(unboundRole.error?.code, "unbound advisor error code").toBe("42501");
      const { data: still } = await service
        .from("advisor")
        .select("role")
        .eq("advisor_id", unbound.advisor_id as number)
        .maybeSingle();
      expect(still?.role, "unbound advisor display unchanged").toBe("Advisor");
    } finally {
      await service.from("advisor").delete().eq("advisor_id", unbound.advisor_id as number);
    }
  });

  it("CONCURRENCY/ATOMICITY: serialized expected-version role changes keep the claim/display consistent and reject a genuinely stale version", async () => {
    await seedAtomicAdvisor(false);
    try {
      // Both writers race from the SAME base version 1. The row lock and the
      // shared membership advisory lock serialize the two atomic transactions.
      // Only the meaningful promotion (Advisor -> Admin) advances the version;
      // the "demote to Advisor" is a NO-OP restatement (the row is already
      // Advisor), which the version trigger deliberately does NOT bump — so it
      // may either commit as a no-op first or observe the committed version and
      // be rejected PT409. Either way the claim/display can never diverge.
      const [promote, demote] = await Promise.all([
        setRole(atomicAdvisorId, "Admin", 1),
        setRole(atomicAdvisorId, "Advisor", 1),
      ]);

      expect(promote.error, "the meaningful promotion from base version 1 commits").toBeNull();
      if (demote.error) {
        expect(demote.error.code, "a rejected no-op competitor uses the stale-version code").toBe(
          "PT409"
        );
      }

      // FINAL CONSISTENCY: display ⇔ claim always match, and exactly one
      // meaningful change landed (the no-op restatement never bumps the version).
      const role = (await advisorRow(atomicAdvisorId))?.role;
      const claim = await authClaim(atomicAuthUserId);
      expect(role, "final display role").toBe("Admin");
      expect(claim, "final claim").toBe(true);
      expect(role, "display ⇔ claim never diverge").toBe(claim === true ? "Admin" : "Advisor");
      const { rows } = await pool.query<{ row_version: number }>(
        "SELECT row_version FROM public.advisor WHERE advisor_id = $1",
        [atomicAdvisorId]
      );
      expect(rows[0].row_version, "the meaningful write advanced the version once").toBe(2);

      // A genuinely stale write pinned to the superseded version 1 is rejected
      // with the expected-version conflict code.
      const stale = await setRole(atomicAdvisorId, "Advisor", 1);
      expect(stale.error, "a stale expected version is rejected").not.toBeNull();
      expect(stale.error?.code, "stale rejection code").toBe("PT409");
    } finally {
      await cleanupAtomicAdvisor();
    }
  });

  it("catalog + surface: set_advisor_role is SECURITY DEFINER with empty search_path, service_role-pinned EXECUTE, and anon/authenticated denied", async () => {
    const rows = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean; auth: boolean }>(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('service_role', 'public.set_advisor_role(integer, text, text, integer, integer)', 'EXECUTE') AS sr,
              has_function_privilege('anon', 'public.set_advisor_role(integer, text, text, integer, integer)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.set_advisor_role(integer, text, text, integer, integer)', 'EXECUTE') AS auth
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'set_advisor_role'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].prosecdef, "set_advisor_role must be SECURITY DEFINER").toBe(true);
    expect(rows.rows[0].proconfig, "set_advisor_role must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows.rows[0].sr, "service_role EXECUTE on set_advisor_role").toBe(true);
    expect(rows.rows[0].anon, "no anon EXECUTE on set_advisor_role").toBe(false);
    expect(rows.rows[0].auth, "no authenticated EXECUTE on set_advisor_role").toBe(false);

    const anonCall = await anon.rpc("set_advisor_role", {
      p_advisor_id: atomicAdvisorId ?? 1,
      p_role: "Admin",
      p_reason: "anon attempt",
      p_actor_id: roleActorId ?? 1,
      p_expected_version: 1,
    });
    expect(anonCall.data).toBeNull();
    expect(anonCall.error, "anon must be denied set_advisor_role").not.toBeNull();
  });
});
