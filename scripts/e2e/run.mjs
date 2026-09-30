#!/usr/bin/env node
/**
 * scripts/e2e/run.mjs — local Playwright E2E lane for the OCF data platform.
 *
 * Lifecycle (all against a throwaway Docker-local Supabase instance — never
 * hosted, never the repository's own local project):
 *   1. Pre-flight prerequisites (node_modules bins, Docker daemon, supabase CLI,
 *      Playwright + its locally provisioned Chromium).
 *   2. Materialize an ISOLATED temporary Supabase workdir: a copy of the repo
 *      migrations + a rewritten `config.toml` with a unique `project_id` and
 *      unique free ports (see `scripts/test-support/supabase-isolation.mjs`).
 *   3. `supabase start --workdir <isolated>`      – bring the isolated stack up
 *                                                   (first run pulls Docker
 *                                                   images). Start output is
 *                                                   suppressed: only a
 *                                                   lifecycle summary is logged
 *                                                   on success and a safe FIXED
 *                                                   summary (exit code + attempt
 *                                                   metadata, never the
 *                                                   captured output) on
 *                                                   failure, so the local
 *                                                   credentials the CLI
 *                                                   prints as a table
 *                                                   (Publishable/Secret/
 *                                                   Access Key/Secret Key rows)
 *                                                   are never emitted.
 *   4. `supabase status -o env --workdir <isolated>` – capture the runtime local
 *      env (URL, anon key, service-role key, Postgres URL). Output is parsed
 *      robustly (bare API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL + aliases);
 *      values are never logged; loopback-only URLs are enforced.
 *   5. `supabase db reset --no-seed --workdir <isolated>` – apply the FULL
 *      migration chain to a fresh database, then apply the TEST-ONLY pipeline
 *      stage/flag invariant SQL from `scripts/test-support/`
 *      (outside `supabase/migrations/`, never a deployable migration).
 *   6. `tsx tests/e2e/fixtures/seed.ts`           – seed synthetic active/inactive
 *                                                   advisor AUTH users plus OCF
 *                                                   fixtures through the server-only
 *                                                   service role (never the browser).
 *   7. `next build` + `next start`                – build/start the app with the
 *                                                   runtime local NEXT_PUBLIC_*
 *                                                   Supabase env, inside an
 *                                                   ISOLATED app workdir (a
 *                                                   throwaway copy of the source
 *                                                   tree): the repository's
 *                                                   `.env*` files are never
 *                                                   copied, so Next.js cannot
 *                                                   load any project env, and
 *                                                   `.next` build artifacts land
 *                                                   in the workdir and are
 *                                                   removed on teardown — the
 *                                                   repository's `.next` is
 *                                                   never touched. The isolated
 *                                                   server's APP_URL is injected
 *                                                   into the build/start env.
 *                                                   The Next SERVER (build AND
 *                                                   start) runs the isolated
 *                                                   workdir's OWN
 *                                                   `node_modules/next` binary,
 *                                                   so the server runtime and
 *                                                   the app's bundled
 *                                                   `next/headers` share one
 *                                                   module tree (a server
 *                                                   launched from the
 *                                                   repository's `next` bin
 *                                                   splits
 *                                                   `workUnitAsyncStorage`
 *                                                   across two module instances
 *                                                   and the prerender crashes
 *                                                   with the "Expected
 *                                                   workUnitAsyncStorage to
 *                                                   have a store" invariant).
 *   8. Wait for the app health endpoint.
 *   9. `playwright test` (Chromium project).
 *  10. Teardown in `finally` (also on SIGINT/SIGTERM): terminate every spawned
 *      child, kill the Next server, stop ONLY the isolated Supabase instance,
 *      remove its temp workdir and the isolated app workdir. A `supabase
 *      start` port conflict retries the whole lane (fresh port allocation,
 *      bounded); an `E2E_APP_PORT` override is probed for availability up
 *      front. The repository's normal local Supabase project is never
 *      started/reset/stopped.
 *
 * Truthfulness policy: if pnpm-equivalent tooling, Docker, the supabase CLI,
 * the Supabase images, or the Playwright Chromium browser cannot be
 * provisioned, the lane reports the EXACT blocker and exits non-zero. It NEVER
 * substitutes a hosted/shared database, and it never reads the project `.env`
 * files for Supabase credentials.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertLoopbackRuntime,
  captureRuntimeEnv,
  completeRetryableTeardown,
  isPortConflictOutput,
  isPortFree,
  killChildGracefully,
  pipeRedacted,
  prepareIsolatedAppDir,
  prepareIsolatedSupabase,
  presenceSummary,
  redactSensitiveOutput,
  runtimeEnv,
  runProbe,
  runTrackedSubprocess,
  sanitizeEnv,
  startFailureSummary,
  stopIsolatedSupabase,
  supabaseArgs,
  terminateAllChildren,
  trackChild,
  untrackChild,
} from "../test-support/supabase-isolation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_FILE = path.join(ROOT, "tests", "e2e", "fixtures", "seed.ts");
const RESULTS_DIR = path.join(ROOT, "test-results");
const NEXT_LOG = path.join(RESULTS_DIR, "next-e2e.log");

const APP_HOST = "127.0.0.1";
// The Next app port is probed per run (never a fixed/assumed-free default); an
// explicit `E2E_APP_PORT` override is honored when the operator sets one (and
// is itself probed for availability before the lane commits to it). A fresh
// probed port is allocated on every lane attempt when no override is set.
const APP_PORT_OVERRIDE = Number(process.env.E2E_APP_PORT) || 0;
let APP_PORT = 0;
let APP_URL = "";

const START_TIMEOUT_MS = 15 * 60_000; // first run pulls Docker images
const RESET_TIMEOUT_MS = 10 * 60_000;
const SEED_TIMEOUT_MS = 5 * 60_000;
// TEST-ONLY pipeline stage/flag invariant SQL, applied AFTER the
// production-equivalent migration chain. Deliberately outside
// `supabase/migrations/`: never part of a deployable migration path (oracle P1
// fix), applied through the dedicated `apply-test-only-sql.mjs` runner.
const TEST_ONLY_INVARIANT_SQL = path.join(ROOT, "scripts", "test-support", "invariant-application-stage-flag.sql");
const APPLY_TEST_ONLY_SQL = path.join(ROOT, "scripts", "test-support", "apply-test-only-sql.mjs");
const APPLY_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SUPABASE_HEALTH_TIMEOUT_MS = 30_000;
const APP_HEALTH_TIMEOUT_MS = 120_000;
const PLAYWRIGHT_TIMEOUT_MS = 30 * 60_000;
const SERVER_STOP_GRACE_MS = 5_000; // SIGTERM grace before SIGKILL escalation
// Bounded timeout for every preflight/availability probe (a hung probe is a
// reported blocker, never an unbounded hang).
const PROBE_TIMEOUT_MS = 15_000;
// Bounded timeout for a single `supabase status` capture (transient container
// warm-up is handled by `captureRuntimeEnv`'s bounded retries).
const STATUS_CAPTURE_TIMEOUT_MS = 120_000;
// Hard deadlines for teardown children (`docker info` availability probe and
// `supabase stop`): SIGTERM→SIGKILL escalation — a hung teardown is reported,
// never a hang.
const TEARDOWN_PROBE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 120_000;
// SIGTERM grace before SIGKILL escalation when a child hits its timeout.
const TIMEOUT_KILL_GRACE_MS = 3_000;
// Bounded whole-lane retries: a port conflict on `supabase start` tears down
// the isolated stack and retries with a fresh port allocation; anything else
// is reported as the blocker it is.
const MAX_LANE_ATTEMPTS = 3;

const log = (...args) => console.log("[e2e]", ...args);
const warn = (...args) => console.warn("[e2e]", ...args);
const error = (...args) => console.error("[e2e]", ...args);

/**
 * Synchronous child helper with FULL containment: the child env is ALWAYS the
 * sanitized env (never raw inherited `process.env`) and every call runs under
 * a bounded timeout. Callers that need to inject lane runtime values pass an
 * explicit `env` (e.g. `sanitizeEnv` + `runtimeEnv`); anything else is
 * sanitized here.
 */
