#!/usr/bin/env node
/**
 * scripts/contract/run.mjs
 *
 * Isolated database contract-test lane for the OCF data platform.
 *
 * Lifecycle (all against a throwaway Docker-local Supabase instance — never
 * hosted, never the repository's own local project):
 *   1. Pre-flight prerequisites (pnpm, Docker daemon, supabase CLI).
 *   2. Materialize an ISOLATED temporary Supabase workdir: a copy of the repo
 *      migrations + a rewritten `config.toml` with a unique `project_id` and
 *      unique free ports (see `scripts/test-support/supabase-isolation.mjs`).
 *   3. `supabase start --workdir <isolated>`            – bring the isolated
 *                                                         stack up (first run
 *                                                         pulls Docker images).
 *                                                         Start output is
 *                                                         suppressed: only a
 *                                                         lifecycle summary is
 *                                                         logged on success and
 *                                                         a safe FIXED summary
 *                                                         (exit code + attempt
 *                                                         metadata, never the
 *                                                         captured output) on
 *                                                         failure, so the local
 *                                                         credentials the CLI
 *                                                         prints as a table
 *                                                         (Publishable/Secret/
 *                                                         Access Key/Secret
 *                                                         Key rows) are never
 *                                                         emitted.
 *   4. `supabase status -o env --workdir <isolated>`    – capture the runtime
 *                                                         local env (URL, anon
 *                                                         key, service-role
 *                                                         key, Postgres URL).
 *                                                         The output is parsed
 *                                                         robustly (bare
 *                                                         API_URL/ANON_KEY/
 *                                                         SERVICE_ROLE_KEY/
 *                                                         DB_URL + aliases);
 *                                                         values are never
 *                                                         logged. Loopback-only
 *                                                         URLs are enforced.
 *   5. `supabase db reset --no-seed --workdir <isolated>` – apply the FULL
 *                                                         migration chain to a
 *                                                         fresh database, then
 *                                                         apply the TEST-ONLY
 *                                                         pipeline stage/flag
 *                                                         invariant SQL from
 *                                                         `scripts/test-support/`
 *                                                         (outside
 *                                                         `supabase/migrations/`,
 *                                                         never a deployable
 *                                                         migration). The seed
 *                                                         step is skipped: the
 *                                                         contract lane creates
 *                                                         its own synthetic
 *                                                         fixtures.
 *   6. `pnpm exec vitest run --config vitest.contract.config.ts` with the
 *      captured env exported through a sanitized child environment.
 *   7. Teardown in a `finally` block (also on SIGINT/SIGTERM): stop ONLY the
 *      isolated instance and remove its temporary directory. The repository's
 *      normal local Supabase project is never started, reset, or stopped.
 *
 * Truthfulness policy: if pnpm, Docker, the CLI, or the Supabase Docker
 * images cannot be provisioned, the lane reports the environment blocker and
 * exits non-zero. It NEVER substitutes a hosted/shared database, and it never
 * reads the project `.env` files.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertLoopbackRuntime,
  captureRuntimeEnv,
  completeRetryableTeardown,
  isPortConflictOutput,
  killChildGracefully,
  pipeRedacted,
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
const VITEST_CONFIG = path.join(ROOT, "vitest.contract.config.ts");
// TEST-ONLY pipeline stage/flag invariant SQL, applied AFTER the
// production-equivalent migration chain. Deliberately outside
// `supabase/migrations/`: never part of a deployable migration path (oracle P1
// fix), applied through the dedicated `apply-test-only-sql.mjs` runner.
const TEST_ONLY_INVARIANT_SQL = path.join(ROOT, "scripts", "test-support", "invariant-application-stage-flag.sql");
const APPLY_TEST_ONLY_SQL = path.join(ROOT, "scripts", "test-support", "apply-test-only-sql.mjs");
const APPLY_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 15 * 60_000; // first run pulls Docker images
const RESET_TIMEOUT_MS = 10 * 60_000;
const VITEST_TIMEOUT_MS = 20 * 60_000;
const HEALTH_TIMEOUT_MS = 30_000;
// Bounded timeout for every preflight/availability probe (a hung probe is a
// reported blocker, never an unbounded hang).
const PROBE_TIMEOUT_MS = 15_000;
// SIGTERM grace before SIGKILL escalation when a child hits its timeout.
const TIMEOUT_KILL_GRACE_MS = 3_000;
// Bounded timeout for a single `supabase status` capture (transient container
// warm-up is handled by `captureRuntimeEnv`'s bounded retries).
const STATUS_CAPTURE_TIMEOUT_MS = 120_000;
// Hard deadline for the `supabase stop` teardown child (SIGTERM→SIGKILL
// escalation; a hung teardown is reported, never a hang).
const STOP_TIMEOUT_MS = 120_000;

const log = (...args) => console.log("[contract]", ...args);
const warn = (...args) => console.warn("[contract]", ...args);
const error = (...args) => console.error("[contract]", ...args);

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
 * failure reporting via a safe fixed summary (never the captured output), so a
 * successful `supabase start` never prints credential-bearing CLI tables.
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
    // Every captured child stream passes through the redaction filter before it
    // reaches the terminal, so a stray key/token in CLI output can never leak
    // into the log. `supabase start` runs QUIET (see `runLane`): its raw output
    // is captured for internal port-conflict classification only and is NEVER
    // surfaced — failures log a safe fixed summary plus exit/attempt metadata.
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

/** Poll the local API until PostgREST and GoTrue answer, or timeout. */
async function waitForHealth(apiUrl, timeoutMs) {
  const base = apiUrl.replace(/\/+$/, "");
  const probe = (url) =>
    fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      () => true,
      () => false
    );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rest, auth] = await Promise.all([
      probe(`${base}/rest/v1/`),
      probe(`${base}/auth/v1/health`),
    ]);
    if (rest && auth) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// ---- Scoped teardown -------------------------------------------------------
