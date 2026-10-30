/**
 * Ambient type declarations for `scripts/test-support/supabase-isolation.mjs`.
 *
 * The runner module is plain ESM JavaScript; this declaration lets TypeScript
 * consumers (unit tests) and editors see its surface without `any`-splatting.
 */

/** Canonical runtime fields derived from `supabase status` output. */
export interface SupabaseRuntime {
  apiUrl?: string;
  dbUrl?: string;
  anonKey?: string;
  serviceRoleKey?: string;
  jwtSecret?: string;
}

/** Port map used by `rewriteIsolatedConfig` (+ optional lane app port). */
export interface IsolatedPorts {
  api: number;
  db: number;
  shadow: number;
  pooler: number;
  studio: number;
  inbucket: number;
  analytics: number;
  edgeInspector: number;
  next?: number;
}

/** Handles returned by `prepareIsolatedSupabase`. */
export interface IsolatedSupabase {
  workdir: string;
  supabaseDir: string;
  projectId: string;
  ports: IsolatedPorts;
  cleanup: () => void;
}

/** Redaction options for `redactSensitiveOutput`. */
export interface RedactOptions {
  runtime?: Partial<SupabaseRuntime>;
}

/** Result of a single `supabase status -o <format>` invocation. */
export interface StatusCapture {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Result of `captureRuntimeEnv`. */
export type RuntimeCapture =
  | { ok: true; runtime: Partial<SupabaseRuntime>; source: "env" | "json-merged"; result: StatusCapture }
  | {
      ok: false;
      runtime: Partial<SupabaseRuntime>;
      envResult: StatusCapture | null;
      jsonResult: StatusCapture;
    };

/** Options for a bounded preflight/availability probe (`runProbe`). */
export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  captureOutput?: boolean;
}

/**
 * Spawn/sync error, possibly carrying a Node `code` (e.g. `ETIMEDOUT` on a
 * timeout kill, `ENOENT` on a missing binary).
 */
export type SpawnError = Error & { code?: string; errno?: number; killed?: boolean };

/** Result of a bounded preflight/availability probe (`runProbe`). */
export interface ProbeResult {
  /** True only for a clean exit code 0 within the timeout. */
  ok: boolean;
  /** Exit code, or `null` when killed by a signal / timeout / spawn failure. */
  status: number | null;
  /** Signal that terminated the probe (e.g. `SIGKILL` at the hard deadline). */
  signal: NodeJS.Signals | null;
  /** Spawn error (e.g. `ETIMEDOUT` on timeout), otherwise `null`. */
  error: SpawnError | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a bounded preflight/availability probe (e.g. `docker info`, version
 * probes, the Chromium executable probe) with the sanitized child env and a
 * hard bounded timeout (SIGKILL at the deadline, even if the probe ignores
 * SIGTERM).
 */
export function runProbe(cmd: string, args?: string[], options?: ProbeOptions): ProbeResult;

/** Options for a material tracked subprocess (`runTrackedSubprocess`). */
export interface TrackedSubprocessOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Hard deadline in ms (SIGTERM, then SIGKILL after `killGraceMs`). */
  timeoutMs?: number;
  /** SIGTERM grace before SIGKILL escalation once the deadline fires. */
  killGraceMs?: number;
}

/** Result of a material tracked subprocess (`runTrackedSubprocess`). */
export interface TrackedSubprocessResult {
  /** Exit code, or `null` when killed by a signal / the deadline / spawn failure. */
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** RAW combined stdout+stderr — caller redacts anything it surfaces. */
  output: string;
  /** True when the hard deadline fired and the child had to be terminated. */
  timedOut: boolean;
  /** Spawn error, otherwise `null`. */
  error: SpawnError | null;
}

/**
 * Run a MATERIAL subprocess (e.g. `supabase status`, the teardown Docker
 * availability probe, `supabase stop`) as a TRACKED async child with a hard
 * bounded deadline and SIGTERM→SIGKILL escalation. The child is registered so
 * process-level SIGINT/SIGTERM and lane teardown terminate it.
 */
export function runTrackedSubprocess(
  cmd: string,
  args?: string[],
  options?: TrackedSubprocessOptions
): Promise<TrackedSubprocessResult>;

/** Options for the retryable-attempt teardown (`completeRetryableTeardown`). */
export interface RetryableTeardownOptions<T> {
  /** STABLE lane snapshot captured at call time (never a mutable global). */
  lane: T | null | undefined;
  /** Fully awaited before `removeWorkdir` runs (e.g. E2E Docker probe + stop). */
  stop?: (lane: T) => Promise<void> | void;
  /** Runs only after `stop` resolved (e.g. `lane.cleanup()` + global clear). */
  removeWorkdir?: (lane: T) => void;
  /** Receives any teardown error; teardown never rejects. */
  onError?: (caught: unknown) => void;
}