function runSync(cmd, args, { env, timeout = PROBE_TIMEOUT_MS, cwd = ROOT, ...rest } = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: "pipe",
    cwd,
    env: env ?? sanitizeEnv(process.env),
    timeout,
    // Retained synchronous path: hard SIGKILL at the deadline (a probe that
    // ignores SIGTERM is still killed, never left hanging).
    killSignal: "SIGKILL",
    ...rest,
  });
}

/**
 * Spawn a child, streaming its output through the redaction filter. The child
 * is registered in the shared process registry so a SIGINT/SIGTERM (or the
 * `finally` teardown) terminates it — and its own bounded timeout escalates
 * SIGTERM → SIGKILL rather than killing cold. The child env is ALWAYS the
 * sanitized env (never raw inherited `process.env`). When `captureOutput` is
 * set, the raw (pre-redaction) output is also accumulated — separately for
 * stdout and stderr, plus a combined `output` — and returned so the caller can
 * classify failures (e.g. port conflicts) or parse structured output (e.g.
 * `E2E_SEED_JSON`); it is still redacted on the way to the terminal. When
 * `quiet` is set, nothing is streamed to the terminal at all: the caller owns
 * failure reporting via a safe fixed summary (never the captured output).
 */
function runChild(cmd, args, { env, timeoutMs = 0, timeoutKillGraceMs = TIMEOUT_KILL_GRACE_MS, cwd = ROOT, runtime, captureOutput = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = trackChild(
      spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd, env: env ?? sanitizeEnv(process.env) })
    );
    let captured = "";
    let capturedStdout = "";
    let capturedStderr = "";
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => {
        captured += chunk.toString();
        capturedStdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        captured += chunk.toString();
        capturedStderr += chunk.toString();
      });
    }
    // Every captured child stream (CLI, build, test output) passes through the
    // redaction filter before it reaches the terminal. `supabase start` runs
    // QUIET (see `runLane`): its raw output is captured for internal
    // port-conflict classification only and is NEVER surfaced — failures log
    // a safe fixed summary plus exit/attempt metadata.
    if (!quiet) {
      pipeRedacted(child.stdout, process.stdout, { runtime });
      pipeRedacted(child.stderr, process.stderr, { runtime });
    }
    let timer = null;
    let settled = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        error(`"${cmd} ${args.join(" ")}" timed out after ${timeoutMs} ms; terminating (SIGTERM, escalating to SIGKILL).`);
        killChildGracefully(child, { graceMs: timeoutKillGraceMs, killSignal: "SIGKILL" });
      }, timeoutMs);
    }
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      untrackChild(child);
      resolve({ code: code ?? 1, output: captured, stdout: capturedStdout, stderr: capturedStderr });
    };
    child.on("close", (code) => settle(code));
    child.on("error", (spawnError) => {
      error(`Failed to spawn "${cmd}": ${spawnError.message}`);
      settle(1);
    });
  });
}

