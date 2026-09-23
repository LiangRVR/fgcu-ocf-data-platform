#!/usr/bin/env node
/**
 * scripts/test-support/supabase-isolation.mjs
 *
 * Shared helpers used by the contract (`scripts/contract/run.mjs`) and E2E
 * (`scripts/e2e/run.mjs`) runners to run every test invocation against a
 * fully isolated, throwaway Docker-local Supabase instance.
 *
 * Isolation guarantees:
 *   - Each invocation gets a brand-new temporary project directory
 *     (`<tmp>/ocf-<label>-*`) holding a *copy* of the repository's
 *     `supabase/migrations` and a *rewritten* copy of `supabase/config.toml`
 *     with a unique `project_id` (unique Docker container/network identity) and
 *     unique free host ports. The repository's own `supabase/` project is never
 *     started, reset, or stopped.
 *   - The CLI is always invoked with `--workdir <isolated workdir>`, so every
 *     `start` / `status` / `db reset` / `stop` is scoped to the isolated
 *     instance.
 *
 * Secrets handling:
 *   - `parseSupabaseStatus` maps the actual CLI `status` output to the runtime
 *     values used by the test suites (`API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/
 *     `DB_URL` and their `SUPABASE_*` aliases) WITHOUT ever printing a value.
 *   - `captureRuntimeEnv` captures `status -o env` with bounded retries
 *     (transient CLI/container warm-up) and a merged `-o json` fallback, so a
 *     partial or failing capture is retried before the lane declares an
 *     environment blocker.
 *   - `runtimeEnv` injects the captured values into a child environment under
 *     the canonical names (`API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/`DB_URL`) as
 *     authoritative, with `SUPABASE_*` aliases set for consumers that read
 *     those — all consumers resolve identically.
 *   - `sanitizeEnv` strips hosted credentials from any child process env.
 *   - `runProbe` runs a bounded preflight/availability probe with FULL
 *     containment (sanitized child env, piped stdio, bounded timeout), so no
 *     preflight subprocess ever inherits raw `process.env` or hangs.
 *   - `redactSensitiveOutput`/`pipeRedacted`/`createRedactTransform` scrub
 *     captured command output (keys, tokens, URL credentials, JWT-shaped
 *     values, CLI table rows — `Publishable`/`Secret`/`Access Key`/
 *     `Secret Key` and labelled `Label: value` secret lines — their wrapped
 *     continuation cells in both bordered and compact unbordered tables, bare
 *     `sb_publishable_*`/`sb_secret_*` and AWS/S3-style tokens, and long
 *     key-shaped token runs) before it is printed or written to an artifact —
 *     including BEFORE the runtime is captured. `createRedactTransform`
 *     carries the labelled-secret continuation state ACROSS chunk boundaries,
 *     so a wrapped continuation cell arriving in a later chunk is masked too.
 *   - `assertLoopbackRuntime` refuses to run against anything that is not a
 *     loopback URL, so hosted/shared databases are impossible by construction.
 *   - `startFailureSummary` is the ONLY surfacing path for a failed/retried
 *     `supabase start`: a fixed summary plus exit/attempt metadata. The
 *     captured CLI output stays strictly internal (port-conflict
 *     classification and bounded retry) and is never printed — fail-closed,
 *     because arbitrary CLI diagnostics can contain credentials.
 *
 * Ports and processes:
 *   - `findFreePorts`/`isPortFree` probe loopback ports (the latter for
 *     operator-configured overrides); `isPortConflictOutput` classifies a
 *     failed `supabase start` so lanes can retry the whole run bounded.
 *   - `prepareIsolatedAppDir` gives the E2E lane a throwaway Next.js build/start
 *     directory with NO `.env*` files and no repository `.next` artifacts.
 *   - `trackChild`/`terminateAllChildren` form a spawned-child registry so every
 *     lane child is terminated on SIGINT/SIGTERM and during teardown.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

function listenOnce(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Reserve `count` distinct free TCP ports on the loopback interface.
 *
 * Each port is probed for bind-availability (an actual listen test) and the
 * whole reservation is retried with a fresh probe on transient bind conflicts,
 * up to `maxAttempts` (bounded — a persistently unusable interface is an
 * environment blocker, not an infinite loop).
 */
export async function findFreePorts(count, { host = "127.0.0.1", maxAttempts = 50 } = {}) {
  const ports = new Set();
  let attempts = 0;
  while (ports.size < count) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `Could not find ${count} free port(s) on ${host} after ${maxAttempts} attempts.`
      );
    }
    attempts += 1;
    try {
      ports.add(await listenOnce(host));
    } catch {
      /* transient bind failure; retry (bounded) */
    }
  }
  return [...ports];
}

/**
 * Probe whether a SPECIFIC configured port is currently free on the loopback
 * interface. Used to validate operator-supplied overrides (e.g.
 * `E2E_APP_PORT`) instead of assuming an unprobed override is usable.
 */
