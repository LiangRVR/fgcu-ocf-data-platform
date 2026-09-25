/**
 * tests/unit/scripts/schema-inventory/cli.test.ts
 *
 * CLI behavior: packet-file diffing with required sections, optional reviewed
 * disposition manifest, redacted output, fail-closed exit codes, and
 * rejection of a non-loopback capture URL. No live database is touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runCapture, runDiff } from "../../../../scripts/schema-inventory/cli";
import { CATALOG_SECTIONS, INVENTORY_FORMAT_VERSION } from "../../../../scripts/schema-inventory/types";

let tmpDir: string | null = null;

function makeTmp(): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "schema-inventory-cli-"));
  return tmpDir;
}

/** Build a catalog object carrying every required section (empty by default). */
function fullCatalog(overrides: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  const catalog: Record<string, unknown[]> = {};
  for (const section of CATALOG_SECTIONS) catalog[section] = [];
  return { ...catalog, ...overrides };
}

const ADVISOR_TABLE = {
  identity: "public.advisor",
  source: "pg_class: public.advisor",
  fields: { schema: "public", name: "advisor", kind: "table", persistence: "p" },
};

function writePacket(name: string, catalog: Record<string, unknown[]>): string {
  const dir = makeTmp();
  const file = path.join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      formatVersion: INVENTORY_FORMAT_VERSION,
      source: name.startsWith("remote") ? "remote" : "local",
      capturedAt: "2026-09-25T00:00:00.000Z",
      catalog,
    })
  );
  return file;
}

function writeManifest(entries: unknown[]): string {
  const dir = makeTmp();
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify({ formatVersion: 1, reviewed: entries }));
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("parseArgs", () => {
  it("parses --key value pairs", () => {
    expect(parseArgs(["--remote", "a.json", "--local", "b.json"])).toEqual({
      remote: "a.json",
      local: "b.json",
    });
  });

  it("throws when a value is missing", () => {
    expect(() => parseArgs(["--remote"])).toThrow(/Missing value/);
  });
});

describe("runDiff", () => {
  it("writes a redacted register and does not exit non-zero for an equivalent diff", () => {
    const out = writePacket("out.json", fullCatalog());
    const remoteFile = writePacket("remote.json", fullCatalog({ tables: [ADVISOR_TABLE] }));
    const localFile = writePacket("local.json", fullCatalog({ tables: [ADVISOR_TABLE] }));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runDiff({ remote: remoteFile, local: localFile, out });
    expect(exit).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.blocked).toBe(false);
    expect(written.summary.equivalent).toBe(1);
    expect(written.entries[0].disposition).toBe("equivalent");
  });

  it("fails closed (exit 1) when a conflict is present and prints a redacted register", () => {
    const out = writePacket("out.json", fullCatalog());
    const remoteFile = writePacket("remote.json", fullCatalog({ tables: [ADVISOR_TABLE] }));
    const localFile = writePacket(
      "local.json",
      fullCatalog({ tables: [{ ...ADVISOR_TABLE, fields: { ...ADVISOR_TABLE.fields, persistence: "u" } }] })
    );

    let exitCode: number | null = null;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as (code?: number | string | null) => never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => runDiff({ remote: remoteFile, local: localFile, out })).toThrow(/process.exit called/);
    expect(exit).toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalled();

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.blocked).toBe(true);
    expect(written.summary.conflict).toBe(1);
  });

  it("fails closed (exit 1) for a remote-only object without manifest authorization", () => {
    const out = writePacket("out.json", fullCatalog());
    const remoteFile = writePacket("remote.json", fullCatalog({ tables: [ADVISOR_TABLE] }));
    const localFile = writePacket("local.json", fullCatalog());

    let exitCode: number | null = null;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as (code?: number | string | null) => never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => runDiff({ remote: remoteFile, local: localFile, out })).toThrow(/process.exit called/);
    expect(exitCode).toBe(1);

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.blocked).toBe(true);
    expect(written.summary.unknown).toBe(1);
  });

  it("honors a reviewed disposition manifest for a remote-only object", () => {
    const out = writePacket("out.json", fullCatalog());
    const remoteFile = writePacket("remote.json", fullCatalog({ tables: [ADVISOR_TABLE] }));
    const localFile = writePacket("local.json", fullCatalog());
    const manifestFile = writeManifest([
      { section: "tables", identity: "public.advisor", disposition: "remote-only intended" },
    ]);

    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runDiff({ remote: remoteFile, local: localFile, manifest: manifestFile, out });
    expect(exit).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.blocked).toBe(false);
    expect(written.summary["remote-only intended"]).toBe(1);
  });
});

describe("runCapture", () => {
  it("rejects a non-loopback DB URL before connecting", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      runCapture({ "db-url": "postgresql://postgres:secret@db.internal.supabase.co:5432/postgres" })
    ).rejects.toThrow(/loopback/);
    expect(stdout).not.toHaveBeenCalled();
  });
});