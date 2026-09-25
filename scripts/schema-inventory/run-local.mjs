#!/usr/bin/env node
/**
 * scripts/schema-inventory/run-local.mjs
 *
 * Local schema-inventory capture lane: captures a REDACTED, schema-only
 * inventory from the EXACT Git migration chain in a disposable, loopback-only,
 * Docker-local Supabase lane, writes it to an EXPLICIT output path outside the
 * repository, and tears the lane down completely (no containers, no workdirs).
 *
 * Lifecycle (all against a throwaway Docker-local Supabase instance — never
 * hosted, never the repository's own local project):
 *   1. Pre-flight prerequisites (Docker daemon, supabase CLI, tsx).
 *   2. Materialize an ISOLATED temporary Supabase workdir: a copy of the repo
 *      migrations + a rewritten `config.toml` with a unique `project_id` and
 *      unique free ports (see `scripts/test-support/supabase-isolation.mjs`).
 *   3. `supabase start --workdir <isolated>` — bring the isolated stack up
 *      (first run pulls Docker images). Start output is QUIET: only a fixed
 *      summary (exit code + attempt metadata, never the captured output) is
 *      logged on failure, so the local credentials the CLI prints as a table
 *      are never emitted.
 *   4. `supabase status -o env --workdir <isolated>` — capture the runtime
 *      local env (URLs/keys). Values are never logged; loopback-only URLs are
 *      enforced before anything else runs.
 *   5. `supabase db reset --no-seed --workdir <isolated>` — apply the FULL
 *      migration chain to a fresh database (seed skipped: the inventory is
 *      schema-only).
 *   6. `tsx scripts/schema-inventory/cli.ts capture --db-url <loopback db-url>
 *      --out <output>` — the existing capture CLI writes the REDACTED inventory
 *      packet (its own validation + redaction guarantees) to the
 *      operator-supplied output path. The child runs with the sanitized env;
 *      its stdout/stderr is captured and only redacted text is surfaced on
 *      failure.
 *   7. Teardown in `finally` (also SIGINT/SIGTERM): stop ONLY the isolated
 *      instance and remove its temporary directory; terminate every spawned
 *      child. The repository's normal local Supabase project is never started,
 *      reset, or stopped.
 *
 * Output path contract:
 *   - `--out <path>` is REQUIRED. The runner never writes into the repository;
 *     a path resolving inside the repo root is rejected.
 *
 * Truthfulness policy: if Docker, the supabase CLI, or tsx cannot be
 * provisioned, the lane reports the exact blocker and exits non-zero. It never
 * substitutes a hosted/shared database, and it never reads the project `.env`
 * files.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const CLI_PATH = path.join(ROOT, "scripts", "schema-inventory", "cli.ts");

const START_TIMEOUT_MS = 15 * 60_000; // first run pulls Docker images
const RESET_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_TIMEOUT_MS = 5 * 60_000;
// Bounded timeout for a single `supabase status` capture (transient container
// warm-up is handled by `captureRuntimeEnv`'s bounded retries).
const STATUS_CAPTURE_TIMEOUT_MS = 120_000;
// Hard deadline for the `supabase stop` teardown child (SIGTERM→SIGKILL
// escalation; a hung teardown is reported, never a hang).
const STOP_TIMEOUT_MS = 120_000;
// Bounded timeout for every preflight/availability probe (a hung probe is a
// reported blocker, never an unbounded hang).
const PROBE_TIMEOUT_MS = 15_000;
// SIGTERM grace before SIGKILL escalation when a child hits its timeout.
const TIMEOUT_KILL_GRACE_MS = 3_000;
// Bounded whole-lane retries: a port conflict on `supabase start` tears down
// the isolated stack and retries with a fresh port allocation; anything else
// is reported as the blocker it is.
const MAX_LANE_ATTEMPTS = 3;

const log = (...args) => console.log("[schema-inventory:local]", ...args);
const warn = (...args) => console.warn("[schema-inventory:local]", ...args);
const error = (...args) => console.error("[schema-inventory:local]", ...args);

const USAGE = `Usage:
  node scripts/schema-inventory/run-local.mjs --out <path>

  --out <path>   REQUIRED: write the redacted local inventory packet to this
                 file. The path must resolve OUTSIDE the repository — an output
                 path inside the repo root is rejected (the runner never writes
                 into the repo).`;

/**
 * Parse `--key value` arguments (and `--help`). Exported for unit tests.
 */
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for --${key}`);
      }
      opts[key] = value;
      i += 1;
    }
  }
  return opts;
}

/**
 * Resolve and validate the operator-supplied output path. Requires a non-empty
 * `--out` and rejects any path that resolves inside the repository root, so a
 * default or careless invocation can never write into the repo. Exported for
 * unit tests.
 */
function resolveOutputPath(out) {
  if (typeof out !== "string" || out.trim() === "") {
    throw new Error(
      "run-local requires --out <path> (an explicit output path outside the repository)."
    );
  }
  const resolved = path.resolve(out);
  const relative = path.relative(ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(
      `Refusing to write the inventory into the repository: "${out}" resolves inside ` +
        `the repo root (${ROOT}).`
    );
  }
  return resolved;
}

/**
 * Synchronous child helper with FULL containment: the child env is ALWAYS the
 * sanitized env (never raw inherited `process.env`) and every call runs under
 * a bounded timeout (hard SIGKILL at the deadline).
 */
function runSync(cmd, args, { env, timeout = PROBE_TIMEOUT_MS, cwd = ROOT, ...rest } = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: "pipe",
    cwd,
    env: env ?? sanitizeEnv(process.env),
    timeout,
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
 * set, the raw output is also accumulated for internal classification (e.g.
 * port conflicts) but is still redacted on the way to the terminal; when
 * `quiet` is set nothing is streamed at all (the caller owns failure reporting
 * via a safe fixed summary).
 *
 * Deliberately logs only the command (never the argument vector) on timeout, so
 * a credential-bearing argument can never be echoed.
 */
function runChild(cmd, args, { env, timeoutMs = 0, timeoutKillGraceMs = TIMEOUT_KILL_GRACE_MS, cwd = ROOT, runtime, captureOutput = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = trackChild(
      spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd, env: env ?? sanitizeEnv(process.env) })
    );
    let captured = "";
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => {
        captured += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        captured += chunk.toString();
      });
    }
    if (!quiet) {
      pipeRedacted(child.stdout, process.stdout, { runtime });
      pipeRedacted(child.stderr, process.stderr, { runtime });
    }
    let timer = null;
    let settled = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        error(`"${cmd}" timed out after ${timeoutMs} ms; terminating (SIGTERM, escalating to SIGKILL).`);
        killChildGracefully(child, { graceMs: timeoutKillGraceMs, killSignal: "SIGKILL" });
      }, timeoutMs);
    }
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      untrackChild(child);
      resolve({ code: code ?? 1, output: captured });
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

// ---- Scoped teardown -------------------------------------------------------
// Only the isolated instance is ever stopped; the repository's own local
// Supabase project is never touched.
let isolated = null;
let supabaseBin = null;
// The single sanitized lane environment, computed once in `main()` and reused
// by every child the lane spawns — including teardown, so `supabase stop`
// NEVER inherits the raw parent env.
let sanitizedLaneEnv = null;

/**
 * Stop ONLY the isolated instance's stack (no backup). Operates on the STABLE
 * `lane` reference captured by the caller (default: the current global), so an
 * async teardown can never dereference a global a later attempt reassigned.
 */
async function stopSupabase(lane = isolated) {
  if (!lane) return;
  const probe = await runTrackedSubprocess("docker", ["info"], {
    env: sanitizedLaneEnv ?? sanitizeEnv(process.env),
    timeoutMs: 30_000,
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
  // Teardown containment: the stop child runs with the SANITIZED lane env as a
  // TRACKED ASYNC child with a hard deadline and SIGTERM→SIGKILL escalation; its
  // captured output is already scrubbed by `stopIsolatedSupabase`.
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
  await stopSupabase(lane);
  cleanupIsolatedWorkdir(lane);
}

/**
 * Run one full lane attempt. Returns `{ retryable: true }` when `supabase
 * start` failed because a probed port was already taken (the caller tears the
 * stack down and retries the whole lane with a fresh allocation, bounded), or
 * `{ code }` on any other outcome.
 */
async function runLane(attempt, outputPath) {
  // ---- Materialize the isolated Supabase workdir --------------------------
  log("Preparing isolated temporary Supabase workdir (unique project identity + ports)...");
  let iso;
  try {
    iso = await prepareIsolatedSupabase({ root: ROOT, label: "schema-inventory" });
  } catch (caught) {
    error(`Environment blocker: could not prepare the isolated Supabase workdir: ${caught.message}`);
    return { code: 1 };
  }
  isolated = iso;
  log(`Isolated workdir: ${iso.workdir} (project_id ${iso.projectId}, attempt ${attempt}/${MAX_LANE_ATTEMPTS})`);

  // The CLI version probe runs with the isolated workdir as cwd so its
  // update-check cache lands inside the throwaway workdir, never the
  // repository's `supabase/`.
  if (!toolAvailable(supabaseBin, ["--version"], { cwd: iso.workdir })) {
    error("Environment blocker: the `supabase` CLI is not usable (`node_modules/.bin/supabase --version` failed).");
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
      // next attempt will reassign.
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

  // ---- Capture the redacted local inventory --------------------------------
  // The existing capture CLI validates the loopback DB URL, runs read-only
  // catalog queries, and writes REDACTED output to the operator-supplied path.
  // The child runs with the sanitized env; its stdout/stderr is CAPTURED (never
  // streamed) because the invocation carries the throwaway lane DB URL — only
  // redacted text is surfaced on failure, and the URL itself is never echoed.
  log(`Capturing redacted local inventory via the schema-inventory capture CLI...`);
  const captureCli = await runTrackedSubprocess(
    binPath("tsx"),
    [CLI_PATH, "capture", "--db-url", runtime.dbUrl, "--out", outputPath],
    { env: sanitizedEnv, cwd: ROOT, timeoutMs: CAPTURE_TIMEOUT_MS }
  );
  if (!captureCli || captureCli.status !== 0) {
    error("Schema-inventory capture CLI failed; redacted output:");
    if (captureCli?.stdout) error(redactSensitiveOutput(captureCli.stdout.trim(), { runtime }));
    if (captureCli?.stderr) error(redactSensitiveOutput(captureCli.stderr.trim(), { runtime }));
    return { code: captureCli?.status ?? 1 };
  }
  log(`Redacted local inventory written to ${outputPath}.`);
  return { code: 0 };
}

async function main() {
  log("=== OCF schema-inventory local capture lane ===");

  // ---- Output path contract -------------------------------------------------
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    error(USAGE);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let outputPath;
  try {
    outputPath = resolveOutputPath(opts.out);
    // The capture CLI writes the packet but does not create parent
    // directories; create them at the explicitly supplied output location
    // (never inside the repo — that is rejected above).
    mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    error(USAGE);
    return 1;
  }

  // ---- Pre-flight prerequisites -------------------------------------------
  log("Checking prerequisites...");
  if (!toolAvailable("docker", ["info"])) {
    error("Environment blocker: the Docker daemon is not available or not running.");
    error("The lane provisions an isolated Docker-local Supabase instance and cannot continue without it.");
    return 1;
  }

  supabaseBin = binPath("supabase");
  if (!supabaseBin) {
    error("Environment blocker: the `supabase` CLI is not usable (`node_modules/.bin/supabase --version` failed).");
    error("Restore it via `pnpm install` / `pnpm rebuild supabase`, then re-run.");
    return 1;
  }

  if (!binPath("tsx")) {
    error("Environment blocker: `tsx` is not available; run `pnpm install` first.");
    return 1;
  }

  const images = runSync("docker", ["images", "--format", "{{.Repository}}"]);
  const hasSupabaseImages =
    images.status === 0 &&
    images.stdout.split(/\r?\n/).some((line) => line.trim().includes("supabase/"));
  if (!hasSupabaseImages) {
    log("No Supabase Docker images found locally; `supabase start` will pull them (first run needs network).");
    log("If the pull fails, the lane reports the exact blocker — it never falls back to a hosted database.");
  }

  sanitizedLaneEnv = sanitizeEnv(process.env);

  // Bounded whole-lane retry: a port conflict on `supabase start` tears down
  // the isolated stack and retries with a fresh port allocation; every other
  // failure is reported as the blocker it is.
  for (let attempt = 1; attempt <= MAX_LANE_ATTEMPTS; attempt += 1) {
    const outcome = await runLane(attempt, outputPath);
    if (outcome.retryable) continue;
    return outcome.code;
  }
  error(`Environment blocker: the lane exhausted ${MAX_LANE_ATTEMPTS} whole-lane retries.`);
  return 1;
}

// Only run when executed directly (not when imported by unit tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

let exitCode = 1;
if (isDirectRun) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      error(`\nReceived ${signal}; terminating spawned children, then running teardown before exit.`);
      terminateAllChildren({ graceMs: TIMEOUT_KILL_GRACE_MS }).finally(async () => {
        try {
          await teardownIsolated();
        } finally {
          process.exit(130);
        }
      });
    });
  }
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
}

export { main, parseArgs, resolveOutputPath };