export function isPortFree(port, { host = "127.0.0.1" } = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * True when captured command output indicates a port conflict rather than any
 * other failure mode. The lane uses this to decide whether to retry the whole
 * lane with a fresh port allocation (bounded) or to report an environment
 * blocker immediately.
 */
const PORT_CONFLICT_RE = /(?:already in use|address already in use|EADDRINUSE|already allocated)/i;

export function isPortConflictOutput(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return PORT_CONFLICT_RE.test(text);
}

/**
 * Build the ONLY diagnostic text emitted when `supabase start` fails (or is
 * retried): a fixed summary plus exit/attempt metadata. The captured
 * stdout/stderr is NEVER surfaced — arbitrary CLI diagnostics can contain
 * credentials, so it stays strictly internal for port-conflict classification
 * and bounded whole-lane retry. `output` is accepted (and deliberately
 * dropped) so the fail-closed contract is explicit at every call site and
 * provably testable: nothing the CLI wrote can reach a log or artifact.
 */
export function startFailureSummary({ exitCode, attempt, maxAttempts, retryable = false, output }) {
  // Fail-closed: the captured process output must never be emitted. It is
  // referenced solely so the contract is enforced at the call site (the
  // runner passes the captured result) and is excluded from the return value
  // by construction.
  void output;
  const meta = `attempt ${attempt}/${maxAttempts}, exit code ${exitCode}`;
  if (retryable) {
    return `\`supabase start\` failed on ${meta}; retrying the whole lane with a fresh port allocation.`;
  }
  return `\`supabase start\` failed on ${meta}.`;
}

// ---------------------------------------------------------------------------
// Isolated project preparation
// ---------------------------------------------------------------------------

/**
 * Rewrite a copied `config.toml` for full isolation:
 *   - unique `project_id` (drives Docker container/network names);
 *   - unique host ports for every service that binds one;
 *   - seeding disabled (the lanes create their own fixtures; `seed.sql` is
 *     intentionally absent from the repository).
 *
 * The rewrite is line/section aware so `port =` under `[api]` cannot clobber
 * the `port =` under `[db]`, etc.
 */
export function rewriteIsolatedConfig(configText, { projectId, ports }) {
  const portBySection = {
    api: ports.api,
    db: ports.db,
    studio: ports.studio,
    inbucket: ports.inbucket,
    analytics: ports.analytics,
    "db.pooler": ports.pooler,
  };
  let section = "";
  const lines = configText.split("\n").map((line) => {
    const header = line.match(/^\s*\[([a-zA-Z0-9_.]+)\]\s*$/);
    if (header) section = header[1];

    if (/^\s*project_id\s*=/.test(line)) {
      return `project_id = "${projectId}"`;
    }
    if (/^\s*shadow_port\s*=/.test(line) && section === "db") {
      return `shadow_port = ${ports.shadow}`;
    }
    if (/^\s*inspector_port\s*=/.test(line) && section === "edge_runtime") {
      return `inspector_port = ${ports.edgeInspector}`;
    }
    if (/^\s*port\s*=\s*\d+\s*$/.test(line)) {
      const next = portBySection[section];
      if (next !== undefined) return line.replace(/\d+/, String(next));
    }
    if (/^\s*enabled\s*=/.test(line) && section === "db.seed") {
      return "enabled = false";
    }
    return line;
  });
  return lines.join("\n");
}

/**
 * Materialize a throwaway Supabase project directory.
 *
 * Layout (as the CLI expects): `<workdir>/supabase/config.toml` +
 * `<workdir>/supabase/migrations`. The repository project is only read
 * (config/migrations copied); it is never written or started.
 *
 * `extraPorts` reserves additional probed loopback ports from the same
 * per-run allocation (e.g. the E2E lane's Next app server port, surfaced as
 * `ports.next`) so no lane process ever binds a fixed or assumed-free port.
 *
 * Returns `{ workdir, supabaseDir, projectId, ports, cleanup }`.
 */
export async function prepareIsolatedSupabase({ root, label = "test", extraPorts = 0 }) {
  const srcDir = path.join(root, "supabase");
  const srcConfig = path.join(srcDir, "config.toml");
  const srcMigrations = path.join(srcDir, "migrations");
  if (!existsSync(srcConfig)) {
    throw new Error(`Expected Supabase config at ${srcConfig}`);
  }
  if (!existsSync(srcMigrations)) {
    throw new Error(`Expected Supabase migrations directory at ${srcMigrations}`);
  }

  const projectId = `ocf-${label}-${randomBytes(4).toString("hex")}`;
  const workdir = mkdtempSync(path.join(os.tmpdir(), `ocf-${label}-`));
  const supabaseDir = path.join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  cpSync(srcMigrations, path.join(supabaseDir, "migrations"), { recursive: true });

  const freePorts = await findFreePorts(8 + extraPorts);
  const [api, db, shadow, pooler, studio, inbucket, analytics, edgeInspector, ...extra] = freePorts;
  const ports = { api, db, shadow, pooler, studio, inbucket, analytics, edgeInspector };
  if (extraPorts > 0) {
    ports.next = extra[0];
  }

  const rewritten = rewriteIsolatedConfig(readFileSync(srcConfig, "utf8"), {
    projectId,
    ports,
  });
  writeFileSync(path.join(supabaseDir, "config.toml"), rewritten);
  // Keep the referenced seed file present even though seeding is disabled,
  // so no CLI version can choke on the absent path.
  writeFileSync(path.join(supabaseDir, "seed.sql"), "");

  return {
    workdir,
    supabaseDir,
    projectId,
    ports,
    cleanup() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/**
 * Build the CLI argument vector for a subcommand scoped to the isolated
 * workdir. `--workdir` is placed immediately after the subcommand, which the
 * CLI's global-flag parsing accepts (`start`, `status`, `db reset`, `stop`).
 */
export function supabaseArgs(subcommand, args = [], workdir) {
  return [subcommand, "--workdir", workdir, ...args];
}

/**
 * Run a teardown auxiliary subprocess (e.g. a `docker info` availability
 * probe or any other teardown helper) with FULL containment:
 *   - the child environment is ALWAYS the sanitized child env (or
 *     `sanitizeEnv(process.env)` when no `env` is supplied), so hostile
 *     inherited credentials can never reach the teardown process;
 *   - stdout/stderr are CAPTURED (never inherited raw to the terminal);
 *   - the returned output is scrubbed through `redactSensitiveOutput`, so the
 *     caller can print it or write it to an artifact without ever emitting a
 *     raw value.
 *
 * Additional `spawnSync` options (e.g. `cwd`, `timeout`) pass through, but the
 * text `encoding`, pipe-only `stdio`, and the sanitized `env` are always
 * applied last — containment cannot be bypassed by the caller.
 *
 * Returns `{ status, output, error }`:
 *   - `status` is the exit code, or `null` when the command could not be
 *     spawned (`error` then carries the spawn error);
 *   - `output` is the already-redacted captured stdout+stderr (empty when the
 *     command produced nothing);
 *   - `error` is the spawn error (if any), otherwise `null`.
 */
export function runTeardownSubprocess(cmd, args, { env, runtime, ...spawnOptions } = {}) {
  const result = spawnSync(cmd, args, {
    ...spawnOptions,
    encoding: "utf8",
    stdio: "pipe",
    env: sanitizeEnv(env ?? process.env),
  });
  const output = redactSensitiveOutput(
    [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim(),
    { runtime }
  );
  return { status: result.status, output, error: result.error ?? null };
}

/**
 * Run a MATERIAL subprocess (e.g. `supabase status`, the teardown Docker
 * availability probe, `supabase stop`) as a TRACKED ASYNCHRONOUS child with a
 * HARD BOUNDED DEADLINE and SIGTERM→SIGKILL escalation:
 *   - the child is registered via `trackChild`, so a process-level
 *     SIGINT/SIGTERM (and the lane `finally` teardown) terminates it through
 *     `terminateAllChildren` — a synchronous `spawnSync` child would block the
 *     event loop and be invisible to signal handling;
 *   - a hard deadline (`timeoutMs`) fires SIGTERM and, after `killGraceMs`
 *     without exit, escalates to SIGKILL — the child cannot hang the lane even
 *     if it ignores SIGTERM;
 *   - the child env is ALWAYS the sanitized env (never raw `process.env`);
 *   - stdout/stderr are piped and captured separately (never inherited raw);
 *   - the child auto-unregisters from the registry on `close`/`error`.
 *
 * Returns `{ status, signal, stdout, stderr, output, timedOut, error }`:
 *   - `status` is the exit code, `null` when killed by a signal / the deadline
 *     / a spawn failure;
 *   - `timedOut` is true when the hard deadline was reached and the child had
 *     to be terminated;
 *   - `output` is the RAW combined stdout+stderr — the caller is responsible
 *     for redacting (`redactSensitiveOutput`) anything it surfaces.
 */
export function runTrackedSubprocess(
  cmd,
  args = [],
  { env, cwd, timeoutMs = 120_000, killGraceMs = 3_000 } = {}
) {
  return new Promise((resolve) => {
    const child = trackChild(
      spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeEnv(env ?? process.env),
      })
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killChildGracefully(child, { graceMs: killGraceMs, killSignal: "SIGKILL" });
    }, timeoutMs);
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackChild(child);
      resolve({
        status: timedOut ? null : child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
        timedOut,
        error: null,
      });
    };
    child.on("close", () => settle());
    child.on("error", (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackChild(child);
      resolve({ status: null, signal: null, stdout, stderr, output: `${stdout}${stderr}`, timedOut, error: spawnError });
    });
  });
}

