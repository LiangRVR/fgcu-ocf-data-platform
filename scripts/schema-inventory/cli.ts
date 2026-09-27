#!/usr/bin/env tsx
/**
 * scripts/schema-inventory/cli.ts
 *
 * CLI entrypoint for the schema inventory/diff utility.
 *
 *   tsx scripts/schema-inventory/cli.ts capture --db-url <loopback-url> [--out <file>]
 *   tsx scripts/schema-inventory/cli.ts diff --remote <file> --local <file> [--out <file>]
 *
 * Safety contract:
 *   - `capture` asserts the DB URL is loopback-only and uses read-only catalog
 *     queries against a disposable local database. There is NO production
 *     connection feature anywhere in the utility.
 *   - `diff` consumes pre-redacted packet files only — it never connects to a
 *     database and never accepts a DB URL.
 *   - Output is always redacted (no credentials, URLs, JWTs, or row data).
 *   - A blocked diff (any conflict/unknown) exits non-zero and prints a
 *     redacted register: callers must fail closed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { captureLocalInventory } from "./capture";
import { diffInventories } from "./diff";
import { toRedactedJson } from "./redact";
import { parseDispositionManifest, parseInventoryPacket } from "./validate";

const USAGE = `Usage:
  tsx scripts/schema-inventory/cli.ts capture --db-url <loopback-url> [--out <file>]
  tsx scripts/schema-inventory/cli.ts diff --remote <file> --local <file> [--manifest <file>] [--out <file>]`;

function parseArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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

function fail(message: string, code = 2): never {
  // Errors may embed a user-supplied value; redact before printing.
  process.stderr.write(`schema-inventory: ${toRedactedJson(message)}\n`);
  process.exit(code);
}

async function runCapture(opts: Record<string, string>): Promise<void> {
  const dbUrl = opts["db-url"];
  if (!dbUrl) fail("capture requires --db-url <loopback-url>");
  const inventory = await captureLocalInventory(dbUrl);
  const output = toRedactedJson(inventory);
  if (opts.out) writeFileSync(opts.out, `${output}\n`);
  else process.stdout.write(`${output}\n`);
}

function runDiff(opts: Record<string, string>): void {
  const remotePath = opts.remote;
  const localPath = opts.local;
  if (!remotePath || !localPath) {
    fail("diff requires --remote <file> and --local <file>");
  }
  const remote = parseInventoryPacket(readFileSync(remotePath, "utf8"));
  const local = parseInventoryPacket(readFileSync(localPath, "utf8"));
  const manifest = opts.manifest
    ? parseDispositionManifest(readFileSync(opts.manifest, "utf8"))
    : undefined;
  const register = diffInventories(remote, local, manifest);
  const output = toRedactedJson(register);
  if (opts.out) writeFileSync(opts.out, `${output}\n`);
  else process.stdout.write(`${output}\n`);

  if (register.blocked) {
    const blocking = register.entries.filter(
      (e) => e.disposition === "conflict" || e.disposition === "unknown"
    );
    fail(
      `Diff is BLOCKED: ${blocking.length} blocking difference(s) ` +
        `(${register.summary.conflict} conflict, ${register.summary.unknown} unknown).`,
      1
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let opts: Record<string, string>;
  try {
    opts = parseArgs(rest);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  switch (command) {
    case "capture":
      await runCapture(opts);
      break;
    case "diff":
      runDiff(opts);
      break;
    default:
      fail(USAGE);
  }
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

export { main, parseArgs, runCapture, runDiff };