/** True when `cmd` exits 0 within the bounded probe timeout (sanitized env). */
function toolAvailable(cmd, args = ["--version"], opts = {}) {
  return runProbe(cmd, args, opts).ok;
}

/** Resolve a tool binary inside the repo's node_modules/.bin. */
function binPath(name) {
  const p = path.join(ROOT, "node_modules", ".bin", name);
  return existsSync(p) ? p : null;
}

/** Probe an HTTP endpoint until it responds or the timeout elapses. */
async function waitForHealth(url, timeoutMs) {
  const probe = (u) =>
    fetch(u, { signal: AbortSignal.timeout(2_000) }).then(
      () => true,
      () => false
    );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Check that Playwright's own Chromium is provisioned (the executable that
 * `playwright test` will actually launch). Returns the exact executable path
 * or a precise blocker reason. The probe runs with the SANITIZED env and a
 * bounded timeout — a hostile inherited credential can never reach it, and a
 * hung probe is reported as a blocker, never a hang. Anything surfaced from
 * the probe output is redacted.
 */
function chromiumAvailability() {
  const probe = `
    const { chromium } = require("@playwright/test");
    const fs = require("fs");
    const p = chromium.executablePath();
    process.stdout.write(JSON.stringify({ path: p, exists: fs.existsSync(p) }));
  `;
  const res = runProbe(process.execPath, ["-e", probe], {
    cwd: ROOT,
    timeoutMs: PROBE_TIMEOUT_MS,
    captureOutput: true,
  });
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || "").trim();
    return {
      ok: false,
      reason: `Could not resolve the Playwright Chromium executable (${redactSensitiveOutput(detail) || "probe failed"}).`,
    };
  }
  try {
    const info = JSON.parse(res.stdout.trim());
    if (!info.exists) {
      return {
        ok: false,
        reason:
          `Playwright Chromium is not installed (expected at "${info.path}").\n` +
          `  Install it with: pnpm run test:e2e:install   (i.e. pnpm exec playwright install --with-deps chromium)\n` +
          `  The lane runs only against a locally provisioned Chromium; it does not fall back to system browsers.`,
      };
    }
    return { ok: true, path: info.path };
  } catch {
    return { ok: false, reason: "Could not parse the Playwright Chromium probe output." };
  }
}

// ---- Scoped teardown -------------------------------------------------------
// Only the isolated Supabase instance is ever stopped; the repository's own
// local Supabase project is never touched.
let isolated = null;
let supabaseBin = null;
// The single sanitized lane environment, computed once in `main()` and reused
// by every child the lane spawns — including teardown, so `supabase stop`
// NEVER inherits the raw parent env.
let sanitizedLaneEnv = null;

/**
 * Stop ONLY the isolated instance's stack (no backup). Operates on the STABLE
 * `lane` reference captured by the caller (default: the current global), so an
 * async teardown can never dereference a global a later attempt reassigned or
 * null-ed.
 */