/**
 * Stop the isolated instance (no backup) with full teardown containment as a
 * TRACKED ASYNCHRONOUS child (see `runTrackedSubprocess`):
 *   - the child is registered in the process registry, so a process-level
 *     SIGINT/SIGTERM (and the lane `finally` teardown) terminates it — a hung
 *     `supabase stop` cannot block signal handling;
 *   - a hard deadline (`timeoutMs`, default 120s) fires SIGTERM and escalates
 *     to SIGKILL after `killGraceMs` — a hung or SIGTERM-ignoring teardown is
 *     never left hanging;
 *   - the child environment is ALWAYS the sanitized lane environment (or
 *     `sanitizeEnv(process.env)` when no `env` is supplied), so hostile
 *     inherited credentials can never reach the teardown process;
 *   - stdout/stderr are CAPTURED (never inherited raw to the terminal) and
 *     scrubbed through `redactSensitiveOutput` before they can be printed or
 *     written to any artifact.
 *
 * Returns `{ status, output, timedOut }` where `output` is the already-redacted
 * captured output (empty when the command produced nothing).
 */
export async function stopIsolatedSupabase(supabaseBin, workdir, { env, runtime, timeoutMs = 120_000, killGraceMs = 3_000 } = {}) {
  const result = await runTrackedSubprocess(
    supabaseBin,
    supabaseArgs("stop", ["--no-backup"], workdir),
    { env, runtime, timeoutMs, killGraceMs }
  );
  return {
    status: result.status ?? 1,
    output: redactSensitiveOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
      { runtime }
    ),
    timedOut: result.timedOut,
  };
}

/**
 * Complete a RETRYABLE-ATTEMPT teardown to FULL completion before the next
 * lane attempt may begin (retryable-path race fix).
 *
 * The lanes' whole-lane retry (`supabase start` port conflict) must tear down
 * the previous stack AND remove its workdir BEFORE the next attempt starts,
 * and every async step must operate on the STABLE lane snapshot captured at
 * call time — an async teardown must never dereference a global that a later
 * attempt already reassigned/null-ed.
 *
 * `lane` is that stable snapshot. `stop(lane)` is awaited fully (for E2E this
 * includes the tracked Docker availability probe followed by `supabase stop`);
 * only after it resolves is `removeWorkdir(lane)` run; only then does the
 * returned promise resolve, so the caller can clear its own lane state and
 * return `{ retryable: true }` with certainty that no stack or workdir from
 * the previous attempt is still alive when the next attempt starts.
 *
 * Never rejects: a failing `stop` is routed to `onError` and the workdir
 * removal still runs, so a retry is never blocked on teardown failure.
 */
export async function completeRetryableTeardown({ lane, stop, removeWorkdir, onError } = {}) {
  if (!lane) return;
  if (stop) {
    try {
      await stop(lane);
    } catch (caught) {
      onError?.(caught);
    }
  }
  if (removeWorkdir) {
    try {
      removeWorkdir(lane);
    } catch (caught) {
      onError?.(caught);
    }
  }
}

// ---------------------------------------------------------------------------
// Isolated app (Next.js) build/start directory
// ---------------------------------------------------------------------------

/**
 * Top-level entries never copied into the isolated app workdir:
 *   - `node_modules` is re-created separately as a real directory tree
 *     (hardlinked files + recreated pnpm symlinks) so the copy is
 *     self-contained without duplicating ~1.6 GB;
 *   - `supabase` keeps the repository project (and any embedded secrets) out;
 *   - VCS/CI/docs/agent metadata is irrelevant to a build;
 *   - generated artifacts (`.next`, `tsconfig.tsbuildinfo`, `next-env.d.ts`)
 *     are regenerated inside the workdir and removed by `cleanup()`.
 */
const APP_DIR_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".next",
  "supabase",
  "test-results",
  "playwright-report",
  "aidlc-docs",
  "docs",
  "plan",
  ".codegraph",
  ".agents",
  ".claude",
  ".github",
  ".vercel",
  "scripts",
  "tests",
  "tsconfig.tsbuildinfo",
  "next-env.d.ts",
]);

/** True for any project env file (`.env`, `.env.local`, `.env.production`, ...). */
function isEnvFileName(name) {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Materialize a throwaway app build/start directory for the E2E lane.
 *
 * The whole repository tree (minus the exclude list) is copied, and
 * `node_modules` is re-created as a REAL directory tree (files hardlinked, pnpm
 * symlinks recreated relative) rather than a symlink to the repository's —
 * Next.js 16's Turbopack resolver rejects a `node_modules` symlink that points
 * out of the project root, so the isolated copy must be self-contained.
 * Hardlinks avoid duplicating ~1.6 GB on disk; builds only read node_modules.
 *
 * Running `next build` / `next start` with this directory as cwd guarantees:
 *   - NO repository `.env*` file is present, so Next.js cannot load any
 *     committed/local project env (the lane's sanitized+runtime env is the only
 *     source);
 *   - build artifacts (`.next`, `tsconfig.tsbuildinfo`, `next-env.d.ts`) land
 *     inside the throwaway directory and are removed by `cleanup()` — the
 *     repository's `.next` is never touched.
 *
 * Returns `{ workdir, cleanup }`.
 */
export function prepareIsolatedAppDir({ root, label = "e2e-app" }) {
  const nodeModules = path.join(root, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(`Expected node_modules at ${nodeModules}; run pnpm install first.`);
  }
  const workdir = mkdtempSync(path.join(os.tmpdir(), `ocf-${label}-`));
  cpSync(root, workdir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      if (src === root) return true;
      const topLevel = path.relative(root, src).split(path.sep)[0];
      if (APP_DIR_EXCLUDES.has(topLevel)) return false;
      if (isEnvFileName(path.basename(src))) return false;
      return true;
    },
  });
  copyNodeModulesTree(nodeModules, path.join(workdir, "node_modules"));
  return {
    workdir,
    cleanup() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/**
 * Re-create a node_modules tree inside the isolated workdir:
 *   - directories are created for real (never symlinked — Turbopack rejects an
 *     out-of-root node_modules symlink);
 *   - regular files are HARDLINKED (fast, no disk duplication; builds only read
 *     them) with a byte-copy fallback for special files;
 *   - symlinks (pnpm's layout is a tree of relative links inside node_modules)
 *     are recreated with the same target, so they resolve within the copy.
 */
function copyNodeModulesTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      copyNodeModulesTree(from, to);
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (stat.isFile()) {
      try {
        linkSync(from, to);
      } catch {
        /* cross-device or unsupported: byte-copy the file */
        cpSync(from, to);
      }
    }
    // sockets/FIFOs are skipped (nothing in a pnpm node_modules needs them).
  }
}

// ---------------------------------------------------------------------------
// CLI `status` output parsing
// ---------------------------------------------------------------------------