/**
 * Complete a retryable-attempt teardown (stop + workdir removal) to FULL
 * completion before the next lane attempt may begin. Resolves only after every
 * step finished, so the caller can clear its lane state and return
 * `{ retryable: true }`; never rejects.
 */
export function completeRetryableTeardown<T>(options?: RetryableTeardownOptions<T>): Promise<void>;

/** Result of `confirmTeardownBeforeRetry` (fail-closed retry gate). */
export interface RetryTeardownGate {
  /** True ONLY when teardown explicitly returned `confirmed: true`. */
  retryable: boolean;
  /** The explicit confirmation flag (false for missing/false/thrown teardown). */
  confirmed: boolean;
  /** The teardown result (when it returned instead of throwing). */
  result?: unknown;
  /** The teardown error (when it threw); never surfaced raw by callers. */
  error?: unknown;
}

/**
 * Await a complete isolated teardown and permit a whole-lane retry ONLY when it
 * explicitly returns `{ confirmed: true }`. Missing/false confirmation and a
 * thrown teardown error both fail closed (`retryable: false`).
 */
export function confirmTeardownBeforeRetry(
  teardown: () => unknown
): Promise<RetryTeardownGate>;

/** Options carrying an alternate repository project id (tests only). */
export interface ProjectIdOptions {
  repositoryProjectId?: string;
}

/** The repository's own Supabase project id — never a lane cleanup target. */
export const REPOSITORY_PROJECT_ID: string;

/** Docker label the Supabase CLI stamps on every resource it owns. */
export const SUPABASE_PROJECT_LABEL: string;

/**
 * Validate a lane-generated project id before it scopes any cleanup command.
 * Rejects empty/whitespace ids, the repository's own project id, and the CLI
 * default project id. Returns the id for chaining; throws otherwise.
 */
export function assertSafeProjectId(projectId: unknown, options?: ProjectIdOptions): string;

/** Non-throwing variant of `assertSafeProjectId`. */
export function isSafeProjectId(projectId: unknown, options?: ProjectIdOptions): boolean;

/** Scoped `docker … ls` args for one resource kind (label filter only). */
export function dockerScopedListArgs(
  kind: "container" | "network" | "volume",
  projectId: string
): string[];

/** Scoped `docker … rm` args for the exact ids a scoped list returned. */
export function dockerScopedRemoveArgs(
  kind: "container" | "network" | "volume",
  ids: string[]
): string[];

/** Split `docker … ls -q` output into trimmed, non-empty ids. */
export function parseDockerIds(stdout: string | null | undefined): string[];

/** Result shape a `run` function must return to the scoped reaper. */
export interface DockerRunResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}