// Only the isolated instance is ever stopped; the repository's own local
// Supabase project is never touched.
let isolated = null;
// The single sanitized lane environment, computed once in `main()` and reused
// by every child the lane spawns — including teardown, so `supabase stop`
// NEVER inherits the raw parent env.
let sanitizedLaneEnv = null;

/**
 * Stop ONLY the isolated instance's stack (no backup). Operates on the STABLE
 * `lane` reference captured by the caller (default: the current global), so an
 * async teardown can never dereference a global a later attempt reassigned.
 */
async function stopIsolatedStack(lane = isolated) {
  if (!lane) return;
  const supabaseBin = path.join(ROOT, "node_modules", ".bin", "supabase");
  if (!existsSync(supabaseBin)) {
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

/** Full isolated-lane teardown: stop the stack, then remove the workdir. */
async function teardownIsolated(lane = isolated) {
  if (!lane) return;
  await stopIsolatedStack(lane);
  cleanupIsolatedWorkdir(lane);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    error(`\nReceived ${signal}; terminating spawned children, then running teardown before exit.`);
    terminateAllChildren({ graceMs: 3_000 }).finally(async () => {
      try {
        await teardownIsolated();
      } finally {
        process.exit(130);
      }
    });
  });
}

/** Bounded whole-lane retries: a port conflict on `supabase start` gets a
 * fresh isolated stack (fresh probed ports); anything else is a blocker. */
const MAX_LANE_ATTEMPTS = 3;