/**
 * Canonical runtime fields produced by `parseSupabaseStatus`.
 * These are the values the test suites need, expressed under their
 * `SUPABASE_*` names by the runners — never logged.
 */

/** Bare `KEY=VALUE` names (this CLI generation) and `SUPABASE_*` aliases. */
const KEY_ALIASES = {
  apiUrl: ["API_URL", "SUPABASE_URL", "SUPABASE_API_URL", "SUPABASE_PUBLIC_URL", "PROJECT_URL"],
  dbUrl: ["DB_URL", "SUPABASE_DB_URL", "POSTGRES_URL"],
  anonKey: ["ANON_KEY", "SUPABASE_ANON_KEY"],
  serviceRoleKey: [
    "SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_KEY",
    "SUPABASE_SERVICE_KEY",
  ],
  jwtSecret: ["JWT_SECRET", "SUPABASE_JWT_SECRET", "SUPABASE_AUTH_JWT_SECRET"],
};

/** Pretty-output labels (`Label: value`) as a fallback for older CLIs. */
const PRETTY_LABELS = {
  apiUrl: ["api url", "project url"],
  dbUrl: ["db url"],
  anonKey: ["anon key"],
  serviceRoleKey: ["service_role key", "service role key"],
  jwtSecret: ["jwt secret"],
};

/**
 * Decode backslash escapes inside a double-quoted value (`\"`, `\\`, `\n`,
 * `\r`, `\t`, `\b`, `\f`, `\v`). Unknown escapes collapse to the bare
 * character, matching POSIX shell quoting.
 */
function decodeEscapes(raw) {
  return raw.replace(/\\([\\"nrtbfv])/g, (_, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      default:
        return ch; // \" and \\
    }
  });
}

/**
 * Unquote a parsed `KEY=value` payload robustly:
 *   - surrounding single or double quotes are stripped;
 *   - double-quoted values decode backslash escapes (`\"`, `\\`, `\n`, ...);
 *   - an inline `# comment` after a closing quote is ignored;
 *   - bare (unquoted) values are returned as-is.
 */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    let i = 1;
    let escaped = false;
    for (; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') break;
    }
    if (i < trimmed.length) {
      const rest = trimmed.slice(i + 1).trim();
      if (rest === "" || rest.startsWith("#")) {
        return decodeEscapes(trimmed.slice(1, i));
      }
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end !== -1) {
      const rest = trimmed.slice(end + 1).trim();
      if (rest === "" || rest.startsWith("#")) {
        return trimmed.slice(1, end);
      }
    }
  }
  return trimmed;
}

function fromRawMap(raw) {
  const out = {};
  for (const [canonical, aliases] of Object.entries(KEY_ALIASES)) {
    for (const alias of aliases) {
      if (raw[alias]) {
        out[canonical] = raw[alias];
        break;
      }
    }
  }
  return out;
}

function fromPrettyLines(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(\S.*?)\s*$/);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    for (const [canonical, labels] of Object.entries(PRETTY_LABELS)) {
      if (labels.includes(label) && !out[canonical]) {
        out[canonical] = m[2].trim();
      }
    }
  }
  return out;
}

/**
 * Parse the actual `supabase status` output robustly.
 *
 * Handles:
 *   - `KEY="value"` env lines (`-o env`), stripping surrounding single/double
 *     quotes and decoding backslash escapes (`\"`, `\\`, `\n`, ...);
 *   - noise lines the CLI interleaves on stdout (`Using workdir ...`,
 *     `Stopped services: [...]`, update notices);
 *   - `export KEY=value` lines (defensive);
 *   - CRLF and empty values;
 *   - `Label: value` pretty lines as a fallback.
 *
 * Maps `API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/`DB_URL` plus their aliases to
 * `{ apiUrl, dbUrl, anonKey, serviceRoleKey, jwtSecret }`. Missing fields are
 * `undefined` (callers report presence without logging values).
 */
export function parseSupabaseStatus(stdout) {
  const raw = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const value = unquote(m[2].trim());
    if (value) raw[m[1].toUpperCase()] = value;
  }
  const fromEnv = fromRawMap(raw);
  const missing = ["apiUrl", "dbUrl", "anonKey", "serviceRoleKey", "jwtSecret"].filter(
    (key) => !fromEnv[key]
  );
  if (missing.length > 0) {
    const fromPretty = fromPrettyLines(stdout);
    for (const key of missing) {
      if (fromPretty[key]) fromEnv[key] = fromPretty[key];
    }
  }
  return fromEnv;
}

/**
 * Parse `supabase status -o json` output (secondary path for CLI versions
 * where `-o env` is unavailable or partial). Accepts:
 *   - a flat JSON object whose keys are the canonical names
 *     (`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL`, `JWT_SECRET`)
 *     or their camelCase equivalents;
 *   - a JSON array wrapping such an object.
 *
 * Applies the same alias mapping as `parseSupabaseStatus`; missing fields stay
 * `undefined`.
 */
export function parseSupabaseStatusJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (Array.isArray(parsed)) parsed = parsed[0] ?? null;
  if (!parsed || typeof parsed !== "object") return {};

  // Normalize any casing so the alias table always matches: camelCase keys
  // (apiUrl/anonKey/serviceRoleKey/dbUrl/jwtSecret) become SCREAMING_SNAKE
  // (API_URL/ANON_KEY/...), and pre-uppercased keys pass through unchanged.
  const normalizeKey = (key) =>
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase();

  const raw = {};
  const collect = (obj) => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "object") {
        collect(value);
        continue;
      }
      const str = String(value).trim();
      if (str) raw[normalizeKey(key)] = str;
    }
  };
  collect(parsed);
  return fromRawMap(raw);
}

/** Human-readable presence summary (no values). */
export function presenceSummary(runtime) {
  const mark = (v) => (v ? "ok" : "missing");
  return (
    `api=${mark(runtime.apiUrl)} ` +
    `db=${mark(runtime.dbUrl)} ` +
    `anon=${mark(runtime.anonKey)} ` +
    `service-role=${mark(runtime.serviceRoleKey)}`
  );
}

// ---------------------------------------------------------------------------
// Capture retry, merge/fallback mapping, and canonical env injection
// ---------------------------------------------------------------------------

/** Canonical fields every lane must obtain before it will run anything. */
export const REQUIRED_RUNTIME_KEYS = ["apiUrl", "dbUrl", "anonKey", "serviceRoleKey"];

/** True when all four required runtime values are present and non-empty. */
export function hasRequiredRuntime(runtime) {
  return REQUIRED_RUNTIME_KEYS.every(
    (key) => typeof runtime?.[key] === "string" && runtime[key].length > 0
  );
}

/**
 * Merge several partial runtime maps, filling missing canonical fields from
 * later maps (first non-empty value wins per field). Used to combine the
 * `-o env` parse with the `-o json` parse so a partial capture can be
 * completed rather than discarded.
 */
export function mergeRuntimeMaps(...maps) {
  const out = {};
  for (const canonical of Object.keys(KEY_ALIASES)) {
    for (const map of maps) {
      const value = map?.[canonical];
      if (typeof value === "string" && value.length > 0) {
        out[canonical] = value;
        break;
      }
    }
  }
  return out;
}

