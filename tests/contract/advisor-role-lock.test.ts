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
 *   - FENCED DISPLAY WRITE (migration 20261004000001): the protected
 *     `advisor.role` write is accepted ONLY while the caller's holder still
 *     owns a non-expired lease — a non-holder, an EXPIRED holder, and a holder
 *     SUPERSEDED by a takeover are all fenced out (the write returns false and
 *     the role is untouched), while the current holder's write lands; the
 *     ownership check `verify_advisor_role_lock` gates compensation.
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
describe("fenced protected-display-role write (migration 20261004000001, P1 finding)", () => {
  const fencedWrite = (holder: string, role: string) =>
    service.rpc("fenced_write_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: holder,
      p_role: role,
    });

  const verify = (holder: string) =>
    service.rpc("verify_advisor_role_lock", { p_advisor_id: advisorId, p_holder: holder });

  const advisorRole = async (): Promise<string | null> => {
    const { data, error } = await service
      .from("advisor")
      .select("role")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    if (error) throw new Error(`read advisor role: ${error.message}`);
    return data?.role ?? null;
  };

  it("accepts the fenced display write ONLY while the same holder owns a NON-EXPIRED lease", async () => {
    const acquired = await acquire("holder-owner", 60);
    expect(acquired.data, "owner must acquire the lease").toBe(true);

    // The owner writes its role through the fence.
    const landed = await fencedWrite("holder-owner", "Admin");
    expect(landed.error, "owner fenced write").toBeNull();
    expect(landed.data, "owner fenced write must land").toBe(true);
    expect(await advisorRole(), "owner display role written").toBe("Admin");

    // A NON-holder cannot write: fenced out, role untouched.
    const denied = await fencedWrite("holder-intruder", "Advisor");
    expect(denied.error, "non-holder fenced write").toBeNull();
    expect(denied.data, "non-holder fenced write must be fenced out").toBe(false);
    expect(await advisorRole(), "role unchanged by the non-holder").toBe("Admin");

    // verify agrees: owner owns a non-expired lease, the intruder does not.
    expect((await verify("holder-owner")).data).toBe(true);
    expect((await verify("holder-intruder")).data).toBe(false);

    // The owner can still write (lease still valid).
    expect((await fencedWrite("holder-owner", "Advisor")).data).toBe(true);
    expect(await advisorRole()).toBe("Advisor");
  });

  it("fences out an EXPIRED holder: after the lease expires, the holder cannot write", async () => {
    const acquired = await acquire("holder-short", 1);
    expect(acquired.data, "short-lease holder must acquire").toBe(true);

    // Wait for the lease to expire.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const expired = await fencedWrite("holder-short", "Admin");
    expect(expired.error, "expired-holder fenced write").toBeNull();
    expect(expired.data, "expired holder must be fenced out").toBe(false);
    expect(await advisorRole(), "role untouched after expired-holder fence").toBe("Advisor");
    expect((await verify("holder-short")).data, "expired holder no longer owns").toBe(false);
  });

  it("fences out a SUPERSEDED holder after a takeover: stale A cannot write, B can, and the state stays consistent (P1 core proof)", async () => {
    // A takes a short lease, its lease expires, B takes over.
    const aAcquired = await acquire("holder-a-stale", 1);
    expect(aAcquired.data, "A must acquire").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const bTakeover = await acquire("holder-b-new", 60);
    expect(bTakeover.data, "B must take over the expired lease").toBe(true);

    // Stale A's display write is FENCED OUT by the database.
    const staleAWrite = await fencedWrite("holder-a-stale", "Admin");
    expect(staleAWrite.error, "stale A fenced write").toBeNull();
    expect(staleAWrite.data, "stale A must be fenced out").toBe(false);
    expect(await advisorRole(), "role untouched by stale A").toBe("Advisor");

    // B (the current owner) writes the OPPOSING role and it lands.
    const bWrite = await fencedWrite("holder-b-new", "Admin");
    expect(bWrite.data, "current holder B write must land").toBe(true);
    expect(await advisorRole(), "B display role written").toBe("Admin");

    // verify agrees on ownership: B owns, stale A does not.
    expect((await verify("holder-b-new")).data).toBe(true);
    expect((await verify("holder-a-stale")).data).toBe(false);
  });

  it("rejects an invalid display role at the database boundary (fail closed)", async () => {
    const acquired = await acquire("holder-invalid", 60);
    expect(acquired.data).toBe(true);

    const invalid = await fencedWrite("holder-invalid", "boss");
    expect(invalid.data, "invalid role must return no data").toBeNull();
    expect(invalid.error, "invalid role must be rejected").not.toBeNull();
    expect(invalid.error?.code, "invalid role error code").toBe("22023");
    expect(await advisorRole(), "role untouched by the invalid write").toBe("Advisor");
  });

  it("catalog + surface: fenced write and verify are SECURITY DEFINER, service_role-pinned, anon denied", async () => {
    const rows = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean }>(
      `SELECT p.proname,
              p.prosecdef,
              p.proconfig,
              CASE p.proname
                WHEN 'fenced_write_advisor_role_display' THEN
                  has_function_privilege('service_role', 'public.fenced_write_advisor_role_display(integer, text, text)', 'EXECUTE')
                WHEN 'verify_advisor_role_lock' THEN
                  has_function_privilege('service_role', 'public.verify_advisor_role_lock(integer, text)', 'EXECUTE')
                ELSE false
              END AS sr,
              CASE p.proname
                WHEN 'fenced_write_advisor_role_display' THEN
                  has_function_privilege('anon', 'public.fenced_write_advisor_role_display(integer, text, text)', 'EXECUTE')
                WHEN 'verify_advisor_role_lock' THEN
                  has_function_privilege('anon', 'public.verify_advisor_role_lock(integer, text)', 'EXECUTE')
                ELSE false
              END AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('fenced_write_advisor_role_display', 'verify_advisor_role_lock')
        ORDER BY p.proname`
    );
    expect(rows.rows.map((r) => r.proname).sort()).toEqual([
      "fenced_write_advisor_role_display",
      "verify_advisor_role_lock",
    ]);
    for (const row of rows.rows) {
      expect(row.prosecdef, `${row.proname} must be SECURITY DEFINER`).toBe(true);
      expect(row.proconfig, `${row.proname} must set an empty search_path`).toEqual(["search_path=\"\""]);
      expect(row.sr, `service_role EXECUTE on ${row.proname}`).toBe(true);
      expect(row.anon, `no anon EXECUTE on ${row.proname}`).toBe(false);
    }

    const anonCall = await anon.rpc("verify_advisor_role_lock", {
      p_advisor_id: advisorId,
      p_holder: "anon",
    });
    expect(anonCall.data).toBeNull();
    expect(anonCall.error, "anon must be denied the verify RPC").not.toBeNull();
  });
});