async function stopSupabase(lane = isolated) {
  if (!lane) return;
  // Teardown containment for the Docker availability probe: the probe child is
  // a TRACKED ASYNC child running with the SANITIZED lane env (a hostile
  // inherited credential can never reach it) under a hard deadline with
  // SIGTERM→SIGKILL escalation — a hung probe cannot block signal handling.
  // Its output is captured (never inherited raw) and is not surfaced raw.
  const probe = await runTrackedSubprocess("docker", ["info"], {
    env: sanitizedLaneEnv ?? sanitizeEnv(process.env),
    timeoutMs: TEARDOWN_PROBE_TIMEOUT_MS,
  });
  if (probe.status !== 0) {
    log("Skipping `supabase stop` (Docker daemon unavailable).");
    return;
  }
  if (!supabaseBin) {
    log("Skipping `supabase stop` (supabase CLI unavailable).");
    return;
  }
  log(`Stopping isolated Supabase (workdir ${lane.workdir}, no backup)...`);
  // Teardown containment: the stop child runs with the SANITIZED lane env (a
  // hostile inherited credential can never reach it) as a TRACKED ASYNC child
  // with a hard deadline and SIGTERM→SIGKILL escalation — a hung `supabase
  // stop` is terminated by the deadline and can never block signal handling.
  // Its captured output is already scrubbed by `stopIsolatedSupabase` before
  // it is logged.
  const stop = await stopIsolatedSupabase(supabaseBin, lane.workdir, {
    env: sanitizedLaneEnv ?? sanitizeEnv(process.env),
    timeoutMs: STOP_TIMEOUT_MS,
  });
  if (stop.timedOut) {
    warn(`supabase stop hit its hard deadline and was SIGKILLed; the isolated stack may need manual cleanup.`);
  }
  if (stop.output) log(`supabase stop output:\n${stop.output}`);
  if (stop.status === 0) {
    log("Isolated Supabase stopped without backup.");
  } else if (!stop.timedOut) {
    warn(`supabase stop exited with code ${stop.status}; the isolated stack may need manual cleanup.`);
  }
}

/**
 * Remove the isolated workdir for `lane` and clear the lane global — but ONLY
 * when the global still refers to the very lane just removed, so a stale
 * teardown can never clobber a fresh lane installed by a later attempt.
 */
function cleanupIsolatedWorkdir(lane = isolated) {
  if (!lane) return;
  try {
    lane.cleanup();
    log("Isolated workdir removed.");
  } catch (caught) {
    warn(`Could not remove isolated workdir: ${caught.message}`);
  }
  if (isolated === lane) isolated = null;
}

let teardownDone = false;
let nextChild = null;
let serverLogStream = null;
let appDir = null;

async function teardown() {
  if (teardownDone) return;
  teardownDone = true;
  if (nextChild) {
    if (nextChild.exitCode === null && nextChild.signalCode === null) {
      log("Stopping the Next.js server (SIGTERM, escalating to SIGKILL if needed)...");
      const code = await killChildGracefully(nextChild, { graceMs: SERVER_STOP_GRACE_MS });
      log(`Next.js server stopped${code === null ? "." : ` (exit code ${code}).`}`);
    } else {
      log(`Next.js server already exited (code ${nextChild.exitCode ?? "signaled"}).`);
    }
    nextChild = null;
  }
  if (serverLogStream) {
    serverLogStream.end();
    serverLogStream = null;
  }
  await stopSupabase();
  cleanupIsolatedWorkdir();
  // The isolated app workdir holds the build output and any stray artifacts;
  // removing it guarantees nothing lands in (or pollutes) the repository.
  if (appDir) {
    try {
      appDir.cleanup();
      log("Isolated app workdir removed.");
    } catch (caught) {
      warn(`Could not remove isolated app workdir: ${caught.message}`);
    }
    appDir = null;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    error(`\nReceived ${signal}; terminating spawned children, then running teardown before exit.`);
    terminateAllChildren({ graceMs: SERVER_STOP_GRACE_MS }).finally(() => {
      teardown().finally(() => process.exit(130));
    });
  });
}

/**
 * Build/start env for the Next.js app: the runtime LOCAL Supabase values must
 * win over any committed `.env` (process env takes precedence in Next), and no
 * hosted credentials may leak from the parent shell into the app processes.
 * Values are injected under canonical names plus `SUPABASE_*` aliases; the
 * `NEXT_PUBLIC_*` pair is set explicitly for client-side resolution. The
 * isolated server's own `APP_URL` is injected so server-side code (e.g. the
 * password-reset redirect origin) resolves to THIS instance, not localhost:3000.
 */