/**
 * Capture and parse the runtime env from `supabase status` with bounded retry.
 *
 * - Runs `run("env")` (i.e. `supabase status -o env`) up to `attempts` times,
 *   retrying on a non-zero exit OR an incomplete parse (transient CLI/container
 *   warm-up) with `retryDelayMs` between attempts. `run` may return a result
 *   synchronously OR a promise (e.g. a tracked asynchronous child via
 *   `runTrackedSubprocess`); each invocation is awaited, so a material
 *   `supabase status` child stays trackable by signal handling.
 * - If the bounded env attempts still do not yield all four required values,
 *   runs `run("json")` (`status -o json`) once and MERGES its parse into the
 *   last env parse, filling any still-missing fields.
 * - Returns `{ ok: true, runtime, source, result }` on success, or
 *   `{ ok: false, runtime, envResult, jsonResult }` on failure so the caller
 *   can report presence (and redact+print the captured output) as an explicit
 *   environment blocker. Never falls back to a hosted/shared database.
 */
export async function captureRuntimeEnv({ run, attempts = 3, retryDelayMs = 1_500 }) {
  let envResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run("env");
    envResult = result;
    if (result.status === 0) {
      const runtime = parseSupabaseStatus(result.stdout);
      if (hasRequiredRuntime(runtime)) {
        return { ok: true, runtime, source: "env", result };
      }
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  const jsonResult = await run("json");
  const runtime = mergeRuntimeMaps(
    parseSupabaseStatus(envResult?.stdout ?? ""),
    jsonResult.status === 0 ? parseSupabaseStatusJson(jsonResult.stdout) : {}
  );
  if (hasRequiredRuntime(runtime)) {
    return { ok: true, runtime, source: "json-merged", result: jsonResult };
  }
  return { ok: false, runtime, envResult, jsonResult };
}

/**
 * Build a child environment from a sanitized base plus the captured runtime
 * values. Values are injected under the CANONICAL names (`API_URL`, `ANON_KEY`,
 * `SERVICE_ROLE_KEY`, `DB_URL`, `JWT_SECRET`) as authoritative, with the
 * `SUPABASE_*` aliases also set — every consumer (contract helpers, E2E seed,
 * Next build) resolves identically because the canonical names are always
 * present.
 */
export function runtimeEnv(base, runtime) {
  const env = { ...base };
  env.API_URL = runtime.apiUrl ?? "";
  env.ANON_KEY = runtime.anonKey ?? "";
  env.SERVICE_ROLE_KEY = runtime.serviceRoleKey ?? "";
  env.DB_URL = runtime.dbUrl ?? "";
  env.JWT_SECRET = runtime.jwtSecret ?? "";
  env.SUPABASE_URL = env.API_URL;
  env.SUPABASE_API_URL = env.API_URL;
  env.SUPABASE_PUBLIC_URL = env.API_URL;
  env.SUPABASE_DB_URL = env.DB_URL;
  env.SUPABASE_ANON_KEY = env.ANON_KEY;
  env.SUPABASE_SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY;
  env.SUPABASE_JWT_SECRET = env.JWT_SECRET;
  return env;
}

// ---------------------------------------------------------------------------
// Loopback guards
// ---------------------------------------------------------------------------

const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/;

/** True only for an http(s) URL bound to a loopback address. */
export function isLoopbackHttpUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return LOOPBACK_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** True only for a postgres(ql) URL bound to a loopback address. */
export function isLoopbackDbUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return false;
    return LOOPBACK_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Assert every runtime value is loopback-only. Throws (without echoing any
 * captured value) so a lane can never touch a hosted/shared database.
 */
export function assertLoopbackRuntime(runtime) {
  if (!runtime.apiUrl || !isLoopbackHttpUrl(runtime.apiUrl)) {
    throw new Error("Refusing to run the lane: API_URL did not resolve to a loopback host.");
  }
  if (!runtime.dbUrl || !isLoopbackDbUrl(runtime.dbUrl)) {
    throw new Error("Refusing to run the lane: DB_URL did not resolve to a loopback host.");
  }
}

// ---------------------------------------------------------------------------
// Sanitized child environment
// ---------------------------------------------------------------------------

/** Known non-`SUPABASE_*` bare credential keys that must never leak. */
const SENSITIVE_BARE_KEYS = new Set([
  "API_URL",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "SERVICE_KEY",
  "DB_URL",
  "JWT_SECRET",
  "POSTGRES_URL",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "SUPABASE_ACCESS_TOKEN",
]);

/** Prefix families that always carry environment/config credentials. */
const SENSITIVE_PREFIXES = ["SUPABASE_", "NEXT_PUBLIC_", "POSTGRES_", "VITE_", "REACT_APP_"];

/** Suffixes that mark a credential-bearing variable. */
const SENSITIVE_SUFFIXES = ["TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL"];

function isSensitiveEnvKey(key) {
  const upper = key.toUpperCase();
  if (SENSITIVE_BARE_KEYS.has(upper)) return true;
  if (SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/**
 * Return a copy of the given env (default: `process.env`) with any hosted or
 * potentially sensitive Supabase-related variables removed, so no credential
 * can leak from the parent shell into a spawned child (CLI, tests, build,
 * seed, browser).
 *
 * Beyond the `SUPABASE_*` family this also strips `NEXT_PUBLIC_*`, `POSTGRES_*`,
 * `VITE_*`, `REACT_APP_*`, the bare key names, and any key ending in
 * `TOKEN`/`SECRET`/`KEY`/`PASSWORD`/`CREDENTIAL` — the union of every
 * credential-shaped variable that could otherwise reach a child process.
 */
export function sanitizeEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvKey(key)) delete env[key];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Preflight probes
// ---------------------------------------------------------------------------

/**
 * Run a bounded preflight/availability probe (e.g. `docker info`,
 * `docker images`, `pnpm`/`supabase`/`next`/`tsx`/`playwright`/`vitest`
 * version probes, the Chromium executable probe) with FULL containment:
 *   - the child environment is ALWAYS the sanitized child env (or
 *     `sanitizeEnv(process.env)` when no `env` is supplied), so hostile
 *     inherited credentials can never reach a preflight subprocess — raw
 *     `process.env` is eliminated as a spawn base here too;
 *   - a bounded timeout (`timeoutMs`, default 15s) turns a hung probe into a
 *     reported `{ ok: false }` result, never an unbounded hang, and the
 *     timeout termination is a HARD `SIGKILL` (a probe that deliberately
 *     ignores SIGTERM is still killed at the deadline, never left hanging);
 *   - stdout/stderr are piped (never inherited raw to the terminal).
 *
 * When `captureOutput` is set, the captured stdout/stderr are returned so the
 * caller can parse them (e.g. the Chromium executable probe's JSON); the
 * caller is responsible for redacting anything it surfaces.
 *
 * Returns `{ ok, status, signal, error, stdout, stderr }`:
 *   - `ok` is true only for a clean exit code 0 within the timeout;
 *   - `status` is the exit code, or `null` when the probe was killed by a
 *     signal or the timeout, or could not be spawned (`error` then carries the
 *     spawn error / `ETIMEDOUT`).
 */
export function runProbe(cmd, args = [], { env, cwd, timeoutMs = 15_000, captureOutput = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: sanitizeEnv(env ?? process.env),
    timeout: timeoutMs,
    // Hard termination at the deadline: a hung probe that ignores SIGTERM is
    // SIGKILLed, never left hanging.
    killSignal: "SIGKILL",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Output redaction
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

/** A value that looks like a JWT (three dot-separated base64url segments). */
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * A bare JWT fragment: an unbroken base64url run of ≥ 12 characters after the
 * `eyJ` JWT header. Catches wrapped or truncated table cells that `JWT_RE`
 * (which needs all three segments on one line) cannot match. Runs AFTER
 * `JWT_RE` so a whole token is replaced as one unit and never partially
 * unmasked.
 */
const JWT_FRAGMENT_RE = /\beyJ[A-Za-z0-9_-]{12,}/g;

/** URL userinfo (scheme://user:pass@host) — redact the password portion. */
const URL_USERINFO_RE = /(postgres(?:ql)?:\/\/[^/@:\s]+):[^/@\s]+@/gi;

/** `KEY="value"` (and `export KEY="value"`) lines for credential keys. */
const ASSIGNMENT_RE = /(^|\s)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gm;

/**
 * Pretty `Label: value` lines (the format `supabase status` prints) whose
 * values are secrets. These are redacted EVEN WHEN no runtime map has been
 * captured yet — a failed pre-capture `status` dump must not leak them either.
 * Non-secret labels (`GraphQL URL`, `Studio URL`, `S3 Region`, ...) pass
 * through unchanged.
 */
const PRETTY_SECRET_LABELS = new Set([
  "api url",
  "project url",
  "db url",
  "anon key",
  "service_role key",
  "service role key",
  "jwt secret",
  "s3 access key",
  "s3 secret key",
  // `supabase start` prints the local credentials as table rows BEFORE the
  // runtime is captured:
  //   - storage is labelled `Access Key` / `Secret Key` (values are NOT
  //     JWT-shaped — random S3-style strings);
  //   - newer CLI generations label the API key pair `Publishable` / `Secret`;
  //   - `api key` / `api secret` are defensive additions for other CLI
  //     generations.
  // Every one of these rows must be masked label-driven, because no value-shape
  // heuristic can recognize them.
  "publishable",
  "publishable key",
  "secret",
  "secret key",
  "access key",
  "access key id",
  "secret access key",
  "api key",
  "api secret",
  "s3 access key id",
  "s3 secret access key",
]);

const PRETTY_SECRET_RE = /^(\s*)([^:\n]+):(\s*)(\S.*)$/gm;

/**
 * One regex matching every secret-bearing CLI row shape that `supabase start`
 * / `supabase status` can print:
 *
 *   - colon form:     `anon key: eyJanon`
 *   - compact rows:   `Publishable        eyJ...`   (label padded to a column)
 *   - pipe rows:      `| Access Key | AKIA... |`
 *   - box-drawing:    `│ Secret │ bare-secret │`
 *
 * The label is matched EXPLICITLY from `PRETTY_SECRET_LABELS` (longest first)
 * and bounded by `(?![A-Za-z0-9_-])`, so `Secret` cannot match `Secretary`, a
 * bare line followed by a single space is never mistaken for a table row, and
 * multi-word labels (`S3 Access Key`) match as one unit.
 */
const SECRET_LABEL_ALT = [...PRETTY_SECRET_LABELS]
  .sort((a, b) => b.length - a.length)
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const SECRET_TABLE_ROW_RE = new RegExp(
  `^([ \\t]*(?:[│┃┆┊┋|][ \\t]*)*)(${SECRET_LABEL_ALT})(?![A-Za-z0-9_-])([ \\t]*(?:[:|│┃┆┊┋][ \\t]*|[ \\t]{2,}))(.*)$`,
  "i"
);

/**
 * Redact a single line that is a secret-bearing CLI row (see
 * `SECRET_TABLE_ROW_RE`). The label (and any table border) is preserved for
 * diagnostics; the value — including any wrapped remainder — is masked.
 * Returns the redacted line, or `null` when the line is not a secret row.
 */
function redactSecretRowLine(line) {
  if (typeof line !== "string" || line.length === 0) return null;
  const match = line.match(SECRET_TABLE_ROW_RE);
  if (!match) return null;
  const [, prefix, label, separator, value] = match;
  // Drop a trailing table border so a wrapped value fragment cannot survive
  // the masked-cell reconstruction; the border is re-appended after masking.
  const trailingBorder = value.match(/[ \t]*[│┃┆┊┋|][ \t]*$/);
  const trailing = trailingBorder ? trailingBorder[0] : "";
  return `${prefix}${label}${separator}${REDACTED}${trailing}`;
}

/**
 * A table row whose label cell is blank — the wrapped continuation of the
 * PREVIOUS row's value. Matches the leading border plus a whitespace-only
 * first cell. Only consulted while the preceding line was a secret row, so a
 * standalone label-less row (or a blank-line-separated second table) is never
 * touched.
 */
const TABLE_CONTINUATION_RE = /^([ \t]*[│┃┆┊┋|][ \t]*)([ \t]+)[│┃┆┊┋|][ \t]*(.*)$/;

/**
 * An indented, unbordered line — the wrapped continuation cell of a
 * COMPACT-table row (no borders), aligned under the value column. Only
 * consulted while the preceding line was a secret row.
 */
const UNBORDERED_CONTINUATION_RE = /^([ \t]+)(\S.*)$/;

/**
 * A generic `Label: value` / `Label  value` row shape (any label, secret or
 * not), used to tell a NEW table row apart from a wrapped continuation cell.
 * The colon must be followed by whitespace so URL values
 * (`postgres://…`) are never mistaken for a row label.
 */
const ROW_LIKE_RE = /^[A-Za-z][A-Za-z0-9 _-]*?(?::[ \t]+|[ \t]{2,})\S/;

/** Modern Supabase local key tokens (`sb_publishable_…` / `sb_secret_…`).
 *  The marker prefix is kept for diagnostics; the value is masked. Catches
 *  bare tokens in failed-`supabase start` error dumps that appear OUTSIDE any
 *  labelled row. */
const SUPABASE_SB_KEY_RE = /\b(sb_(?:publishable|secret)_)[A-Za-z0-9_.\-]+/gi;

/** AWS/S3-style access key IDs (the `AKIA…` access-key-id format). */
const AWS_ACCESS_KEY_RE = /\bAKIA[A-Z0-9]{12,}\b/g;

/** Characters that may bound a bare token without making it a digest,
 *  assignment value, path, or URL: whitespace, quotes, table borders, and line
 *  boundaries. The right side also accepts sentence punctuation so a value at
 *  the end of a message is still masked. */
const BARE_TOKEN_LEFT = `[ \\t\\r"'|│┃┆┊┋]`;
const BARE_TOKEN_RIGHT = `[ \\t\\r"'|│┃┆┊┋.,;:!?)\\]}]`;

/**
 * A bare long credential-shaped token in diagnostic text: an unbroken run of
 * 24+ base64url/hex characters (the base64url alphabet — letters, digits,
 * `_`, `-`) bounded by whitespace, quotes, line boundaries, table borders, or
 * sentence punctuation — NOT by `:`/`=`/`.`/`/` (which would make it a
 * digest, assignment value, path, or URL). Catches dumped S3-style secret
 * values and wrapped key fragments that no label survives to identify.
 * Pure-lowercase-hex identifier runs of exactly 40 (git SHA) or 64 (container
 * ID / image digest) characters are excluded, since those are almost never
 * credentials.
 */
const BARE_LONG_TOKEN_RE = new RegExp(
  `(^|${BARE_TOKEN_LEFT})(?!(?:[0-9a-f]{40}|[0-9a-f]{64})(?=$|${BARE_TOKEN_RIGHT}))([A-Za-z0-9_\\-]{24,})(?=$|${BARE_TOKEN_RIGHT})`,
  "gm"
);

/**
 * A bare standard-base64 secret-shaped token: conventional AWS/S3 secret
 * access keys use the FULL base64 alphabet, so they can contain `/`, `+`, and
 * up to two trailing `=` padding characters — none of which the base64url rule
 * above allows. Deliberately excludes `-`/`_`/`.` (breaking paths, package
 * refs, and domains) and allows at most two `/`/`+` separators, so
 * hierarchical paths (`/var/lib/…`), package identifiers (`org/pkg`), URLs,
 * and hashes (`sha256:…`) are not mistaken for secrets. Length and
 * identifier-shape exclusions are enforced in the replacement callback.
 */
const BARE_BASE64_TOKEN_RE = new RegExp(
  `(^|${BARE_TOKEN_LEFT})([A-Za-z0-9]+(?:[/+][A-Za-z0-9]+){0,2}={0,2})(?=$|${BARE_TOKEN_RIGHT})`,
  "gm"
);

/** Redact any value already captured by the runtime (never printed elsewhere). */
function redactKnownValues(text, runtime) {
  const known = [];
  if (runtime?.apiUrl) known.push(runtime.apiUrl);
  if (runtime?.dbUrl) known.push(runtime.dbUrl);
  if (runtime?.anonKey) known.push(runtime.anonKey);
  if (runtime?.serviceRoleKey) known.push(runtime.serviceRoleKey);
  if (runtime?.jwtSecret) known.push(runtime.jwtSecret);
  if (known.length === 0) return text;
  let out = text;
  for (const value of known) {
    if (value) out = out.split(value).join(REDACTED);
  }
  return out;
}

/**
 * Per-line secret-table pass with an EXTERNALLY carried `inSecretRow`
 * continuation state. Redacts secret-bearing CLI table rows and the wrapped
 * continuation cells that follow them, and returns the resulting state so a
 * streaming caller can preserve the labelled-secret continuation context
 * across chunk boundaries (a secret row whose wrapped continuation cell
 * arrives in a later chunk is still fully masked).
 */
function redactSecretRowLines(lines, initialInSecretRow = false) {
  let inSecretRow = initialInSecretRow;
  const out = lines.map((line) => {
    const redacted = redactSecretRowLine(line);
    if (redacted !== null) {
      inSecretRow = true;
      return redacted;
    }
    if (inSecretRow) {
      // Bordered continuation (wrapped cell in a box-drawing/pipe table).
      const continuation = line.match(TABLE_CONTINUATION_RE);
      if (continuation) {
        const [, lead, blankCell, content] = continuation;
        const trailingBorder = content.match(/[ \t]*[│┃┆┊┋|][ \t]*$/);
        const trailing = trailingBorder ? trailingBorder[0] : "";
        return `${lead}${blankCell}${REDACTED}${trailing}`;
      }
      // Compact-table continuation: an indented, unbordered line directly
      // under a secret row carries the wrapped remainder of the value. Mask it
      // until the table context ends — a blank/whitespace-only line, a
      // dedented line, or a NEW labelled row (secret rows above are redacted
      // by `redactSecretRowLine` and continue the context).
      const indented = line.match(UNBORDERED_CONTINUATION_RE);
      if (indented && !ROW_LIKE_RE.test(indented[2])) {
        return `${indented[1]}${REDACTED}`;
      }
    }
    inSecretRow = false;
    return line;
  });
  return { lines: out, inSecretRow };
}

/**
 * Full streaming-capable redaction pass. Applies every scrubbing rule in the
 * same order as `redactSensitiveOutput` while carrying the labelled-secret
 * continuation state across calls, so a wrapped table cell that arrives in a
 * later chunk is masked as a continuation of the secret row that preceded it.
 * Returns `{ text, inSecretRow }`.
 */
function redactStreaming(text, { runtime, inSecretRow = false } = {}) {
  let out = text;
  out = redactKnownValues(out, runtime);

  // Secret-bearing CLI table rows (`Publishable`/`Secret`/`Access Key`/
  // `Secret Key` plus every labelled `Label: value` secret) and the wrapped
  // continuation cells that immediately follow a secret row. These rows carry
  // the local credentials BEFORE any runtime map exists, and their values are
  // often NOT JWT-shaped (S3 keys, random secrets), so only an explicit label
  // match can catch them. Processed per line so the exact line endings are
  // preserved, and the continuation state threads through chunk boundaries.
  const parts = out.split(/(\r\n|\n|\r)/);
  // `split` appends a trailing empty element when the text ends with a line
  // terminator. That element is a SPLIT ARTIFACT, not a real blank line: it
  // must not reset the labelled-secret continuation state at the end of a
  // chunk, or a continuation cell arriving in the next chunk would leak. (A
  // genuine blank line — e.g. `row\n\n` — still yields a real empty element
  // before the artifact and correctly ends the table context.)
  if (parts.length > 1 && parts[parts.length - 1] === "" && /(?:\r\n|\n|\r)$/.test(out)) {
    parts.pop();
  }
  const lineIndexes = [];
  const lines = [];
  for (let index = 0; index < parts.length; index += 2) {
    lineIndexes.push(index);
    lines.push(parts[index]);
  }
  const tableResult = redactSecretRowLines(lines, inSecretRow);
  tableResult.lines.forEach((line, index) => {
    parts[lineIndexes[index]] = line;
  });
  out = parts.join("");

  // Whole JWT-shaped tokens first, then bare JWT fragments (a wrapped or
  // truncated table cell still starts with the base64 JWT header). The
  // fragment pass runs AFTER the whole-token pass so a full token is replaced
  // as one unit and never partially unmasked.
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(JWT_FRAGMENT_RE, REDACTED);

  // Bare modern Supabase key tokens (`sb_publishable_*` / `sb_secret_*`) and
  // AWS/S3-style access key IDs can appear in a failed `supabase start` dump
  // WITHOUT any surrounding label; mask them by their distinctive prefixes.
  out = out.replace(SUPABASE_SB_KEY_RE, "$1" + REDACTED);
  out = out.replace(AWS_ACCESS_KEY_RE, REDACTED);

  // Bare non-JWT key-shaped tokens (e.g. a dumped S3 secret key) with no
  // label surviving in the diagnostic: mask long unbroken token runs — both
  // base64url-shaped and conventional base64, which may contain `/`, `+`, and
  // trailing `=` padding.
  out = out.replace(BARE_LONG_TOKEN_RE, "$1" + REDACTED);
  out = out.replace(BARE_BASE64_TOKEN_RE, (whole, lead, token) => {
    if (token.length < 24) return whole;
    // Pure-lowercase-hex 40/64-char runs are git SHAs, container IDs, or
    // image digests — identifiers, not credentials.
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token)) return whole;
    return `${lead}${REDACTED}`;
  });

  out = out.replace(URL_USERINFO_RE, "$1:" + REDACTED + "@");

  // Pre-runtime CLI `Label: value` pretty lines carry the same secrets as
  // `KEY="value"` lines; the label is preserved for diagnostics, the value is
  // masked (works even when `runtime` is empty because the capture failed).
  out = out.replace(PRETTY_SECRET_RE, (whole, indent, label, sep, value) => {
    if (!PRETTY_SECRET_LABELS.has(label.trim().toLowerCase())) return whole;
    return `${indent}${label}:${sep}${REDACTED}`;
  });

  // The E2E seed hands the runner a single JSON line (`E2E_SEED_JSON={...}`)
  // that embeds the seeded auth passwords; never let a failure-path dump leak
  // it. Redact the entire value.
  out = out.replace(/(^|\s)(E2E_SEED_JSON)\s*=\s*\S+/gm, `$1$2=${REDACTED}`);

  // Redact KEY=VALUE / KEY="VALUE" assignment lines whose key looks like a
  // credential (token/secret/key/password/credential/url, or a known bare
  // key). The captured key is preserved for diagnostics; only the value is
  // masked.
  out = out.replace(ASSIGNMENT_RE, (whole, lead, exportPrefix, key) => {
    const upper = key.toUpperCase();
    const sensitive =
      SENSITIVE_BARE_KEYS.has(upper) ||
      SENSITIVE_PREFIXES.some((p) => upper.startsWith(p)) ||
      SENSITIVE_SUFFIXES.some((s) => upper.endsWith(s));
    if (!sensitive) return whole;
    return `${lead}${exportPrefix ?? ""}${key}=${REDACTED}`;
  });

  return { text: out, inSecretRow: tableResult.inSecretRow };
}

/**
 * Sanitize captured command output so no credential can be printed to a log,
 * report, or CI artifact. Applies over-eagerly to any failure-path output
 * (`status -o env` dumps, seed stdout/stderr, app logs) where a raw dump could
 * carry keys, tokens, or connection strings.
 */
export function redactSensitiveOutput(text, { runtime } = {}) {
  if (typeof text !== "string" || text.length === 0) return text;
  return redactStreaming(text, { runtime }).text;
}

// ---------------------------------------------------------------------------
// Streaming redaction and graceful process teardown
// ---------------------------------------------------------------------------

/**
 * A `Transform` that scrubs captured child output line-by-line as it streams
 * through. Newlines (`\n`) are preserved exactly; a partial trailing line is
 * flushed when the stream ends, so no redaction pattern can be split across
 * chunk boundaries. The labelled-secret continuation state (`inSecretRow`) is
 * CARRIED across chunk boundaries, so a secret-bearing CLI table row whose
 * wrapped continuation cell arrives in a later chunk is still fully masked.
 *
 * CRLF safety: lines are split ONLY at `\n` (never at a bare `\r`). A trailing
 * `\r` is therefore retained in the buffer until the next character resolves
 * it — if the next character is `\n`, the pair forms one CRLF terminator on
 * the SAME line, and a `\r`/`\n` chunk split can never flush a bare `\n` that
 * would reset the secret-table continuation state. `redactStreaming` treats
 * `\r\n`, `\n`, and a lone `\r` all as line terminators when it processes a
 * flushed unit.
 */
export function createRedactTransform({ runtime } = {}) {
  let buffer = "";
  let inSecretRow = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const parts = buffer.split(/(?<=\n)/);
      buffer = parts.pop() ?? "";
      if (parts.length > 0) {
        const result = redactStreaming(parts.join(""), { runtime, inSecretRow });
        inSecretRow = result.inSecretRow;
        this.push(result.text);
      }
      callback();
    },
    flush(callback) {
      if (buffer.length > 0) {
        const result = redactStreaming(buffer, { runtime, inSecretRow });
        this.push(result.text);
      }
      callback();
    },
  });
}

