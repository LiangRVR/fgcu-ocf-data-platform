/**
 * tests/unit/contract/helpers/setup.test.ts
 *
 * Deterministic, offline regression coverage for
 * `attachPoolErrorHandler` (tests/contract/helpers/setup.ts), driven by an
 * independent review P2 finding.
 *
 * The handler exists so that EXPECTED teardown-time server terminations
 * (SQLSTATE 57P01 from `DROP DATABASE ... WITH (FORCE)` reaping a scratch
 * database, or from the runner's `supabase stop`) do not crash the contract
 * suite through an unhandled EventEmitter `error` event. It must be STRICTLY
 * additive:
 *
 *   - it must never intercept, transform, or conceal a rejected query —
 *     node-postgres rejects query promises independently of pool `error`
 *     events, and the handler must preserve that behavior;
 *   - it must be non-throwing and diagnostic.
 *
 * These tests exercise the handler against a minimal in-memory EventEmitter
 * "pool" (never a real database), so they are deterministic and run anywhere
 * the unit suite runs.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { attachPoolErrorHandler, createDbPool } from "../../../contract/helpers/setup";

/** Minimal pg-like error carrying a SQLSTATE code (as node-postgres does). */
function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Minimal stand-in for a node-postgres Pool: an EventEmitter whose `query`
 * models the two real-world outcomes that matter here.
 *
 *   - normal query failure: the query promise rejects and NO pool `error`
 *     event is emitted (node-postgres semantics — query errors never surface
 *     as pool `error` events);
 *   - fatal connection error during a query (the server terminates the
 *     connection mid-query): the query rejects AND the pool emits `error` —
 *     but the rejection is independent of the event.
 */
class FakePool extends EventEmitter {
  private queued: { error: Error; alsoEmitPoolError?: boolean } | null = null;

  enqueueRejection(error: Error, alsoEmitPoolError = false): this {
    this.queued = { error, alsoEmitPoolError };
    return this;
  }

  query(): Promise<never> {
    const { error, alsoEmitPoolError } = this.queued ?? { error: new Error("mock query failure") };
    if (alsoEmitPoolError) {
      // Connection-level failure: the pool ALSO fires the `error` event. The
      // query must still reject independently with the same error object.
      this.emit("error", error);
    }
    return Promise.reject(error);
  }
}

/** A FakePool with the production guard attached; returns the fake instance. */
function guardedFakePool(label = "unit-mock"): FakePool {
  const fake = new FakePool();
  attachPoolErrorHandler(fake as unknown as Pool, label);
  return fake;
}

describe("attachPoolErrorHandler (tests/contract/helpers/setup.ts)", () => {
  it("does not intercept or transform a rejected query (normal query failure)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const checkViolation = pgError(
        "23514",
        'new row for relation "advising_meeting_amendment" violates check constraint "advising_meeting_amendment_reason_not_blank_check"'
      );
      const pool = guardedFakePool();

      pool.enqueueRejection(checkViolation);
      await expect(pool.query()).rejects.toBe(checkViolation);

      // The handler only listens for connection-level `error` events. A
      // rejected query never becomes one, so the rejection passes through
      // untouched (same object identity, no wrapper) and no diagnostic fires.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("keeps a rejected query visible even when the termination also fires the pool error event", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const termination = pgError("57P01", "terminating connection due to administrator command");
      const pool = guardedFakePool();

      pool.enqueueRejection(termination, true);
      await expect(pool.query()).rejects.toBe(termination);

      // The query was NOT concealed: it rejected with the same error object,
      // while the connection-level termination was logged as the expected
      // teardown diagnostic.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("57P01"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("absorbs an expected teardown-time termination (57P01) without throwing, and logs a diagnostic", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = guardedFakePool();

      expect(() =>
        pool.emit("error", pgError("57P01", "terminating connection due to administrator command"))
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[contract:unit-mock]"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("57P01"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reports an unexpected idle-client error without throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pool = guardedFakePool();

      expect(() => pool.emit("error", pgError("08001", "sqlclient_unable_to_establish_sqlconnection"))).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("08001"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected idle-client pool error"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("prevents the crash a bare EventEmitter throws on an unhandled error event", () => {
    // Counterfactual crash mode: without any listener, emitting `error`
    // throws synchronously (this is the unhandled-EventEmitter crash the
    // contract lane used to hit during teardown).
    const bare = new EventEmitter();
    expect(() => bare.emit("error", pgError("57P01", "terminating connection due to administrator command"))).toThrow();

    // With the handler attached, the same event is absorbed non-throwingly.
    const guarded = attachPoolErrorHandler(new EventEmitter() as unknown as Pool, "unit-mock");
    expect(() => guarded.emit("error", pgError("57P01", "terminating connection due to administrator command"))).not.toThrow();
  });

  it("wires the guard into every pool produced by createDbPool", async () => {
    const pool = createDbPool({
      apiUrl: "http://127.0.0.1:54321",
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      anonKey: "eyJhbGciOiJIUzI1NiJ9.unit-anon",
      serviceRoleKey: "eyJhbGciOiJIUzI1NiJ9.unit-service",
    });
    try {
      // The factory's pools carry exactly one `error` listener (our guard) —
      // never multiple, and never zero.
      expect(pool.listenerCount("error")).toBe(1);
    } finally {
      await pool.end();
    }
  });
});