/** Options for `reapScopedDockerResources`. */
export interface ReapScopedDockerOptions {
  projectId: string;
  run: (cmd: string, args: string[]) => DockerRunResult | Promise<DockerRunResult>;
  repositoryProjectId?: string;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** Result of a label-scoped Docker fallback reap. */
export interface DockerReapResult {
  confirmed: boolean;
  removed: { containers: number; networks: number; volumes: number };
  errors: string[];
}

/**
 * Label-scoped Docker fallback reaper: lists and removes ONLY resources
 * carrying the lane's own `com.supabase.cli.project` value.
 */
export function reapScopedDockerResources(
  options: ReapScopedDockerOptions
): Promise<DockerReapResult>;

/** Project-specific recovery text for a lane whose cleanup was unconfirmed. */
export function laneRecoverySummary(
  projectId: string,
  lane?: { workdir?: string }
): string;

/** Result of a scoped lane teardown. */
export interface ScopedTeardownResult {
  confirmed: boolean;
  projectId?: string;
  workdir?: string;
  command?: string;
  skipped?: boolean;
}

/** Lane shape required by `createScopedLaneTeardown`. */
export interface ScopedLane {
  projectId: string;
  workdir: string;
  cleanup: () => void;
}

/** Options for `createScopedLaneTeardown`. */
export interface CreateScopedLaneTeardownOptions<T = ScopedLane> {
  /**
   * Attempts the normal workdir-scoped stop (`supabase stop --no-backup
   * --yes`, scoped to the isolated workdir). May return `true`, a
   * `{ confirmed }` result, `undefined`/`false` (unconfirmed), or a promise of
   * any of these.
   */
  stop?: (lane: T) => unknown;
  /**
   * Injected label-scoped Docker reaper; invoked only when the normal stop
   * cannot be confirmed.
   */
  reap?: (lane: T) => unknown;
  removeWorkdir?: (lane: T) => void;
  recovery?: (projectId: string, lane: T) => string;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Build a memoized, idempotent, scoped lane teardown: normal project-scoped
 * stop first, the label-scoped Docker reaper only when that stop cannot be
 * confirmed, workdir removal only after confirmed cleanup.
 */
export function createScopedLaneTeardown<T = ScopedLane>(
  options?: CreateScopedLaneTeardownOptions<T>
): (lane: T | null | undefined) => Promise<ScopedTeardownResult>;

/** Options for `installSignalTeardown`. */
export interface InstallSignalTeardownOptions {
  terminate?: () => unknown;
  teardown?: () => unknown;
  signals?: NodeJS.Signals[];
  exitCode?: number;
  error?: (...args: unknown[]) => void;
}

/**
 * Install one-time signal handlers that terminate lane children and then await
 * the shared teardown promise before exiting. Returns a disposer.
 */
export function installSignalTeardown(options?: InstallSignalTeardownOptions): () => void;

/** Graceful-kill options for `killChildGracefully`. */
export interface KillOptions {
  signal?: NodeJS.Signals;
  graceMs?: number;
  killSignal?: NodeJS.Signals;
}

export function findFreePorts(
  count: number,
  options?: { host?: string; maxAttempts?: number }
): Promise<number[]>;

export function isPortFree(port: number, options?: { host?: string }): Promise<boolean>;

export function isPortConflictOutput(text: string): boolean;

/**
 * True ONLY for a transient registry/image-pull failure of `supabase start`:
 * a SINGLE line must show BOTH a registry/image-pull context AND a transient
 * network transport error (timeout, DNS failure, reset, rate limit, 5xx), so
 * unrelated pull text followed later by a generic transport error does not
 * trigger a retry. Deterministic pull errors (missing manifest, denied access)
 * and non-registry failures (Docker daemon down, port conflict, invalid config)
 * return `false` so callers fail fast.
 */
export function isTransientRegistryStartFailure(text: string): boolean;

/** Options for `startFailureDiagnosticExcerpt` (redacted + bounded). */
export interface StartFailureDiagnosticExcerptOptions {
  /** Maximum characters in the returned excerpt (default 1200). */
  maxChars?: number;
  /** Maximum trailing lines kept before character bounding (default 12). */
  maxLines?: number;
  /** Already-captured runtime values to redact (never surfaced elsewhere). */
  runtime?: Partial<SupabaseRuntime>;
}

/**
 * Build a credential-safe, bounded excerpt from failed `supabase start`
 * output. The output is passed through the shared redactor FIRST, then only the
 * last `maxLines` lines are kept and the result is capped at `maxChars`
 * characters. Empty/non-string input returns an empty string.
 */
export function startFailureDiagnosticExcerpt(
  output: string,
  options?: StartFailureDiagnosticExcerptOptions
): string;

/** Options for `startFailureSummary` (redacted, bounded start surfacing). */
export interface StartFailureSummaryOptions extends StartFailureDiagnosticExcerptOptions {
  /** Exit code of the failed `supabase start` (metadata only). */
  exitCode: number;
  /** Current whole-lane attempt number. */
  attempt: number;
  /** Bounded whole-lane retry budget. */
  maxAttempts: number;
  /** Whether the lane will retry with a fresh isolated workdir/port allocation. */
  retryable?: boolean;
  /** Short cause label appended to the fixed summary (e.g. `port conflict`). */
  reason?: string;
  /**
   * Captured `supabase start` stdout/stderr. NEVER surfaced raw: it is passed
   * through `startFailureDiagnosticExcerpt` (shared redaction + line/character
   * bounds) before being appended to the fixed summary.
   */
  output?: string;
}

/**
 * Build the ONLY diagnostic text emitted for a failed `supabase start`: a
 * fixed summary plus exit/attempt metadata and, when output was captured, a
 * REDACTED and bounded diagnostic excerpt. Raw captured output is never
 * returned.
 */
export function startFailureSummary(options: StartFailureSummaryOptions): string;

export function rewriteIsolatedConfig(
  configText: string,
  options: { projectId: string; ports: Record<string, number> }
): string;

export function prepareIsolatedSupabase(options: {
  root: string;
  label?: string;
  extraPorts?: number;
}): Promise<IsolatedSupabase>;

/** Handles returned by `prepareIsolatedAppDir`. */
export interface IsolatedAppDir {
  workdir: string;
  cleanup: () => void;
}

export function prepareIsolatedAppDir(options: {
  root: string;
  label?: string;
}): IsolatedAppDir;

export function supabaseArgs(subcommand: string, args?: string[], workdir?: string): string[];

/** Options for a contained teardown auxiliary subprocess invocation. */
export interface TeardownSubprocessOptions {
  env?: Record<string, string | undefined>;
  runtime?: Partial<SupabaseRuntime>;
  cwd?: string;
  timeout?: number;
}

/** Result of a contained teardown auxiliary subprocess invocation. */
export interface TeardownSubprocessResult {
  /** Exit code, or `null` when the command could not be spawned. */
  status: number | null;
  /** Captured stdout+stderr already passed through `redactSensitiveOutput`. */
  output: string;
  /** Spawn error (when `status` is `null`), otherwise `null`. */
  error: Error | null;
}

/**
 * Run a teardown auxiliary subprocess (e.g. a `docker info` availability
 * probe) with the sanitized child env, captured output, and redacted return.
 */
export function runTeardownSubprocess(
  cmd: string,
  args: string[],
  options?: TeardownSubprocessOptions
): TeardownSubprocessResult;

/** Result of a contained `stopIsolatedSupabase` invocation. */
export interface StopIsolatedResult {
  status: number;
  /** Captured stdout+stderr already passed through `redactSensitiveOutput`. */
  output: string;
  /** True when the hard deadline fired and the stop child had to be terminated. */
  timedOut: boolean;
  /** True only for a clean, non-timed-out exit. */
  confirmed: boolean;
}

/**
 * Stop the isolated instance (no backup) as a TRACKED async child, scoped to
 * the isolated project THROUGH the `--workdir` argument (whose config.toml
 * carries the lane's unique project id), with `--no-backup --yes`, the
 * sanitized child env, a hard deadline (`timeoutMs`, default 120s) with
 * SIGTERM→SIGKILL escalation (`killGraceMs`, default 3s), captured output, and
 * redacted return. No `--project-id` flag is passed (the CLI's `stop` does not
 * accept one); scope comes from the isolated workdir config.
 */
export function stopIsolatedSupabase(
  supabaseBin: string,
  workdir: string,
  options?: {
    env?: Record<string, string | undefined>;
    runtime?: Partial<SupabaseRuntime>;
    timeoutMs?: number;
    killGraceMs?: number;
  }
): Promise<StopIsolatedResult>;

export function parseSupabaseStatus(stdout: string): Partial<SupabaseRuntime>;

export function parseSupabaseStatusJson(stdout: string): Partial<SupabaseRuntime>;

export function presenceSummary(runtime: Partial<SupabaseRuntime>): string;

export const REQUIRED_RUNTIME_KEYS: string[];

export function hasRequiredRuntime(runtime?: Partial<SupabaseRuntime> | null): boolean;

export function mergeRuntimeMaps(
  ...maps: Array<Partial<SupabaseRuntime> | null | undefined>
): Partial<SupabaseRuntime>;

export function captureRuntimeEnv(options: {
  /**
   * Each invocation may return a result synchronously OR a promise (e.g. a
   * tracked asynchronous `supabase status` child via `runTrackedSubprocess`);
   * it is always awaited.
   */
  run: (format: "env" | "json") => StatusCapture | Promise<StatusCapture>;
  attempts?: number;
  retryDelayMs?: number;
}): Promise<RuntimeCapture>;

export function runtimeEnv(
  base: Record<string, string | undefined>,
  runtime: Partial<SupabaseRuntime>
): Record<string, string>;

export function isLoopbackHttpUrl(url: string): boolean;

export function isLoopbackDbUrl(url: string): boolean;

export function assertLoopbackRuntime(runtime: Partial<SupabaseRuntime>): void;

export function sanitizeEnv(base?: Record<string, string | undefined>): Record<string, string>;

export function redactSensitiveOutput(text: string, options?: RedactOptions): string;

export function createRedactTransform(options?: RedactOptions): NodeJS.ReadWriteStream;

export function pipeRedacted(
  readable: NodeJS.ReadableStream | null,
  writable: NodeJS.WritableStream | null,
  options?: RedactOptions
): void;

export function killChildGracefully(
  child: import("node:child_process").ChildProcess | null,
  options?: KillOptions
): Promise<number | null>;

export function trackChild(
  child: import("node:child_process").ChildProcess | null
): import("node:child_process").ChildProcess | null;

export function untrackChild(child: import("node:child_process").ChildProcess | null): void;

export function activeChildCount(): number;

export function terminateAllChildren(options?: KillOptions): Promise<void>;