/**
 * Pipe a captured child stream through the redaction filter into a writable
 * destination (terminal, log file, artifact). Any sensitive value in the
 * stream is scrubbed before it reaches the destination.
 */
export function pipeRedacted(readable, writable, options) {
  if (!readable || !writable) return;
  readable.pipe(createRedactTransform(options)).pipe(writable);
}

/**
 * Stop a spawned child gracefully: send `signal` (SIGTERM by default), wait up
 * to `graceMs` for it to exit, then escalate to `killSignal` (SIGKILL) and
 * resolve. Resolves with the child's exit code, or `null` if it was already
 * gone. Never rejects.
 */
export function killChildGracefully(
  child,
  { signal = "SIGTERM", graceMs = 5_000, killSignal = "SIGKILL" } = {}
) {
  return new Promise((resolve) => {
    if (!child || typeof child.kill !== "function") {
      resolve(null);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    let settled = false;
    let timer = null;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    timer = setTimeout(() => {
      try {
        child.kill(killSignal);
      } catch {
        /* process already gone */
      }
      // SIGKILL is best-effort; resolve after a short settle window even if
      // the OS has not reaped the process yet.
      setTimeout(() => settle(child.exitCode ?? null), 500);
    }, graceMs);
    child.once("exit", (code) => settle(code ?? null));
    try {
      child.kill(signal);
    } catch {
      /* process already gone */
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode);
    }
  });
}