describe("fenced display-role read-back / lost-response reconciliation (migration 20261005000001, final P1)", () => {
  const fencedRead = (holder: string) =>
    service.rpc("fenced_read_advisor_role_display", { p_advisor_id: advisorId, p_holder: holder });

  const fencedWrite = (holder: string, role: string) =>
    service.rpc("fenced_write_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: holder,
      p_role: role,
    });

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

    // After the holder writes a new role, the read-back reflects it.
    const write = await service.rpc("fenced_write_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: "holder-reader",
      p_role: "Admin",
    });
    expect(write.data, "owner fenced write").toBe(true);
    expect((await fencedRead("holder-reader")).data, "read-back reflects the new role").toBe("Admin");
  });

  it("returns NULL for an EXPIRED lease and after a SUPERSEDED takeover (the stale holder cannot read or write)", async () => {
    const aAcquired = await acquire("holder-a-expire", 1);
    expect(aAcquired.data, "A must acquire").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Expired: A's read-back is NULL (and its write is fenced out).
    const expiredRead = await fencedRead("holder-a-expire");
    expect(expiredRead.data, "expired holder read-back must be NULL").toBeNull();
    expect((await fencedWrite("holder-a-expire", "Admin")).data, "expired holder write fenced out").toBe(false);

    // B takes over and can read/write; A stays fenced.
    const bTakeover = await acquire("holder-b-takeover", 60);
    expect(bTakeover.data, "B must take over").toBe(true);
    expect((await fencedRead("holder-b-takeover")).data, "B read-back returns the current role").toBe("Advisor");
    expect((await fencedRead("holder-a-expire")).data, "superseded A read-back must be NULL").toBeNull();
    expect((await fencedWrite("holder-a-expire", "Admin")).data, "superseded A write fenced out").toBe(false);
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

describe("durable display-role reconciliation (migration 20261006000001, lease-expiry P1)", () => {
  // A BOUND advisor with a real auth user so reconcile can read the claim.
  let boundAdvisorId: number;
  let boundAuthUserId: string;

  const seedBoundAdvisor = async (claim: boolean): Promise<void> => {
    const email = syntheticEmail(`reconcile-${claim}`);
    const { data: user, error: userError } = await service.auth.admin.createUser({
      email,
      password: "ReconcilePass!2026",
      email_confirm: true,
      app_metadata: { ocf_admin: claim },
    });
    if (userError || !user.user) throw new Error(`seed reconcile auth user: ${userError?.message ?? "none"}`);
    boundAuthUserId = user.user.id;
    const { data: advisor, error: advisorError } = await service
      .from("advisor")
      .insert({ advisor_name: syntheticName(`reconcile-${claim}`), email, auth_user_id: user.user.id, is_active: true })
      .select("advisor_id")
      .single();
    if (advisorError) throw new Error(`seed reconcile advisor: ${advisorError.message}`);
    boundAdvisorId = advisor.advisor_id as number;
  };

  const cleanupBoundAdvisor = async (): Promise<void> => {
    try {
      await service.from("advisor_role_lock").delete().eq("advisor_id", boundAdvisorId);
      await service.from("advisor").delete().eq("advisor_id", boundAdvisorId);
    } catch {
      /* best-effort */
    }
    if (boundAuthUserId) await service.auth.admin.deleteUser(boundAuthUserId).catch(() => {});
  };

  const reconcile = (advisorId: number, holder: string) =>
    service.rpc("reconcile_advisor_role_display", { p_advisor_id: advisorId, p_holder: holder });

  it("re-aligns the display role to the AUTHORITATIVE claim under a non-expired lease (both directions)", async () => {
    await seedBoundAdvisor(true); // claim true (Admin)
    await cleanupBoundAdvisor();
    await seedBoundAdvisor(false); // claim false (Advisor), display default Advisor
    try {
      // Force a MISMATCH: claim true, display Advisor.
      await service
        .from("advisor")
        .update({ role: "Admin" })
        .eq("advisor_id", boundAdvisorId);
      await service.auth.admin.updateUserById(boundAuthUserId, { app_metadata: { ocf_admin: false } });

      const acquired = await service.rpc("acquire_advisor_role_lock", {
        p_advisor_id: boundAdvisorId,
        p_holder: "reconciler",
        p_lease_seconds: 60,
      });
      expect(acquired.data, "reconciler must acquire the lease").toBe(true);

      // claim false -> display should become Advisor.
      const result = await reconcile(boundAdvisorId, "reconciler");
      expect(result.error, "reconcile (claim false)").toBeNull();
      expect(result.data, "reconcile projects Advisor from the false claim").toBe("Advisor");
      const { data: row } = await service.from("advisor").select("role").eq("advisor_id", boundAdvisorId).maybeSingle();
      expect(row?.role, "display aligned to the false claim").toBe("Advisor");

      // Now claim true -> display should become Admin.
      await service.auth.admin.updateUserById(boundAuthUserId, { app_metadata: { ocf_admin: true } });
      const promoted = await reconcile(boundAdvisorId, "reconciler");
      expect(promoted.error).toBeNull();
      expect(promoted.data, "reconcile projects Admin from the true claim").toBe("Admin");
      const { data: row2 } = await service.from("advisor").select("role").eq("advisor_id", boundAdvisorId).maybeSingle();
      expect(row2?.role, "display aligned to the true claim").toBe("Admin");

      await service.rpc("release_advisor_role_lock", { p_advisor_id: boundAdvisorId, p_holder: "reconciler" });
    } finally {
      await cleanupBoundAdvisor();
    }
  });

  it("returns NULL for a NON-holder and after expiry/superseded takeover (never reconciles without ownership)", async () => {
    await seedBoundAdvisor(false);
    try {
      const aAcquired = await service.rpc("acquire_advisor_role_lock", {
        p_advisor_id: boundAdvisorId,
        p_holder: "holder-a-short",
        p_lease_seconds: 1,
      });
      expect(aAcquired.data, "A must acquire").toBe(true);

      // Non-holder: NULL.
      const intruder = await reconcile(boundAdvisorId, "holder-intruder");
      expect(intruder.error, "non-holder reconcile").toBeNull();
      expect(intruder.data, "non-holder reconcile must be NULL").toBeNull();

      // Expired: NULL.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const expired = await reconcile(boundAdvisorId, "holder-a-short");
      expect(expired.error, "expired-holder reconcile").toBeNull();
      expect(expired.data, "expired-holder reconcile must be NULL").toBeNull();

      // Superseded by takeover: the stale holder still gets NULL.
      const bTakeover = await service.rpc("acquire_advisor_role_lock", {
        p_advisor_id: boundAdvisorId,
        p_holder: "holder-b-new",
        p_lease_seconds: 60,
      });
      expect(bTakeover.data, "B must take over").toBe(true);
      expect((await reconcile(boundAdvisorId, "holder-a-short")).data, "superseded A reconcile NULL").toBeNull();
      expect((await reconcile(boundAdvisorId, "holder-b-new")).data, "B reconcile returns the role").not.toBeNull();

      await service.rpc("release_advisor_role_lock", { p_advisor_id: boundAdvisorId, p_holder: "holder-b-new" });
    } finally {
      await cleanupBoundAdvisor();
    }
  });

  it("catalog: reconcile is SECURITY DEFINER with empty search_path and service_role-pinned EXECUTE", async () => {
    const rows = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean }>(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('service_role', 'public.reconcile_advisor_role_display(integer, text)', 'EXECUTE') AS sr,
              has_function_privilege('anon', 'public.reconcile_advisor_role_display(integer, text)', 'EXECUTE') AS anon
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'reconcile_advisor_role_display'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].prosecdef, "reconcile must be SECURITY DEFINER").toBe(true);
    expect(rows.rows[0].proconfig, "reconcile must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(rows.rows[0].sr, "service_role EXECUTE on reconcile").toBe(true);
    expect(rows.rows[0].anon, "no anon EXECUTE on reconcile").toBe(false);
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

  it("reconcile-after-rollback aligns the display to the authoritative claim under the re-secured lease", async () => {
    // The lock-target advisor is UNBOUND, so the authoritative claim is false
    // (Advisor projection). Force a mismatched display (Admin) and reconcile.
    await service.from("advisor").update({ role: "Admin" }).eq("advisor_id", advisorId);
    const acquired = await acquire("holder-post-rollback", 60);
    expect(acquired.data, "post-rollback holder must acquire").toBe(true);

    const reconciled = await service.rpc("reconcile_advisor_role_display", {
      p_advisor_id: advisorId,
      p_holder: "holder-post-rollback",
    });
    expect(reconciled.error, "post-rollback reconcile").toBeNull();
    expect(reconciled.data, "reconcile projects Advisor for the unbound (false) claim").toBe("Advisor");

    const { data: row } = await service
      .from("advisor")
      .select("role")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    expect(row?.role, "display aligned to the authoritative claim").toBe("Advisor");

    await release("holder-post-rollback");
    // Restore the baseline for the shared lock-target advisor.
    await service.from("advisor").update({ role: "Advisor" }).eq("advisor_id", advisorId);
  });
});

describe("atomic advisor role change (migration 20261007000001, final P1)", () => {
  let atomicAdvisorId: number;
  let atomicAuthUserId: string;

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
      await service.from("advisor").delete().eq("advisor_id", atomicAdvisorId);
    } catch {
      /* best-effort */
    }
    if (atomicAuthUserId) await service.auth.admin.deleteUser(atomicAuthUserId).catch(() => {});
  };

  const setRole = (advisorId: number, role: string) =>
    service.rpc("set_advisor_role", { p_advisor_id: advisorId, p_role: role });

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

  it("CONCURRENCY/ATOMICITY: concurrent role changes are serialized by the transaction and the final claim/display NEVER diverge", async () => {
    await seedAtomicAdvisor(false);
    try {
      const [promote, demote] = await Promise.all([
        setRole(atomicAdvisorId, "Admin"),
        setRole(atomicAdvisorId, "Advisor"),
      ]);
      // Both atomic transactions succeed (the last writer wins).
      expect(promote.error, "concurrent promote").toBeNull();
      expect(demote.error, "concurrent demote").toBeNull();

      // FINAL CONSISTENCY: display ⇔ claim always match, whichever won.
      const role = (await advisorRow(atomicAdvisorId))?.role;
      const claim = await authClaim(atomicAuthUserId);
      expect(role, "final display role").toBe(claim === true ? "Admin" : "Advisor");
      expect(claim, "final claim").toBe(role === "Admin");
    } finally {
      await cleanupAtomicAdvisor();
    }
  });

  it("catalog + surface: set_advisor_role is SECURITY DEFINER with empty search_path, service_role-pinned EXECUTE, and anon/authenticated denied", async () => {
    const rows = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; sr: boolean; anon: boolean; auth: boolean }>(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('service_role', 'public.set_advisor_role(integer, text)', 'EXECUTE') AS sr,
              has_function_privilege('anon', 'public.set_advisor_role(integer, text)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.set_advisor_role(integer, text)', 'EXECUTE') AS auth
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

    const anonCall = await anon.rpc("set_advisor_role", { p_advisor_id: atomicAdvisorId ?? 1, p_role: "Admin" });
    expect(anonCall.data).toBeNull();
    expect(anonCall.error, "anon must be denied set_advisor_role").not.toBeNull();
  });
});
