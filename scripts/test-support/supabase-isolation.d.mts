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

/** Options for `startFailureSummary` (fail-closed `supabase start` surfacing). */
export interface StartFailureSummaryOptions {
  /** Exit code of the failed `supabase start` (never surfaced, metadata only). */
  exitCode: number;
  /** Current whole-lane attempt number. */
  attempt: number;
  /** Bounded whole-lane retry budget. */
  maxAttempts: number;
  /** Whether the lane will retry with a fresh port allocation. */
  retryable?: boolean;
  /**
   * Captured `supabase start` stdout/stderr. ACCEPTED AND DELIBERATELY
   * DROPPED: CLI diagnostics can contain credentials, so the captured output
   * is never included in the returned summary — it stays strictly internal
   * for port-conflict classification and bounded retry.
   */
  output?: string;
}

/**
 * Build the ONLY diagnostic text emitted for a failed `supabase start`: a
 * fixed summary plus exit/attempt metadata, never the captured output.
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
}

/**
 * Stop the isolated instance (no backup) as a TRACKED async child with the
 * sanitized child env, a hard deadline (`timeoutMs`, default 120s) with
 * SIGTERM→SIGKILL escalation (`killGraceMs`, default 3s), captured output, and
 * redacted return.
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