function buildAppEnv(runtime) {
  const env = runtimeEnv(sanitizeEnv(process.env), runtime);
  env.NEXT_PUBLIC_SUPABASE_URL = runtime.apiUrl;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = runtime.anonKey;
  env.APP_URL = APP_URL;
  env.NEXT_PUBLIC_APP_URL = APP_URL;
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

/**
 * Run one full lane attempt. Returns `{ retryable: true }` when `supabase
 * start` failed because a probed port was already taken (the caller tears the
 * stack down and retries the whole lane with a fresh allocation, bounded), or
 * `{ code }` on any other outcome.
 */
async function runLane(attempt, { supabaseBin, tsxBin, playwrightBin, sanitizedEnv }) {
  // ---- Materialize the isolated Supabase workdir --------------------------
  log("Preparing isolated temporary Supabase workdir (unique project identity + ports)...");
  let iso;
  try {
    // The Next app server port is probed from the same per-run allocation and
    // retried on conflict, so it never binds a fixed or assumed-free port.
    iso = await prepareIsolatedSupabase({ root: ROOT, label: "e2e", extraPorts: 1 });
  } catch (caught) {
    error(`Environment blocker: could not prepare the isolated Supabase workdir: ${caught.message}`);
    return { code: 1 };
  }
  isolated = iso;
  // A configured override stays fixed across attempts (it was probed up
  // front); otherwise each attempt binds a freshly probed port from its own
  // per-run allocation.
  if (APP_PORT_OVERRIDE) {
    APP_PORT = APP_PORT_OVERRIDE;
  } else {
    APP_PORT = iso.ports.next;
  }
  APP_URL = `http://${APP_HOST}:${APP_PORT}`;
  log(`Isolated workdir: ${iso.workdir} (project_id ${iso.projectId}, attempt ${attempt}/${MAX_LANE_ATTEMPTS})`);

  // The CLI version probe runs with the isolated workdir as cwd so its
  // update-check cache lands inside the throwaway workdir, never the
  // repository's `supabase/`.
  if (!toolAvailable(supabaseBin, ["--version"], { cwd: iso.workdir })) {
    error("Environment blocker: the `supabase` CLI is not usable (`node_modules/.bin/supabase --version` failed).");
    error("Restore it via `pnpm install` / `pnpm rebuild supabase`, then re-run.");
    return { code: 1 };
  }

  // ---- Start the isolated Docker-local Supabase ----------------------------
  // `supabase start` runs QUIET: its stdout/stderr is captured but NEVER
  // surfaced. Arbitrary CLI diagnostics can contain credentials, so on failure
  // only a safe fixed summary plus exit/attempt metadata is logged — the
  // captured output is used strictly internally for port-conflict
  // classification and bounded whole-lane retry.
  log("Starting isolated Docker-local Supabase...");
  const start = await runChild(supabaseBin, supabaseArgs("start", [], iso.workdir), {
    env: sanitizedEnv,
    timeoutMs: START_TIMEOUT_MS,
    captureOutput: true,
    quiet: true,
  });
  if (start.code !== 0) {
    const conflict = isPortConflictOutput(start.output);
    if (conflict && attempt < MAX_LANE_ATTEMPTS) {
      warn(startFailureSummary({ exitCode: start.code, attempt, maxAttempts: MAX_LANE_ATTEMPTS, retryable: true, output: start.output }));
      // The full async teardown (Docker probe → supabase stop → workdir
      // removal) MUST complete before the next attempt may begin — a retry can
      // never start against a still-running previous stack, and the stable
      // lane snapshot keeps the async teardown from dereferencing a global the
      // next attempt will reassign/null.
      await completeRetryableTeardown({
        lane: isolated,
        stop: (lane) => stopSupabase(lane),
        removeWorkdir: (lane) => cleanupIsolatedWorkdir(lane),
        onError: (caught) => warn(`Retryable teardown issue: ${caught.message}`),
      });
      return { retryable: true };
    }
    if (conflict) {
      error(startFailureSummary({ exitCode: start.code, attempt, maxAttempts: MAX_LANE_ATTEMPTS, output: start.output }));
      error("Environment blocker: `supabase start` kept failing on port conflicts after all bounded whole-lane retries.");
    } else {
      error(startFailureSummary({ exitCode: start.code, attempt, maxAttempts: MAX_LANE_ATTEMPTS, output: start.output }));
      error("Environment blocker: `supabase start` failed (Docker images could not be provisioned/started).");
      error("Ensure Docker is running and the Supabase images can be pulled (network access).");
      error("The lane does NOT use a hosted/shared database as a substitute.");
    }
    return { code: start.code };
  }
  log("Isolated Docker-local Supabase is up.");

  // ---- Capture runtime local env ------------------------------------------
  // Bounded retry: a non-zero exit or an incomplete parse is retried (transient
  // CLI/container warm-up); a merged `-o json` fallback completes partial
  // captures. Values are never logged; loopback-only URLs are enforced below.
  log("Capturing runtime env via `supabase status -o env` (bounded retries)...");
  const capture = await captureRuntimeEnv({
    run: (format) =>
      runTrackedSubprocess(supabaseBin, supabaseArgs("status", ["-o", format], iso.workdir), {
        env: sanitizedEnv,
        timeoutMs: STATUS_CAPTURE_TIMEOUT_MS,
      }),
  });
  if (!capture.ok) {
    error("Environment blocker: `supabase status` did not yield the expected runtime variables after bounded retries.");
    error(`Runtime env presence: ${presenceSummary(capture.runtime)}`);
    const diagnostics = [
      capture.envResult?.stderr?.trim(),
      capture.envResult?.stdout?.trim(),
      capture.jsonResult?.stderr?.trim(),
      capture.jsonResult?.stdout?.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    if (diagnostics) error(redactSensitiveOutput(diagnostics, { runtime: capture.runtime }));
    return { code: 1 };
  }
  const runtime = capture.runtime;
  try {
    assertLoopbackRuntime(runtime);
  } catch (caught) {
    error(`Environment blocker: ${caught.message}`);
    error("The lane refuses to run against anything other than a loopback-local Supabase instance.");
    return { code: 1 };
  }
  log(`Runtime env captured (${presenceSummary(runtime)}, source ${capture.source}) — values kept out of the log.`);

  // ---- Reset database to the full migration chain --------------------------
  log("Resetting the isolated database and applying the full migration chain...");
  const reset = await runChild(supabaseBin, supabaseArgs("db", ["reset", "--no-seed"], iso.workdir), {
    env: sanitizedEnv,
    timeoutMs: RESET_TIMEOUT_MS,
    runtime,
  });
  if (reset.code !== 0) {
    error("`supabase db reset` failed; the migration chain did not apply cleanly on the fresh instance.");
    return { code: reset.code };
  }
  log("Migration chain applied.");

  // ---- Wait for the isolated Supabase API ----------------------------------
  log("Waiting for the isolated Supabase API to be healthy...");
  const restHealthy = await waitForHealth(`${runtime.apiUrl}/rest/v1/`, SUPABASE_HEALTH_TIMEOUT_MS);
  const authHealthy = await waitForHealth(`${runtime.apiUrl}/auth/v1/health`, SUPABASE_HEALTH_TIMEOUT_MS);
  if (!restHealthy || !authHealthy) {
    error("The isolated Supabase API did not become healthy in time; refusing to run the suite against a partial stack.");
    return { code: 1 };
  }

  // ---- Apply the test-only pipeline invariant after the migration chain ---
  log("Applying the test-only pipeline stage/flag invariant (after the production-equivalent migration chain)...");
  const apply = await runChild(process.execPath, [APPLY_TEST_ONLY_SQL, TEST_ONLY_INVARIANT_SQL], {
    env: runtimeEnv(sanitizedEnv, runtime),
    timeoutMs: APPLY_TIMEOUT_MS,
    runtime,
  });
  if (apply.code !== 0) {
    error("The test-only pipeline invariant SQL did not apply cleanly on the fresh instance.");
    return { code: apply.code };
  }
  log("Test-only pipeline invariant applied.");

  // ---- Seed fixtures (server-only service role) ----------------------------
  log("Seeding synthetic advisor auth users + OCF fixtures (server-only service role)...");
  // The seed is a MATERIAL subprocess: tracked async lifecycle with a bounded
  // timeout and SIGTERM cleanup, sanitized+runtime env only (never raw
  // inherited `process.env`). It runs QUIET — the `E2E_SEED_JSON` line embeds
  // seeded auth passwords, so nothing streams to the terminal; stdout is
  // captured separately for parsing and the failure path prints redacted
  // output only.
  const seedResult = await runChild(tsxBin, [SEED_FILE], {
    env: runtimeEnv(sanitizedEnv, runtime),
    timeoutMs: SEED_TIMEOUT_MS,
    captureOutput: true,
    quiet: true,
  });
  if (seedResult.code !== 0) {
    error("Seed step failed; redacted output:");
    if (seedResult.stdout) error(redactSensitiveOutput(seedResult.stdout.trim()));
    if (seedResult.stderr) error(redactSensitiveOutput(seedResult.stderr.trim()));
    return { code: seedResult.code };
  }
  const seedMatch = seedResult.stdout.match(/^E2E_SEED_JSON=(\{.*\})$/m);
  if (!seedMatch) {
    error("Seed step completed but did not emit E2E_SEED_JSON; redacted tail of stdout:");
    error(redactSensitiveOutput(seedResult.stdout.trim().slice(-500)));
    return { code: 1 };
  }
  let seed;
  try {
    seed = JSON.parse(seedMatch[1]);
  } catch (caught) {
    error(`Could not parse E2E_SEED_JSON: ${caught.message}`);
    return { code: 1 };
  }
  const seedEnv = {
    E2E_ACTIVE_EMAIL: seed.activeAdvisorEmail,
    E2E_ACTIVE_PASSWORD: seed.activeAdvisorPassword,
    E2E_INACTIVE_EMAIL: seed.inactiveAdvisorEmail,
    E2E_INACTIVE_PASSWORD: seed.inactiveAdvisorPassword,
    E2E_ACTIVE_ADVISOR_NAME: seed.activeAdvisorName,
    E2E_INACTIVE_ADVISOR_NAME: seed.inactiveAdvisorName,
    E2E_STUDENT_NAME: seed.studentName,
    E2E_STUDENT_EMAIL: seed.studentEmail,
    E2E_STUDENT_TWO_NAME: seed.secondStudentName,
    E2E_FELLOWSHIP_NAME: seed.fellowshipName,
    E2E_FELLOWSHIP_TWO_NAME: seed.secondFellowshipName,
    E2E_APPLICATION_YEAR: String(seed.studentApplicationYear),
    E2E_CYCLE_YEAR_OLD: String(seed.cycleYearOld),
    E2E_CYCLE_YEAR_NEW: String(seed.cycleYearNew),
    E2E_REPORT_TOTALS: JSON.stringify(seed.reportTotals),
  };
  if (Object.values(seedEnv).some((value) => value === undefined || value === null || value === "")) {
    error("Seed output is missing one or more required fields.");
    return { code: 1 };
  }
  log(`Seeded active=${seedEnv.E2E_ACTIVE_EMAIL} inactive=${seedEnv.E2E_INACTIVE_EMAIL} student=${seedEnv.E2E_STUDENT_NAME}`);

  // ---- Build the app in an isolated workdir --------------------------------
  // The app is built with a throwaway copy of the source tree as cwd:
  //   - the repository's `.env*` files are NOT copied, so Next.js cannot load
  //     any committed/local project env — the lane's sanitized+runtime env is
  //     the only source;
  //   - `.next`/`tsconfig.tsbuildinfo`/`next-env.d.ts` land inside the
  //     throwaway directory (removed by teardown), never in the repository.
  //
  // The Next server (build AND start) runs from the ISOLATED WORKDIR's own
  // node_modules (`<workdir>/node_modules/next/dist/bin/next`), never the
  // repository's `next` bin. Rationale (A5 prerender-invariant fix): Turbopack
  // bundles the app's `next/headers` from the workdir's recreated node_modules
  // tree, while a server launched from the REPOSITORY's `next` bin would load
  // Next's own internals — including the `workUnitAsyncStorage` singleton the
  // renderer seeds — from the REPOSITORY tree. Those two distinct module
  // instances make `cookies()`/`searchParams`/`params` read the wrong storage
  // during static generation, crashing the prerender with
  // `Invariant: Expected workUnitAsyncStorage to have a store`. Running the
  // workdir's own Next binary makes the server and the app resolve one module
  // tree, preserving the isolated app dir/env/ports and the no-`.env` rule.
  log("Building the Next.js app in the isolated app workdir with the runtime local env...");
  try {
    appDir = prepareIsolatedAppDir({ root: ROOT, label: "e2e-app" });
  } catch (caught) {
    error(`Environment blocker: could not prepare the isolated app workdir: ${caught.message}`);
    return { code: 1 };
  }
  const isolatedNextBin = path.join(appDir.workdir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(isolatedNextBin)) {
    error("Environment blocker: the isolated app workdir does not contain the `next` binary; run `pnpm install` first.");
    return { code: 1 };
  }
  const appEnv = buildAppEnv(runtime);
  // `process.execPath` + the workdir's `dist/bin/next` bypasses the pnpm `.bin`
  // shim (which embeds absolute REPOSITORY `NODE_PATH`s), keeping the build
  // fully self-contained inside the throwaway directory.
  const build = await runChild(process.execPath, [isolatedNextBin, "build"], {
    env: appEnv,
    timeoutMs: BUILD_TIMEOUT_MS,
    runtime,
    cwd: appDir.workdir,
  });
  if (build.code !== 0) {
    error("`next build` failed; the E2E lane cannot run against an unbuildable app.");
    return { code: build.code };
  }

  // ---- Start the app ---------------------------------------------------------
  log(`Starting the Next.js app on ${APP_URL} ...`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  // The server log artifact is written THROUGH the redaction filter, so no
  // captured value can reach the artifact either.
  serverLogStream = createWriteStream(NEXT_LOG, { flags: "w" });
  nextChild = trackChild(
    spawn(
      process.execPath,
      [isolatedNextBin, "start", "-H", APP_HOST, "-p", String(APP_PORT)],
      { cwd: appDir.workdir, env: appEnv, stdio: ["ignore", "pipe", "pipe"] }
    )
  );
  pipeRedacted(nextChild.stdout, serverLogStream, { runtime });
  pipeRedacted(nextChild.stderr, serverLogStream, { runtime });
  nextChild.on("error", (spawnError) => {
    error(`Failed to spawn "next start": ${spawnError.message}`);
  });

  log(`Waiting for the app health endpoint at ${APP_URL}/api/health ...`);
  const deadline = Date.now() + APP_HEALTH_TIMEOUT_MS;
  let appHealthy = false;
  let earlyExitCode = null;
  while (Date.now() < deadline) {
    // Ownership: if OUR server process exited (port taken, boot error), stop
    // waiting and report the early exit rather than misreading the port.
    if (nextChild.exitCode !== null || nextChild.signalCode !== null) {
      earlyExitCode = nextChild.exitCode;
      break;
    }
    const healthy = await fetch(`${APP_URL}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    }).then((res) => res.ok, () => false);
    if (healthy) {
      // Re-assert ownership immediately before declaring health: the responder
      // must still be our child (not a stale process on the probed port).
      if (nextChild.exitCode === null && nextChild.signalCode === null) {
        appHealthy = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!appHealthy) {
    error("The Next.js app did not become healthy in time.");
    if (earlyExitCode !== null) {
      error(`The Next server exited early with code ${earlyExitCode}.`);
    }
    error(`Recent server log (${NEXT_LOG}):`);
    try {
      error(redactSensitiveOutput(readFileSync(NEXT_LOG, "utf8").split("\n").slice(-40).join("\n"), { runtime }));
    } catch {
      /* log file not readable */
    }
    return { code: 1 };
  }
  log("App is healthy.");

  // ---- Run Playwright (Chromium) ---------------------------------------------
  log("Running the Playwright E2E suite (Chromium)...");
  const playwrightEnv = { ...appEnv, APP_URL, ...seedEnv };
  const test = await runChild(playwrightBin, ["test"], {
    env: playwrightEnv,
    timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
    runtime,
  });
  if (test.code !== 0) {
    error(`Playwright E2E suite failed (exit code ${test.code}).`);
  } else {
    log("Playwright E2E suite passed.");
  }
  return { code: test.code };
}

async function main() {
  log("=== OCF E2E lane (local Playwright + Docker-local Supabase) ===");
  log("Checking prerequisites...");

  if (!toolAvailable("docker", ["info"])) {
    error("Environment blocker: the Docker daemon is not available or not running.");
    error("The E2E lane provisions an isolated Docker-local Supabase instance and cannot continue without it.");
    return 1;
  }

  supabaseBin = binPath("supabase");
  if (!supabaseBin) {
    error("Environment blocker: the `supabase` CLI is not usable (`node_modules/.bin/supabase --version` failed).");
    error("Restore it via `pnpm install` / `pnpm rebuild supabase`, then re-run.");
    return 1;
  }

  const tsxBin = binPath("tsx");
  if (!tsxBin || !toolAvailable(tsxBin, ["--version"])) {
    error("Environment blocker: `tsx` is not available; run `pnpm install` first.");
    return 1;
  }

  const nextBin = binPath("next");
  if (!nextBin || !toolAvailable(nextBin, ["--version"])) {
    error("Environment blocker: the `next` CLI is not usable; run `pnpm install` first.");
    return 1;
  }

  const playwrightBin = binPath("playwright");
  if (!playwrightBin || !toolAvailable(playwrightBin, ["--version"])) {
    error("Environment blocker: `@playwright/test` is not installed; run `pnpm install` first.");
    return 1;
  }

  const browser = chromiumAvailability();
  if (!browser.ok) {
    error("Environment blocker: the Playwright Chromium browser is not available.");
    error(browser.reason);
    error("The lane cannot run without it and will not substitute a hosted browser or a hosted database.");
    return 1;
  }
  log(`Chromium: ${browser.path}`);

  const images = runSync("docker", ["images", "--format", "{{.Repository}}"]);
  const hasSupabaseImages =
    images.status === 0 &&
    images.stdout.split(/\r?\n/).some((line) => line.trim().includes("supabase/"));
  if (!hasSupabaseImages) {
    log("No Supabase Docker images found locally; `supabase start` will pull them (first run needs network).");
    log("If the pull fails, the lane reports the exact blocker — it never falls back to a hosted database.");
  }

  // ---- Validate a configured app-port override by probing it ----------------
  // An operator-supplied `E2E_APP_PORT` is used verbatim, but it is PROBED for
  // availability first — an occupied override is a blocker, not a surprise.
  const overrideRaw = process.env.E2E_APP_PORT;
  if (overrideRaw) {
    const overridePort = Number(overrideRaw);
    if (!Number.isInteger(overridePort) || overridePort <= 0 || overridePort > 65_535) {
      error(`Environment blocker: invalid E2E_APP_PORT override "${overrideRaw}".`);
      return 1;
    }
    if (!(await isPortFree(overridePort))) {
      error(`Environment blocker: configured E2E_APP_PORT=${overridePort} is already in use; free the port or change the override.`);
      return 1;
    }
    log(`Using configured E2E_APP_PORT=${overridePort} (verified free).`);
  }

  const sanitizedEnv = sanitizeEnv(process.env);
  sanitizedLaneEnv = sanitizedEnv;

  // Bounded whole-lane retry: a port conflict on `supabase start` tears down
  // the isolated stack and retries with a fresh port allocation; every other
  // failure is reported as the blocker it is.
  for (let attempt = 1; attempt <= MAX_LANE_ATTEMPTS; attempt += 1) {
    const outcome = await runLane(attempt, { supabaseBin, tsxBin, playwrightBin, sanitizedEnv });
    if (outcome.retryable) continue;
    return outcome.code;
  }
  error(`Environment blocker: the lane exhausted ${MAX_LANE_ATTEMPTS} whole-lane retries.`);
  return 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (caught) {
  error("Unexpected runner failure:", caught);
  exitCode = 1;
} finally {
  await terminateAllChildren();
  await teardown();
}
process.exit(exitCode);
