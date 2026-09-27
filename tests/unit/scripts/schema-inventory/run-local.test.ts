/**
 * tests/unit/scripts/schema-inventory/run-local.test.ts
 *
 * Focused unit coverage for the local capture lane runner's pure surface
 * (`scripts/schema-inventory/run-local.mjs`):
 *   - `parseArgs` requires/exposes `--out` (and `--help`);
 *   - `resolveOutputPath` requires an explicit `--out` and REJECTS any path
 *     that resolves inside the repository root, so a default or careless
 *     invocation can never write into the repo.
 *
 * No Docker lane, container, or database is started here; the heavy lifecycle
 * is exercised separately by running the runner itself.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseArgs,
  resolveOutputPath,
} from "../../../../scripts/schema-inventory/run-local.mjs";

// Same repo root the runner derives from its own location.
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);

describe("parseArgs", () => {
  it("parses --out <path>", () => {
    expect(parseArgs(["--out", "/tmp/opencode/inventory.json"])).toEqual({
      out: "/tmp/opencode/inventory.json",
    });
  });

  it("exposes --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("throws when --out is missing a value", () => {
    expect(() => parseArgs(["--out"])).toThrow(/Missing value/);
  });
});

describe("resolveOutputPath", () => {
  it("accepts an explicit path outside the repository", () => {
    const out = path.join("/tmp", "opencode", "inventory.json");
    expect(resolveOutputPath(out)).toBe(path.resolve(out));
  });

  it("requires --out (no default write into the repo)", () => {
    expect(() => resolveOutputPath(undefined)).toThrow(/requires --out/);
    expect(() => resolveOutputPath("")).toThrow(/requires --out/);
    expect(() => resolveOutputPath("   ")).toThrow(/requires --out/);
  });

  it("rejects an output path inside the repo root", () => {
    expect(() => resolveOutputPath(path.join(ROOT, "local-inventory.json"))).toThrow(
      /inside the repo root/
    );
    expect(() =>
      resolveOutputPath(path.join(ROOT, "scripts", "schema-inventory", "local-inventory.json"))
    ).toThrow(/inside the repo root/);
    expect(() => resolveOutputPath(ROOT)).toThrow(/inside the repo root/);
  });
});