// ---------------------------------------------------------------------------
// Spawned-child registry (signal-driven teardown)
// ---------------------------------------------------------------------------

/** Every async child currently spawned by a lane, tracked for signal teardown. */
const activeChildren = new Set();

/**
 * Register a spawned child so it can be terminated on SIGINT/SIGTERM (and on
 * the `finally` teardown path). Auto-unregisters on `close`/`error`. Returns
 * the child for chaining.
 */
export function trackChild(child) {
  if (!child || activeChildren.has(child)) return child;
  activeChildren.add(child);
  const release = () => activeChildren.delete(child);
  child.once("close", release);
  child.once("error", release);
  return child;
}

/** Remove a child from the registry without signalling it. */
export function untrackChild(child) {
  activeChildren.delete(child);
}

/** Number of children currently registered (used by unit tests). */
export function activeChildCount() {
  return activeChildren.size;
}

/**
 * Terminate every registered child gracefully (SIGTERM with a grace window,
 * escalating to SIGKILL) so no lane process survives a signal or a torn-down
 * run. Resolves once every child has been signalled; never rejects.
 */
export async function terminateAllChildren({
  signal = "SIGTERM",
  graceMs = 5_000,
  killSignal = "SIGKILL",
} = {}) {
  const children = [...activeChildren];
  activeChildren.clear();
  await Promise.allSettled(
    children.map((child) => killChildGracefully(child, { signal, graceMs, killSignal }))
  );
}