async function runLane(attempt) {
  // ---- Materialize the isolated Supabase workdir --------------------------
  log("Preparing isolated temporary Supabase workdir (unique project identity + ports)...");
  let iso;
  try {
    iso = await prepareIsolatedSupabase({ root: ROOT, label: "contract" });
  } catch (caught) {
    error(`Environment blocker: could not prepare the isolated Supabase workdir: ${caught.message}`);
    return { code: 1 };
  }
  isolated = iso;
  log(`Isolated workdir: ${iso.workdir} (project_id ${iso.projectId}, attempt ${attempt}/${MAX_LANE_ATTEMPTS})`);

  // The CLI version probe runs with the isolated workdir as cwd so its
  // update-check cache lands inside the throwaway workdir, never the
  // repository's `supabase/`.
  const supabaseBin = path.join(ROOT, "node_modules", ".bin", "supabase");
  if (!existsSync(supabaseBin) || !toolAvailable(supabaseBin, ["--version"], { cwd: iso.workdir })) {
    error("Environment blocker: the `supabase` CLI is not usable (`pnpm exec supabase --version` failed).");
    error("Restore it via `pnpm install` / `pnpm rebuild supabase`, then re-run.");
    return { code: 1 };
  }

  const sanitizedEnv = sanitizedLaneEnv ?? sanitizeEnv(process.env);

  // ---- Start the isolated Docker-local Supabase ---------------------------
  // `supabase start` runs QUIET: its stdout/stderr is captured but NEVER
  // surfaced. Arbitrary CLI diagnostics can contain credentials, so on failure
  // only a safe fixed summary plus exit/attempt metadata is logged — the
  // captured output is used strictly internally for port-conflict
  // classification and bounded whole-lane retry.
  log("Starting isolated Docker-local Supabase...");
  const start = await runChild(
    "pnpm",
    ["exec", "supabase", ...supabaseArgs("start", [], iso.workdir)],
    { env: sanitizedEnv, timeoutMs: START_TIMEOUT_MS, captureOutput: true, quiet: true }
  );
  if (start.code !== 0) {
    const conflict = isPortConflictOutput(start.output);
    if (conflict && attempt < MAX_LANE_ATTEMPTS) {
      warn(startFailureSummary({ exitCode: start.code, attempt, maxAttempts: MAX_LANE_ATTEMPTS, retryable: true, output: start.output }));
      // The full async teardown (stop + workdir removal) MUST complete before
      // the next attempt may begin — a retry can never start against a still
      // running previous stack, and the stable lane snapshot keeps the async
      // teardown from dereferencing a global the next attempt will reassign.
      await completeRetryableTeardown({
        lane: isolated,
        stop: (lane) => stopIsolatedStack(lane),
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
      runTrackedSubprocess(
        "pnpm",
        ["exec", "supabase", ...supabaseArgs("status", ["-o", format], iso.workdir)],
        { env: sanitizedEnv, timeoutMs: STATUS_CAPTURE_TIMEOUT_MS }
      ),
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
  const reset = await runChild(
    "pnpm",
    ["exec", "supabase", ...supabaseArgs("db", ["reset", "--no-seed"], iso.workdir)],
    { env: sanitizedEnv, timeoutMs: RESET_TIMEOUT_MS, runtime }
  );
  if (reset.code !== 0) {
    error("`supabase db reset` failed; the migration chain did not apply cleanly on the fresh instance.");
    return { code: reset.code };
  }
  log("Migration chain applied.");

  // ---- Health check ------------------------------------------------------
  log("Waiting for the isolated API to be healthy...");
  const healthy = await waitForHealth(runtime.apiUrl, HEALTH_TIMEOUT_MS);
  if (!healthy) {
    error("The isolated Supabase API did not become healthy in time; refusing to run the suite against a possibly partial stack.");
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

  // ---- Run the contract Vitest suite -------------------------------------
  if (!toolAvailable("pnpm", ["exec", "vitest", "--version"])) {
    error("Environment blocker: `vitest` is not available via pnpm; run `pnpm install` first.");
    return { code: 1 };
  }
  if (!existsSync(VITEST_CONFIG)) {
    error(`Environment blocker: expected Vitest config not found: ${VITEST_CONFIG}`);
    return { code: 1 };
  }

  log("Running contract Vitest suite (schema, constraints, RLS)...");
  // Canonical names (API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL) are authoritative
  // with SUPABASE_* aliases also set, so every consumer resolves identically.
  const testEnv = runtimeEnv(sanitizedEnv, runtime);
  testEnv.SUPABASE_CONTRACT_LOCAL = "1";
  const test = await runChild("pnpm", ["exec", "vitest", "run", "--config", VITEST_CONFIG], {
    env: testEnv,
    timeoutMs: VITEST_TIMEOUT_MS,
    runtime,
  });
  if (test.code !== 0) {
    error(`Contract suite failed (exit code ${test.code}).`);
  } else {
    log("Contract suite passed.");
  }
  return { code: test.code };
}

async function main() {
  // ---- Pre-flight prerequisites -----------------------------------------
  log("Checking prerequisites...");

  if (!toolAvailable("pnpm")) {
    error("Environment blocker: pnpm is not installed or not on PATH.");
    error("The contract lane runs through the repository's pnpm contract (`pnpm run test:contract`).");
    error("Provision pnpm (e.g. `corepack enable pnpm` or `npm i -g pnpm@latest`) and re-run.");
    error("The lane will not fall back to npm/bun or to a hosted database.");
    return 1;
  }

  if (!toolAvailable("docker", ["info"])) {
    error("Environment blocker: the Docker daemon is not available or not running.");
    error("The contract lane provisions an isolated Docker-local Supabase instance and cannot continue.");
    return 1;
  }

  const images = runSync("docker", ["images", "--format", "{{.Repository}}"]);
  const hasSupabaseImages =
    images.status === 0 &&
    images.stdout.split(/\r?\n/).some((line) => line.trim().includes("supabase/"));
  if (!hasSupabaseImages) {
    log("No Supabase Docker images found locally; `supabase start` will pull them (first run, needs network).");
    log("If the pull fails, the lane reports the environment blocker — it never falls back to a hosted database.");
  }

  // Bounded whole-lane retry: port conflicts on `supabase start` tear down the
  // isolated stack and retry with a fresh port allocation; every other failure
  // is reported as the blocker it is.
  sanitizedLaneEnv = sanitizeEnv(process.env);
  for (let attempt = 1; attempt <= MAX_LANE_ATTEMPTS; attempt += 1) {
    const outcome = await runLane(attempt);
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
  await teardownIsolated();
}
process.exit(exitCode);